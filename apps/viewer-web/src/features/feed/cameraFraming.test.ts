import { describe, expect, it } from "vitest";
import { Box3, MathUtils, Vector3 } from "three";

import {
  DEFAULT_CAMERA_FRAMING_CONFIG,
  computeDesiredFraming,
  stepDistance
} from "./cameraFraming";

function createBounds(min: [number, number, number], max: [number, number, number]): Box3 {
  return new Box3(new Vector3(...min), new Vector3(...max));
}

describe("computeDesiredFraming", () => {
  it("uses horizontal fit for wide poses", () => {
    const bounds = createBounds([-3, -1, -0.5], [3, 1, 0.5]);
    const camera = { fov: 40, aspect: 16 / 9 };
    const result = computeDesiredFraming(bounds, camera, DEFAULT_CAMERA_FRAMING_CONFIG);

    const verticalFov = MathUtils.degToRad(camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
    const expectedWidthDistance =
      (6 * DEFAULT_CAMERA_FRAMING_CONFIG.marginScale) / (2 * Math.tan(horizontalFov / 2));

    expect(result.distance).toBeCloseTo(expectedWidthDistance, 5);
  });

  it("uses vertical fit for tall poses", () => {
    const bounds = createBounds([-1, -4, -0.5], [1, 4, 0.5]);
    const camera = { fov: 40, aspect: 16 / 9 };
    const result = computeDesiredFraming(bounds, camera, DEFAULT_CAMERA_FRAMING_CONFIG);

    const verticalFov = MathUtils.degToRad(camera.fov);
    const expectedHeightDistance =
      (8 * DEFAULT_CAMERA_FRAMING_CONFIG.marginScale) / (2 * Math.tan(verticalFov / 2));

    expect(result.distance).toBeCloseTo(expectedHeightDistance, 5);
  });

  it("increases distance when margin scale increases", () => {
    const bounds = createBounds([-1.5, -2, -0.5], [1.5, 2, 0.5]);
    const camera = { fov: 40, aspect: 1.4 };
    const compact = computeDesiredFraming(bounds, camera, {
      ...DEFAULT_CAMERA_FRAMING_CONFIG,
      marginScale: 1
    });
    const roomy = computeDesiredFraming(bounds, camera, {
      ...DEFAULT_CAMERA_FRAMING_CONFIG,
      marginScale: 1.4
    });

    expect(roomy.distance).toBeGreaterThan(compact.distance);
  });
});

describe("stepDistance", () => {
  it("zooms out faster than it zooms in", () => {
    const config = DEFAULT_CAMERA_FRAMING_CONFIG;
    const delta = 1 / 60;

    const zoomOutStart = 3;
    const zoomOutTarget = 7;
    const zoomOutStep = stepDistance(zoomOutStart, zoomOutTarget, delta, config) - zoomOutStart;

    const zoomInStart = 7;
    const zoomInTarget = 3;
    const zoomInStep = zoomInStart - stepDistance(zoomInStart, zoomInTarget, delta, config);

    expect(zoomOutStep).toBeGreaterThan(zoomInStep);
  });
});
