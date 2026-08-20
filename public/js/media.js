/**
 * Capture, codec tuning and remote playback.
 *
 * Most WebRTC apps sound thin for one avoidable reason: Opus negotiates at
 * roughly 32 kbps by default and nobody changes it. Everything in the audio
 * section here exists to fix that without sacrificing the echo cancellation
 * and gain control that make a speakerphone call usable.
 */

/**
 * Mic constraints.
 *
 * The three processing flags stay ON deliberately. They are implemented in
 * native code against the actual playout signal, and switching them off to
 * chase "purity" is what produces howling feedback the moment two people in
 * one room join the same call on speakerphone.
 *
 * Mono is a bitrate decision: stereo would split the same budget across two
 * channels, and a voice call gains nothing from the second one.
 */
export const MIC_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
  sampleRate: 48000,
};

/** 720p ceiling: beyond this a mesh call saturates a phone's uplink. */
export const CAM_CONSTRAINTS = {
  width: { ideal: 1280, max: 1280 },
  height: { ideal: 720, max: 720 },
  frameRate: { ideal: 30, max: 30 },
};

/** Per-track send budgets, in bits per second. */
export const BITRATE = {
  audio: 96_000, // ~3x the Opus default; the single biggest clarity win
  camera: 1_600_000, // 1:1 default; scaled down by the ladder below
  screen: 2_500_000, // text has to stay readable
};

/**
 * Video ladder.
 *
 * In a mesh every peer encodes and uploads a separate copy of its camera, so
 * the uplink cost is (N-1) x bitrate. A single fixed number is therefore
 * always wrong: it either starves a 1:1 call of quality or melts a phone's
 * uplink in a full room. This scales the per-stream budget so the *total*
 * upload stays inside roughly 3 Mbps, which is a realistic mobile ceiling.
 *
 * Audio is never scaled -- it is ~96 kbps and it is the part people actually
 * cannot tolerate losing.
 */
export function videoProfileFor(peerCount) {
  const others = Math.max(1, peerCount - 1);

  if (others <= 1) return { maxBitrate: 1_600_000, scaleDown: 1, maxFps: 30 };
  if (others <= 2) return { maxBitrate: 1_100_000, scaleDown: 1, maxFps: 30 };
  if (others <= 3) return { maxBitrate: 800_000, scaleDown: 1, maxFps: 26 };
  if (others <= 5) return { maxBitrate: 500_000, scaleDown: 1.5, maxFps: 24 };
  return { maxBitrate: 320_000, scaleDown: 2, maxFps: 20 };
}

/**
 * Phones are assumed here rather than detected, because the signal that
 * matters (is there a hardware H.264 encoder) is not exposed to JS. Coarse
 * but the failure mode is mild: a slightly different codec choice.
 */
const IS_MOBILE =
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

/**
 * Video codec preference.
 *
 * Desktop gets VP9: noticeably better quality per bit than VP8, and there is
 * CPU headroom to spare. Phones get H.264, because it is the codec with a
 * hardware encoder on essentially every handset -- and in a mesh a phone is
 * running several encoders at once, so software encoding there costs battery,
 * causes thermal throttling, and ends up *reducing* quality.
 */
export function preferVideoCodec(transceiver) {
  if (!transceiver || typeof RTCRtpReceiver.getCapabilities !== "function") return;
  try {
    const caps = RTCRtpReceiver.getCapabilities("video");
    if (!caps) return;

    const wanted = IS_MOBILE ? /H264/i : /VP9/i;
    const first = caps.codecs.filter((c) => wanted.test(c.mimeType));
    if (first.length === 0) return; // codec unavailable; leave defaults alone

    const rest = caps.codecs.filter((c) => !wanted.test(c.mimeType));
    transceiver.setCodecPreferences([...first, ...rest]);
  } catch {
    /* older implementations: default ordering is acceptable */
  }
}

export async function getMic() {
  return navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS, video: false });
}

export async function getCamera(facingMode = "user") {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { ...CAM_CONSTRAINTS, facingMode },
  });
}

export async function getScreen() {
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 15, max: 30 } },
    // Tab audio when the browser offers it; harmless when it does not.
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
}

/** True when the device exposes more than one camera (i.e. a flip is useful). */
export async function hasMultipleCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput").length > 1;
  } catch {
    return false;
  }
}

// --- SDP tuning -------------------------------------------------------------

/**
 * Rewrite the Opus fmtp line.
 *
 * SDP munging is normally a smell, but audio bitrate is one of the few knobs
 * with no RTCRtpSender equivalent that browsers honour consistently, so it
 * remains the standard way to do this.
 *
 *   maxaveragebitrate  the actual fix -- 96 kbps mono is transparent for speech
 *   useinbandfec       lets Opus reconstruct a lost packet from the next one,
 *                      which is what keeps voice intact on flaky mobile data
 *   usedtx=0           DTX saves bandwidth by not transmitting during silence,
 *                      but it clips quiet speech onsets; clarity wins here
 *   minptime=10        allows 10 ms packets, halving packetisation latency
 */
export function tuneOpus(sdp) {
  const rtpmap = /a=rtpmap:(\d+) opus\/48000(?:\/2)?/i.exec(sdp);
  if (!rtpmap) return sdp;

  const pt = rtpmap[1];
  const params = [
    "stereo=0",
    "sprop-stereo=0",
    `maxaveragebitrate=${BITRATE.audio}`,
    "maxplaybackrate=48000",
    "useinbandfec=1",
    "usedtx=0",
    "cbr=0",
    "minptime=10",
  ].join(";");

  const fmtp = new RegExp(`a=fmtp:${pt} .*`);
  if (fmtp.test(sdp)) {
    return sdp.replace(fmtp, `a=fmtp:${pt} ${params}`);
  }
  return sdp.replace(rtpmap[0], `${rtpmap[0]}\r\na=fmtp:${pt} ${params}`);
}

/**
 * Put Opus first in the audio m-line.
 *
 * Browsers already prefer Opus, but a peer advertising a hardware codec can
 * shuffle the order, and falling back to G.722 or PCMU is an audible cliff.
 */
export function preferOpus(transceiver) {
  if (!transceiver || typeof RTCRtpReceiver.getCapabilities !== "function") return;
  try {
    const caps = RTCRtpReceiver.getCapabilities("audio");
    if (!caps) return;

    const opus = caps.codecs.filter((c) => /opus/i.test(c.mimeType));
    // Keep DTMF and comfort noise available; just demote them.
    const rest = caps.codecs.filter((c) => !/opus/i.test(c.mimeType));
    if (opus.length) transceiver.setCodecPreferences([...opus, ...rest]);
  } catch {
    // setCodecPreferences throws on some older implementations; the default
    // ordering is fine there.
  }
}

/** Apply a send bitrate cap and the right degradation strategy. */
export async function applyEncoding(
  sender,
  { maxBitrate, priority = "medium", degradation, scaleDown, maxFps },
) {
  if (!sender) return;
  try {
    const params = sender.getParameters();
    params.encodings ??= [{}];
    if (params.encodings.length === 0) params.encodings.push({});

    const e = params.encodings[0];
    e.maxBitrate = maxBitrate;
    e.networkPriority = priority;
    e.priority = priority;
    if (scaleDown != null) e.scaleResolutionDownBy = scaleDown;
    if (maxFps != null) e.maxFramerate = maxFps;
    if (degradation) params.degradationPreference = degradation;

    await sender.setParameters(params);
  } catch {
    // Not fatal: without a cap the browser picks its own, which is merely
    // less good rather than broken.
  }
}

/**
 * Tell the encoder what the content is.
 *
 * "motion" lets a camera drop resolution to hold frame rate; "detail" makes a
 * screen share do the opposite, which is what keeps shared text legible.
 */
export function setContentHint(track, hint) {
  if (track && "contentHint" in track) track.contentHint = hint;
}

// --- Audio output -----------------------------------------------------------

/**
 * Whether this browser lets a page choose the playback device.
 *
 * Chrome and Edge on desktop do. Safari, and mobile browsers generally, do
 * not -- there the OS owns routing, and the honest thing is to say so rather
 * than render a control that silently does nothing.
 */
export function supportsOutputSelection() {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

/**
 * Classify an output device from its label. Labels are free text and vary by
 * OS and locale, so this is a hint for iconography and ordering -- never a
 * correctness dependency.
 */
export function classifyOutput(label = "") {
  const l = label.toLowerCase();
  if (/airpod|headphone|headset|earbud|earphone|buds/.test(l)) return "headphones";
  if (/bluetooth|\bbt\b/.test(l)) return "bluetooth";
  if (/receiver|earpiece/.test(l)) return "earpiece";
  if (/speaker/.test(l)) return "speaker";
  return "other";
}

/**
 * List playback devices.
 *
 * Labels are only populated once microphone permission has been granted,
 * which by this point in a call it has.
 */
export async function listAudioOutputs() {
  if (!supportsOutputSelection()) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === "audiooutput")
      .map((d) => ({
        deviceId: d.deviceId,
        label: d.label || (d.deviceId === "default" ? "System default" : "Output device"),
        kind: classifyOutput(d.label),
      }));
  } catch {
    return [];
  }
}

// --- Remote playback --------------------------------------------------------

/**
 * Plays a remote peer's audio.
 *
 * Two things make this less trivial than an <audio> element:
 *
 * 1. Autoplay. Playback can only start from a user gesture, and the promise
 *    from play() rejects silently otherwise. We surface that so the UI can
 *    prompt instead of the call being mysteriously silent.
 *
 * 2. The boost chain. Routing through WebAudio lets us add a compressor and
 *    makeup gain, which is the difference between "I can hear you" and
 *    "you are loud and clear" for someone on a laptop mic across a room.
 *    On iOS a MediaStream routed into WebAudio goes silent unless it is also
 *    attached to a (muted) media element, so we always keep the element.
 */
export class RemoteAudio {
  #ctx;
  #el;
  #nodes = null;
  #boost = false;

  constructor(stream, audioContext) {
    this.#ctx = audioContext;

    this.#el = document.createElement("audio");
    this.#el.srcObject = stream;
    this.#el.autoplay = true;
    this.#el.playsInline = true;
    // Keep it in the DOM: some browsers garbage-collect a detached element
    // mid-call and the audio simply stops.
    this.#el.style.display = "none";
    document.body.append(this.#el);
  }

  async play() {
    try {
      await this.#el.play();
      return true;
    } catch {
      return false; // caller shows an "unmute" affordance
    }
  }

  /**
   * Playback mode.
   *
   *   loud  speakerphone: compressor plus makeup gain, so a quiet talker on a
   *         laptop mic across a room is still intelligible
   *   call  flat, phone-to-ear levels with no added gain
   *   off   silence, without tearing down the connection
   */
  setMode(mode) {
    if (mode === "off") {
      this.setBoost(false);
      this.#el.muted = true;
      this.#el.volume = 0;
      return;
    }

    this.#el.volume = 1;
    // setBoost owns `muted` when the WebAudio chain is engaged, so unmute
    // first and let it decide.
    this.#el.muted = false;
    this.setBoost(mode === "loud");
  }

  /** Route playback to a specific device where the browser allows it. */
  async setSink(deviceId) {
    if (!deviceId || typeof this.#el.setSinkId !== "function") return false;
    try {
      await this.#el.setSinkId(deviceId);
      return true;
    } catch {
      // Device vanished, or permission was refused; stay on the default.
      return false;
    }
  }

  /** Compressor + makeup gain. Safe to toggle mid-call. */
  setBoost(enabled) {
    if (enabled === this.#boost) return;

    if (!enabled) {
      this.#teardownChain();
      this.#el.muted = false;
      this.#boost = false;
      return;
    }

    try {
      const src = this.#ctx.createMediaStreamSource(this.#el.srcObject);

      const comp = this.#ctx.createDynamicsCompressor();
      // Gentle bus compression: lift quiet speech without pumping.
      comp.threshold.value = -30;
      comp.knee.value = 24;
      comp.ratio.value = 4;
      comp.attack.value = 0.006;
      comp.release.value = 0.18;

      const gain = this.#ctx.createGain();
      gain.value = 1.6;

      // A hard limiter after makeup gain, so the boost can never clip.
      const limiter = this.#ctx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.05;

      src.connect(comp).connect(gain).connect(limiter).connect(this.#ctx.destination);
      this.#nodes = { src, comp, gain, limiter };

      // Mute the element so we do not hear both paths at once.
      this.#el.muted = true;
      this.#boost = true;
    } catch {
      this.#teardownChain();
      this.#el.muted = false;
      this.#boost = false;
    }
  }

  setVolume(value) {
    if (this.#nodes) this.#nodes.gain.value = value * 1.6;
    else this.#el.volume = Math.min(1, value);
  }

  destroy() {
    this.#teardownChain();
    this.#el.srcObject = null;
    this.#el.remove();
  }

  #teardownChain() {
    if (!this.#nodes) return;
    for (const node of Object.values(this.#nodes)) {
      try {
        node.disconnect();
      } catch {
        /* already detached */
      }
    }
    this.#nodes = null;
  }
}

/**
 * One AudioContext for the whole page.
 *
 * "interactive" asks for the smallest buffer the device will give us, which
 * is what keeps the speaking indicator in step with the voice.
 */
let sharedContext = null;

export function audioContext() {
  sharedContext ??= new (window.AudioContext || window.webkitAudioContext)({
    latencyHint: "interactive",
    sampleRate: 48000,
  });
  return sharedContext;
}

/** Browsers start the context suspended; call this from a real gesture. */
export async function resumeAudio() {
  const ctx = audioContext();
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      /* will retry on the next gesture */
    }
  }
  return ctx;
}
