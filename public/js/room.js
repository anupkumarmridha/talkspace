/**
 * Call screen orchestration.
 *
 * Owns the lifecycle: pre-join -> signalling -> mesh -> teardown, and keeps
 * the DOM in step with three independent sources of truth (presence from the
 * relay, media from the peer connections, and voice activity from the audio
 * thread) without letting any one of them block the others.
 */

import { $, $$, api, createWakeLock, el, haptic, initials, rafThrottle, shareLink, store, toast } from "./util.js";
import { Signal, reconnectOnResume } from "./signal.js";
import { Mesh } from "./mesh.js";
import { Sheet } from "./sheet.js";
import { EventChain, createIdentity, decryptFrom, deriveSharedKey, encryptFor, safetyNumber } from "./e2ee.js";
import { createVoiceDetector } from "./vad.js";
import {
  MAX_VIDEO_SUBSCRIPTIONS,
  RemoteAudio,
  audioContext,
  listAudioOutputs,
  supportsOutputSelection,
  getCamera,
  getMic,
  getScreen,
  hasMultipleCameras,
  resumeAudio,
} from "./media.js";

const NAME_KEY = "talkspace:name";
const OUTPUT_KEY = "talkspace:output";
const SINK_KEY = "talkspace:sink";

const roomId = decodeURIComponent(location.pathname.replace(/^\/r\//, "")).toLowerCase();

const state = {
  self: null,
  room: null,
  identity: null,
  chain: new EventChain(),
  signal: null,
  mesh: null,
  /** peerId -> { info, key, seqOut, tiles, audio, detector, fingerprint } */
  peers: new Map(),
  local: { mic: null, camera: null, screen: null },
  facing: "user",
  unread: 0,
  pinned: null,
  joined: false,
  hostId: "",
  waitingDismissed: false,
  /** Peers whose camera we are currently asking for. */
  subscribed: new Set(),
};

const isHost = () => state.self?.id && state.self.id === state.hostId;

const wakeLock = createWakeLock();

// ============================================================================
// Pre-join
// ============================================================================

const prejoin = $("#prejoin");
const preview = $("#preview");
const nameInput = $("#prejoin-name");

let wantMic = true;
let wantCam = false;

nameInput.value = store.get(NAME_KEY, "") ?? "";

$("#pre-mic").addEventListener("click", () => {
  wantMic = !wantMic;
  paintToggle($("#pre-mic"), wantMic, "i-mic", "i-mic-off");
  haptic();
});

$("#pre-cam").addEventListener("click", async () => {
  wantCam = !wantCam;
  paintToggle($("#pre-cam"), wantCam, "i-cam", "i-cam-off");
  haptic();
  await refreshPreview();
});

function paintToggle(button, on, iconOn, iconOff) {
  button.dataset.on = String(on);
  button.setAttribute("aria-pressed", String(on));
  button.querySelector("use").setAttribute("href", `#${on ? iconOn : iconOff}`);
}

async function refreshPreview() {
  const avatar = $("#preview-avatar");

  if (!wantCam) {
    stopStream(preview.srcObject);
    preview.srcObject = null;
    $("#preview-initials").textContent = initials(nameInput.value || "?");
    avatar.hidden = false;
    return;
  }

  try {
    const stream = await getCamera(state.facing);
    stopStream(preview.srcObject);
    preview.srcObject = stream;
    avatar.hidden = true;
  } catch {
    wantCam = false;
    paintToggle($("#pre-cam"), false, "i-cam", "i-cam-off");
    avatar.hidden = false;
    toast("Camera unavailable", "error");
  }
}

function stopStream(stream) {
  stream?.getTracks?.().forEach((t) => t.stop());
}

// Show the room's name and whether a passcode is needed before joining.
api(`/api/rooms`)
  .then(({ rooms }) => {
    const found = rooms.find((r) => r.id === roomId);
    if (found) $("#prejoin-hint").textContent = `Joining “${found.name}”`;
  })
  .catch(() => {});

refreshPreview();

$("#join-btn").addEventListener("click", join);
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") join();
});

// ============================================================================
// Join
// ============================================================================

async function join() {
  const button = $("#join-btn");
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.focus();
    toast("Add your name first", "error");
    return;
  }
  store.set(NAME_KEY, name);

  button.disabled = true;
  button.textContent = "Connecting…";

  try {
    // The click is our one guaranteed user gesture: unlock audio playback now
    // or every remote stream will silently refuse to start.
    await resumeAudio();

    // One identity and one DTLS certificate for the whole session. The
    // certificate is shared by every peer connection so we present a single
    // fingerprint to the room -- that is what makes a room-wide safety number
    // possible at all.
    const [identity, certificate] = await Promise.all([
      createIdentity(),
      // Not fatal if unavailable: without it each connection uses its own
      // certificate, so we simply cannot contribute our own fingerprint to
      // the safety number. Everything else, including the media encryption
      // itself, is unaffected.
      RTCPeerConnection.generateCertificate({ name: "ECDSA", namedCurve: "P-256" }).catch(
        () => null,
      ),
    ]);
    state.identity = identity;
    state.certificate = certificate;
    state.dtls = certificate ? pickSha256(certificate) : "";

    const [{ token, room }, ice] = await Promise.all([
      api("/api/join", {
        method: "POST",
        body: JSON.stringify({
          roomId,
          name,
          passcode: $("#prejoin-passcode").value || undefined,
        }),
      }),
      api("/api/ice"),
    ]);

    state.room = room;

    state.hasTurn = Boolean(ice.hasTurn);
    state.turnSource = ice.turnSource ?? "none";
    if (!state.hasTurn) {
      // Worth saying plainly: without a relay, a minority of networks simply
      // cannot establish a direct path.
      console.info("No TURN server configured; peers behind symmetric NAT may fail to connect.");
    }

    // Held until `welcome`: the mesh cannot be built before the server has
    // assigned our peer id, because politeness is derived by comparing ids.
    state.ice = ice.iceServers;

    await startLocalMedia();
    openSignal(token);

    prejoin.hidden = true;
    $("#call").hidden = false;
    state.joined = true;
    wakeLock.enable();
  } catch (err) {
    button.disabled = false;
    button.textContent = "Join call";

    if (err.status === 403) {
      $("#prejoin-passcode-wrap").hidden = false;
      $("#prejoin-passcode").focus();
      toast("This room needs a passcode", "error");
      return;
    }
    if (err.status === 409) {
      toast("This room is full", "error");
      return;
    }
    toast("Could not join the call", "error");
  }
}

async function startLocalMedia() {
  if (wantMic) {
    try {
      const stream = await getMic();
      state.local.mic = stream.getAudioTracks()[0];
    } catch {
      wantMic = false;
      toast("Microphone unavailable — you can still listen", "error");
    }
  }

  // Reuse the preview stream so the camera does not visibly restart.
  if (wantCam && preview.srcObject) {
    state.local.camera = preview.srcObject.getVideoTracks()[0];
    preview.srcObject = null; // ownership moves to the call
  }

  paintToggle($("#mic-btn"), Boolean(state.local.mic) && wantMic, "i-mic", "i-mic-off");
  paintToggle($("#cam-btn"), Boolean(state.local.camera), "i-cam", "i-cam-off");

  if (await hasMultipleCameras()) $("#flip-btn").hidden = false;
}

function openSignal(firstToken) {
  const scheme = location.protocol === "https:" ? "wss" : "ws";

  // Consumed once, then every later attempt mints a fresh grant. The token is
  // only valid for two minutes, so a socket URL captured at join time is
  // unusable by the time a real-world reconnect happens.
  let pending = firstToken;

  async function socketUrl() {
    let token = pending;
    pending = null;

    if (!token) {
      try {
        ({ token } = await api("/api/join", {
          method: "POST",
          body: JSON.stringify({
            roomId,
            name: state.self?.name ?? nameInput.value.trim(),
            passcode: $("#prejoin-passcode").value || undefined,
          }),
        }));
      } catch (err) {
        // 403/409/410 mean we are no longer welcome; retrying cannot help.
        if ([403, 409, 410].includes(err.status)) {
          err.terminal = true;
          err.code = err.status === 409 ? 4001 : 4002;
        }
        throw err;
      }
    }

    return `${scheme}://${location.host}/ws/room/${encodeURIComponent(roomId)}?token=${encodeURIComponent(
      token,
    )}&pub=${encodeURIComponent(state.identity.pub)}`;
  }

  const signal = new Signal(socketUrl);
  state.signal = signal;

  signal.addEventListener("welcome", (e) => onWelcome(e.detail));
  signal.addEventListener("peer-joined", (e) => onPeerJoined(e.detail.peer));
  signal.addEventListener("peer-left", (e) => onPeerLeft(e.detail));
  signal.addEventListener("signal", (e) => onSignalPayload(e.detail));
  signal.addEventListener("state", (e) => onPeerState(e.detail));

  signal.addEventListener("host", (e) => {
    state.hostId = e.detail.id;
    if (isHost()) toast("You are now the host");
    renderPeople();
  });

  // Host mute and unmute are both enforced: applied on receipt, no prompt.
  // They are always announced, so the microphone never changes state without
  // the person being told, and they can override it immediately.
  signal.addEventListener("force-mute", (e) => {
    setMicEnabled(false);
    toast(`${e.detail.by} muted you`);
    haptic(20);
  });

  signal.addEventListener("force-unmute", (e) => {
    if (!state.local.mic) {
      toast(`${e.detail.by} asked you to unmute — no microphone available`, "error", 6000);
      return;
    }
    setMicEnabled(true);
    toast(`${e.detail.by} unmuted you — your mic is live`, "error", 6000);
    haptic([30, 60, 30]);
  });

  signal.addEventListener("error", (e) => {
    const { code, message } = e.detail;

    // Act on the application frame, not the close code. A WebSocket close
    // handshake is best-effort -- it can stall behind a proxy or when the
    // remote end goes away mid-handshake -- so the frame is the contract and
    // the close code below is only a backstop.
    if (code === "ended") return leave("The meeting has ended");
    if (code === "removed") return leave("The host removed you from the call");

    toast(message || code, "error");
  });

  signal.addEventListener("open", () => setConnStatus(""));
  signal.addEventListener("reconnecting", () => setConnStatus("reconnecting…"));
  signal.addEventListener("close", (e) => {
    const { code } = e.detail;
    if (code === 4001) return leave("This room is full");
    if (code === 4002) return leave("Your invite expired");
    if (code === 4005) return leave("The host removed you from the call");
    if (code === 4006) return leave("The meeting has ended");
    if (code >= 4000 && code < 5000) return leave("Disconnected");
    setConnStatus("offline");
  });

  reconnectOnResume(signal);
  signal.connect();
}

/** The sha-256 entry from an RTCCertificate, lower-cased to match SDP. */
function pickSha256(certificate) {
  const prints = certificate.getFingerprints?.() ?? [];
  const sha256 = prints.find((f) => f.algorithm === "sha-256") ?? prints[0];
  return (sha256?.value ?? "").toLowerCase();
}

function setConnStatus(text) {
  $("#conn-status").textContent = text;
}

// ============================================================================
// Presence
// ============================================================================

async function onWelcome({ self, room, peers, hostId }) {
  state.self = self;
  state.room = room;
  state.hostId = hostId ?? "";

  // A reconnect replays `welcome`. Tear the old mesh down rather than
  // stacking a second set of peer connections on top of it.
  state.mesh?.close();

  state.mesh = new Mesh({
    selfId: self.id,
    iceServers: state.ice,
    certificate: state.certificate,
    send: (to, payload) => state.signal?.send({ t: "signal", to, payload }),
  });
  wireMesh(state.mesh);

  await state.mesh.setLocalTrack("mic", state.local.mic);
  await state.mesh.setLocalTrack("camera", state.local.camera);

  $("#room-title").textContent = room.name;
  document.title = `${room.name} — TalkSpace`;

  // Discard any peer state left over from a previous connection, so a
  // reconnect rebuilds cleanly instead of leaking tiles and detectors.
  for (const [peerId, record] of state.peers) {
    record.detector?.destroy();
    record.audio?.destroy();
    removeTile(peerId);
    removeTile(`${peerId}:screen`);
  }
  state.peers.clear();
  state.pinned = null;

  ensureSelfTile();

  // Register peers first. Starting the voice detector pulls in the wasm
  // module and spins up an AudioWorklet, and awaiting that here would leave
  // inbound offers arriving with no peer record to attach them to.
  for (const peer of peers) await addPeer(peer, false);

  if (!state.selfDetector) void startSelfDetector();

  await state.chain.append("self-joined", { id: self.id, pub: state.identity.pub });
  refreshAll();
  broadcastState();
}

async function onPeerJoined(peer) {
  await addPeer(peer, true);
  refreshAll();
  // Re-run the video ladder: one more peer means a smaller slice of uplink.
  await state.mesh.rebalance();
  systemMessage(`${peer.name} joined`);
}

async function addPeer(info, isNew) {
  if (info.id === state.self?.id || state.peers.has(info.id)) return;

  const record = {
    info,
    key: null,
    seqOut: 0,
    seqIn: -1,
    seen: new Set(),
    audio: null,
    detector: null,
    screenStream: null,
    screenShown: false,
    fingerprint: "",
    quality: null,
  };
  state.peers.set(info.id, record);

  ensureTile(info.id, info.name);
  state.mesh.addPeer(info.id);

  // The connection may already be underway: signalling from this peer can
  // arrive before we were told they joined, in which case the fingerprint
  // event fired with nowhere to land. Pull it rather than wait for another.
  record.fingerprint = state.mesh.getFingerprint(info.id);

  await state.chain.append("peer-joined", { id: info.id, pub: info.pub });

  // Derive the chat key in the background: a slow curve operation must not
  // delay the media handshake.
  if (info.pub) {
    deriveSharedKey(state.identity, info.pub)
      .then((key) => {
        record.key = key;
      })
      .catch(() => {
        /* malformed key: that peer falls back to peer-to-peer chat only */
      });
  }

  if (isNew) haptic(6);
  void refreshSafety();
}

async function onPeerLeft({ id, name }) {
  const record = state.peers.get(id);
  if (!record) return;

  record.detector?.destroy();
  record.audio?.destroy();
  state.peers.delete(id);
  state.mesh.removePeer(id);

  removeTile(id);
  removeTile(`${id}:screen`);
  if (state.pinned === id || state.pinned === `${id}:screen`) state.pinned = null;

  await state.chain.append("peer-left", { id });
  systemMessage(`${name} left`);
  refreshAll();
  await state.mesh.rebalance();
  void refreshSafety();
}

function onPeerState({ id, state: peerState }) {
  const record = state.peers.get(id);
  if (!record) return;
  record.info.state = peerState;
  updateTileChrome(id);
  syncScreenTile(id);
  renderPeople();
}

/**
 * Show a peer's screen tile exactly when they say they are sharing and we
 * actually have their stream. Both conditions can arrive in either order.
 */
function syncScreenTile(peerId) {
  const record = state.peers.get(peerId);
  if (!record) return;

  const tileId = `${peerId}:screen`;
  const sharing = record.info.state?.screen === true && Boolean(record.screenStream);

  if (sharing) {
    const tile = ensureTile(tileId, `${record.info.name} — screen`, { screen: true });
    tile.video.srcObject = record.screenStream;

    // Auto-pin once, on the transition into sharing. Doing it on every
    // presence update would yank the view back each time anyone muted.
    if (!record.screenShown) {
      record.screenShown = true;
      state.pinned = tileId;
    }
  } else if (record.screenShown || tiles.has(tileId)) {
    record.screenShown = false;
    removeTile(tileId);
    if (state.pinned === tileId) state.pinned = null;
  } else {
    return; // nothing to do; avoid a pointless relayout
  }

  refreshAll();
}

/** Route an inbound relay payload: WebRTC signalling, or fallback chat. */
async function onSignalPayload({ from, payload }) {
  if (payload?.kind === "chat") {
    await receiveFallbackChat(from, payload);
    return;
  }
  // Signalling can arrive in the gap between the socket opening and
  // `welcome` being processed; the sender will retry via ICE restart.
  await state.mesh?.handleSignal(from, payload);
}

// ============================================================================
// Mesh events
// ============================================================================

function wireMesh(mesh) {
  mesh.addEventListener("track", ({ detail }) => onRemoteTrack(detail));

  mesh.addEventListener("track-muted", ({ detail }) => updateTileChrome(detail.peerId));

  mesh.addEventListener("track-ended", ({ detail }) => {
    // Safety net for a peer that vanished without a closing presence update.
    if (detail.slot !== "screen") return;
    const record = state.peers.get(detail.peerId);
    if (record) record.screenStream = null;
    syncScreenTile(detail.peerId);
  });

  mesh.addEventListener("connection", ({ detail }) => {
    const tile = tiles.get(detail.peerId);
    if (tile) {
      tile.root.dataset.connection = detail.state;
      tile.spinner.hidden = detail.state === "connected";
    }

    // A failed peer used to be a silent black tile. On a network that blocks
    // direct UDP the call simply never starts, and without saying why the
    // only signal is nothing happening -- the worst kind of failure.
    if (detail.state === "failed") {
      const record = state.peers.get(detail.peerId);
      const who = record?.info.name ?? "A participant";

      // Be specific about why, because each case has a different remedy.
      let why = "";
      if (!state.hasTurn) why = " This network needs a TURN relay.";
      else if (state.turnSource === "community") {
        // The free fallback is UDP-only, so it cannot rescue a network that
        // blocks UDP outright -- that needs TURN over TCP/443.
        why = " If this network blocks UDP, a TCP relay is needed.";
      }

      toast(`Could not connect to ${who}.${why || " Retrying."}`, "error", 7000);
    }
  });

  mesh.addEventListener("fingerprint", async ({ detail }) => {
    // No record yet means the peer record is still being built; addPeer
    // pulls the value from the mesh, so nothing is lost by returning here.
    const record = state.peers.get(detail.peerId);
    if (!record) return;

    // A peer's DTLS fingerprint is fixed for their session. Seeing it change
    // means either a reconnect with a new identity or someone re-keying the
    // media path underneath us -- worth saying out loud either way. This is
    // the payoff of keeping an append-only log rather than just current state.
    const previous = record.fingerprint;
    if (previous && previous !== detail.fingerprint) {
      toast(`${record.info.name}'s encryption key changed — re-verify`, "error", 8000);
      await state.chain.append("dtls-changed", {
        id: detail.peerId,
        from: previous,
        to: detail.fingerprint,
      });
    }

    record.fingerprint = detail.fingerprint;
    await state.chain.append("dtls", { id: detail.peerId, fp: detail.fingerprint });
    void refreshSafety();
  });

  mesh.addEventListener("quality", ({ detail }) => {
    const record = state.peers.get(detail.peerId);
    if (record) record.quality = detail;
    renderPeople();
  });

  mesh.addEventListener("data", ({ detail }) => onDataChannelMessage(detail.peerId, detail.data));
  mesh.addEventListener("data-open", () => updateChatTransport());
  mesh.addEventListener("data-close", () => updateChatTransport());
}

async function onRemoteTrack({ peerId, slot, stream, track }) {
  const record = state.peers.get(peerId);
  if (!record) return;

  if (slot === "audio") {
    record.audio?.destroy();
    record.audio = new RemoteAudio(stream, audioContext());
    record.audio.setMode(state.outputMode);
    void record.audio.setSink(state.outputSink);

    const played = await record.audio.play();
    if (!played) promptForAudio();

    // Analyse the received audio locally rather than trusting a "speaking"
    // flag over the wire: accurate, and it keeps working while signalling is
    // reconnecting.
    record.detector?.destroy();
    record.detector = await createVoiceDetector(stream, ({ speaking }) => {
      setSpeaking(peerId, speaking);

      // Remember when each peer last spoke. Video subscriptions follow the
      // conversation, so the people actually talking are the ones whose
      // cameras get the bandwidth.
      if (!speaking) return;
      record.lastSpoke = Date.now();
      scheduleSubscriptionRefresh();
    }).catch(() => null);
    return;
  }

  if (slot === "screen") {
    // The screen transceiver exists on every connection from the start, so
    // ontrack fires for it whether or not the peer is actually sharing. Track
    // mute state looked like the signal for that but is not reliable enough
    // to hang UI on -- it is timing-dependent and differs across browsers.
    //
    // The peer already tells us, explicitly, over the presence channel. Use
    // that: stash the stream and let syncScreenTile decide what is visible.
    record.screenStream = stream;
    syncScreenTile(peerId);
    return;
  }

  const tile = ensureTile(peerId, record.info.name);
  tile.video.srcObject = stream;
  updateTileChrome(peerId);
}

/**
 * Autoplay was blocked. Retry from the next real interaction rather than
 * leaving the user in a silent call wondering why.
 */
let audioPromptShown = false;

function promptForAudio() {
  if (audioPromptShown) return;
  audioPromptShown = true;
  toast("Tap anywhere to enable sound");

  const retry = async () => {
    await resumeAudio();
    for (const record of state.peers.values()) await record.audio?.play();
    document.removeEventListener("pointerdown", retry);
    audioPromptShown = false;
  };
  document.addEventListener("pointerdown", retry, { once: true });
}

// ============================================================================
// Tiles
// ============================================================================

const grid = $("#grid");
/** tileId -> { root, video, avatar, initials, label, name, spinner } */
const tiles = new Map();

function ensureSelfTile() {
  const tile = ensureTile("self", `${state.self.name} (you)`, { self: true });
  if (state.local.camera) {
    tile.video.srcObject = new MediaStream([state.local.camera]);
  }
  tile.video.muted = true; // never monitor your own mic
  updateSelfChrome();
}

function ensureTile(id, name, { self = false, screen = false } = {}) {
  const existing = tiles.get(id);
  if (existing) return existing;

  const root = el("div", {
    class: `tile${self ? " tile--self" : ""}${screen ? " tile--screen" : ""}`,
    "data-tile": id,
  });

  const video = el("video", { autoplay: "", playsinline: "" });
  video.muted = self;
  // Mirror your own camera (but never a screen share).
  if (self && !screen) video.dataset.mirror = "true";

  const avatar = el("div", { class: "tile__avatar" });
  const initialsNode = el("div", { class: "tile__initials" }, initials(name));
  avatar.append(initialsNode);

  const label = el("div", { class: "tile__label" });
  const micIcon = svgIcon("i-mic");
  const nameNode = el("span", {}, name);
  label.append(micIcon, nameNode);

  const spinner = el("div", { class: "tile__spinner" });
  spinner.hidden = self;

  root.append(video, avatar, label, spinner);

  // Tapping a tile opens its actions, rather than pinning outright. Pinning
  // is one of several things you might want, and a tap that silently
  // rearranges the whole grid is a surprising default.
  root.addEventListener("click", () => openTileActions(id));

  grid.append(root);
  const record = { root, video, avatar, initials: initialsNode, label, name: nameNode, micIcon, spinner };
  tiles.set(id, record);
  refreshGridCount();
  return record;
}

function removeTile(id) {
  const tile = tiles.get(id);
  if (!tile) return;
  tile.video.srcObject = null;
  tile.root.remove();
  tiles.delete(id);
  refreshGridCount();
}

function svgIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon icon--sm");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${name}`);
  svg.append(use);
  return svg;
}

/**
 * Per-participant actions, opened by tapping their tile.
 *
 * The same actions live in the participants list; this is the direct route,
 * because on a phone the person you want to act on is the one you are
 * looking at.
 */
function openTileActions(tileId) {
  // A screen-share tile stands in for its owner.
  const peerId = tileId.replace(/:screen$/, "");
  const isSelf = peerId === "self";
  const record = isSelf ? null : state.peers.get(peerId);
  const name = isSelf ? "You" : (record?.info.name ?? "Participant");

  const body = $("#tile-sheet .sheet__body");
  body.textContent = "";
  $("#tile-sheet-title").textContent = name;

  const pinned = state.pinned === tileId;
  body.append(
    el(
      "button",
      {
        class: "btn btn--ghost btn--block",
        type: "button",
        onclick: () => {
          state.pinned = pinned ? null : tileId;
          haptic();
          refreshAll();
          sheets.tile.close();
        },
      },
      pinned ? "Unpin" : "Pin to full screen",
    ),
  );

  if (isHost() && !isSelf && record) {
    const muted = record.info.state?.mic === false;

    body.append(
      el(
        "button",
        {
          class: "btn btn--ghost btn--block",
          type: "button",
          onclick: () => {
            state.signal.send({
              t: "host",
              action: muted ? "unmute" : "mute",
              target: peerId,
            });
            toast(muted ? `Unmuted ${name}` : `Muted ${name}`);
            haptic();
            sheets.tile.close();
          },
        },
        muted ? `Unmute ${name}` : `Mute ${name}`,
      ),
    );

    body.append(
      el(
        "button",
        {
          class: "btn btn--danger btn--block",
          type: "button",
          onclick: () => {
            if (!confirm(`Remove ${name} from the call?`)) return;
            state.signal.send({ t: "host", action: "kick", target: peerId });
            haptic(20);
            sheets.tile.close();
          },
        },
        `Remove ${name}`,
      ),
    );
  }

  openSheet("tile");
}

function refreshGridCount() {
  grid.dataset.count = String(Math.min(8, tiles.size));
  grid.dataset.pinned = String(Boolean(state.pinned));

  for (const [id, tile] of tiles) {
    tile.root.classList.toggle("tile--pinned", state.pinned === id);
  }
}

/** Show or hide the avatar depending on whether real video is flowing. */
function updateTileChrome(peerId) {
  const record = state.peers.get(peerId);
  const tile = tiles.get(peerId);
  if (!record || !tile) return;

  const camOn = record.info.state?.cam === true;
  tile.avatar.hidden = camOn;
  tile.initials.textContent = initials(record.info.name);
  tile.name.textContent = record.info.name;

  const micOn = record.info.state?.mic !== false;
  tile.micIcon.querySelector("use").setAttribute("href", micOn ? "#i-mic" : "#i-mic-off");
  tile.micIcon.style.color = micOn ? "" : "var(--danger)";
}

function updateSelfChrome() {
  const tile = tiles.get("self");
  if (!tile || !state.self) return;

  const camOn = Boolean(state.local.camera);
  tile.avatar.hidden = camOn;
  tile.initials.textContent = initials(state.self.name);

  const micOn = Boolean(state.local.mic?.enabled);
  tile.micIcon.querySelector("use").setAttribute("href", micOn ? "#i-mic" : "#i-mic-off");
  tile.micIcon.style.color = micOn ? "" : "var(--danger)";
}

/** Batched: VAD fires ~46 times a second per peer. */
const setSpeaking = rafThrottle((peerId, speaking) => {
  const tile = tiles.get(peerId === "self" ? "self" : peerId);
  if (tile) tile.root.dataset.speaking = String(speaking);
});

async function startSelfDetector() {
  if (!state.local.mic) return;
  const stream = new MediaStream([state.local.mic]);
  state.selfDetector = await createVoiceDetector(stream, ({ speaking }) => {
    // Do not light up your own ring while muted.
    setSpeaking("self", speaking && state.local.mic.enabled);
  }).catch(() => null);
}

/**
 * Decide whose camera we actually want, and tell them.
 *
 * Priority: anyone sharing a screen, then the pinned tile, then whoever spoke
 * most recently. Everyone beyond the cap is shown as an avatar and their
 * upload is spared entirely.
 */
/**
 * Speech is bursty, and renegotiating who to subscribe to on every syllable
 * would thrash. Coalesce, and only act once the room is big enough for
 * subscriptions to matter at all.
 */
let subscriptionTimer = null;

function scheduleSubscriptionRefresh() {
  if (subscriptionTimer || state.peers.size <= MAX_VIDEO_SUBSCRIPTIONS) return;
  subscriptionTimer = setTimeout(() => {
    subscriptionTimer = null;
    refreshVideoSubscriptions();
  }, 2000);
}

function refreshVideoSubscriptions() {
  if (!state.mesh) return;

  const pinnedPeer = state.pinned ? state.pinned.replace(/:screen$/, "") : null;

  // Pinning is an explicit "show me only this", so honour it exactly.
  if (pinnedPeer && pinnedPeer !== "self" && state.peers.has(pinnedPeer)) {
    state.mesh.setVideoSubscriptions([pinnedPeer]);
    return;
  }

  const candidates = [...state.peers.values()]
    .map((r) => ({
      id: r.info.id,
      sharing: r.info.state?.screen === true,
      // Incumbency bonus. In a lively call several people are speaking within
      // any given window, so a pure most-recent-speaker ranking reshuffles
      // constantly -- and every reshuffle is a replaceTrack, which restarts
      // an encoder and produces a visible hitch. Treating whoever is already
      // on screen as slightly more recent means a newcomer has to be clearly
      // more active to displace them.
      lastSpoke: (r.lastSpoke ?? 0) + (state.subscribed.has(r.info.id) ? 8000 : 0),
      joinedAt: r.info.joinedAt,
    }))
    .sort((a, b) => {
      if (a.sharing !== b.sharing) return a.sharing ? -1 : 1;
      if (a.lastSpoke !== b.lastSpoke) return b.lastSpoke - a.lastSpoke;
      return a.joinedAt - b.joinedAt;
    });

  const chosen = candidates.slice(0, MAX_VIDEO_SUBSCRIPTIONS).map((c) => c.id);
  state.subscribed = new Set(chosen);
  state.mesh.setVideoSubscriptions(chosen);
}

function refreshAll() {
  refreshGridCount();
  refreshVideoSubscriptions();
  renderPeople();
  $("#people-count").textContent = String(state.peers.size + 1);

  // Being alone is a normal state, not an error: the room stays open and the
  // code keeps working, so whoever left can come straight back.
  const alone = state.peers.size === 0;
  $("#waiting").hidden = !alone || state.waitingDismissed;
  if (alone) $("#waiting-code").textContent = roomId;
  // Dismissing is per-spell-of-being-alone: if everyone leaves again later,
  // the prompt (and the room code) is worth showing once more.
  if (!alone) state.waitingDismissed = false;
}

// ============================================================================
// Participants
// ============================================================================

function renderPeople() {
  const list = $("#people");
  list.textContent = "";

  // Say plainly whether these controls are available, so their absence is
  // never mistaken for the feature being broken.
  const note = $("#people-note");
  if (isHost()) {
    note.textContent =
      state.peers.size === 0
        ? "You are the host. Mute and remove controls appear here once someone else joins."
        : "You are the host — you can mute or remove anyone here.";
  } else {
    note.textContent = "";
  }

  const rows = [
    {
      id: state.self?.id ?? "",
      isSelf: true,
      name: state.self?.name ?? "You",
      state: { mic: Boolean(state.local.mic?.enabled), cam: Boolean(state.local.camera) },
      quality: null,
    },
    ...[...state.peers.values()].map((r) => ({
      id: r.info.id,
      isSelf: false,
      name: r.info.name,
      state: r.info.state,
      quality: r.quality,
    })),
  ];

  for (const row of rows) {
    const item = el("li", { class: "person" });
    item.append(el("div", { class: "person__avatar" }, initials(row.name)));

    const nameWrap = el("div", { class: "u-grow" });
    nameWrap.append(
      el("div", { class: "person__name" }, row.isSelf ? `${row.name} (you)` : row.name),
    );
    if (row.quality?.rtt != null) {
      const bits = [`${row.quality.rtt} ms`];
      if (row.quality.loss) bits.push(`${row.quality.loss}% loss`);
      if (row.quality.relayed) bits.push("relayed");
      nameWrap.append(el("div", { class: "room__meta" }, bits.join(" · ")));
    }
    item.append(nameWrap);

    if (row.id === state.hostId) nameWrap.append(el("span", { class: "badge" }, "Host"));

    const icons = el("div", { class: "person__icons" });
    const mic = svgIcon(row.state?.mic === false ? "i-mic-off" : "i-mic");
    mic.setAttribute("class", "icon icon--md");
    if (row.state?.mic === false) mic.dataset.off = "true";
    icons.append(mic);
    item.append(icons);

    // Host controls. Hidden for everyone else purely as a courtesy -- the
    // Durable Object re-checks who is asking before it acts.
    if (isHost() && !row.isSelf) {
      const actions = el("div", { class: "person__actions" });

      const muted = row.state?.mic === false;
      actions.append(
        el(
          "button",
          {
            class: "chip",
            type: "button",
            "aria-label": `${muted ? "Unmute" : "Mute"} ${row.name}`,
            onclick: () => {
              state.signal.send({
                t: "host",
                action: muted ? "unmute" : "mute",
                target: row.id,
              });
              toast(muted ? `Unmuted ${row.name}` : `Muted ${row.name}`);
              haptic();
            },
          },
          muted ? "Unmute" : "Mute",
        ),
      );

      actions.append(
        el(
          "button",
          {
            class: "chip chip--danger",
            type: "button",
            "aria-label": `Remove ${row.name}`,
            onclick: () => {
              if (!confirm(`Remove ${row.name} from the call?`)) return;
              state.signal.send({ t: "host", action: "kick", target: row.id });
              haptic(20);
            },
          },
          "Remove",
        ),
      );

      item.append(actions);
    }

    list.append(item);
  }
}

// ============================================================================
// Controls
// ============================================================================

/** Single path for changing our own mic, whoever asked for it. */
function setMicEnabled(on) {
  if (!state.local.mic) return false;

  state.local.mic.enabled = on;
  paintToggle($("#mic-btn"), on, "i-mic", "i-mic-off");
  $("#mic-btn").setAttribute("aria-label", on ? "Mute microphone" : "Unmute microphone");
  updateSelfChrome();
  broadcastState();
  return true;
}

$("#mic-btn").addEventListener("click", () => {
  if (!state.local.mic) return void toast("No microphone available", "error");
  setMicEnabled(!state.local.mic.enabled);
  haptic();
});

$("#cam-btn").addEventListener("click", async () => {
  if (state.local.camera) {
    state.local.camera.stop();
    state.local.camera = null;
    // replaceTrack(null) frees the uplink outright, which matters in a mesh.
    await state.mesh.setLocalTrack("camera", null);
    tiles.get("self").video.srcObject = null;
  } else {
    try {
      const stream = await getCamera(state.facing);
      state.local.camera = stream.getVideoTracks()[0];
      await state.mesh.setLocalTrack("camera", state.local.camera);
      tiles.get("self").video.srcObject = stream;
    } catch {
      return void toast("Camera unavailable", "error");
    }
  }

  paintToggle($("#cam-btn"), Boolean(state.local.camera), "i-cam", "i-cam-off");
  haptic();
  updateSelfChrome();
  broadcastState();
});

$("#flip-btn").addEventListener("click", async () => {
  if (!state.local.camera) return void toast("Turn the camera on first");

  state.facing = state.facing === "user" ? "environment" : "user";
  try {
    const stream = await getCamera(state.facing);
    state.local.camera.stop();
    state.local.camera = stream.getVideoTracks()[0];
    await state.mesh.setLocalTrack("camera", state.local.camera);

    const tile = tiles.get("self");
    tile.video.srcObject = stream;
    // The rear camera must not be mirrored -- only the selfie view is.
    tile.video.dataset.mirror = String(state.facing === "user");
    haptic();
  } catch {
    toast("Could not switch camera", "error");
  }
});

$("#screen-btn").addEventListener("click", async () => {
  if (state.local.screen) {
    stopScreenShare();
    return;
  }
  try {
    const stream = await getScreen();
    const track = stream.getVideoTracks()[0];
    state.local.screen = track;

    // The browser's own "Stop sharing" button ends the track directly.
    track.addEventListener("ended", stopScreenShare);

    await state.mesh.setLocalTrack("screen", track);

    const tile = ensureTile("self:screen", "Your screen", { screen: true });
    tile.video.srcObject = stream;
    tile.video.muted = true;
    state.pinned = "self:screen";

    setScreenButton(true);
    sheets.more.close();
    refreshAll();
    broadcastState();
  } catch {
    // Includes the user simply cancelling the picker; not an error worth a toast.
  }
});

async function stopScreenShare() {
  if (!state.local.screen) return;
  state.local.screen.stop();
  state.local.screen = null;
  await state.mesh.setLocalTrack("screen", null);

  removeTile("self:screen");
  if (state.pinned === "self:screen") state.pinned = null;

  setScreenButton(false);
  refreshAll();
  broadcastState();
}

/**
 * Relabel without destroying the icon.
 *
 * Assigning textContent to the button would replace *all* its children,
 * including the inline <svg>, leaving a label with no icon after the first
 * toggle. Only the trailing text node is replaced here.
 */
function setScreenButton(sharing) {
  const button = $("#screen-btn");
  const label = sharing ? "Stop sharing" : "Share screen";

  const text = [...button.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
  if (text) text.textContent = ` ${label} `;
  else button.append(document.createTextNode(` ${label} `));

  button.setAttribute("aria-pressed", String(sharing));
}

// --- Audio output ----------------------------------------------------------

state.outputMode = store.get(OUTPUT_KEY, "loud") ?? "loud";
state.outputSink = store.get(SINK_KEY, "") ?? "";

function applyOutputMode(mode) {
  state.outputMode = mode;
  store.set(OUTPUT_KEY, mode);

  for (const button of $$("#output-modes .segment")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  }
  for (const record of state.peers.values()) record.audio?.setMode(mode);

  if (mode === "off") toast("Sound off");
}

for (const button of $$("#output-modes .segment")) {
  button.addEventListener("click", () => {
    applyOutputMode(button.dataset.mode);
    haptic();
  });
}

/**
 * Populate the device picker.
 *
 * Only Chromium desktop implements setSinkId; everywhere else the OS owns
 * routing, so we say that plainly instead of showing a control that would
 * silently do nothing.
 */
async function refreshOutputDevices() {
  const wrap = $("#output-device-wrap");
  const select = $("#output-device");
  const hint = $("#output-hint");

  if (!supportsOutputSelection()) {
    wrap.hidden = true;
    hint.textContent =
      "Your browser routes sound through the system output — use your device's volume and Bluetooth controls to switch between speaker and headphones.";
    return;
  }

  const devices = await listAudioOutputs();
  if (devices.length <= 1) {
    wrap.hidden = true;
    hint.textContent = "Only one audio output is available.";
    return;
  }

  select.textContent = "";
  const emoji = { headphones: "🎧", bluetooth: "🎧", speaker: "🔊", earpiece: "📞", other: "🔈" };
  for (const device of devices) {
    const option = el("option", { value: device.deviceId }, `${emoji[device.kind]}  ${device.label}`);
    if (device.deviceId === state.outputSink) option.selected = true;
    select.append(option);
  }

  wrap.hidden = false;
  const headphones = devices.find((d) => d.kind === "headphones" || d.kind === "bluetooth");
  hint.textContent = headphones
    ? `Headphones detected — echo cancellation works best with them.`
    : "Choose where the other participants are played.";
}

$("#output-device").addEventListener("change", async (event) => {
  state.outputSink = event.target.value;
  store.set(SINK_KEY, state.outputSink);
  for (const record of state.peers.values()) await record.audio?.setSink(state.outputSink);
});

// Plugging in headphones changes the device list; keep the picker honest.
navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  void refreshOutputDevices();
  void hasMultipleCameras().then((many) => {
    $("#flip-btn").hidden = !many;
  });
});

// --- Invite ------------------------------------------------------------------

function inviteUrl() {
  return `${location.origin}/r/${roomId}`;
}

function openInvite() {
  $("#invite-code").textContent = roomId;
  $("#invite-link").textContent = inviteUrl();
  openSheet("invite");
}

$("#invite-btn").addEventListener("click", openInvite);

$("#invite-share").addEventListener("click", async () => {
  const result = await shareLink(inviteUrl(), state.room?.name ?? "Join my call");
  if (result === "copied") toast("Invite link copied");
  if (result === "failed") toast("Could not copy the link", "error");
  haptic();
});

$("#invite-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(inviteUrl());
    toast("Invite link copied");
  } catch {
    toast("Could not copy — select the link above", "error");
  }
  haptic();
});

// --- Host: mute everyone -----------------------------------------------------

$("#mute-all-btn").addEventListener("click", () => {
  if (!isHost()) return;
  for (const peerId of state.peers.keys()) {
    state.signal.send({ t: "host", action: "mute", target: peerId });
  }
  toast(`Asked ${state.peers.size} ${state.peers.size === 1 ? "person" : "people"} to mute`);
  haptic(20);
});

$("#waiting-share").addEventListener("click", openInvite);

$("#waiting-close").addEventListener("click", () => {
  state.waitingDismissed = true;
  $("#waiting").hidden = true;
  haptic();
});

$("#share-btn").addEventListener("click", openInvite);

$("#leave-btn").addEventListener("click", () => leave());

$("#end-btn").addEventListener("click", () => {
  if (!isHost()) return;
  if (!confirm("End the meeting for everyone? The room code stops working.")) return;
  state.signal.send({ t: "host", action: "end" });
});

function broadcastState() {
  state.signal?.send({
    t: "state",
    state: {
      mic: Boolean(state.local.mic?.enabled),
      cam: Boolean(state.local.camera),
      screen: Boolean(state.local.screen),
    },
  });
}

function leave(reason) {
  if (reason) toast(reason, "error");

  state.signal?.send({ t: "bye" });
  state.signal?.close();
  state.mesh?.close();
  state.selfDetector?.destroy();

  for (const record of state.peers.values()) {
    record.detector?.destroy();
    record.audio?.destroy();
  }
  for (const track of Object.values(state.local)) track?.stop();

  wakeLock.disable();
  location.href = "/";
}

// Best-effort notice so others see you leave immediately rather than waiting
// for the socket to time out.
window.addEventListener("pagehide", () => {
  if (state.joined) state.signal?.send({ t: "bye" });
});

// ============================================================================
// Sheets
// ============================================================================

const scrim = $("#scrim");

const sheets = {
  chat: new Sheet($("#chat-sheet"), { scrim, onClose: () => {} }),
  people: new Sheet($("#people-sheet"), { scrim }),
  more: new Sheet($("#more-sheet"), { scrim }),
  invite: new Sheet($("#invite-sheet"), { scrim }),
  tile: new Sheet($("#tile-sheet"), { scrim }),
  safety: new Sheet($("#safety-sheet"), { scrim }),
};

function openSheet(which) {
  for (const [key, sheet] of Object.entries(sheets)) {
    if (key !== which) sheet.close();
  }
  sheets[which].open();
}

$("#chat-btn").addEventListener("click", () => {
  openSheet("chat");
  state.unread = 0;
  $("#chat-badge").hidden = true;
  $("#composer-input").focus();
});

$("#more-btn").addEventListener("click", () => {
  // Host-only actions are revealed here, and re-checked server-side anyway.
  const host = isHost();
  $("#end-btn").hidden = !host;
  $("#mute-all-btn").hidden = !host || state.peers.size === 0;
  $("#people-btn-count").textContent = String(state.peers.size + 1);

  void refreshOutputDevices();
  openSheet("more");
});
$("#safety-btn").addEventListener("click", () => openSheet("safety"));
$("#people-btn").addEventListener("click", () => openSheet("people"));

for (const button of $$("[data-close-sheet]")) {
  button.addEventListener("click", () => Object.values(sheets).forEach((s) => s.close()));
}

// ============================================================================
// Chat
// ============================================================================

const composer = $("#composer");
const composerInput = $("#composer-input");

// Grow the textarea with its content, up to the CSS max-height.
composerInput.addEventListener("input", () => {
  composerInput.style.height = "auto";
  composerInput.style.height = `${Math.min(120, composerInput.scrollHeight)}px`;
});

// Enter sends on a physical keyboard; Shift+Enter is a newline. On a phone
// the enterkeyhint="send" key fires the same path.
composerInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = composerInput.value.trim();
  if (!text) return;

  composerInput.value = "";
  composerInput.style.height = "auto";

  await sendChat(text);
  haptic();
});

async function sendChat(text) {
  const message = {
    type: "msg",
    id: crypto.randomUUID(),
    text,
    ts: Date.now(),
    name: state.self.name,
  };

  renderMessage({ mine: true, name: "You", text, ts: message.ts });

  // Preferred path: the peer-to-peer data channel. It rides the same DTLS
  // session as the media, so the server is not merely unable to read it --
  // it never receives it at all.
  const unreachable = state.mesh.broadcastData(message);

  // Fallback for peers whose direct channel is not up: AES-GCM under the
  // pairwise ECDH key, blind-relayed. The server still cannot read it.
  for (const peerId of unreachable) {
    const record = state.peers.get(peerId);
    if (!record?.key) continue;

    const seq = record.seqOut++;
    const box = await encryptFor(record.key, {
      fromId: state.self.id,
      toId: peerId,
      seq,
      text,
    });
    state.signal.send({
      t: "signal",
      to: peerId,
      payload: { kind: "chat", ...box, name: state.self.name, ts: message.ts },
    });
  }

  updateChatTransport(unreachable.length);
}

function onDataChannelMessage(peerId, data) {
  if (data?.type !== "msg" || typeof data.text !== "string") return;
  const record = state.peers.get(peerId);
  if (!record) return;

  // Ignore a duplicate that also arrived over the fallback path.
  if (record.seen.has(data.id)) return;
  record.seen.add(data.id);
  // Bounded: only recent ids can plausibly arrive twice (the duplicate is a
  // message that crossed both the data channel and the relay), so an
  // unbounded set would just leak across a long call.
  if (record.seen.size > 300) {
    for (const id of [...record.seen].slice(0, 100)) record.seen.delete(id);
  }

  receiveChat(record.info.name, data.text, data.ts);
}

async function receiveFallbackChat(fromId, payload) {
  const record = state.peers.get(fromId);
  if (!record?.key) return;

  // Binding the sequence number into the AAD stops the relay from
  // *relabelling* a ciphertext, but not from replaying one verbatim. Refusing
  // to go backwards is what actually closes that: a captured message can
  // never be delivered a second time.
  const seq = Number(payload.seq);
  if (!Number.isInteger(seq) || seq < 0 || seq <= record.seqIn) return;

  const text = await decryptFrom(record.key, {
    fromId,
    toId: state.self.id,
    seq,
    iv: payload.iv,
    ct: payload.ct,
  });

  // null means the tag failed: forged, tampered, replayed or misrouted.
  // Dropping it silently is the correct response.
  if (text === null) return;

  record.seqIn = seq;
  receiveChat(record.info.name, text, payload.ts);
}

function receiveChat(name, text, ts) {
  renderMessage({ mine: false, name, text, ts });

  if (!sheets.chat.isOpen) {
    state.unread += 1;
    const badge = $("#chat-badge");
    badge.textContent = String(Math.min(99, state.unread));
    badge.hidden = false;
    haptic(12);
  }
}

const msgs = $("#msgs");

function renderMessage({ mine, name, text }) {
  const bubble = el("div", { class: `msg${mine ? " msg--mine" : ""}` });
  if (!mine) bubble.append(el("span", { class: "msg__who" }, name));
  // textContent, never innerHTML: chat is attacker-controlled by definition.
  bubble.append(document.createTextNode(text));
  msgs.append(bubble);
  scrollChatToEnd();
}

function systemMessage(text) {
  msgs.append(el("div", { class: "msg msg--system" }, text));
  scrollChatToEnd();
}

function scrollChatToEnd() {
  const body = $("#chat-sheet .sheet__body");
  // rAF so the scroll happens after the new node has been laid out.
  requestAnimationFrame(() => {
    body.scrollTop = body.scrollHeight;
  });
}

function updateChatTransport(fallbackCount = 0) {
  const badge = $("#chat-transport");
  if (fallbackCount > 0) {
    badge.textContent = "encrypted relay";
    badge.classList.remove("badge--secure");
  } else {
    badge.textContent = "peer-to-peer";
    badge.classList.add("badge--secure");
  }
}

// ============================================================================
// Safety number
// ============================================================================

async function refreshSafety() {
  const participants = [
    { id: state.self?.id ?? "", pub: state.identity.pub, dtls: state.dtls },
    ...[...state.peers.values()].map((r) => ({
      id: r.info.id,
      pub: r.info.pub,
      dtls: r.fingerprint,
    })),
  ];

  // Every participant computes this over the same inputs, so the values are
  // comparable out loud. Anything local (such as the event chain) must stay
  // out of it or the numbers would never match.
  const { emoji, digits } = await safetyNumber(roomId, participants);

  $("#safety-emoji").textContent = state.peers.size ? emoji : "· · · · ·";
  $("#safety-code").textContent = state.peers.size ? digits : "waiting for peers";
  $("#chain-head").textContent = `event log ${state.chain.shortHead}`;
}
