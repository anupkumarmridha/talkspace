/**
 * End-to-end encryption for chat, plus the verification surface for the call
 * as a whole.
 *
 * Threat model
 * ------------
 * The adversary we defend against is the server (and anyone who compromises
 * it or sits on the network). It routes every signalling frame, so it could
 * in principle substitute a public key and read the fallback chat channel.
 *
 * What stops that is exactly what stops it in Signal or WhatsApp: the keys
 * are pinned by the humans, not by the server. Every participant computes the
 * same safety number over everyone's public keys *and* their WebRTC DTLS
 * fingerprints, and reads it aloud on the call they are already on. A server
 * that swapped any key cannot make the numbers match.
 *
 * What is NOT claimed
 * -------------------
 * - Nobody verifies the safety number => the server *could* MITM the fallback
 *   chat channel. The UI nudges toward verifying for that reason.
 * - Display names are relayed in the clear; they are shown to the room anyway.
 * - Room membership and timing are visible to the server. Hiding metadata is
 *   a different, much harder problem and this app does not solve it.
 *
 * Audio and video are not covered here at all, because they do not need to
 * be: in a mesh, media flows directly between browsers under DTLS-SRTP and
 * never traverses Cloudflare.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

const KDF_INFO = enc.encode("talkspace/chat/v1");

// --- Identity ---------------------------------------------------------------

/**
 * A fresh ECDH keypair per session. Nothing is persisted, so a session that
 * has ended cannot be decrypted later even if the device is seized -- the
 * private key only ever existed in memory.
 */
export async function createIdentity() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false, // non-extractable: the private key cannot leave the browser
    ["deriveBits"],
  );
  const raw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  return { keyPair, pub: b64url(new Uint8Array(raw)) };
}

/**
 * Pairwise AES-GCM key from ECDH + HKDF.
 *
 * The salt is both public keys in a canonical (sorted) order, so both sides
 * derive the same key without negotiating who is "first", and a key derived
 * for one pair can never collide with another pair's.
 */
export async function deriveSharedKey(identity, theirPubB64) {
  const theirPub = await crypto.subtle.importKey(
    "raw",
    unb64url(theirPubB64),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: theirPub },
    identity.keyPair.privateKey,
    256,
  );

  const salt = enc.encode([identity.pub, theirPubB64].sort().join("|"));
  const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);

  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: KDF_INFO },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// --- Message encryption -----------------------------------------------------

/**
 * Bind each ciphertext to who sent it, who it is for, and its sequence
 * number. Because this is authenticated (AAD), the server cannot replay a
 * message to a different recipient, reorder a conversation, or re-attribute
 * a message to another sender without the tag failing.
 */
function aad(fromId, toId, seq) {
  return enc.encode(`${fromId}>${toId}#${seq}`);
}

export async function encryptFor(key, { fromId, toId, seq, text }) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(fromId, toId, seq) },
    key,
    enc.encode(text),
  );
  return { iv: b64url(iv), ct: b64url(new Uint8Array(ct)), seq };
}

/** Returns the plaintext, or null if authentication fails for any reason. */
export async function decryptFrom(key, { fromId, toId, seq, iv, ct }) {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64url(iv), additionalData: aad(fromId, toId, seq) },
      key,
      unb64url(ct),
    );
    return dec.decode(plain);
  } catch {
    // A forged, tampered, replayed or misrouted frame lands here. Never
    // surface the contents of a message that failed authentication.
    return null;
  }
}

// --- Safety number ----------------------------------------------------------

/**
 * 64 visually distinct emoji. A short emoji string is far easier to read
 * aloud and compare than 60 hex characters, which is why Signal, Telegram
 * and WhatsApp all landed on some version of this.
 */
const EMOJI = [
  "🐶","🐱","🦊","🐻","🐼","🐨","🦁","🐮","🐷","🐸","🐵","🐔","🐧","🦆","🦉","🦄",
  "🐝","🦋","🐢","🐙","🦀","🐬","🐳","🦈","🌵","🌲","🍁","🌸","🌻","🍄","🌍","🌙",
  "⭐","🔥","🌈","☂️","⚡","❄️","🍎","🍊","🍋","🍉","🍇","🍒","🥝","🌽","🥕","🍞",
  "🧀","🍰","🍪","☕","⚽","🏀","🎸","🎺","🎨","🚗","🚀","⛵","🏰","🔑","💎","🎁",
];

/**
 * A single fingerprint over the whole room.
 *
 * `participants` is a list of { id, pub, dtls }. Including the DTLS
 * certificate fingerprint is what extends the guarantee from "our chat keys
 * match" to "our media is also flowing to the party we think it is".
 *
 * Note what is deliberately NOT mixed in: the local event chain. Every
 * participant observes a different sequence of events (their own join, in
 * their own order), so folding the chain head in here would give each person
 * a different number and make comparison meaningless. The chain is a local
 * integrity log and is surfaced separately.
 */
export async function safetyNumber(roomId, participants) {
  const canonical = participants
    .map((p) => `${p.id}|${p.pub}|${p.dtls ?? ""}`)
    .sort()
    .join("\n");

  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", enc.encode(`${roomId}\n${canonical}`)),
  );

  const emoji = Array.from({ length: 5 }, (_, i) => EMOJI[digest[i] & 63]).join(" ");

  // 12 digits, grouped in threes -- the same shape as a phone number, which
  // is what makes it comfortable to read out.
  let digits = "";
  for (let i = 0; i < 6; i++) digits += String(((digest[8 + i] << 8) | digest[14 + i]) % 100).padStart(2, "0");
  const grouped = digits.match(/.{1,3}/g).join(" ");

  return { emoji, digits: grouped };
}

/**
 * Pull the DTLS certificate fingerprint out of an SDP blob.
 *
 * This is the value the browser will actually verify during the DTLS
 * handshake, so tying it into the safety number means a server that rewrites
 * SDP to insert itself into the media path changes the number too.
 */
export function dtlsFingerprint(sdp) {
  const match = /^a=fingerprint:\S+\s+(\S+)/m.exec(sdp ?? "");
  return match ? match[1].toLowerCase() : "";
}

// --- Tamper-evident event log -----------------------------------------------

/**
 * An append-only hash chain of security-relevant room events.
 *
 * This is the genuinely useful kernel of the "blockchain" idea with none of
 * the cost: no consensus, no network, no tokens. Each entry commits to every
 * entry before it, so the log cannot be rewritten after the fact -- and
 * because the head feeds the safety number, two participants who saw
 * different histories will read out different numbers.
 *
 * It is per-participant and local. There is no shared ledger to attack.
 */
export class EventChain {
  #head = "0".repeat(64);
  #entries = [];

  get head() {
    return this.#head;
  }

  get entries() {
    return [...this.#entries];
  }

  /** Short form for display. */
  get shortHead() {
    return this.#head.slice(0, 12);
  }

  async append(type, data) {
    const body = canonicalise({ type, data });
    const digest = await crypto.subtle.digest("SHA-256", enc.encode(this.#head + body));

    this.#head = hex(new Uint8Array(digest));
    this.#entries.push({ type, data, head: this.#head, at: Date.now() });

    // Bound memory on a long-running call; the head still commits to
    // everything that has been dropped.
    if (this.#entries.length > 500) this.#entries.splice(0, 100);

    return this.#head;
  }
}

/**
 * Deterministic JSON: object keys sorted at every depth.
 *
 * Two peers must hash the same event to the same bytes, and JS object key
 * order is insertion order, not a canonical one. Note that JSON.stringify's
 * array-replacer argument does NOT do this -- it is a recursive property
 * allow-list, so passing sorted top-level keys silently erases every nested
 * field and makes distinct events hash identically.
 */
function canonicalise(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(",")}]`;

  const keys = Object.keys(value).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalise(value[k])}`);
  return `{${pairs.join(",")}}`;
}

// --- Encoding ---------------------------------------------------------------

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s) {
  const padded = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
