/** Apple ARKit's 52 blendshape names, in ARKit casing. "Left" is the avatar's own left. */
export const ARKIT_BLENDSHAPES = [
  "eyeBlinkLeft",
  "eyeLookDownLeft",
  "eyeLookInLeft",
  "eyeLookOutLeft",
  "eyeLookUpLeft",
  "eyeSquintLeft",
  "eyeWideLeft",
  "eyeBlinkRight",
  "eyeLookDownRight",
  "eyeLookInRight",
  "eyeLookOutRight",
  "eyeLookUpRight",
  "eyeSquintRight",
  "eyeWideRight",
  "jawForward",
  "jawLeft",
  "jawRight",
  "jawOpen",
  "mouthClose",
  "mouthFunnel",
  "mouthPucker",
  "mouthLeft",
  "mouthRight",
  "mouthSmileLeft",
  "mouthSmileRight",
  "mouthFrownLeft",
  "mouthFrownRight",
  "mouthDimpleLeft",
  "mouthDimpleRight",
  "mouthStretchLeft",
  "mouthStretchRight",
  "mouthRollLower",
  "mouthRollUpper",
  "mouthShrugLower",
  "mouthShrugUpper",
  "mouthPressLeft",
  "mouthPressRight",
  "mouthLowerDownLeft",
  "mouthLowerDownRight",
  "mouthUpperUpLeft",
  "mouthUpperUpRight",
  "browDownLeft",
  "browDownRight",
  "browInnerUp",
  "browOuterUpLeft",
  "browOuterUpRight",
  "cheekPuff",
  "cheekSquintLeft",
  "cheekSquintRight",
  "noseSneerLeft",
  "noseSneerRight",
  "tongueOut"
] as const;
export type ArkitBlendshape = (typeof ARKIT_BLENDSHAPES)[number];

/** The 15 Oculus/Meta lip-sync visemes (also used by Ready Player Me). */
export const OCULUS_VISEMES = [
  "viseme_sil",
  "viseme_PP",
  "viseme_FF",
  "viseme_TH",
  "viseme_DD",
  "viseme_kk",
  "viseme_CH",
  "viseme_SS",
  "viseme_nn",
  "viseme_RR",
  "viseme_aa",
  "viseme_E",
  "viseme_I",
  "viseme_O",
  "viseme_U"
] as const;
export type OculusViseme = (typeof OCULUS_VISEMES)[number];

export type FaceChannel = ArkitBlendshape | OculusViseme;
export const FACE_CHANNELS: readonly FaceChannel[] = [...ARKIT_BLENDSHAPES, ...OCULUS_VISEMES];

/** Radians. yaw + = toward the avatar's own left, pitch + = up. */
export type EyeGaze = { yaw: number; pitch: number };

export type FaceFrame = {
  weights: Partial<Record<FaceChannel, number>>;
  gaze?: { left: EyeGaze; right: EyeGaze };
};
