import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import type { RoomMeta, RoomSummary } from "./protocol";
import { randomId } from "./crypto";

const PRUNE_INTERVAL_MS = 30_000;

interface RoomRow {
  [key: string]: string | number;
  id: string;
  name: string;
  topic: string;
  lang: string;
  max_peers: number;
  is_public: number;
  has_passcode: number;
  expires_at: number;
  peer_count: number;
  peers: string;
  created_at: number;
  updated_at: number;
}

/**
 * A single global directory of live rooms, plus a WebSocket feed so the lobby
 * page updates without polling.
 *
 * A single Durable Object instance is normally an anti-pattern, but a
 * directory is inherently one shared list and the write rate is bounded by
 * room churn (not by traffic inside rooms), so one instance is the right
 * coordination atom here. If room churn ever outgrows it, shard by a prefix
 * of the room id and fan out reads.
 */
export class Lobby extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS rooms (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          topic       TEXT NOT NULL DEFAULT '',
          lang        TEXT NOT NULL DEFAULT '',
          max_peers   INTEGER NOT NULL DEFAULT 8,
          is_public   INTEGER NOT NULL DEFAULT 1,
          has_passcode INTEGER NOT NULL DEFAULT 0,
          expires_at  INTEGER NOT NULL DEFAULT 0,
          peer_count  INTEGER NOT NULL DEFAULT 0,
          peers       TEXT NOT NULL DEFAULT '[]',
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(
        `CREATE INDEX IF NOT EXISTS rooms_public_updated ON rooms (is_public, updated_at)`,
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
      );

      /*
       * Additive column migrations.
       *
       * CREATE TABLE IF NOT EXISTS is a no-op against an already-created
       * table, so adding a field to the definition above does nothing to a
       * live object -- every insert then fails with "no such column". A
       * Durable Object keeps its SQLite database across deploys, so schema
       * changes have to be applied explicitly, and idempotently.
       */
      const columns = new Set(
        this.ctx.storage.sql
          .exec<{ name: string }>(`PRAGMA table_info(rooms)`)
          .toArray()
          .map((c) => c.name),
      );

      const additions: Record<string, string> = {
        has_passcode: `ALTER TABLE rooms ADD COLUMN has_passcode INTEGER NOT NULL DEFAULT 0`,
        expires_at: `ALTER TABLE rooms ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0`,
      };

      for (const [column, statement] of Object.entries(additions)) {
        if (!columns.has(column)) this.ctx.storage.sql.exec(statement);
      }
    });
  }

  /**
   * HMAC key for join tokens, generated once and then persisted.
   *
   * Keeping it here rather than in a Wrangler secret means a fresh clone
   * deploys and works with no setup step, and the value is identical across
   * every colo because there is exactly one lobby object. Rotate it by
   * deleting the row; outstanding join tokens (120s TTL) simply expire.
   */
  async signingSecret(): Promise<string> {
    const existing = this.ctx.storage.sql
      .exec<{ v: string }>(`SELECT v FROM kv WHERE k = 'signing_secret'`)
      .toArray()[0];
    if (existing) return existing.v;

    const secret = randomId(32);
    this.ctx.storage.sql.exec(
      `INSERT INTO kv (k, v) VALUES ('signing_secret', ?)
       ON CONFLICT(k) DO NOTHING`,
      secret,
    );
    // Re-read: a concurrent caller may have won the insert.
    return this.ctx.storage.sql
      .exec<{ v: string }>(`SELECT v FROM kv WHERE k = 'signing_secret'`)
      .one().v;
  }

  /** Called by a SignalRoom whenever its membership changes. */
  async upsert(meta: RoomMeta, peerCount: number, peers: string[]): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO rooms (id, name, topic, lang, max_peers, is_public, has_passcode, expires_at, peer_count, peers, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         topic = excluded.topic,
         lang = excluded.lang,
         max_peers = excluded.max_peers,
         is_public = excluded.is_public,
         has_passcode = excluded.has_passcode,
         expires_at = excluded.expires_at,
         peer_count = excluded.peer_count,
         peers = excluded.peers,
         updated_at = excluded.updated_at`,
      meta.id,
      meta.name,
      meta.topic,
      meta.lang,
      meta.maxPeers,
      meta.isPublic ? 1 : 0,
      meta.hasPasscode ? 1 : 0,
      meta.expiresAt,
      peerCount,
      JSON.stringify(peers.slice(0, 12)),
      meta.createdAt,
      now,
    );
    await this.afterChange();
  }

  /** Called by a SignalRoom once its last participant disconnects. */
  async remove(id: string): Promise<void> {
    this.ctx.storage.sql.exec(`DELETE FROM rooms WHERE id = ?`, id);
    await this.afterChange();
  }

  async list(): Promise<RoomSummary[]> {
    return this.readRooms();
  }

  private readRooms(): RoomSummary[] {
    const rows = this.ctx.storage.sql
      .exec<RoomRow>(
        `SELECT * FROM rooms
         WHERE is_public = 1 AND peer_count > 0
         ORDER BY peer_count DESC, updated_at DESC
         LIMIT 100`,
      )
      .toArray();

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      topic: r.topic,
      lang: r.lang,
      maxPeers: r.max_peers,
      isPublic: r.is_public === 1,
      hasPasscode: r.has_passcode === 1,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      peerCount: r.peer_count,
      peers: safeParseNames(r.peers),
    }));
  }

  // --- Live lobby feed ---------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ t: "rooms", rooms: this.readRooms() }));
    await this.ensureAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(): Promise<void> {
    // The lobby feed is push-only; keepalives are handled by auto-response.
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    ws.close(1000, "bye");
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    ws.close(1011, "error");
  }

  private async afterChange(): Promise<void> {
    this.broadcast();
    await this.ensureAlarm();
  }

  private broadcast(): void {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;

    const frame = JSON.stringify({ t: "rooms", rooms: this.readRooms() });
    for (const ws of sockets) {
      try {
        ws.send(frame);
      } catch {
        // Socket is already gone; webSocketClose will clean it up.
      }
    }
  }

  // --- Stale room reaping ------------------------------------------------

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
    }
  }

  /**
   * A room whose Durable Object was evicted mid-call never gets to call
   * remove(), so entries are also expired by heartbeat age.
   */
  override async alarm(): Promise<void> {
    const idleTimeout = Number(this.env.ROOM_IDLE_TIMEOUT_MS ?? "120000");
    const cutoff = Date.now() - idleTimeout;

    const before = this.count();
    this.ctx.storage.sql.exec(`DELETE FROM rooms WHERE updated_at < ?`, cutoff);
    if (this.count() !== before) this.broadcast();

    // Keep reaping while anything is still listed or anyone is watching.
    if (this.count() > 0 || this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
    }
  }

  private count(): number {
    return this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM rooms`)
      .one().n;
  }
}

function safeParseNames(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}
