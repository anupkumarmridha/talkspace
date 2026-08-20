/**
 * Full-mesh peer connection manager.
 *
 * Every participant holds one RTCPeerConnection to every other participant.
 * Media never touches a server, which is what makes the call both free to run
 * and genuinely end-to-end encrypted -- DTLS-SRTP terminates in the two
 * browsers and nowhere else.
 *
 * Two design decisions carry most of the weight here:
 *
 * 1. Fixed transceivers. Each connection creates exactly three m-lines up
 *    front -- audio, camera, screen -- in a fixed order, before any SDP is
 *    generated. Toggling the camera or starting a screen share is then just
 *    replaceTrack() on an existing sender, with no renegotiation at all. That
 *    removes an entire category of glare bugs and makes screen sharing
 *    effectively instant instead of a a round trip.
 *
 * 2. Perfect negotiation. Both sides may try to offer at once; the standard
 *    polite/impolite algorithm resolves the collision without either peer
 *    getting stuck. Politeness is decided by comparing peer ids, which both
 *    sides can compute identically with no extra signalling.
 */

import {
  BITRATE,
  applyEncoding,
  audioBitrateFor,
  preferOpus,
  preferVideoCodec,
  setContentHint,
  tuneOpus,
  videoProfileFor,
} from "./media.js";

/** Slot order is load-bearing: it must match on both sides of a connection. */
const SLOTS = ["audio", "camera", "screen"];

export class Mesh extends EventTarget {
  #selfId;
  #iceServers;
  #certificate;
  #send;
  /** peerId -> peer record */
  #peers = new Map();
  #local = { mic: null, camera: null, screen: null };
  #statsTimer = null;
  #closed = false;

  /**
   * @param send  (toPeerId, payload) => void  -- routes through the relay
   */
  constructor({ selfId, iceServers, certificate, send }) {
    super();
    this.#selfId = selfId;
    this.#iceServers = iceServers;
    this.#certificate = certificate ?? null;
    this.#send = send;
    this.#startStats();
  }

  get peerIds() {
    return [...this.#peers.keys()];
  }

  /**
   * The DTLS fingerprint already observed for a peer, if any.
   *
   * Events can fire before the UI has a record to attach them to -- an offer
   * can arrive while the join handler is still awaiting something slow. A
   * pull accessor means a listener that missed the event can still catch up
   * instead of losing the value permanently.
   */
  getFingerprint(peerId) {
    return this.#peers.get(peerId)?.fingerprint ?? "";
  }

  // --- Local tracks ---------------------------------------------------------

  /**
   * Swap a local track into every existing connection.
   * `kind` is one of mic | camera | screen; `track` may be null to stop
   * sending that slot entirely (which frees the uplink, unlike enabled=false).
   */
  async setLocalTrack(kind, track) {
    this.#local[kind] = track ?? null;

    if (kind === "camera") setContentHint(track, "motion");
    if (kind === "screen") setContentHint(track, "detail");

    await Promise.all(
      [...this.#peers.values()].map((peer) => this.#applyTrack(peer, kind, track)),
    );
  }

  async #applyTrack(peer, kind, track) {
    const slot = kind === "mic" ? "audio" : kind;
    const sender = peer.tx[slot]?.sender;
    if (!sender) return;

    // Respect an existing unsubscribe: turning our camera on must not start
    // pushing video at someone who has told us they are not displaying it.
    const effective = slot === "camera" && !peer.sendingVideo ? null : (track ?? null);

    try {
      await sender.replaceTrack(effective);
    } catch {
      return; // connection is tearing down
    }
    if (effective) await this.#applyEncodingFor(peer, slot);
  }

  async #applyEncodingFor(peer, slot) {
    const sender = peer.tx[slot]?.sender;
    if (!sender) return;

    if (slot === "audio") {
      // Audio always goes to everyone; only its per-stream budget tapers.
      await applyEncoding(sender, {
        maxBitrate: audioBitrateFor(this.#peers.size + 1),
        priority: "high",
      });
      return;
    }

    if (slot === "screen") {
      await applyEncoding(sender, {
        maxBitrate: BITRATE.screen,
        priority: "high",
        // Shared text must stay sharp; drop frames before pixels.
        degradation: "maintain-resolution",
      });
      return;
    }

    const profile = videoProfileFor(this.#peers.size + 1);
    await applyEncoding(sender, {
      maxBitrate: profile.maxBitrate,
      scaleDown: profile.scaleDown,
      maxFps: profile.maxFps,
      priority: "medium",
      // Faces read better as smooth motion than as a sharp slideshow.
      degradation: "maintain-framerate",
    });
  }

  /** Re-run the ladder after someone joins or leaves. */
  async rebalance() {
    await Promise.all(
      [...this.#peers.values()].flatMap((peer) => [
        this.#applyEncodingFor(peer, "audio"),
        this.#applyEncodingFor(peer, "camera"),
      ]),
    );
  }

  // --- Receiver-driven video subscription -----------------------------------

  /**
   * Declare which peers' cameras this client wants to display.
   *
   * Upload is the mesh bottleneck, and there is no point uploading video to
   * someone who is not rendering it. Each peer tells the others whether it
   * wants their camera; senders pause the camera track for anyone who does
   * not. In a twelve-person grid this turns eleven video uploads into four.
   *
   * Audio is deliberately never unsubscribed -- you must always hear
   * everyone, including whoever is off-screen.
   */
  setVideoSubscriptions(wantedPeerIds) {
    const wanted = new Set(wantedPeerIds);

    for (const peer of this.#peers.values()) {
      const want = wanted.has(peer.id);
      if (peer.wantsOurVideo === want) continue;
      peer.wantsOurVideo = want;
      this.#send(peer.id, { kind: "video-request", want });
    }
  }

  /** Act on a peer telling us whether to send them our camera. */
  async #handleVideoRequest(peer, want) {
    if (peer.sendingVideo === want) return;
    peer.sendingVideo = want;

    const sender = peer.tx.camera?.sender;
    if (!sender) return;

    try {
      await sender.replaceTrack(want ? (this.#local.camera ?? null) : null);
      if (want && this.#local.camera) await this.#applyEncodingFor(peer, "camera");
    } catch {
      /* connection is tearing down */
    }
  }

  // --- Peer lifecycle -------------------------------------------------------

  addPeer(peerId) {
    if (this.#closed || peerId === this.#selfId || this.#peers.has(peerId)) return;

    const pc = new RTCPeerConnection({
      iceServers: this.#iceServers,
      // Pre-gather candidates so the first offer already carries them; this
      // measurably shortens time-to-first-frame.
      iceCandidatePoolSize: 4,
      // One transport for everything: fewer ports, faster setup, and it is
      // required for the fixed-transceiver layout to share a DTLS session.
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
      // One certificate reused across every connection in the session.
      // Without this each RTCPeerConnection mints its own, so a peer would
      // present a different DTLS fingerprint to each participant and no
      // room-wide safety number could exist. It also skips a keygen per peer.
      ...(this.#certificate ? { certificates: [this.#certificate] } : {}),
    });

    const peer = {
      id: peerId,
      pc,
      // Lower id offers first. Both sides derive this identically.
      polite: this.#selfId > peerId,
      makingOffer: false,
      ignoreOffer: false,
      pendingCandidates: [],
      tx: {},
      channel: null,
      streams: {},
      fingerprint: "",
      /** Whether this peer currently wants our camera. Assumed until told. */
      sendingVideo: true,
      /** Whether we last told them we want theirs. */
      wantsOurVideo: undefined,
    };
    this.#peers.set(peerId, peer);

    // Exactly one side builds the m-lines.
    //
    // If both peers create transceivers and both offer, the collision does
    // not merge: it resolves into two independent sets, and you end up with
    // six half-duplex m-lines (three sendonly plus three recvonly) instead of
    // three sendrecv ones. Media still flows, but every slot is negotiated
    // twice and the transceiver identities no longer line up across the pair.
    //
    // So the impolite peer owns the offer and creates everything; the polite
    // peer creates nothing and adopts the m-lines it is offered. That also
    // removes glare entirely, which makes connecting one round trip faster.
    if (!peer.polite) {
      // Order matters and must not change: audio, camera, screen.
      peer.tx.audio = pc.addTransceiver("audio", { direction: "sendrecv" });
      peer.tx.camera = pc.addTransceiver("video", { direction: "sendrecv" });
      peer.tx.screen = pc.addTransceiver("video", { direction: "sendrecv" });

      preferOpus(peer.tx.audio);
      preferVideoCodec(peer.tx.camera);
      preferVideoCodec(peer.tx.screen);

      peer.channel = pc.createDataChannel("chat", { ordered: true });
      this.#wireChannel(peer, peer.channel);
    }
    pc.addEventListener("datachannel", (event) => {
      peer.channel = event.channel;
      this.#wireChannel(peer, event.channel);
    });

    this.#wireConnection(peer);

    // The polite peer waits to be offered to. If that offer never arrives --
    // the other side crashed between joining and negotiating, or its frame
    // was lost -- it would wait forever. Take over after a grace period.
    if (peer.polite) {
      peer.rescue = setTimeout(() => {
        if (!this.#peers.has(peerId) || peer.pc.remoteDescription) return;
        console.warn("no offer from", peerId, "- taking over negotiation");
        peer.tx.audio = pc.addTransceiver("audio", { direction: "sendrecv" });
        peer.tx.camera = pc.addTransceiver("video", { direction: "sendrecv" });
        peer.tx.screen = pc.addTransceiver("video", { direction: "sendrecv" });
        preferOpus(peer.tx.audio);
        preferVideoCodec(peer.tx.camera);
        preferVideoCodec(peer.tx.screen);
        for (const kind of ["mic", "camera", "screen"]) {
          if (this.#local[kind]) void this.#applyTrack(peer, kind, this.#local[kind]);
        }
      }, 6000);
    }

    // Attach whatever we are already capturing.
    for (const kind of ["mic", "camera", "screen"]) {
      const track = this.#local[kind];
      if (track) void this.#applyTrack(peer, kind, track);
    }

    return peer;
  }

  removePeer(peerId) {
    const peer = this.#peers.get(peerId);
    if (!peer) return;
    this.#peers.delete(peerId);
    if (peer.rescue) clearTimeout(peer.rescue);

    try {
      peer.channel?.close();
    } catch {
      /* already closed */
    }
    try {
      peer.pc.close();
    } catch {
      /* already closed */
    }
    this.#emit("peer-closed", { peerId });
  }

  #wireConnection(peer) {
    const { pc, id } = peer;

    pc.addEventListener("negotiationneeded", async () => {
      try {
        peer.makingOffer = true;
        // No argument: the browser picks offer or answer correctly, which is
        // what makes rollback safe.
        await pc.setLocalDescription();
        this.#send(id, { kind: "desc", desc: this.#tune(pc.localDescription) });
      } catch (err) {
        console.warn("negotiation failed", err);
      } finally {
        peer.makingOffer = false;
      }
    });

    pc.addEventListener("icecandidate", ({ candidate }) => {
      // The null candidate marks end-of-gathering; peers infer that anyway.
      if (candidate) this.#send(id, { kind: "ice", candidate });
    });

    pc.addEventListener("track", (event) => {
      const slot = this.#slotFor(peer, event.transceiver, event.track.kind);
      if (!slot) return;

      // addTransceiver + replaceTrack means event.streams is usually empty,
      // so build a stream per slot ourselves.
      const stream = new MediaStream([event.track]);
      peer.streams[slot] = stream;

      event.track.addEventListener("ended", () => {
        if (peer.streams[slot] === stream) delete peer.streams[slot];
        this.#emit("track-ended", { peerId: id, slot });
      });
      // Fires when the sender does replaceTrack(null) -- i.e. camera off.
      event.track.addEventListener("mute", () =>
        this.#emit("track-muted", { peerId: id, slot, muted: true }),
      );
      event.track.addEventListener("unmute", () =>
        this.#emit("track-muted", { peerId: id, slot, muted: false }),
      );

      this.#emit("track", { peerId: id, slot, stream, track: event.track });
    });

    pc.addEventListener("connectionstatechange", () => {
      this.#emit("connection", { peerId: id, state: pc.connectionState });

      // "failed" means ICE gave up entirely. A restart re-gathers candidates
      // and often recovers a network that changed underneath us (Wi-Fi to
      // cellular), which on a phone is routine.
      if (pc.connectionState === "failed") this.#restartIce(peer);
    });

    pc.addEventListener("iceconnectionstatechange", () => {
      if (pc.iceConnectionState === "disconnected") {
        // Give it a moment: "disconnected" is frequently transient.
        setTimeout(() => {
          if (pc.iceConnectionState === "disconnected") this.#restartIce(peer);
        }, 3000);
      }
    });
  }

  #restartIce(peer) {
    if (this.#closed || !this.#peers.has(peer.id)) return;
    // Only one side should drive the restart, or they collide again.
    if (peer.polite) return;
    try {
      peer.pc.restartIce();
    } catch {
      /* unsupported; the connection will be rebuilt on rejoin */
    }
  }

  /**
   * Identify which of the three fixed slots a received track belongs to.
   *
   * The transceiver object is the reliable answer: on the answering side the
   * browser associates our pre-created transceivers with the offer's m-lines
   * in order, so the references match. Index order is kept as a fallback for
   * implementations that hand back a fresh transceiver.
   */
  #slotFor(peer, transceiver, kind) {
    for (const slot of SLOTS) {
      if (peer.tx[slot] === transceiver) return slot;
    }
    if (kind === "audio") return "audio";

    const videoTx = peer.pc.getTransceivers().filter((t) => {
      const c = t.receiver?.track?.kind ?? t.sender?.track?.kind;
      return c === "video";
    });
    const index = videoTx.indexOf(transceiver);
    return index <= 0 ? "camera" : "screen";
  }

  #tune(description) {
    if (!description) return description;
    // toJSON so we can hand a plain object to the relay.
    return { type: description.type, sdp: tuneOpus(description.sdp) };
  }

  // --- Signalling -----------------------------------------------------------

  /** Feed an inbound relay payload from `fromId`. */
  async handleSignal(fromId, payload) {
    if (this.#closed || !payload) return;

    let peer = this.#peers.get(fromId);
    // A peer we have not been told about yet (join notifications can race
    // an incoming offer) -- create the connection now.
    peer ??= this.addPeer(fromId);
    if (!peer) return;

    const { pc } = peer;

    try {
      if (payload.kind === "video-request") {
        await this.#handleVideoRequest(peer, payload.want === true);
        return;
      }

      if (payload.kind === "desc" && payload.desc) {
        const description = payload.desc;
        const isOffer = description.type === "offer";

        // Perfect negotiation, exactly as specified: a collision is when an
        // offer arrives while we are mid-offer or otherwise unstable.
        const collision = isOffer && (peer.makingOffer || pc.signalingState !== "stable");
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;

        if (collision) {
          // Polite side yields: implicit rollback via setRemoteDescription.
          await pc.setRemoteDescription(description);
        } else {
          await pc.setRemoteDescription(description);
        }

        this.#captureFingerprint(peer, description.sdp);
        await this.#drainCandidates(peer);

        if (isOffer) {
          // Claim the offered m-lines before building the answer, so the
          // answer already says sendrecv and no second round trip is needed.
          await this.#adoptTransceivers(peer);

          await pc.setLocalDescription();
          this.#send(fromId, { kind: "desc", desc: this.#tune(pc.localDescription) });
        }
        return;
      }

      if (payload.kind === "ice" && payload.candidate) {
        // Candidates can arrive before the remote description exists; buffer
        // them rather than throwing them away.
        if (!pc.remoteDescription) {
          peer.pendingCandidates.push(payload.candidate);
          return;
        }
        try {
          await pc.addIceCandidate(payload.candidate);
        } catch (err) {
          // Expected when we deliberately ignored the offer these belong to.
          if (!peer.ignoreOffer) console.warn("addIceCandidate", err);
        }
      }
    } catch (err) {
      console.warn("signal handling failed", err);
    }
  }

  /**
   * Polite side: take ownership of the transceivers the offer just created.
   *
   * setRemoteDescription instantiates one transceiver per offered m-line, in
   * m-line order, each defaulting to recvonly. Mapping them to our three
   * slots by kind-and-order gives both peers the same view, and flipping them
   * to sendrecv *before* setLocalDescription means the answer advertises
   * two-way media immediately rather than triggering a renegotiation.
   */
  async #adoptTransceivers(peer) {
    // An offer arrived, so the takeover timer is no longer needed.
    if (peer.rescue) {
      clearTimeout(peer.rescue);
      peer.rescue = null;
    }
    if (peer.tx.audio) return; // already owned (we were the offerer)

    const kindOf = (t) => t.receiver?.track?.kind ?? t.sender?.track?.kind ?? "";
    const all = peer.pc.getTransceivers();
    const audio = all.filter((t) => kindOf(t) === "audio");
    const video = all.filter((t) => kindOf(t) === "video");

    // A peer that offered a different shape is not one of ours; leave the
    // browser's defaults alone rather than mis-assigning slots.
    if (audio.length < 1 || video.length < 2) return;

    peer.tx.audio = audio[0];
    peer.tx.camera = video[0];
    peer.tx.screen = video[1];

    preferOpus(peer.tx.audio);
    preferVideoCodec(peer.tx.camera);
    preferVideoCodec(peer.tx.screen);

    for (const slot of SLOTS) {
      const transceiver = peer.tx[slot];
      try {
        transceiver.direction = "sendrecv";
      } catch {
        /* already stopped */
      }
    }

    await Promise.all([
      this.#applyTrack(peer, "mic", this.#local.mic),
      this.#applyTrack(peer, "camera", this.#local.camera),
      this.#applyTrack(peer, "screen", this.#local.screen),
    ]);
  }

  async #drainCandidates(peer) {
    const queued = peer.pendingCandidates.splice(0);
    for (const candidate of queued) {
      try {
        await peer.pc.addIceCandidate(candidate);
      } catch {
        /* stale candidate from a rolled-back description */
      }
    }
  }

  /**
   * Record the peer's DTLS certificate fingerprint from its SDP.
   *
   * This is the value that gets verified during the DTLS handshake, so
   * folding it into the safety number means a server that rewrote SDP to
   * insert itself into the media path would change what users read aloud.
   */
  #captureFingerprint(peer, sdp) {
    const match = /^a=fingerprint:\S+\s+(\S+)/m.exec(sdp ?? "");
    if (!match) return;
    const fp = match[1].toLowerCase();
    if (fp === peer.fingerprint) return;

    peer.fingerprint = fp;
    this.#emit("fingerprint", { peerId: peer.id, fingerprint: fp });
  }

  // --- Data channel ---------------------------------------------------------

  #wireChannel(peer, channel) {
    channel.binaryType = "arraybuffer";

    channel.addEventListener("open", () => this.#emit("data-open", { peerId: peer.id }));
    channel.addEventListener("close", () => this.#emit("data-close", { peerId: peer.id }));
    channel.addEventListener("message", (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      this.#emit("data", { peerId: peer.id, data });
    });
  }

  /** True if it went out over the peer-to-peer channel. */
  sendData(peerId, payload) {
    const channel = this.#peers.get(peerId)?.channel;
    if (channel?.readyState !== "open") return false;
    try {
      channel.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  /** Returns the peers that could not be reached directly. */
  broadcastData(payload) {
    const failed = [];
    for (const peerId of this.#peers.keys()) {
      if (!this.sendData(peerId, payload)) failed.push(peerId);
    }
    return failed;
  }

  // --- Stats ----------------------------------------------------------------

  /**
   * Poll connection quality. 3s is a deliberate compromise: often enough to
   * notice a call degrading, rare enough that getStats does not itself become
   * a battery cost on a phone.
   */
  #startStats() {
    this.#statsTimer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      for (const peer of this.#peers.values()) void this.#collect(peer);
    }, 3000);
  }

  async #collect(peer) {
    let report;
    try {
      report = await peer.pc.getStats();
    } catch {
      return;
    }

    let rtt = null;
    let loss = null;
    let kbps = null;
    let relayed = false;

    report.forEach((stat) => {
      if (stat.type === "candidate-pair" && stat.state === "succeeded" && stat.nominated) {
        if (stat.currentRoundTripTime != null) rtt = Math.round(stat.currentRoundTripTime * 1000);
      }
      if (stat.type === "local-candidate" && stat.candidateType === "relay") relayed = true;
      if (stat.type === "inbound-rtp" && stat.kind === "audio") {
        const received = stat.packetsReceived ?? 0;
        const lost = stat.packetsLost ?? 0;
        if (received + lost > 0) loss = Math.round((lost / (received + lost)) * 100);
      }
      if (stat.type === "outbound-rtp" && stat.kind === "video") {
        const prev = peer.lastVideo;
        if (prev && stat.timestamp > prev.timestamp) {
          const bits = (stat.bytesSent - prev.bytesSent) * 8;
          kbps = Math.round(bits / ((stat.timestamp - prev.timestamp) / 1000) / 1000);
        }
        peer.lastVideo = { bytesSent: stat.bytesSent, timestamp: stat.timestamp };
      }
    });

    this.#emit("quality", { peerId: peer.id, rtt, loss, kbps, relayed });
  }

  // --- Teardown -------------------------------------------------------------

  close() {
    this.#closed = true;
    if (this.#statsTimer) clearInterval(this.#statsTimer);
    for (const peerId of [...this.#peers.keys()]) this.removePeer(peerId);
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
