/**
 * AudioWorkletProcessor host for the Rust voice-activity detector.
 *
 * This code runs on the realtime audio thread. It is called once per render
 * quantum (128 frames -- about every 2.7 ms at 48 kHz), and anything slow or
 * allocating here produces audible glitches for everyone in the call. So:
 * no allocation in process(), no closures created per call, and messages to
 * the main thread are rate-limited rather than sent per quantum.
 *
 * WebAssembly.Module compiles synchronously here, which is allowed in a
 * worklet (and disallowed on the main thread for modules of any size). The
 * bytes are fetched on the main thread and handed over via processorOptions,
 * because there is no fetch() in this scope.
 */

/** Post at ~46 Hz rather than ~375 Hz: smooth to the eye, cheap on the thread. */
const POST_EVERY = 8;

class VadProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const { wasmBytes, sensitivity } = options.processorOptions ?? {};

    this.frames = 0;
    this.lastSpeaking = false;
    this.mode = "js";

    if (wasmBytes) {
      try {
        const instance = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {});
        this.wasm = instance.exports;
        this.wasm.init(sampleRate);
        if (typeof sensitivity === "number") this.wasm.set_sensitivity(sensitivity);
        this.#refreshView();
        this.mode = "wasm";
      } catch (err) {
        // Fall through to the JS path: a wrong indicator is much better than
        // a call that fails to start.
        this.wasm = null;
      }
    }

    // JS fallback state (also used if the wasm view ever detaches).
    this.jsFloor = 1e-6;
    this.jsLevel = 0;
    this.jsHangover = 0;
    this.jsHangoverFrames = Math.round((260 / 1000) * (sampleRate / 128));

    this.port.postMessage({ type: "ready", mode: this.mode });

    this.port.onmessage = (event) => {
      const { type, value } = event.data ?? {};
      if (type === "sensitivity" && this.wasm) this.wasm.set_sensitivity(value);
    };
  }

  /**
   * The wasm module never grows its memory, so this view stays valid for the
   * life of the processor. Re-taken defensively because a detached buffer
   * reads as length 0 rather than throwing.
   */
  #refreshView() {
    this.view = new Float32Array(this.wasm.memory.buffer, this.wasm.input_ptr(), 2048);
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true; // upstream not producing yet; keep the node alive

    let level;
    let speaking;

    if (this.wasm) {
      if (this.view.length === 0) this.#refreshView();
      this.view.set(channel);
      level = this.wasm.process(channel.length);
      speaking = this.wasm.speaking() === 1;
    } else {
      ({ level, speaking } = this.#processJs(channel));
    }

    this.frames += 1;

    // Report a state change immediately -- latency on the speaking ring is
    // the thing people notice. Levels can wait for the next tick.
    const changed = speaking !== this.lastSpeaking;
    if (changed || this.frames % POST_EVERY === 0) {
      this.lastSpeaking = speaking;
      this.port.postMessage({ type: "vad", speaking, level });
    }

    return true;
  }

  /** Same shape as the Rust path, minus the high-pass and zero-crossing gate. */
  #processJs(channel) {
    let sum = 0;
    for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
    const ms = sum / channel.length;

    if (ms < this.jsFloor) this.jsFloor += (ms - this.jsFloor) * 0.35;
    else this.jsFloor += (ms - this.jsFloor) * 0.0008;
    if (this.jsFloor < 1e-9) this.jsFloor = 1e-9;

    if (ms > 9e-8 && ms > this.jsFloor * 6.31) this.jsHangover = this.jsHangoverFrames;
    else if (this.jsHangover > 0) this.jsHangover -= 1;

    const k = ms > this.jsLevel ? 0.5 : 0.08;
    this.jsLevel += (ms - this.jsLevel) * k;

    return {
      level: Math.min(1, Math.sqrt(Math.sqrt(this.jsLevel)) * 1.9),
      speaking: this.jsHangover > 0,
    };
  }
}

registerProcessor("vad", VadProcessor);
