import { describe, expect, it } from "vitest";
import { Euler, Quaternion, Vector3 } from "three";

import {
  computeFloorPlacement,
  computeVisibilityFallbackPlacement,
  evaluatePlacementVisibility,
  isPlacementLikelyVisible
} from "./arPlacement";

describe("computeFloorPlacement", () => {
  it("places the model forward using camera yaw", () => {
    const camPos = new Vector3(0, 1.6, 0);
    const camQuat = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    const placement = computeFloorPlacement(camPos, camQuat);

    expect(placement.mode).toBe("floor");
    expect(placement.position.x).toBeCloseTo(-1.4, 3);
    expect(placement.position.z).toBeCloseTo(0, 3);
    expect(placement.position.y).toBeCloseTo(0.35, 5);
  });

  it("falls back to stable horizontal placement when camera pitch is near vertical", () => {
    const camPos = new Vector3(3, 1.9, -1);
    const camQuat = new Quaternion().setFromEuler(new Euler(-Math.PI / 2, Math.PI / 4, 0, "YXZ"));
    const placement = computeFloorPlacement(camPos, camQuat);
    const horizontalDistance = Math.hypot(
      placement.position.x - camPos.x,
      placement.position.z - camPos.z
    );

    expect(Number.isFinite(placement.position.x)).toBe(true);
    expect(Number.isFinite(placement.position.y)).toBe(true);
    expect(Number.isFinite(placement.position.z)).toBe(true);
    expect(horizontalDistance).toBeCloseTo(1.4, 2);
    expect(placement.position.y).toBeCloseTo(0.65, 5);
  });

  it("supports an explicit vertical lift for view-biased placement", () => {
    const camPos = new Vector3(0, 1.6, 0);
    const camQuat = new Quaternion();
    const placement = computeFloorPlacement(camPos, camQuat, { verticalOffsetMeters: 0.3 });

    expect(placement.position.y).toBeCloseTo(0.65, 5);
  });
});

describe("visibility heuristics", () => {
  it("returns false when the target is behind the camera", () => {
    const result = evaluatePlacementVisibility(
      new Vector3(0, 1.6, 0),
      new Vector3(0, 0, -1),
      new Vector3(0, 1.3, 1)
    );

    expect(result.visible).toBe(false);
    expect(result.reason).toBe("behind-camera");
    expect(
      isPlacementLikelyVisible(
        new Vector3(0, 1.6, 0),
        new Vector3(0, 0, -1),
        new Vector3(0, 1.3, 1)
      )
    ).toBe(false);
  });

  it("returns true for a target that is forward and inside view cone", () => {
    const result = evaluatePlacementVisibility(
      new Vector3(0, 1.6, 0),
      new Vector3(0, 0, -1),
      new Vector3(0.2, 1.45, -1.25)
    );

    expect(result.visible).toBe(true);
    expect(result.reason).toBe("visible");
    expect(
      isPlacementLikelyVisible(
        new Vector3(0, 1.6, 0),
        new Vector3(0, 0, -1),
        new Vector3(0.2, 1.45, -1.25)
      )
    ).toBe(true);
  });
});

describe("computeVisibilityFallbackPlacement", () => {
  it("places the model near chest height in front of camera", () => {
    const camPos = new Vector3(1, 1.7, 2);
    const camQuat = new Quaternion();
    const placement = computeVisibilityFallbackPlacement(camPos, camQuat);

    expect(placement.mode).toBe("visibility-fallback");
    expect(placement.position.x).toBeCloseTo(1, 6);
    expect(placement.position.y).toBeCloseTo(1.62, 6);
    expect(placement.position.z).toBeCloseTo(1.05, 6);
  });
});
