/**
 * Wire protocol between the browser and the signalling Durable Objects.
 *
 * Design rule: the server is a *blind relay*. It routes opaque payloads
 * between peers and tracks who is in the room. It never sees media (that is
 * peer-to-peer DTLS-SRTP), and it never sees chat plaintext (that is either
 * an RTCDataChannel it has no access to, or AES-GCM ciphertext it cannot
 * decrypt). Nothing message-shaped is persisted anywhere.
 *
 * Every frame is JSON except the literal string "ping", which the Durable
 * Object answers via WebSocket auto-response so keepalives never wake it
 * out of hibernation.
 */

export interface PeerState {
  /** Microphone is enabled. */
  mic: boolean;
  /** Camera is enabled. */
  cam: boolean;
  /** Peer is sharing their screen. */
  screen: boolean;
}

export interface PeerInfo {
  id: string;
  name: string;
  state: PeerState;
  joinedAt: number;
  /**
   * Base64url raw ECDH P-256 public key for the chat fallback channel.
   * Unauthenticated by definition -- users confirm it out loud via the
   * safety number, exactly like comparing a Signal safety number.
   */
  pub: string;
}

export interface RoomMeta {
  id: string;
  name: string;
  topic: string;
  lang: string;
  maxPeers: number;
  isPublic: boolean;
  hasPasscode: boolean;
  createdAt: number;
  /**
   * Rooms stay joinable for a full day even while empty, so a link shared in
   * the morning still works that evening. After this the object deletes its
   * own state; the code then refers to nothing.
   */
  expiresAt: number;
}

/** Actions only the host may perform. Authorised server-side, never in the UI. */
export type HostAction =
  /** Disconnect a participant and block an immediate reconnect. */
  | { action: "kick"; target: string }
  /**
   * Mute a participant. Enforced, not negotiated: their client mutes on
   * receipt with no prompt, exactly like Google Meet.
   */
  | { action: "mute"; target: string }
  /**
   * Unmute a participant.
   *
   * Enforced, like mute. This goes further than Meet, Zoom or Teams, which
   * will only ever *ask* -- muting reduces what a microphone captures, while
   * unmuting increases it, so they require consent. Enabled here at the
   * operator's explicit direction. The recipient is always shown a prominent
   * notice, so a microphone never goes live silently and they can mute again
   * immediately.
   */
  | { action: "unmute"; target: string }
  /** End the meeting for everyone and retire the code. */
  | { action: "end" };

/** Frames the browser sends to the room Durable Object. */
export type ClientFrame =
  /** Opaque unicast payload: SDP, ICE, or encrypted chat. Never inspected. */
  | { t: "signal"; to: string; payload: unknown }
  /** Presence only -- booleans that drive other people's UI. */
  | { t: "state"; state: Partial<PeerState> }
  | ({ t: "host" } & HostAction)
  | { t: "bye" };

/** Frames the room Durable Object sends to the browser. */
export type ServerFrame =
  | { t: "welcome"; self: PeerInfo; room: RoomMeta; peers: PeerInfo[]; hostId: string }
  | { t: "peer-joined"; peer: PeerInfo }
  | { t: "peer-left"; id: string; name: string }
  | { t: "signal"; from: string; payload: unknown }
  | { t: "state"; id: string; state: PeerState }
  /** Host changed -- either the first join, or promotion after one leaves. */
  | { t: "host"; id: string }
  /** The host muted you. Applied immediately, without a prompt. */
  | { t: "force-mute"; by: string }
  /** The host unmuted you. Applied immediately, and always surfaced loudly. */
  | { t: "force-unmute"; by: string }
  | { t: "error"; code: string; message: string };

/** Frames the lobby Durable Object sends to the browser. */
export type LobbyFrame = { t: "rooms"; rooms: RoomSummary[] };

export interface RoomSummary extends RoomMeta {
  peerCount: number;
  peers: string[];
}

/** Per-connection data kept on the WebSocket attachment across hibernation. */
export interface Attachment {
  id: string;
  name: string;
  pub: string;
  state: PeerState;
  joinedAt: number;
}

export const CLOSE_ROOM_FULL = 4001;
export const CLOSE_UNAUTHORIZED = 4002;
export const CLOSE_BAD_REQUEST = 4003;
export const CLOSE_FLOOD = 4004;
export const CLOSE_REMOVED = 4005;
export const CLOSE_ENDED = 4006;

/** Rooms outlive their participants by a day. */
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

/** How long a removed participant is kept out before they may knock again. */
export const KICK_BLOCK_MS = 2 * 60 * 1000;

/** Hard caps so a malicious client cannot exhaust the relay. */
export const LIMITS = {
  /** An SDP offer for a 3-transceiver mesh peer is a few KB; 64 KB is slack. */
  signalBytes: 64 * 1024,
  nameChars: 32,
  roomNameChars: 60,
  topicChars: 120,
  /** Token bucket: sustained relay frames per second, and burst depth. */
  relayPerSecond: 40,
  relayBurst: 120,
} as const;
