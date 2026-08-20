/**
 * Main-thread façade over the audio-thread voice detector.
 *
 * Used for two things: the speaking ring around your own tile, and the same
 * ring around everyone else's. Remote peers are analysed locally from their
 * received stream rather than being told over the wire who is talking --
 * that removes a whole class of signalling chatter and stays accurate even
 * while the WebSocket is reconnecting.
 */

import { audioContext } from "./media.js";

let wasmBytes = null;
let workletReady = null;

/** Fetched once and shared by every detector on the page. */
async function loadWasm() {
  if (wasmBytes) return wasmBytes;
  try {
    const res = await fetch("/wasm/dsp.wasm", { cache: "force-cache" });
    if (!res.ok) throw new Error(`http_${res.status}`);
    wasmBytes = await res.arrayBuffer();
  } catch {
    wasmBytes = null; // the worklet falls back to its JS path
  }
  return wasmBytes;
}

async function loadWorklet(ctx) {
  workletReady ??= ctx.audioWorklet.addModule("/js/vad-worklet.js");
  return workletReady;
}

/**
 * Attach a detector to a MediaStream.
 *
 * @param onUpdate  ({speaking, level}) => void, called at roughly 46 Hz
 * @returns a handle with .destroy() and .setSensitivity(db)
 */
export async function createVoiceDetector(stream, onUpdate, { sensitivity = 8 } = {}) {
  const ctx = audioContext();

  const [bytes] = await Promise.all([loadWasm(), loadWorklet(ctx)]);

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "vad", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      // Transfer a copy: the same ArrayBuffer is reused for other detectors,
      // so it must not be neutered.
      wasmBytes: bytes ? bytes.slice(0) : null,
      sensitivity,
    },
  });

  let mode = "js";
  node.port.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "ready") {
      mode = msg.mode;
      return;
    }
    if (msg.type === "vad") onUpdate(msg);
  };

  source.connect(node);

  // A worklet node that reaches no destination is not guaranteed to be
  // pulled by the graph. Route it through a silent gain so it always runs
  // without any of the microphone reaching the speakers (which would be an
  // immediate feedback loop).
  const silence = ctx.createGain();
  silence.gain.value = 0;
  node.connect(silence).connect(ctx.destination);

  return {
    get mode() {
      return mode;
    },
    setSensitivity(db) {
      node.port.postMessage({ type: "sensitivity", value: db });
    },
    destroy() {
      try {
        node.port.onmessage = null;
        source.disconnect();
        node.disconnect();
        silence.disconnect();
      } catch {
        /* graph already torn down */
      }
    },
  };
}
