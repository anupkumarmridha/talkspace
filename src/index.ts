import { Lobby } from "./lobby";
import { SignalRoom } from "./signal-room";
import { getIceServers } from "./ice";
import { randomId, randomRoomCode, signJoinToken, verifyJoinToken } from "./crypto";
import { LIMITS } from "./protocol";

export { Lobby, SignalRoom };

export interface Env {
  ASSETS: Fetcher;
  SIGNAL_ROOM: DurableObjectNamespace<SignalRoom>;
  LOBBY: DurableObjectNamespace<Lobby>;

  MAX_PEERS_PER_ROOM?: string;
  ROOM_IDLE_TIMEOUT_MS?: string;

  /** Cloudflare Realtime TURN (preferred): short-lived, per-user creds. */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  /** Or any static TURN server. */
  TURN_URLS?: string;
  TURN_USERNAME?: string;
  TURN_CREDENTIAL?: string;
  /** Set to "1" to opt out of the free community relay fallback. */
  DISABLE_FALLBACK_TURN?: string;
  /** Override the abandoned-session thresholds (ms). Used by tests. */
  ALONE_WARN_MS?: string;
  ALONE_CLOSE_MS?: string;
}

/**
 * Cached per-isolate. The secret lives in the lobby object so it survives
 * deploys and is identical in every colo, without the operator having to run
 * `wrangler secret put` before the app works at all.
 */
let signingSecret: Promise<string> | null = null;

function getSigningSecret(env: Env): Promise<string> {
  const cached = signingSecret;
  if (cached) return cached;

  const fresh = env.LOBBY.getByName("global").signingSecret();
  // Do not cache a rejection: a transient failure should be retried.
  signingSecret = fresh.catch((err) => {
    signingSecret = null;
    throw err;
  });
  return signingSecret;
}

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    // 'wasm-unsafe-eval' is required to compile the DSP module. It permits
    // WebAssembly compilation only -- it does not re-enable eval() or inline
    // script, so the XSS posture is unchanged.
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    "worker-src 'self' blob:",
    "connect-src 'self' wss: https:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "Permissions-Policy": "camera=(self), microphone=(self), display-capture=(self)",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      const res = await route(request, env, ctx, url);
      return withSecurityHeaders(res);
    } catch (err) {
      console.error("unhandled", err);
      return withSecurityHeaders(json({ error: "internal_error" }, 500));
    }
  },
} satisfies ExportedHandler<Env>;

async function route(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  const path = url.pathname;

  // Pretty room links: /r/<code> serves the call shell; the code stays in the
  // URL bar so the address is shareable and reload-safe.
  //
  // Fetch "/room", not "/room.html": html_handling strips the extension and
  // would answer the latter with a 307 to the former, which the browser would
  // then follow and lose the /r/<code> path.
  if (path.startsWith("/r/")) {
    return env.ASSETS.fetch(new Request(new URL("/room", url), request));
  }

  if (path === "/ws/lobby") {
    const bad = rejectCrossOrigin(request, url);
    if (bad) return bad;
    return env.LOBBY.getByName("global").fetch(request);
  }

  if (path.startsWith("/ws/room/")) {
    const bad = rejectCrossOrigin(request, url);
    if (bad) return bad;
    return joinRoomSocket(request, env, url, path.slice("/ws/room/".length));
  }

  if (path === "/api/ice" && request.method === "GET") {
    const { iceServers, hasTurn, turnSource } = await getIceServers(env, clientKey(request));
    // Credentials are short-lived and per-user; never let a proxy retain them.
    return json({ iceServers, hasTurn, turnSource }, 200, { "Cache-Control": "no-store" });
  }

  if (path === "/api/rooms" && request.method === "GET") {
    const rooms = await env.LOBBY.getByName("global").list();
    return json({ rooms }, 200, { "Cache-Control": "no-store" });
  }

  if (path === "/api/rooms" && request.method === "POST") {
    return createRoom(request, env);
  }

  if (path === "/api/join" && request.method === "POST") {
    return issueJoinToken(request, env);
  }

  return json({ error: "not_found" }, 404);
}

// --- Room creation and joining ---------------------------------------------

async function createRoom(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body) return json({ error: "bad_json" }, 400);

  const id = randomRoomCode();
  const maxAllowed = Number(env.MAX_PEERS_PER_ROOM ?? "8");
  const passcode = cleanText(body.passcode, 64);

  const meta = await env.SIGNAL_ROOM.getByName(id).ensure(
    id,
    {
      name: cleanText(body.name, LIMITS.roomNameChars) || "Untitled room",
      topic: cleanText(body.topic, LIMITS.topicChars),
      lang: cleanText(body.lang, 16),
      maxPeers: Math.min(maxAllowed, Number(body.maxPeers) || maxAllowed),
      isPublic: body.isPublic !== false,
    },
    passcode || undefined,
  );

  return json({ room: meta }, 201, { "Cache-Control": "no-store" });
}

/**
 * Two-step join. The browser proves it can satisfy the passcode here and
 * receives a short-lived signed grant; the WebSocket upgrade then carries
 * only that grant. The peer id is minted server-side, so a client can never
 * claim to be someone else.
 */
async function issueJoinToken(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body) return json({ error: "bad_json" }, 400);

  const roomId = normaliseRoomId(body.roomId);
  if (!roomId) return json({ error: "bad_room_id" }, 400);

  const name = cleanText(body.name, LIMITS.nameChars) || "Guest";
  const room = env.SIGNAL_ROOM.getByName(roomId);

  // An unknown code becomes an unlisted room, so a shared link just works.
  const meta = await room.ensure(roomId);

  // A room outlives its participants by a day, but not forever, and the host
  // can retire it early.
  const closed = await room.unavailable();
  if (closed) return json({ error: `room_${closed}` }, 410);

  if (await room.isBlocked(name)) {
    return json({ error: "removed" }, 403);
  }

  if (meta.hasPasscode) {
    const ok = await room.checkPasscode(cleanText(body.passcode, 64));
    if (!ok) return json({ error: "bad_passcode" }, 403);
  }

  if ((await room.occupancy()) >= meta.maxPeers) {
    return json({ error: "room_full", maxPeers: meta.maxPeers }, 409);
  }

  const token = await signJoinToken(await getSigningSecret(env), {
    rid: roomId,
    pid: randomId(9),
    nm: name,
    exp: Date.now() + 120_000,
  });

  return json({ token, room: meta }, 200, { "Cache-Control": "no-store" });
}

async function joinRoomSocket(
  request: Request,
  env: Env,
  url: URL,
  rawRoomId: string,
): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") {
    return json({ error: "expected_websocket" }, 426);
  }

  const roomId = normaliseRoomId(decodeURIComponent(rawRoomId));
  const token = url.searchParams.get("token");
  if (!roomId || !token) return json({ error: "bad_request" }, 400);

  const claims = await verifyJoinToken(await getSigningSecret(env), token);
  if (!claims || claims.rid !== roomId) {
    return json({ error: "unauthorized" }, 401);
  }

  // The ECDH public key is client-chosen and unauthenticated by design --
  // participants verify it out of band via the safety number. We only bound
  // its size and alphabet so it cannot become a smuggling channel.
  const pub = url.searchParams.get("pub") ?? "";
  if (pub && !/^[A-Za-z0-9_-]{1,256}$/.test(pub)) {
    return json({ error: "bad_key" }, 400);
  }

  const upgrade = new Request(request);
  upgrade.headers.set("x-peer-id", claims.pid);
  upgrade.headers.set("x-peer-name", claims.nm);
  upgrade.headers.set("x-peer-pub", pub);

  return env.SIGNAL_ROOM.getByName(roomId).fetch(upgrade);
}

// --- Helpers ---------------------------------------------------------------

/**
 * WebSockets are exempt from CORS, so without this a hostile page could open
 * a socket to a room using the visitor's network position. Same-origin only.
 */
function rejectCrossOrigin(request: Request, url: URL): Response | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null; // Non-browser client: no ambient authority to abuse.
  try {
    if (new URL(origin).host === url.host) return null;
  } catch {
    /* malformed Origin falls through to the rejection below */
  }
  return json({ error: "forbidden_origin" }, 403);
}

/** Coarse per-caller tag for TURN usage analytics. Not an identity. */
function clientKey(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

function normaliseRoomId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim().toLowerCase();
  return /^[a-z0-9]{3}-[a-z0-9]{3}-[a-z0-9]{3}$/.test(id) ? id : null;
}

/**
 * Strip control characters and bidi overrides. Both are standard tricks for
 * spoofing a display name. Rendering is textContent-only, so this is belt
 * and braces rather than the primary XSS defence.
 */
const UNSAFE_TEXT =
  /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  return raw.replace(UNSAFE_TEXT, "").trim().slice(0, max);
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("Content-Type")?.includes("application/json")) return null;
  try {
    const body = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function withSecurityHeaders(res: Response): Response {
  // A 101 carries the WebSocket handle and must be returned untouched.
  if (res.status === 101) return res;

  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}
