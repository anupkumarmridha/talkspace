//! Voice activity detection and level metering for TalkSpace.
//!
//! This runs inside an `AudioWorkletProcessor`, which means it is called on
//! the realtime audio thread roughly every 2.7 ms (128 frames at 48 kHz) for
//! every participant in the call. Missing that deadline produces audible
//! glitches, so the whole module is `no_std`, allocation-free, and branch-light:
//! cost per call is a fixed number of multiply-adds over the frame.
//!
//! It is deliberately an analysis-only tap. The microphone track goes to the
//! peer connection untouched; nothing here sits in the media path, so a bug
//! in this file can make the speaking indicator wrong but can never add
//! latency to, or corrupt, the audio anyone hears.
//!
//! ABI (all indices are in f32 units, not bytes):
//!   init(sample_rate)          -- (re)configure; safe to call again
//!   input_ptr() -> *mut f32    -- write up to MAX_FRAME samples here
//!   process(len) -> f32        -- analyse; returns UI level in 0.0..=1.0
//!   speaking() -> u32          -- 1 while voice is present (with hangover)
//!   noise_floor() -> f32       -- current estimate, for diagnostics
//!   set_sensitivity(db)        -- SNR threshold in dB; default 8.0

#![no_std]

use core::cell::UnsafeCell;
use core::panic::PanicInfo;

/// 128 is the Web Audio render quantum; 2048 leaves room for future
/// `renderQuantumSize` values without any allocation.
const MAX_FRAME: usize = 2048;

/// Below this absolute RMS the signal is treated as silence outright, so a
/// muted or unplugged mic cannot produce a huge SNR against a ~0 noise floor.
const ABSOLUTE_GATE: f32 = 3.0e-4;

/// Speech sits well under this normalised zero-crossing rate. Steady hiss,
/// fan noise and keyboard chatter sit above it.
const MAX_SPEECH_ZCR: f32 = 0.45;

/// Keep reporting "speaking" this long after the last detection, so the
/// indicator does not strobe during the natural gaps between words.
const HANGOVER_MS: f32 = 260.0;

struct Dsp {
    input: [f32; MAX_FRAME],

    sample_rate: f32,
    /// Frames of hangover, derived from `sample_rate` and the frame length.
    hangover_frames: u32,
    hangover_left: u32,

    /// One-pole high-pass state, removing DC offset and sub-80 Hz rumble
    /// that would otherwise dominate the energy estimate.
    hp_x1: f32,
    hp_y1: f32,
    hp_coeff: f32,

    /// Mean-square noise floor. Tracked in the power domain to avoid a
    /// square root on the hot path.
    floor_ms: f32,
    /// Smoothed mean square, used for the UI meter.
    level_ms: f32,

    /// SNR threshold as a power ratio (not dB) so the comparison is a
    /// single multiply.
    snr_ratio: f32,

    speaking: bool,
}

impl Dsp {
    const fn new() -> Self {
        Self {
            input: [0.0; MAX_FRAME],
            sample_rate: 48_000.0,
            hangover_frames: 96,
            hangover_left: 0,
            hp_x1: 0.0,
            hp_y1: 0.0,
            hp_coeff: 0.995,
            floor_ms: 1.0e-6,
            level_ms: 0.0,
            // 8 dB in the power domain: 10^(8/10).
            snr_ratio: 6.3096,
            speaking: false,
        }
    }
}

/// wasm32 has no threads, so there is exactly one caller and no data race is
/// representable. `UnsafeCell` in a `static` is how we say that without
/// tripping the `static_mut_refs` lint.
struct Global(UnsafeCell<Dsp>);
unsafe impl Sync for Global {}

static STATE: Global = Global(UnsafeCell::new(Dsp::new()));

#[inline(always)]
fn state() -> &'static mut Dsp {
    // Safety: single-threaded module; no reentrancy (the audio thread calls
    // these exports one at a time).
    unsafe { &mut *STATE.0.get() }
}

// --- Exports ---------------------------------------------------------------

#[no_mangle]
pub extern "C" fn init(sample_rate: f32) {
    let s = state();

    s.sample_rate = if sample_rate > 8_000.0 { sample_rate } else { 48_000.0 };

    // 128-frame quanta: how many of them cover the hangover window.
    let frames_per_ms = s.sample_rate / 1000.0 / 128.0;
    s.hangover_frames = (HANGOVER_MS * frames_per_ms) as u32;

    // One-pole high-pass at ~80 Hz: y[n] = a*(y[n-1] + x[n] - x[n-1]).
    // a = exp(-2*pi*fc/fs), approximated as 1 - 2*pi*fc/fs, which is within
    // a fraction of a dB at these ratios and costs no exp().
    let fc_over_fs = 80.0 / s.sample_rate;
    s.hp_coeff = 1.0 - 6.2831855 * fc_over_fs;

    s.hp_x1 = 0.0;
    s.hp_y1 = 0.0;
    s.floor_ms = 1.0e-6;
    s.level_ms = 0.0;
    s.hangover_left = 0;
    s.speaking = false;
}

/// Base of the frame buffer in wasm linear memory. The caller writes samples
/// here as a `Float32Array` view before each `process` call.
#[no_mangle]
pub extern "C" fn input_ptr() -> *mut f32 {
    state().input.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn set_sensitivity(db: f32) {
    // Clamp to a sane range so a bad UI value cannot wedge detection on or off.
    let db = if db < 3.0 {
        3.0
    } else if db > 24.0 {
        24.0
    } else {
        db
    };
    // 10^(db/10) without powf: exp10(x) = exp(x * ln10), and we only need
    // modest accuracy, so use the exp2-by-bit-manipulation trick.
    state().snr_ratio = exp10(db * 0.1);
}

#[no_mangle]
pub extern "C" fn speaking() -> u32 {
    state().speaking as u32
}

#[no_mangle]
pub extern "C" fn noise_floor() -> f32 {
    fast_sqrt(state().floor_ms)
}

/// Analyse one render quantum. Returns a perceptual 0..1 level for the meter.
#[no_mangle]
pub extern "C" fn process(len: u32) -> f32 {
    let s = state();
    let n = (len as usize).min(MAX_FRAME);
    if n == 0 {
        return 0.0;
    }

    let mut sum_sq = 0.0f32;
    let mut crossings = 0u32;
    let mut prev_sign = 0i32;

    // Single pass: high-pass filter, accumulate energy, count sign changes.
    for i in 0..n {
        let x = s.input[i];

        let y = s.hp_coeff * (s.hp_y1 + x - s.hp_x1);
        s.hp_x1 = x;
        s.hp_y1 = y;

        sum_sq += y * y;

        let sign = if y > 0.0 {
            1
        } else if y < 0.0 {
            -1
        } else {
            0
        };
        if sign != 0 {
            if prev_sign != 0 && sign != prev_sign {
                crossings += 1;
            }
            prev_sign = sign;
        }
    }

    let inv_n = 1.0 / n as f32;
    let ms = sum_sq * inv_n;
    let zcr = crossings as f32 * inv_n;

    // Noise floor: fall fast toward a quiet frame, rise slowly. The asymmetry
    // is what stops sustained speech from being absorbed into the floor.
    if ms < s.floor_ms {
        s.floor_ms += (ms - s.floor_ms) * 0.35;
    } else {
        s.floor_ms += (ms - s.floor_ms) * 0.0008;
    }
    if s.floor_ms < 1.0e-9 {
        s.floor_ms = 1.0e-9;
    }

    let loud_enough = ms > ABSOLUTE_GATE * ABSOLUTE_GATE;
    let above_floor = ms > s.floor_ms * s.snr_ratio;
    let voice_like = zcr < MAX_SPEECH_ZCR;

    if loud_enough && above_floor && voice_like {
        s.hangover_left = s.hangover_frames;
    } else if s.hangover_left > 0 {
        s.hangover_left -= 1;
    }
    s.speaking = s.hangover_left > 0;

    // Meter: fast attack so it feels responsive, slow release so it does not
    // flicker between syllables.
    let k = if ms > s.level_ms { 0.5 } else { 0.08 };
    s.level_ms += (ms - s.level_ms) * k;

    // ms^0.25 == rms^0.5: a cheap perceptual curve, two sqrts, no log.
    let level = fast_sqrt(fast_sqrt(s.level_ms)) * 1.9;
    if level > 1.0 {
        1.0
    } else {
        level
    }
}

// --- Math without std ------------------------------------------------------

/// Newton-Raphson square root seeded by exponent halving. Two iterations put
/// us within ~1 ulp over the range we care about, and wasm lowers the
/// arithmetic to native instructions.
#[inline(always)]
fn fast_sqrt(x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    let seed = 0x1fbd_1df5u32.wrapping_add(x.to_bits() >> 1);
    let mut y = f32::from_bits(seed);
    y = 0.5 * (y + x / y);
    y = 0.5 * (y + x / y);
    y
}

/// 10^x for the small positive range used by `set_sensitivity`.
/// Computed as 2^(x * log2(10)) via exponent construction plus a cubic
/// correction on the fractional part.
#[inline]
fn exp10(x: f32) -> f32 {
    let t = x * 3.321_928_1; // log2(10)
    let i = if t >= 0.0 { t as i32 } else { t as i32 - 1 };
    let f = t - i as f32;

    // 2^f on [0,1) -- degree-3 minimax fit, plenty for a threshold constant.
    let poly = 1.0 + f * (0.695_502_5 + f * (0.226_302_5 + f * 0.078_195_0));

    let scale = f32::from_bits((((i + 127) as u32) & 0xff) << 23);
    poly * scale
}

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    // `panic = "abort"` compiles to an unreachable trap; the audio thread
    // simply stops calling us and the JS fallback takes over.
    core::arch::wasm32::unreachable()
}
