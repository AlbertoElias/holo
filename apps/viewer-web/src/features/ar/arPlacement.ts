import { MathUtils, Vector3 } from "three";
import type { Quaternion } from "three";

export type ArPlacementMode = "hit-test" | "floor" | "visibility-fallback";

export type ArPlacementResult = {
  position: Vector3;
  mode: ArPlacementMode;
  reason: string;
};

export type FloorPlacementOptions = {
  distanceMeters?: number;
  minFloorY?: number;
  eyeToFloorMeters?: number;
  nearVerticalThreshold?: number;
  verticalOffsetMeters?: number;
};

export type VisibilityFallbackPlacementOptions = {
  distanceMeters?: number;
  verticalOffsetMeters?: number;
};

export type PlacementVisibilityOptions = {
  minDistanceMeters?: number;
  maxDistanceMeters?: number;
  minInFrontDot?: number;
  maxHorizontalAngleRad?: number;
  maxVerticalAngleRad?: number;
};

export type PlacementVisibilityResult = {
  visible: boolean;
  reason:
    | "visible"
    | "invalid-pose"
    | "too-close"
    | "too-far"
    | "behind-camera"
    | "outside-horizontal-fov"
    | "outside-vertical-fov";
};

const EPSILON = 1e-6;
const DEFAULT_FLOOR_DISTANCE_METERS = 1.4;
const DEFAULT_MIN_FLOOR_Y = 0.05;
const DEFAULT_EYE_TO_FLOOR_METERS = 1.25;
const DEFAULT_NEAR_VERTICAL_THRESHOLD = 0.015;
const DEFAULT_VISIBILITY_FALLBACK_DISTANCE_METERS = 0.95;
const DEFAULT_VISIBILITY_FALLBACK_VERTICAL_OFFSET_METERS = -0.08;

const DEFAULT_MIN_DISTANCE_METERS = 0.2;
const DEFAULT_MAX_DISTANCE_METERS = 6;
const DEFAULT_MIN_IN_FRONT_DOT = 0.05;
const DEFAULT_MAX_HORIZONTAL_ANGLE_RAD = MathUtils.degToRad(50);
const DEFAULT_MAX_VERTICAL_ANGLE_RAD = MathUtils.degToRad(38);

const WORLD_UP = new Vector3(0, 1, 0);

function isFiniteVector(vector: Vector3): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

function isFiniteQuaternion(quaternion: Quaternion): boolean {
  return Number.isFinite(quaternion.x)
    && Number.isFinite(quaternion.y)
    && Number.isFinite(quaternion.z)
    && Number.isFinite(quaternion.w);
}

function getCameraForward(camQuat: Quaternion): Vector3 {
  return new Vector3(0, 0, -1).applyQuaternion(camQuat).normalize();
}

function getHorizontalForward(camQuat: Quaternion, nearVerticalThreshold: number): Vector3 {
  const forward = getCameraForward(camQuat);
  const horizontalForward = new Vector3(forward.x, 0, forward.z);
  if (horizontalForward.lengthSq() >= nearVerticalThreshold) {
    return horizontalForward.normalize();
  }

  const right = new Vector3(1, 0, 0).applyQuaternion(camQuat);
  const yawForward = new Vector3().crossVectors(WORLD_UP, right);
  yawForward.y = 0;
  if (yawForward.lengthSq() > EPSILON) {
    return yawForward.normalize();
  }

  return new Vector3(0, 0, -1);
}

export function computeFloorPlacement(
  camPos: Vector3,
  camQuat: Quaternion,
  options: FloorPlacementOptions = {}
): ArPlacementResult {
  if (!isFiniteVector(camPos) || !isFiniteQuaternion(camQuat)) {
    return {
      position: new Vector3(0, DEFAULT_MIN_FLOOR_Y, -DEFAULT_FLOOR_DISTANCE_METERS),
      mode: "floor",
      reason: "invalid-camera-pose"
    };
  }

  const distanceMeters = options.distanceMeters ?? DEFAULT_FLOOR_DISTANCE_METERS;
  const minFloorY = options.minFloorY ?? DEFAULT_MIN_FLOOR_Y;
  const eyeToFloorMeters = options.eyeToFloorMeters ?? DEFAULT_EYE_TO_FLOOR_METERS;
  const nearVerticalThreshold = options.nearVerticalThreshold ?? DEFAULT_NEAR_VERTICAL_THRESHOLD;
  const verticalOffsetMeters = options.verticalOffsetMeters ?? 0;

  const forward = getHorizontalForward(camQuat, nearVerticalThreshold);
  const position = camPos.clone().addScaledVector(forward, distanceMeters);
  position.y = Math.max(minFloorY, camPos.y - eyeToFloorMeters) + verticalOffsetMeters;

  return {
    position,
    mode: "floor",
    reason: "floor-forward"
  };
}

export function computeVisibilityFallbackPlacement(
  camPos: Vector3,
  camQuat: Quaternion,
  options: VisibilityFallbackPlacementOptions = {}
): ArPlacementResult {
  if (!isFiniteVector(camPos) || !isFiniteQuaternion(camQuat)) {
    return {
      position: new Vector3(0, DEFAULT_MIN_FLOOR_Y, -DEFAULT_VISIBILITY_FALLBACK_DISTANCE_METERS),
      mode: "visibility-fallback",
      reason: "invalid-camera-pose"
    };
  }

  const distanceMeters = options.distanceMeters ?? DEFAULT_VISIBILITY_FALLBACK_DISTANCE_METERS;
  const verticalOffsetMeters = options.verticalOffsetMeters ?? DEFAULT_VISIBILITY_FALLBACK_VERTICAL_OFFSET_METERS;
  const forward = getCameraForward(camQuat);
  const position = camPos.clone().addScaledVector(forward, distanceMeters);
  position.y = camPos.y + verticalOffsetMeters;

  return {
    position,
    mode: "visibility-fallback",
    reason: "visibility-forward"
  };
}

export function evaluatePlacementVisibility(
  camPos: Vector3,
  camForward: Vector3,
  targetPos: Vector3,
  options: PlacementVisibilityOptions = {}
): PlacementVisibilityResult {
  if (!isFiniteVector(camPos) || !isFiniteVector(camForward) || !isFiniteVector(targetPos)) {
    return { visible: false, reason: "invalid-pose" };
  }

  const minDistanceMeters = options.minDistanceMeters ?? DEFAULT_MIN_DISTANCE_METERS;
  const maxDistanceMeters = options.maxDistanceMeters ?? DEFAULT_MAX_DISTANCE_METERS;
  const minInFrontDot = options.minInFrontDot ?? DEFAULT_MIN_IN_FRONT_DOT;
  const maxHorizontalAngleRad = options.maxHorizontalAngleRad ?? DEFAULT_MAX_HORIZONTAL_ANGLE_RAD;
  const maxVerticalAngleRad = options.maxVerticalAngleRad ?? DEFAULT_MAX_VERTICAL_ANGLE_RAD;

  const toTarget = targetPos.clone().sub(camPos);
  const distance = toTarget.length();
  if (!Number.isFinite(distance) || distance <= EPSILON) {
    return { visible: false, reason: "invalid-pose" };
  }

  if (distance < minDistanceMeters) {
    return { visible: false, reason: "too-close" };
  }

  if (distance > maxDistanceMeters) {
    return { visible: false, reason: "too-far" };
  }

  const normalizedToTarget = toTarget.clone().divideScalar(distance);
  const normalizedForward = camForward.clone();
  if (normalizedForward.lengthSq() <= EPSILON) {
    return { visible: false, reason: "invalid-pose" };
  }
  normalizedForward.normalize();

  if (normalizedForward.dot(normalizedToTarget) <= minInFrontDot) {
    return { visible: false, reason: "behind-camera" };
  }

  const headingForward = new Vector3(normalizedForward.x, 0, normalizedForward.z);
  const headingToTarget = new Vector3(normalizedToTarget.x, 0, normalizedToTarget.z);
  if (headingForward.lengthSq() > EPSILON && headingToTarget.lengthSq() > EPSILON) {
    headingForward.normalize();
    headingToTarget.normalize();
    const horizontalDot = MathUtils.clamp(headingForward.dot(headingToTarget), -1, 1);
    const horizontalAngle = Math.acos(horizontalDot);
    if (horizontalAngle > maxHorizontalAngleRad) {
      return { visible: false, reason: "outside-horizontal-fov" };
    }
  }

  const camPitch = Math.atan2(
    normalizedForward.y,
    Math.hypot(normalizedForward.x, normalizedForward.z)
  );
  const targetPitch = Math.atan2(
    normalizedToTarget.y,
    Math.hypot(normalizedToTarget.x, normalizedToTarget.z)
  );
  if (Math.abs(targetPitch - camPitch) > maxVerticalAngleRad) {
    return { visible: false, reason: "outside-vertical-fov" };
  }

  return { visible: true, reason: "visible" };
}

export function isPlacementLikelyVisible(
  camPos: Vector3,
  camForward: Vector3,
  targetPos: Vector3,
  options?: PlacementVisibilityOptions
): boolean {
  return evaluatePlacementVisibility(camPos, camForward, targetPos, options).visible;
}
