import { describe, expect, it } from "vitest";

import {
  createArBubbleQualityState,
  updateArBubbleQuality
} from "./arBubbleQuality";

function stepMany(
  quality: ReturnType<typeof createArBubbleQualityState>,
  frameTimeMs: number,
  steps: number
) {
  let state = quality;
  for (let i = 0; i < steps; i += 1) {
    state = updateArBubbleQuality(state, frameTimeMs);
  }
  return state;
}

describe("arBubbleQuality transitions", () => {
  it("degrades from high to medium after sustained slow frames", () => {
    const initial = createArBubbleQualityState("high", 30);
    const result = stepMany(initial, 30, 120);
    expect(result.quality).toBe("medium");
  });

  it("degrades from medium to low after sustained very slow frames", () => {
    const initial = createArBubbleQualityState("medium", 35);
    const result = stepMany(initial, 35, 120);
    expect(result.quality).toBe("low");
  });

  it("recovers from low to medium after sustained fast frames", () => {
    const initial = createArBubbleQualityState("low", 10);
    const result = stepMany(initial, 10, 300);
    expect(result.quality).toBe("medium");
  });

  it("recovers from medium to high after sustained very fast frames", () => {
    const initial = createArBubbleQualityState("medium", 10);
    const result = stepMany(initial, 10, 300);
    expect(result.quality).toBe("high");
  });

  it("does not oscillate with near-threshold jitter", () => {
    let state = createArBubbleQualityState("medium", 22);
    for (let i = 0; i < 1000; i += 1) {
      const frameTimeMs = i % 2 === 0 ? 16.4 : 27.2;
      state = updateArBubbleQuality(state, frameTimeMs);
    }

    expect(state.quality).toBe("medium");
  });
});
