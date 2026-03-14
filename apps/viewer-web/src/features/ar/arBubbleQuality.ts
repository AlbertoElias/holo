export type ArBubbleQuality = "high" | "medium" | "low";

export type ArBubbleQualityState = {
  quality: ArBubbleQuality;
  ewmaFrameTimeMs: number;
  degradeFrames: number;
  recoverFrames: number;
};

const EWMA_ALPHA = 0.1;

const HIGH_TO_MEDIUM_THRESHOLD_MS = 24;
const MEDIUM_TO_LOW_THRESHOLD_MS = 30;
const LOW_TO_MEDIUM_THRESHOLD_MS = 18;
const MEDIUM_TO_HIGH_THRESHOLD_MS = 15;

const DEGRADE_FRAMES = 120;
const RECOVER_FRAMES = 300;

export function createArBubbleQualityState(
  quality: ArBubbleQuality = "high",
  ewmaFrameTimeMs = 16.6
): ArBubbleQualityState {
  return {
    quality,
    ewmaFrameTimeMs,
    degradeFrames: 0,
    recoverFrames: 0
  };
}

export function updateArBubbleQuality(
  state: ArBubbleQualityState,
  frameTimeMs: number
): ArBubbleQualityState {
  const sanitizedFrameTimeMs = Number.isFinite(frameTimeMs) && frameTimeMs > 0 ? frameTimeMs : state.ewmaFrameTimeMs;
  const ewmaFrameTimeMs = state.ewmaFrameTimeMs + (sanitizedFrameTimeMs - state.ewmaFrameTimeMs) * EWMA_ALPHA;

  if (state.quality === "high") {
    const degradeFrames = ewmaFrameTimeMs > HIGH_TO_MEDIUM_THRESHOLD_MS ? state.degradeFrames + 1 : 0;
    if (degradeFrames >= DEGRADE_FRAMES) {
      return {
        quality: "medium",
        ewmaFrameTimeMs,
        degradeFrames: 0,
        recoverFrames: 0
      };
    }

    return {
      quality: "high",
      ewmaFrameTimeMs,
      degradeFrames,
      recoverFrames: 0
    };
  }

  if (state.quality === "medium") {
    const degradeFrames = ewmaFrameTimeMs > MEDIUM_TO_LOW_THRESHOLD_MS ? state.degradeFrames + 1 : 0;
    if (degradeFrames >= DEGRADE_FRAMES) {
      return {
        quality: "low",
        ewmaFrameTimeMs,
        degradeFrames: 0,
        recoverFrames: 0
      };
    }

    const recoverFrames = ewmaFrameTimeMs < MEDIUM_TO_HIGH_THRESHOLD_MS ? state.recoverFrames + 1 : 0;
    if (recoverFrames >= RECOVER_FRAMES) {
      return {
        quality: "high",
        ewmaFrameTimeMs,
        degradeFrames: 0,
        recoverFrames: 0
      };
    }

    return {
      quality: "medium",
      ewmaFrameTimeMs,
      degradeFrames,
      recoverFrames
    };
  }

  const recoverFrames = ewmaFrameTimeMs < LOW_TO_MEDIUM_THRESHOLD_MS ? state.recoverFrames + 1 : 0;
  if (recoverFrames >= RECOVER_FRAMES) {
    return {
      quality: "medium",
      ewmaFrameTimeMs,
      degradeFrames: 0,
      recoverFrames: 0
    };
  }

  return {
    quality: "low",
    ewmaFrameTimeMs,
    degradeFrames: 0,
    recoverFrames
  };
}
