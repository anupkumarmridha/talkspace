import type { Env } from "./index";

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Public STUN only. Enough for most home NATs, not for symmetric/CGNAT. */
const DEFAULT_STUN: IceServer[] = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
];

/**
 * Roughly 10-20% of real-world peers sit behind symmetric NAT or a firewall
 * that blocks direct UDP, and those calls only connect through a TURN relay.
 * Three ways to supply one, in priority order:
 *
 *   1. TURN_KEY_ID + TURN_KEY_API_TOKEN -> Cloudflare Realtime TURN, which
 *      mints short-lived credentials per user (never ship long-lived ones).
 *   2. TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL -> any static TURN server.
 *   3. Neither -> STUN only, and we tell the client so it can warn the user.
 */
export async function getIceServers(
  env: Env,
  identifier: string,
): Promise<{ iceServers: IceServer[]; hasTurn: boolean; turnSource: string }> {
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    const turn = await mintCloudflareTurn(env.TURN_KEY_ID, env.TURN_KEY_API_TOKEN, identifier);
    if (turn.length > 0) {
      return { iceServers: [...DEFAULT_STUN, ...turn], hasTurn: true, turnSource: "cloudflare" };
    }
  }

  if (env.TURN_URLS && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    return {
      iceServers: [
        ...DEFAULT_STUN,
        {
          urls: env.TURN_URLS.split(",").map((u) => u.trim()).filter(Boolean),
          username: env.TURN_USERNAME,
          credential: env.TURN_CREDENTIAL,
        },
      ],
      hasTurn: true,
      turnSource: "configured",
    };
  }

  // Nothing configured: fall back to a free community relay so a fresh clone
  // works for everyone out of the box, not just the ~85% whose network allows
  // a direct path.
  if (env.DISABLE_FALLBACK_TURN !== "1") {
    const fallback = await communityTurn();
    if (fallback.length > 0) {
      return { iceServers: [...DEFAULT_STUN, ...fallback], hasTurn: true, turnSource: "community" };
    }
  }

  return { iceServers: DEFAULT_STUN, hasTurn: false, turnSource: "none" };
}

/**
 * Free community TURN, used only when nothing better is configured.
 *
 * `turn.elixir-webrtc.org` (the Rel project) hands out short-lived credentials
 * without a signup, which is what makes a zero-configuration deployment
 * possible at all. Treat it as a courtesy, not infrastructure:
 *
 *  - It is volunteer-run with no SLA and could disappear tomorrow. Every
 *    failure path here degrades to STUN rather than breaking the call.
 *  - It offers UDP only, so it rescues symmetric-NAT users but not networks
 *    that block UDP outright. Configured TURN over TCP/443 still covers more.
 *  - A relay sees packet timing and IP addresses. It cannot see media: that is
 *    DTLS-SRTP, encrypted end to end between the browsers.
 *
 * Credentials are cached for most of their lifetime so we make roughly two
 * requests an hour per isolate rather than one per visitor.
 */
let cachedFallback: { servers: IceServer[]; expires: number } | null = null;

async function communityTurn(): Promise<IceServer[]> {
  if (cachedFallback && cachedFallback.expires > Date.now()) return cachedFallback.servers;

  try {
    const res = await fetch("https://turn.elixir-webrtc.org/?service=turn&username=talkspace", {
      method: "POST",
      // A slow third party must never hold up joining a call.
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return [];

    const body = (await res.json()) as { uris?: string[]; username?: string; password?: string; ttl?: number };
    if (!body.uris?.length || !body.username || !body.password) return [];

    const servers: IceServer[] = [
      { urls: body.uris, username: body.username, credential: body.password },
    ];
    const ttl = typeof body.ttl === "number" ? body.ttl : 600;
    cachedFallback = { servers, expires: Date.now() + Math.max(60, ttl - 120) * 1000 };

    return servers;
  } catch {
    // Unreachable or timed out: STUN only, and the client says so if a peer
    // then fails to connect.
    return [];
  }
}

async function mintCloudflareTurn(
  keyId: string,
  apiToken: string,
  identifier: string,
): Promise<IceServer[]> {
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        // Credentials only need to outlive the call they were minted for.
        body: JSON.stringify({ ttl: 3600, customIdentifier: identifier.slice(0, 64) }),
      },
    );

    if (!res.ok) {
      console.error("TURN credential request failed", res.status, await res.text());
      return [];
    }

    // The endpoint returns { iceServers: {...} }; tolerate an array too.
    const body = (await res.json()) as { iceServers?: IceServer | IceServer[] };
    if (!body.iceServers) return [];
    return Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers];
  } catch (err) {
    console.error("TURN credential request threw", err);
    return [];
  }
}
