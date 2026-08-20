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
): Promise<{ iceServers: IceServer[]; hasTurn: boolean }> {
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    const turn = await mintCloudflareTurn(env.TURN_KEY_ID, env.TURN_KEY_API_TOKEN, identifier);
    if (turn.length > 0) {
      return { iceServers: [...DEFAULT_STUN, ...turn], hasTurn: true };
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
    };
  }

  return { iceServers: DEFAULT_STUN, hasTurn: false };
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
