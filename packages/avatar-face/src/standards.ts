import {
  ARKIT_BLENDSHAPES,
  OCULUS_VISEMES,
  type FaceChannel
} from "./canonical.js";
import type { TargetFormula } from "./formula.js";
import { normalizeMorphName } from "./normalize.js";

export type FaceStandard =
  | "arkit"
  | "oculus-viseme"
  | "vrm0"
  | "vrm1"
  | "meta-fb2"
  | "cc4"
  | "rpm-legacy";

export const FACE_STANDARDS: readonly FaceStandard[] = [
  "arkit",
  "oculus-viseme",
  "vrm0",
  "vrm1",
  "meta-fb2",
  "cc4",
  "rpm-legacy"
];

type Weights = Partial<Record<FaceChannel, number>>;
/** One canonical contribution of a standard-specific channel: weight * scale. */
type SourceTerm = { channel: FaceChannel; scale: number };
type SourceTable = Record<string, readonly SourceTerm[]>;
type Pair = readonly [name: string, channel: FaceChannel, scale?: number];

const term = (channel: FaceChannel, scale = 1): SourceTerm => ({ channel, scale });
const formula = (op: TargetFormula["op"], ...terms: SourceTerm[]): TargetFormula => ({ op, terms });
const ch = (name: string): FaceChannel => name as FaceChannel;
/** `lr("Eye_Blink", "eyeBlink")` -> Eye_Blink_L/_R <-> eyeBlinkLeft/Right. */
const lr = (prefix: string, base: string, scale = 1): Pair[] => [
  [`${prefix}_L`, ch(`${base}Left`), scale],
  [`${prefix}_R`, ch(`${base}Right`), scale]
];

function fromPairs(pairs: readonly Pair[]): {
  targets: Record<string, TargetFormula>;
  sources: SourceTable;
} {
  const targets: Record<string, TargetFormula> = {};
  const sources: SourceTable = {};
  for (const [name, channel, scale = 1] of pairs) {
    targets[name] = formula("max", term(channel, scale));
    sources[name] = [term(channel, 1 / scale)];
  }
  return { targets, sources };
}

const identityTable = (channels: readonly FaceChannel[]): Record<string, TargetFormula> =>
  Object.fromEntries(channels.map((c) => [c, formula("max", term(c))]));

// --- VRM -----------------------------------------------------------------
// Canonical -> expression weight. Documented approximations, "left" = avatar's left.
const smile = [term("mouthSmileLeft"), term("mouthSmileRight")];
const VRM1_TARGETS: Record<string, TargetFormula> = {
  neutral: formula("sum"),
  happy: formula("mean", ...smile),
  angry: formula("mean", term("browDownLeft"), term("browDownRight")),
  sad: formula(
    "mean",
    term("mouthFrownLeft"),
    term("mouthFrownRight"),
    term("browInnerUp")
  ),
  relaxed: formula(
    "mean",
    ...smile.map((t) => term(t.channel, 0.5)),
    term("cheekSquintLeft", 0.5),
    term("cheekSquintRight", 0.5)
  ),
  surprised: formula(
    "mean",
    term("eyeWideLeft"),
    term("eyeWideRight"),
    term("browInnerUp"),
    term("jawOpen", 0.5)
  ),
  aa: formula("max", term("jawOpen", 0.8), term("viseme_aa")),
  ih: formula("max", term("viseme_I"), term("mouthStretchLeft", 0.5), term("mouthStretchRight", 0.5)),
  ou: formula("max", term("viseme_U"), term("mouthPucker")),
  ee: formula("max", term("viseme_E"), term("mouthSmileLeft", 0.4), term("mouthSmileRight", 0.4)),
  oh: formula("max", term("viseme_O"), term("mouthFunnel")),
  blink: formula("min", term("eyeBlinkLeft"), term("eyeBlinkRight")),
  blinkLeft: formula("max", term("eyeBlinkLeft")),
  blinkRight: formula("max", term("eyeBlinkRight")),
  lookUp: formula("mean", term("eyeLookUpLeft"), term("eyeLookUpRight")),
  lookDown: formula("mean", term("eyeLookDownLeft"), term("eyeLookDownRight")),
  // Toward the avatar's own left / right.
  lookLeft: formula("mean", term("eyeLookOutLeft"), term("eyeLookInRight")),
  lookRight: formula("mean", term("eyeLookInLeft"), term("eyeLookOutRight"))
};

/** VRM0 preset name -> VRM1 preset name where the semantics match. */
const VRM0_TO_VRM1: Record<string, string> = {
  neutral: "neutral",
  joy: "happy",
  angry: "angry",
  sorrow: "sad",
  fun: "relaxed",
  a: "aa",
  i: "ih",
  u: "ou",
  e: "ee",
  o: "oh",
  blink: "blink",
  blink_l: "blinkLeft", // VRM0 blink_l is the avatar's left
  blink_r: "blinkRight",
  lookup: "lookUp",
  lookdown: "lookDown",
  lookleft: "lookLeft",
  lookright: "lookRight"
};
const VRM0_TARGETS: Record<string, TargetFormula> = Object.fromEntries(
  Object.entries(VRM0_TO_VRM1).map(([k, v]) => [k, VRM1_TARGETS[v] as TargetFormula])
);

// Expression weight -> canonical contributions.
const VRM1_SOURCES: SourceTable = {
  neutral: [],
  happy: smile,
  angry: [term("browDownLeft"), term("browDownRight")],
  sad: [term("mouthFrownLeft"), term("mouthFrownRight"), term("browInnerUp")],
  relaxed: [term("mouthSmileLeft", 0.5), term("mouthSmileRight", 0.5)],
  surprised: [term("eyeWideLeft"), term("eyeWideRight"), term("browInnerUp"), term("jawOpen", 0.5)],
  aa: [term("jawOpen", 0.8), term("viseme_aa")],
  ih: [term("viseme_I")],
  ou: [term("viseme_U"), term("mouthPucker")],
  ee: [term("viseme_E")],
  oh: [term("viseme_O"), term("mouthFunnel")],
  blink: [term("eyeBlinkLeft"), term("eyeBlinkRight")],
  blinkLeft: [term("eyeBlinkLeft")],
  blinkRight: [term("eyeBlinkRight")],
  lookUp: [term("eyeLookUpLeft"), term("eyeLookUpRight")],
  lookDown: [term("eyeLookDownLeft"), term("eyeLookDownRight")],
  lookLeft: [term("eyeLookOutLeft"), term("eyeLookInRight")],
  lookRight: [term("eyeLookInLeft"), term("eyeLookOutRight")]
};
const VRM0_SOURCES: SourceTable = Object.fromEntries(
  Object.entries(VRM0_TO_VRM1).map(([k, v]) => [k, VRM1_SOURCES[v] as readonly SourceTerm[]])
);

// --- Meta XR_FB_face_tracking2 (70 expressions; "_L" is the user's left) ---
const META_PAIRS: Pair[] = [
  ...lr("BROW_LOWERER", "browDown"),
  ["CHEEK_PUFF_L", "cheekPuff"],
  ["CHEEK_PUFF_R", "cheekPuff"],
  ...lr("CHEEK_RAISER", "cheekSquint"),
  ["CHIN_RAISER_B", "mouthShrugLower"],
  ["CHIN_RAISER_T", "mouthShrugUpper"],
  ...lr("DIMPLER", "mouthDimple"),
  ...lr("EYES_CLOSED", "eyeBlink"),
  ["EYES_LOOK_DOWN_L", "eyeLookDownLeft"],
  ["EYES_LOOK_DOWN_R", "eyeLookDownRight"],
  ["EYES_LOOK_UP_L", "eyeLookUpLeft"],
  ["EYES_LOOK_UP_R", "eyeLookUpRight"],
  // Looking to the user's left: out for the left eye, in for the right eye.
  ["EYES_LOOK_LEFT_L", "eyeLookOutLeft"],
  ["EYES_LOOK_LEFT_R", "eyeLookInRight"],
  ["EYES_LOOK_RIGHT_L", "eyeLookInLeft"],
  ["EYES_LOOK_RIGHT_R", "eyeLookOutRight"],
  ["INNER_BROW_RAISER_L", "browInnerUp"],
  ["INNER_BROW_RAISER_R", "browInnerUp"],
  ["JAW_DROP", "jawOpen"],
  ["JAW_SIDEWAYS_LEFT", "jawLeft"],
  ["JAW_SIDEWAYS_RIGHT", "jawRight"],
  ["JAW_THRUST", "jawForward"],
  ...lr("LID_TIGHTENER", "eyeSquint"),
  ...lr("LIP_CORNER_DEPRESSOR", "mouthFrown"),
  ...lr("LIP_CORNER_PULLER", "mouthSmile"),
  ["LIP_FUNNELER_LB", "mouthFunnel"],
  ["LIP_FUNNELER_LT", "mouthFunnel"],
  ["LIP_FUNNELER_RB", "mouthFunnel"],
  ["LIP_FUNNELER_RT", "mouthFunnel"],
  ...lr("LIP_PRESSOR", "mouthPress"),
  ["LIP_PUCKER_L", "mouthPucker"],
  ["LIP_PUCKER_R", "mouthPucker"],
  ...lr("LIP_STRETCHER", "mouthStretch"),
  ["LIP_SUCK_LB", "mouthRollLower"],
  ["LIP_SUCK_RB", "mouthRollLower"],
  ["LIP_SUCK_LT", "mouthRollUpper"],
  ["LIP_SUCK_RT", "mouthRollUpper"],
  ["LIP_TIGHTENER_L", "mouthPressLeft", 0.5],
  ["LIP_TIGHTENER_R", "mouthPressRight", 0.5],
  ["LIPS_TOWARD", "mouthClose"],
  ...lr("LOWER_LIP_DEPRESSOR", "mouthLowerDown"),
  ["MOUTH_LEFT", "mouthLeft"],
  ["MOUTH_RIGHT", "mouthRight"],
  ...lr("NOSE_WRINKLER", "noseSneer"),
  ...lr("OUTER_BROW_RAISER", "browOuterUp"),
  ...lr("UPPER_LID_RAISER", "eyeWide"),
  ...lr("UPPER_LIP_RAISER", "mouthUpperUp"),
  ["TONGUE_OUT", "tongueOut"],
  ["TONGUE_TIP_INTERDENTAL", "tongueOut", 0.5]
];
// Not mapped (no ARKit counterpart): CHEEK_SUCK_L/R, TONGUE_TIP_ALVEOLAR,
// TONGUE_FRONT_DORSAL_PALATE, TONGUE_MID_DORSAL_PALATE, TONGUE_BACK_DORSAL_VELAR, TONGUE_RETREAT.
const META = fromPairs(META_PAIRS);

// --- Character Creator 4 / common Unity-Unreal facial rigs ----------------
const CC4_PAIRS: Pair[] = [
  ...lr("Eye_Blink", "eyeBlink"),
  ...lr("Eye_Squint", "eyeSquint"),
  ...lr("Eye_Wide", "eyeWide"),
  ["Eye_L_Look_Up", "eyeLookUpLeft"],
  ["Eye_L_Look_Down", "eyeLookDownLeft"],
  ["Eye_L_Look_L", "eyeLookOutLeft"],
  ["Eye_L_Look_R", "eyeLookInLeft"],
  ["Eye_R_Look_Up", "eyeLookUpRight"],
  ["Eye_R_Look_Down", "eyeLookDownRight"],
  ["Eye_R_Look_L", "eyeLookInRight"],
  ["Eye_R_Look_R", "eyeLookOutRight"],
  ["Brow_Raise_Inner_L", "browInnerUp"],
  ["Brow_Raise_Inner_R", "browInnerUp"],
  ...lr("Brow_Raise_Outer", "browOuterUp"),
  ...lr("Brow_Drop", "browDown"),
  ["Cheek_Puff_L", "cheekPuff"],
  ["Cheek_Puff_R", "cheekPuff"],
  ...lr("Cheek_Raise", "cheekSquint"),
  ...lr("Nose_Sneer", "noseSneer"),
  ["Jaw_Open", "jawOpen"],
  ["Jaw_Forward", "jawForward"],
  ["Jaw_L", "jawLeft"],
  ["Jaw_R", "jawRight"],
  ["Mouth_Close", "mouthClose"],
  ["Mouth_Funnel", "mouthFunnel"],
  ["Mouth_Pucker", "mouthPucker"],
  ["Mouth_L", "mouthLeft"],
  ["Mouth_R", "mouthRight"],
  ...lr("Mouth_Smile", "mouthSmile"),
  ...lr("Mouth_Frown", "mouthFrown"),
  ...lr("Mouth_Dimple", "mouthDimple"),
  ...lr("Mouth_Stretch", "mouthStretch"),
  ["Mouth_Roll_In_Upper_L", "mouthRollUpper"],
  ["Mouth_Roll_In_Upper_R", "mouthRollUpper"],
  ["Mouth_Roll_In_Lower_L", "mouthRollLower"],
  ["Mouth_Roll_In_Lower_R", "mouthRollLower"],
  ["Mouth_Shrug_Upper", "mouthShrugUpper"],
  ["Mouth_Shrug_Lower", "mouthShrugLower"],
  ...lr("Mouth_Press", "mouthPress"),
  ["Mouth_Down_Lower_L", "mouthLowerDownLeft"],
  ["Mouth_Down_Lower_R", "mouthLowerDownRight"],
  ["Mouth_Up_Upper_L", "mouthUpperUpLeft"],
  ["Mouth_Up_Upper_R", "mouthUpperUpRight"],
  ["Tongue_Out", "tongueOut"]
];
const CC4 = fromPairs(CC4_PAIRS);

// --- Ready Player Me legacy -------------------------------------------------
const RPM_TARGETS: Record<string, TargetFormula> = {
  mouthOpen: formula("max", term("jawOpen"), term("viseme_aa", 0.8)),
  mouthSmile: formula("mean", ...smile)
};
const RPM_SOURCES: SourceTable = {
  mouthOpen: [term("jawOpen")],
  mouthSmile: smile
};

/** Canonical -> avatar target direction: standard morph/expression name -> formula. */
export const TARGET_TABLES: Record<FaceStandard, Record<string, TargetFormula>> = {
  arkit: identityTable(ARKIT_BLENDSHAPES),
  "oculus-viseme": identityTable(OCULUS_VISEMES),
  vrm0: VRM0_TARGETS,
  vrm1: VRM1_TARGETS,
  "meta-fb2": META.targets,
  cc4: CC4.targets,
  "rpm-legacy": RPM_TARGETS
};

const identitySource = (channels: readonly FaceChannel[]): SourceTable =>
  Object.fromEntries(channels.map((c) => [c, [term(c)]]));

/** Standard -> canonical direction: standard channel name -> canonical contributions. */
export const SOURCE_TABLES: Record<FaceStandard, SourceTable> = {
  // MediaPipe uses ARKit names plus `_neutral`, which has no entry and is ignored.
  arkit: identitySource(ARKIT_BLENDSHAPES),
  "oculus-viseme": identitySource(OCULUS_VISEMES),
  vrm0: VRM0_SOURCES,
  vrm1: VRM1_SOURCES,
  "meta-fb2": META.sources,
  cc4: CC4.sources,
  "rpm-legacy": RPM_SOURCES
};

const sourceIndexes = new Map<FaceStandard, Map<string, readonly SourceTerm[]>>();

/**
 * Converts a standard's weights (keyed by that standard's channel names, matched
 * after normalization) into canonical channels. Unknown names are ignored;
 * contributions to one channel combine with max; results are clamped to 0..1.
 */
export function toCanonical(standard: FaceStandard, weights: Record<string, number>): Weights {
  let index = sourceIndexes.get(standard);
  if (!index) {
    index = new Map();
    for (const [name, terms] of Object.entries(SOURCE_TABLES[standard])) {
      const key = normalizeMorphName(name);
      if (!index.has(key)) index.set(key, terms);
    }
    sourceIndexes.set(standard, index);
  }
  const out: Weights = {};
  for (const [name, value] of Object.entries(weights)) {
    const terms = index.get(normalizeMorphName(name));
    if (!terms || !Number.isFinite(value)) continue;
    for (const { channel, scale } of terms) {
      const v = Math.min(1, Math.max(0, value * scale));
      out[channel] = Math.max(out[channel] ?? 0, v);
    }
  }
  return out;
}
