import { MathUtils, Vector3 } from "three";
import type { Box3 } from "three";

export type FramingCamera = {
  fov: number;
  aspect: number;
};

export type CameraFramingConfig = {
  marginScale: number;
  verticalFocusOffsetRatio: number;
  zoomOutRate: number;
  zoomInRate: number;
  followRate: number;
  minNear: number;
};

export type CameraFramingResult = {
  focus: Vector3;
  distance: number;
  near: number;
  far: number;
};

const FAR_MULTIPLIER = 20;
const MIN_FAR = 100;

export const DEFAULT_CAMERA_FRAMING_CONFIG: CameraFramingConfig = {
  marginScale: 1.35,
  verticalFocusOffsetRatio: 0.08,
  zoomOutRate: 10,
  zoomInRate: 2.5,
  followRate: 7,
  minNear: 0.01
};

export function dampFactor(rate: number, delta: number): number {
  if (rate <= 0 || delta <= 0) {
    return 0;
  }

  return 1 - Math.exp(-rate * delta);
}

export function stepDistance(
  current: number,
  desired: number,
  delta: number,
  config: CameraFramingConfig
): number {
  if (!Number.isFinite(current)) {
    return desired;
  }

  const rate = desired > current ? config.zoomOutRate : config.zoomInRate;
  const alpha = dampFactor(rate, delta);
  return current + (desired - current) * alpha;
}

export function computeDesiredFraming(
  bounds: Box3,
  camera: FramingCamera,
  config: CameraFramingConfig
): CameraFramingResult {
  if (bounds.isEmpty()) {
    return {
      focus: new Vector3(),
      distance: 2.5,
      near: config.minNear,
      far: MIN_FAR
    };
  }

  const size = bounds.getSize(new Vector3());
  const center = bounds.getCenter(new Vector3());
  const focus = center.clone();
  focus.y += size.y * config.verticalFocusOffsetRatio;

  const verticalFovRadians = MathUtils.degToRad(Math.max(camera.fov, 1));
  const safeAspect = Math.max(camera.aspect, 0.1);
  const horizontalFovRadians = 2 * Math.atan(Math.tan(verticalFovRadians / 2) * safeAspect);

  const halfHeight = Math.max((size.y * config.marginScale) / 2, 0.001);
  const halfWidth = Math.max((size.x * config.marginScale) / 2, 0.001);

  const distanceForHeight = halfHeight / Math.tan(verticalFovRadians / 2);
  const distanceForWidth = halfWidth / Math.tan(horizontalFovRadians / 2);
  const distance = Math.max(distanceForHeight, distanceForWidth, 0.1);

  const near = Math.max(distance / 500, config.minNear);
  const far = Math.max(distance * FAR_MULTIPLIER, MIN_FAR);

  return { focus, distance, near, far };
}
