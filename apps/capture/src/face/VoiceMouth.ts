import type { FaceWeights } from './faceTypes';

/** What the microphone hears now: the loudness (0..1 above the noise threshold) and the power in three bands. */
export interface VoiceSound {
  level: number;
  /** 150-600 Hz: the first formant of "ee" and "oo". */
  low: number;
  /** 600-1500 Hz: the formants of "ah"; empty in "ee" and "oo". */
  mid: number;
  /** 1500-3500 Hz: the second formant of "ee" and "eh". */
  high: number;
}

/** Band limits (Hz) of `VoiceSound`. */
export const VOICE_BANDS = { low: [150, 600], mid: [600, 1500], high: [1500, 3500] } as const;

// Wide lips ("ee", "eh"): the high band within 20 dB of the mid band starts them, within 5 dB is full.
const WIDE_FROM_DB = -20;
const WIDE_SPAN_DB = 15;
// Round lips ("oo"): the low band's share of low + mid, and no wide sound.
const ROUND_FROM = 0.5;
const ROUND_SPAN = 0.4;
/** The lips take their full shape from this level; a quiet sound shapes them less. */
const FULL_LEVEL = 0.25;
/** Lip smoothing (s), both directions: long enough that a shape does not flicker between two frames. */
const LIP_TAU = 0.06;
const FUNNEL = 0.5;
const PUCKER = 0.35;
const STRETCH = 0.4;

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * The lips of a voice that no camera sees: round for "oo", wide for "ee" and
 * "eh", from the balance of three bands of the microphone. It writes lip
 * channels only; the jaw follows the loudness in `LivenessFace`. No sound
 * above the noise threshold, no shape.
 */
export class VoiceMouth {
  private round = 0;
  private wide = 0;

  /** @param sound what the microphone hears, or null when something else drives the face (the lips then ease to rest). */
  sample(deltaSec: number, sound: VoiceSound | null): FaceWeights {
    let round = 0;
    let wide = 0;
    if (sound && sound.level > 0 && sound.low + sound.mid > 0) {
      const gate = clamp(sound.level / FULL_LEVEL);
      // A band with no power at all counts as 60 dB under the other, never as a division by zero.
      const highToMidDb = 10 * Math.log10(Math.max(sound.high, 1e-6 * sound.mid) / Math.max(sound.mid, 1e-6 * sound.high, 1e-30));
      const wideNow = clamp((highToMidDb - WIDE_FROM_DB) / WIDE_SPAN_DB);
      wide = gate * wideNow;
      round = gate * clamp((sound.low / (sound.low + sound.mid) - ROUND_FROM) / ROUND_SPAN) * (1 - wideNow);
    }
    const k = deltaSec > 0 ? 1 - Math.exp(-deltaSec / LIP_TAU) : 0;
    this.round += (round - this.round) * k;
    this.wide += (wide - this.wide) * k;
    return {
      mouthFunnel: FUNNEL * this.round,
      mouthPucker: PUCKER * this.round,
      mouthStretchLeft: STRETCH * this.wide,
      mouthStretchRight: STRETCH * this.wide
    };
  }
}
