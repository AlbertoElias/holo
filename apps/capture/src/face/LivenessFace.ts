import type { FaceGaze, FaceWeights } from './faceTypes';

const DEG = Math.PI / 180;

/** Small deterministic PRNG so a replay under the manual clock repeats exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Blink envelope: close fast, hold briefly, open slower (seconds).
const BLINK_CLOSE = 0.07;
const BLINK_HOLD = 0.04;
const BLINK_OPEN = 0.12;

/**
 * The face when nothing tracks it: blinks every 2-6 s, small gaze saccades
 * around straight ahead, and a jaw that follows the voice level.
 */
export class LivenessFace {
  private readonly random: () => number;
  private nextBlinkAt: number;
  private blinkStartedAt = -Infinity;
  private nextSaccadeAt: number;
  private saccadeFrom = { yaw: 0, pitch: 0 };
  private saccadeTo = { yaw: 0, pitch: 0 };
  private saccadeStartedAt = -Infinity;
  private jaw = 0;

  constructor(seed = 0x5eed) {
    this.random = mulberry32(seed);
    this.nextBlinkAt = 1 + this.random() * 2;
    this.nextSaccadeAt = 0.5 + this.random();
  }

  /** @param voiceLevel 0..1 speech loudness, or 0 without a microphone. */
  sample(timeSec: number, deltaSec: number, voiceLevel: number): { weights: FaceWeights; gaze: FaceGaze } {
    if (timeSec >= this.nextBlinkAt) {
      this.blinkStartedAt = timeSec;
      this.nextBlinkAt = timeSec + 2 + this.random() * 4;
    }
    const blink = blinkEnvelope(timeSec - this.blinkStartedAt);

    if (timeSec >= this.nextSaccadeAt) {
      this.saccadeFrom = this.currentGaze(timeSec);
      this.saccadeTo = { yaw: (this.random() * 2 - 1) * 6 * DEG, pitch: (this.random() * 2 - 1) * 3 * DEG };
      this.saccadeStartedAt = timeSec;
      this.nextSaccadeAt = timeSec + 0.6 + this.random() * 1.6;
    }
    const gaze = this.currentGaze(timeSec);

    // Jaw opens quickly with the voice and closes a little slower.
    const target = Math.min(0.55, voiceLevel * 0.9);
    const tau = target > this.jaw ? 0.04 : 0.09;
    this.jaw += (target - this.jaw) * (1 - Math.exp(-deltaSec / tau));

    return {
      weights: { eyeBlinkLeft: blink, eyeBlinkRight: blink, jawOpen: this.jaw },
      gaze: { left: { ...gaze }, right: { ...gaze } }
    };
  }

  private currentGaze(timeSec: number): { yaw: number; pitch: number } {
    // Saccades take about 40 ms.
    const t = Math.min(1, Math.max(0, (timeSec - this.saccadeStartedAt) / 0.04));
    return {
      yaw: this.saccadeFrom.yaw + (this.saccadeTo.yaw - this.saccadeFrom.yaw) * t,
      pitch: this.saccadeFrom.pitch + (this.saccadeTo.pitch - this.saccadeFrom.pitch) * t
    };
  }
}

function blinkEnvelope(t: number): number {
  if (t < 0) return 0;
  if (t < BLINK_CLOSE) return t / BLINK_CLOSE;
  if (t < BLINK_CLOSE + BLINK_HOLD) return 1;
  const open = (t - BLINK_CLOSE - BLINK_HOLD) / BLINK_OPEN;
  return open < 1 ? 1 - open : 0;
}
