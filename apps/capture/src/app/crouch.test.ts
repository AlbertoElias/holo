import { describe, expect, it } from "vitest";

import {
  computeCrouchPoseAmount,
  computeVrCrouchTarget,
  resolveCrouchTargetAndSource,
  stepCrouchAmount
} from "./crouch";

describe("computeVrCrouchTarget", () => {
  it("captures initial standing baseline from head pose", () => {
    const result = computeVrCrouchTarget(1 / 60, 1.65, {
      standingHeadY: 0,
      standingCaptured: false
    });

    expect(result.baseline.standingCaptured).toBe(true);
    expect(result.baseline.standingHeadY).toBeCloseTo(1.65, 6);
    expect(result.vrTarget).toBe(0);
  });

  it("increases crouch target when head drops below baseline", () => {
    const baseline = {
      standingHeadY: 1.65,
      standingCaptured: true
    };
    const result = computeVrCrouchTarget(1 / 60, 1.45, baseline);
    expect(result.vrTarget).toBeGreaterThan(0.5);
  });
});

describe("resolveCrouchTargetAndSource", () => {
  it("returns mixed source when desktop and vr targets are both active", () => {
    const result = resolveCrouchTargetAndSource(true, 1, 0.8);
    expect(result.target).toBe(1);
    expect(result.source).toBe("mixed");
  });

  it("returns desktop source when VR is inactive", () => {
    const result = resolveCrouchTargetAndSource(false, 1, 0.9);
    expect(result.target).toBe(1);
    expect(result.source).toBe("desktop");
  });
});

describe("stepCrouchAmount", () => {
  it("releases crouch faster than it engages", () => {
    const engageStep = stepCrouchAmount(0, 1, 1 / 60);
    const releaseStep = stepCrouchAmount(1, 0, 1 / 60);
    expect(releaseStep).toBeLessThan(1 - engageStep);
  });
});

describe("computeCrouchPoseAmount", () => {
  it("boosts visual pose amount for VR and clamps the final amount", () => {
    const desktopPose = computeCrouchPoseAmount(0.7, false);
    const vrPose = computeCrouchPoseAmount(0.7, true);

    expect(vrPose).toBeGreaterThan(desktopPose);
    expect(computeCrouchPoseAmount(1, true)).toBeLessThanOrEqual(1.45);
  });
});
