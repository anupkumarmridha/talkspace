/**
 * WebSocket client for the signalling channel.
 *
 * Mobile networks drop sockets constantly -- backgrounding the tab, walking
 * between cells, Wi-Fi handing off to LTE. Reconnection is therefore the
 * normal case, not an error path, and the call must survive it: the peer
 * connections stay up on their own while signalling is down, because ICE has
 * already done its job. We only need signalling back for the *next* person
 * who joins.
 */

const PING_MS = 25_000;
const MAX_BACKOFF_MS = 15_000;

export class Signal extends EventTarget {
  #urlFor;
  #ws = null;
  #attempt = 0;
  #pingTimer = null;
  #reconnectTimer = null;
  #closed = false;
  #connecting = false;
  /** Frames written while the socket was down, replayed on reconnect. */
  #queue = [];

  /**
   * @param urlFor  () => Promise<string> -- resolved fresh for every attempt.
   *
   * A factory rather than a fixed string because the join grant in the URL is
   * short-lived. Reconnecting to the original URL works for the first couple
   * of minutes and then fails forever, which is precisely the window in which
   * a phone gets pocketed or hands off between networks.
   */
  constructor(urlFor) {
    super();
    this.#urlFor = typeof urlFor === "function" ? urlFor : async () => urlFor;
  }

  get connected() {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  async connect() {
    if (this.#closed || this.#connecting || this.connected) return;
    this.#connecting = true;
    this.#clearReconnect();

    let ws;
    try {
      ws = new WebSocket(await this.#urlFor());
    } catch (err) {
      // Includes a refused re-issue (room ended, removed, full). Those are
      // terminal, so surface them rather than retrying into a wall.
      this.#connecting = false;
      if (err?.terminal) {
        this.#emit("close", { code: err.code ?? 4000, reason: err.message });
        return;
      }
      this.#scheduleReconnect();
      return;
    }

    this.#connecting = false;
    this.#ws = ws;

    ws.addEventListener("open", () => {
      this.#attempt = 0;
      this.#startPing();
      this.#emit("open");

      const pending = this.#queue.splice(0);
      for (const frame of pending) this.send(frame);
    });

    ws.addEventListener("message", (event) => {
      // The server answers keepalives with a bare "pong" via the Durable
      // Object's auto-response, which never wakes its JS. Not a real frame.
      if (event.data === "pong") return;

      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      this.#emit("frame", frame);
      if (frame.t) this.#emit(frame.t, frame);
    });

    ws.addEventListener("close", (event) => {
      this.#stopPing();
      this.#emit("close", { code: event.code, reason: event.reason });

      // 4000-range codes are our own policy rejections (room full, bad token,
      // flooding). Retrying those just loops, so surface them and stop.
      if (this.#closed || (event.code >= 4000 && event.code < 5000)) return;
      this.#scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // 'close' always follows, so reconnection is handled there.
    });
  }

  /** Queues while offline so a message typed mid-reconnect is not lost. */
  send(frame) {
    if (this.connected) {
      try {
        this.#ws.send(JSON.stringify(frame));
        return true;
      } catch {
        /* fall through to queueing */
      }
    }
    if (this.#queue.length < 64) this.#queue.push(frame);
    return false;
  }

  close() {
    this.#closed = true;
    this.#stopPing();
    this.#clearReconnect();
    try {
      this.#ws?.close(1000, "bye");
    } catch {
      /* already gone */
    }
    this.#ws = null;
  }

  // --- internals ------------------------------------------------------------

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #startPing() {
    this.#stopPing();
    this.#pingTimer = setInterval(() => {
      // Cloudflare closes idle WebSockets; a bare "ping" keeps the edge
      // connection warm at zero Durable Object cost.
      if (this.connected) this.#ws.send("ping");
    }, PING_MS);
  }

  #stopPing() {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
  }

  #clearReconnect() {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #scheduleReconnect() {
    if (this.#closed) return;
    this.#attempt += 1;
    // Exponential backoff with jitter, so a colo blip does not produce a
    // synchronised stampede from every client in the room.
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** (this.#attempt - 1));
    const delay = base * (0.5 + Math.random() * 0.5);

    this.#emit("reconnecting", { attempt: this.#attempt, delay });
    this.#reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

/**
 * Reconnect immediately when the OS hands the tab back, rather than waiting
 * out a backoff timer that was scheduled before the phone was pocketed.
 */
export function reconnectOnResume(signal) {
  const kick = () => {
    if (document.visibilityState === "visible" && !signal.connected) signal.connect();
  };
  document.addEventListener("visibilitychange", kick);
  window.addEventListener("online", kick);
  window.addEventListener("pageshow", kick);
}
