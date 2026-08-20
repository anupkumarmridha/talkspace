/**
 * Join-token minting and verification.
 *
 * The browser never chooses its own peer id or display name on the wire:
 * it asks the Worker for a token, the Worker stamps an id into a signed
 * payload, and the room Durable Object only trusts what the signature covers.
 * That removes impersonation and lets us expire a join grant.
 */

export interface JoinClaims {
  /** Room id. */
  rid: string;
  /** Server-assigned peer id. */
  pid: string;
  /** Display name, already sanitised. */
  nm: string;
  /** Expiry, epoch ms. */
  exp: number;
  /** Holder of the room's owner token, verified before the token was signed. */
  own?: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signJoinToken(secret: string, claims: JoinClaims): Promise<string> {
  const body = b64urlEncode(encoder.encode(JSON.stringify(claims)));
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifyJoinToken(
  secret: string,
  token: string,
): Promise<JoinClaims | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const sig = b64urlDecode(token.slice(dot + 1));
  if (!sig) return null;

  const key = await importKey(secret);
  // crypto.subtle.verify is constant-time, so this is not a timing oracle.
  const ok = await crypto.subtle.verify("HMAC", key, sig, encoder.encode(body));
  if (!ok) return null;

  const raw = b64urlDecode(body);
  if (!raw) return null;

  try {
    const claims = JSON.parse(decoder.decode(raw)) as JoinClaims;
    if (typeof claims.exp !== "number" || claims.exp < Date.now()) return null;
    if (typeof claims.rid !== "string" || typeof claims.pid !== "string") return null;
    if (typeof claims.nm !== "string") return null;
    return claims;
  } catch {
    return null;
  }
}

/**
 * Proof that the bearer owns a room.
 *
 * There are no accounts, so "the same person" cannot be recognised across
 * visits by identity -- a rejoin mints a brand new peer id. Ownership is
 * therefore a capability: the room's creator is handed an unguessable signed
 * token, keeps it in localStorage, and presents it on every join. That is what
 * makes the host stable across a reload, a reconnect, or leaving and coming
 * back, instead of the chair sliding to whoever happens to be present.
 *
 * It lives as long as the room does.
 */
export interface OwnerClaims {
  rid: string;
  role: "owner";
  exp: number;
}

export async function signOwnerToken(
  secret: string,
  rid: string,
  ttlMs: number,
): Promise<string> {
  const body = b64urlEncode(
    encoder.encode(JSON.stringify({ rid, role: "owner", exp: Date.now() + ttlMs })),
  );
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** Returns the claims when the token is valid for this room, else null. */
export async function verifyOwnerToken(
  secret: string,
  token: string,
  rid: string,
): Promise<OwnerClaims | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const sig = b64urlDecode(token.slice(dot + 1));
  if (!sig) return null;

  const key = await importKey(secret);
  if (!(await crypto.subtle.verify("HMAC", key, sig, encoder.encode(body)))) return null;

  const raw = b64urlDecode(body);
  if (!raw) return null;

  try {
    const claims = JSON.parse(decoder.decode(raw)) as OwnerClaims;
    if (claims.role !== "owner" || claims.rid !== rid) return null;
    if (typeof claims.exp !== "number" || claims.exp < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Salted SHA-256 of a room passcode. We never store the passcode itself. */
export async function hashPasscode(passcode: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${salt}:${passcode}`),
  );
  return b64urlEncode(new Uint8Array(digest));
}

/** Length-independent comparison for the passcode digest. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomId(bytes = 12): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Room codes use a Crockford-ish alphabet with no vowels (so no accidental
 * words) and no 0/O/1/I/L, because these get read aloud and typed on phones.
 */
const CODE_ALPHABET = "23456789bcdfghjkmnpqrstvwxz";

export function randomRoomCode(): string {
  const raw = crypto.getRandomValues(new Uint8Array(9));
  const chars = Array.from(raw, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return `${chars.slice(0, 3).join("")}-${chars.slice(3, 6).join("")}-${chars.slice(6, 9).join("")}`;
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array | null {
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
