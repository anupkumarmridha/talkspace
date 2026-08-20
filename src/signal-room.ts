import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import {
  CLOSE_BAD_REQUEST,
  CLOSE_ENDED,
  CLOSE_FLOOD,
  CLOSE_REMOVED,
  CLOSE_ROOM_FULL,
  KICK_BLOCK_MS,
  LIMITS,
  ROOM_TTL_MS,
  type Attachment,
  type PeerInfo,
  type PeerState,
  type RoomMeta,
  type ServerFrame,
} from "./protocol";
import { hashPasscode, randomId, timingSafeEqual } from "./crypto";

/** Re-announce to the lobby well inside ROOM_IDLE_TIMEOUT_MS. */
const HEARTBEAT_MS = 45_000;

const DEFAULT_STATE: PeerState = { mic: true, cam: false, screen: false };

/**
 * One Durable Object per room: the coordination atom for that call.
 *
 * It knows who is present and forwards opaque envelopes between them. It
 * deliberately cannot read anything it forwards, and it stores no messages.
 */
export class SignalRoom extends DurableObject<Env> {
  /**
   * Relay rate limiting, per peer. Held in memory on purpose: it is only
   * lost when the object hibernates, which by definition means the room went
   * idle, which is the same state a refilled bucket describes.
   */
  private buckets = new Map<string, { tokens: number; last: number }>();

  /**
   * Recently removed participants, by name, with the time their block lifts.
   * Names rather than peer ids, because a rejoin mints a fresh id -- this is a
   * speed bump against instant re-entry, not an access control system.
   */
  private blocked = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
      );
    });

    // Keepalives are answered by the runtime without ever running our code,
    // so an idle room with 8 open sockets costs nothing.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // --- Room lifecycle (RPC, called from the Worker) ----------------------

  /**
   * Create the room if it does not exist yet, then return its metadata.
   * Joining an unknown code makes an unlisted room, so a shared link works
   * without anyone having pressed "create" first.
   */
  async ensure(id: string, seed?: Partial<RoomMeta>, passcode?: string): Promise<RoomMeta> {
    const existing = this.readMeta();
    if (existing) return existing;

    const meta: RoomMeta = {
      id,
      name: clamp(seed?.name || `Room ${id}`, LIMITS.roomNameChars),
      topic: clamp(seed?.topic ?? "", LIMITS.topicChars),
      lang: clamp(seed?.lang ?? "", 16),
      maxPeers: clampInt(seed?.maxPeers, 2, Number(this.env.MAX_PEERS_PER_ROOM ?? "8")),
      isPublic: seed?.isPublic ?? false,
      hasPasscode: Boolean(passcode),
      createdAt: Date.now(),
      expiresAt: Date.now() + ROOM_TTL_MS,
    };

    this.writeMeta(meta);
    // A room with no participants still has to wake once, at expiry, to
    // delete itself. One alarm per room per day -- not a heartbeat.
    await this.ctx.storage.setAlarm(meta.expiresAt);

    if (passcode) {
      const salt = randomId(16);
      this.put("salt", salt);
      this.put("pass", await hashPasscode(passcode, salt));
    }

    return meta;
  }

  async info(): Promise<RoomMeta | null> {
    return this.readMeta();
  }

  /** Why a join would be refused, or null if the room is open. */
  async unavailable(): Promise<"ended" | "expired" | null> {
    if (this.get("ended")) return "ended";
    const meta = this.readMeta();
    if (meta && Date.now() > meta.expiresAt) return "expired";
    return null;
  }

  /** True while this display name is serving out a removal. */
  async isBlocked(name: string): Promise<boolean> {
    const until = this.blocked.get(name.toLowerCase());
    if (!until) return false;
    if (Date.now() > until) {
      this.blocked.delete(name.toLowerCase());
      return false;
    }
    return true;
  }

  /** True when the room has no passcode, or the supplied one matches. */
  async checkPasscode(passcode: string): Promise<boolean> {
    const stored = this.get("pass");
    const salt = this.get("salt");
    if (!stored || !salt) return true;
    return timingSafeEqual(stored, await hashPasscode(passcode, salt));
  }

  async occupancy(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }

  // --- Connection handling ------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    // The Worker is the only ingress and has already verified the signed
    // join token; these headers carry its verified claims.
    const id = request.headers.get("x-peer-id");
    const name = request.headers.get("x-peer-name");
    const pub = request.headers.get("x-peer-pub") ?? "";
    const meta = this.readMeta();

    if (!id || !name || !meta) {
      return new Response("Bad join", { status: 400 });
    }

    const peers = this.peerList();
    if (peers.length >= meta.maxPeers) {
      return new Response("Room full", { status: 409 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);

    const attachment: Attachment = {
      id,
      name,
      pub,
      state: { ...DEFAULT_STATE },
      joinedAt: Date.now(),
    };
    server.serializeAttachment(attachment);

    // First person in the room takes the chair. It is stored so that a host
    // who reloads does not silently hand it to whoever else is present.
    let hostId = this.get("host");
    if (!hostId || peers.length === 0) {
      hostId = id;
      this.put("host", hostId);
    }

    const self = toPeerInfo(attachment);
    send(server, { t: "welcome", self, room: meta, peers, hostId });
    this.broadcast({ t: "peer-joined", peer: self }, id);
    if (hostId === id && peers.length > 0) this.broadcast({ t: "host", id }, id);

    await this.publishPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const me = ws.deserializeAttachment() as Attachment | null;
    if (!me) return void ws.close(CLOSE_BAD_REQUEST, "no session");

    if (typeof message !== "string") {
      return void ws.close(CLOSE_BAD_REQUEST, "binary not supported");
    }
    if (message.length > LIMITS.signalBytes) {
      return void ws.close(CLOSE_BAD_REQUEST, "frame too large");
    }
    if (!this.spend(me.id)) {
      return void ws.close(CLOSE_FLOOD, "slow down");
    }

    let frame: { t?: string; to?: unknown; payload?: unknown; state?: unknown };
    try {
      frame = JSON.parse(message);
    } catch {
      return void ws.close(CLOSE_BAD_REQUEST, "malformed frame");
    }

    switch (frame.t) {
      case "signal": {
        // Unicast only, and only to someone actually in this room. The
        // payload itself is never parsed -- it is SDP, ICE, or ciphertext.
        if (typeof frame.to !== "string") return;
        const target = this.socketFor(frame.to);
        if (!target) return;
        send(target, { t: "signal", from: me.id, payload: frame.payload });
        return;
      }

      case "state": {
        const next = mergeState(me.state, frame.state);
        ws.serializeAttachment({ ...me, state: next });
        this.broadcast({ t: "state", id: me.id, state: next }, me.id);
        return;
      }

      case "host": {
        // Authorisation is decided here and only here. The client hides the
        // controls from non-hosts as a courtesy; this is what enforces it.
        if (this.get("host") !== me.id) {
          send(ws, { t: "error", code: "not_host", message: "Only the host can do that" });
          return;
        }
        await this.hostAction(me, frame as unknown as { action?: string; target?: unknown });
        return;
      }

      case "bye": {
        ws.close(1000, "bye");
        return;
      }
    }
  }

  private async hostAction(
    me: Attachment,
    frame: { action?: string; target?: unknown },
  ): Promise<void> {
    if (frame.action === "end") {
      this.put("ended", "1");
      this.broadcast({ t: "error", code: "ended", message: "The host ended the meeting" });

      // Everyone else first, the host's own socket last. Closing the socket
      // we are currently handling a message for tears down this invocation's
      // context, and anything left in the loop after it can be lost.
      const sockets = this.ctx.getWebSockets();
      const host = sockets.filter((ws) => {
        const a = ws.deserializeAttachment() as Attachment | null;
        return a?.id === me.id;
      });
      const others = sockets.filter((ws) => !host.includes(ws));

      for (const ws of [...others, ...host]) {
        try {
          ws.close(CLOSE_ENDED, "ended");
        } catch {
          /* already gone */
        }
      }

      await this.env.LOBBY.getByName("global").remove(this.readMeta()?.id ?? "");
      return;
    }

    if (typeof frame.target !== "string" || frame.target === me.id) return;
    const target = this.socketFor(frame.target);
    if (!target) return;

    const victim = target.deserializeAttachment() as Attachment | null;

    if (frame.action === "mute") {
      // Enforced: the recipient mutes on receipt, no prompt.
      send(target, { t: "force-mute", by: me.name });
      return;
    }

    if (frame.action === "unmute") {
      send(target, { t: "force-unmute", by: me.name });
      return;
    }

    if (frame.action === "kick") {
      if (victim) this.blocked.set(victim.name.toLowerCase(), Date.now() + KICK_BLOCK_MS);
      send(target, { t: "error", code: "removed", message: "The host removed you" });
      try {
        target.close(CLOSE_REMOVED, "removed");
      } catch {
        /* already gone */
      }
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.departed(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.departed(ws);
  }

  private async departed(ws: WebSocket): Promise<void> {
    const me = ws.deserializeAttachment() as Attachment | null;
    if (me) {
      this.buckets.delete(me.id);
      this.broadcast({ t: "peer-left", id: me.id, name: me.name }, me.id);

      // The chair passes to whoever has been here longest, so a room is never
      // left with no one able to manage it.
      if (this.get("host") === me.id) {
        const remaining = this.peerList(ws);
        const next = remaining[0]?.id ?? "";
        this.put("host", next);
        if (next) this.broadcast({ t: "host", id: next });
      }
    }
    // The closing socket is still listed during this callback, so exclude it.
    await this.publishPresence(ws);
  }

  // --- Lobby presence -----------------------------------------------------

  /**
   * Keep the directory in sync. An empty room is delisted immediately;
   * an occupied one re-announces on a timer so a crashed object's stale
   * entry can expire.
   */
  private async publishPresence(exclude?: WebSocket): Promise<void> {
    const meta = this.readMeta();
    if (!meta) return;

    const peers = this.peerList(exclude);
    const lobby = this.env.LOBBY.getByName("global");

    if (peers.length === 0) {
      // Delist, but stay alive: the code keeps working for the rest of the
      // day so whoever left can walk back in. Crucially the heartbeat stops
      // here and the only remaining wake-up is expiry -- an idle room costs
      // one alarm per day, not one every 45 seconds.
      await lobby.remove(meta.id);
      await this.ctx.storage.setAlarm(meta.expiresAt);
      return;
    }

    await lobby.upsert(meta, peers.length, peers.map((p) => p.name));
    await this.ctx.storage.setAlarm(Math.min(Date.now() + HEARTBEAT_MS, meta.expiresAt));
  }

  override async alarm(): Promise<void> {
    const meta = this.readMeta();

    if (meta && Date.now() >= meta.expiresAt) {
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(CLOSE_ENDED, "expired");
        } catch {
          /* already gone */
        }
      }
      await this.env.LOBBY.getByName("global").remove(meta.id);
      // Reclaim the storage; the code now refers to nothing.
      await this.ctx.storage.deleteAll();
      return;
    }

    await this.publishPresence();
  }

  // --- Helpers ------------------------------------------------------------

  private peerList(exclude?: WebSocket): PeerInfo[] {
    const out: PeerInfo[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a) out.push(toPeerInfo(a));
    }
    return out.sort((a, b) => a.joinedAt - b.joinedAt);
  }

  private socketFor(peerId: string): WebSocket | null {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.id === peerId) return ws;
    }
    return null;
  }

  private broadcast(frame: ServerFrame, exceptId?: string): void {
    const encoded = JSON.stringify(frame);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a || a.id === exceptId) continue;
      try {
        ws.send(encoded);
      } catch {
        // Already closing; webSocketClose will reconcile.
      }
    }
  }

  /** Token bucket. Returns false once a peer outruns its budget. */
  private spend(peerId: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(peerId) ?? { tokens: LIMITS.relayBurst, last: now };

    const refill = ((now - bucket.last) / 1000) * LIMITS.relayPerSecond;
    bucket.tokens = Math.min(LIMITS.relayBurst, bucket.tokens + refill);
    bucket.last = now;

    if (bucket.tokens < 1) {
      this.buckets.set(peerId, bucket);
      return false;
    }

    bucket.tokens -= 1;
    this.buckets.set(peerId, bucket);
    return true;
  }

  private readMeta(): RoomMeta | null {
    const raw = this.get("meta");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as RoomMeta;
    } catch {
      return null;
    }
  }

  private writeMeta(meta: RoomMeta): void {
    this.put("meta", JSON.stringify(meta));
  }

  private get(k: string): string | null {
    const row = this.ctx.storage.sql
      .exec<{ v: string }>(`SELECT v FROM meta WHERE k = ?`, k)
      .toArray()[0];
    return row?.v ?? null;
  }

  private put(k: string, v: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      k,
      v,
    );
  }
}

function toPeerInfo(a: Attachment): PeerInfo {
  return { id: a.id, name: a.name, state: a.state, joinedAt: a.joinedAt, pub: a.pub };
}

function mergeState(current: PeerState, patch: unknown): PeerState {
  const p = (patch ?? {}) as Partial<Record<keyof PeerState, unknown>>;
  return {
    mic: typeof p.mic === "boolean" ? p.mic : current.mic,
    cam: typeof p.cam === "boolean" ? p.cam : current.cam,
    screen: typeof p.screen === "boolean" ? p.screen : current.screen,
  };
}

function send(ws: WebSocket, frame: ServerFrame): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // Peer vanished mid-handshake.
  }
}

function clamp(s: string, max: number): string {
  return s.slice(0, max);
}

function clampInt(v: unknown, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : max;
  return Math.min(max, Math.max(min, n));
}
