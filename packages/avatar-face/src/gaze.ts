import type { EyeGaze, FaceChannel } from "./canonical.js";

export const MAX_YAW = (30 * Math.PI) / 180;
export const MAX_PITCH = (25 * Math.PI) / 180;

type Weights = Partial<Record<FaceChannel, number>>;
const w = (weights: Weights, c: FaceChannel): number => weights[c] ?? 0;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Left eye: lookOut = toward avatar's left (+yaw), lookIn = toward nose (-yaw). Right eye mirrored. */
export function gazeFromArkit(weights: Weights): { left: EyeGaze; right: EyeGaze } {
  return {
    left: {
      yaw: (w(weights, "eyeLookOutLeft") - w(weights, "eyeLookInLeft")) * MAX_YAW,
      pitch: (w(weights, "eyeLookUpLeft") - w(weights, "eyeLookDownLeft")) * MAX_PITCH
    },
    right: {
      yaw: (w(weights, "eyeLookInRight") - w(weights, "eyeLookOutRight")) * MAX_YAW,
      pitch: (w(weights, "eyeLookUpRight") - w(weights, "eyeLookDownRight")) * MAX_PITCH
    }
  };
}

/** Inverse of gazeFromArkit (the eight eye-look channels only). */
export function arkitFromGaze(gaze: { left: EyeGaze; right: EyeGaze }): Weights {
  const { left, right } = gaze;
  return {
    eyeLookOutLeft: clamp01(left.yaw / MAX_YAW),
    eyeLookInLeft: clamp01(-left.yaw / MAX_YAW),
    eyeLookUpLeft: clamp01(left.pitch / MAX_PITCH),
    eyeLookDownLeft: clamp01(-left.pitch / MAX_PITCH),
    eyeLookInRight: clamp01(right.yaw / MAX_YAW),
    eyeLookOutRight: clamp01(-right.yaw / MAX_YAW),
    eyeLookUpRight: clamp01(right.pitch / MAX_PITCH),
    eyeLookDownRight: clamp01(-right.pitch / MAX_PITCH)
  };
}
