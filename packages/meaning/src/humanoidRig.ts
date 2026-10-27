import { VRM_HUMANOID_BONES, type VrmHumanoidBone, isVrmHumanoidBone } from "./humanoid.js";

/**
 * Canonical humanoid bone resolution for any avatar skeleton. Pure and
 * three-free: each app passes its nodes in and gets VRM 1.0 bones out.
 *
 * Priority: the file's own declaration (VRMC_vrm, VRM 0.x, HOLOIM_humanoid)
 * by node index, then per-standard name tables. No topology guessing.
 */

/** VRM 1.0 required bones: the minimum for a usable humanoid. */
export const VRM_REQUIRED_BONES: readonly VrmHumanoidBone[] = [
  "hips", "spine", "head",
  "leftUpperArm", "leftLowerArm", "leftHand", "rightUpperArm", "rightLowerArm", "rightHand",
  "leftUpperLeg", "leftLowerLeg", "leftFoot", "rightUpperLeg", "rightLowerLeg", "rightFoot"
];

export type HumanoidStandard =
  | "mixamo" | "vrm" | "unity" | "vroid" | "cc4" | "biped" | "unreal" | "meta" | "arkit";

export type HumanoidDeclarationFormat = "vrm1" | "vrm0" | "holoim";

export interface HumanoidNodeCandidate {
  /** Node name as loaded (three.js-sanitized) or raw from the glTF JSON; both normalize alike. */
  readonly name: string;
  /** glTF node index, or any stable id the caller maps back to its object. */
  readonly index: number;
  /** True for skin joints / bones. Only joints are matched by name. */
  readonly isJoint: boolean;
}

export interface HumanoidDeclaration {
  readonly format: HumanoidDeclarationFormat;
  readonly bones: Partial<Record<VrmHumanoidBone, number>>;
}

export interface HumanoidAmbiguity {
  readonly bone: VrmHumanoidBone;
  readonly chosen: number;
  readonly rejected: readonly number[];
}

export interface HumanoidMapping {
  /** Canonical bone → candidate index. */
  readonly bones: Partial<Record<VrmHumanoidBone, number>>;
  readonly source: "declaration" | "names" | "declaration+names" | "none";
  readonly declarationFormat?: HumanoidDeclarationFormat;
  readonly standard?: HumanoidStandard;
  readonly missingRequired: readonly VrmHumanoidBone[];
  readonly unmatched: readonly VrmHumanoidBone[];
  readonly ambiguities: readonly HumanoidAmbiguity[];
  readonly declarationErrors: readonly string[];
}

/**
 * Lowercase alphanumerics only. three.js `sanitizeNodeName` only drops or
 * replaces separators, so raw and sanitized names normalize to the same key
 * (`mixamorig1:Hips`, `mixamorig1Hips` → `mixamorig1hips`).
 */
export function normalizeBoneName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Stripped repeatedly in any order (`Armature|mixamorig:Hips`). `fullbody`
// is Meta's Unity skeleton (`FullBody_Hips`), `character<n>` HumanIK's.
const PREFIXES = [/^mixamorig\d*/, /^armature/, /^xrfullbodyjoint/, /^xrbodyjoint/, /^fullbody/, /^character\d*/];
const SUFFIXES = [/(fb|meta)$/];

/** Keys to try for one normalized name, most specific first. */
function lookupKeys(normalized: string): string[] {
  const keys = new Set<string>([normalized]);
  let stripped = normalized;
  for (let previous = ""; previous !== stripped; ) {
    previous = stripped;
    for (const re of PREFIXES) stripped = stripped.replace(re, "");
  }
  keys.add(stripped);
  if (normalized.startsWith("xr")) for (const re of SUFFIXES) keys.add(stripped.replace(re, ""));
  // Blender duplicate suffix: `Hips.001` → `hips001`, `Spine1.001` → `spine1001`.
  // Tried after the whole name, so a name that matches as is never loses digits.
  for (const key of [...keys]) if (/[a-z]\d*\d{3}$/.test(key)) keys.add(key.slice(0, -3));
  keys.delete("");
  return [...keys];
}

interface TableEntry {
  readonly bone: VrmHumanoidBone;
  /** Lower wins when several source bones can fill one canonical bone. */
  readonly priority: number;
}

type Side = "left" | "right";
const SIDES: readonly Side[] = ["left", "right"];
const cap = (s: string): string => s[0]!.toUpperCase() + s.slice(1);
const vrm = (side: Side, part: string): VrmHumanoidBone => `${side}${part}` as VrmHumanoidBone;
const FINGERS = ["Index", "Middle", "Ring", "Little"] as const;
const FINGER_JOINTS = ["Proximal", "Intermediate", "Distal"] as const;
const THUMB_JOINTS = ["Metacarpal", "Proximal", "Distal"] as const;
/** End sites (fingertips, toe ends) map to the last real bone only as a fallback. */
const END_SITE = 5;

type TableBuilder = (add: (name: string, bone: VrmHumanoidBone, priority?: number) => void) => void;

const TABLE_BUILDERS: Record<HumanoidStandard, TableBuilder> = {
  mixamo(add) {
    add("Hips", "hips"); add("Spine", "spine"); add("Spine1", "chest"); add("Spine2", "upperChest");
    add("Neck", "neck"); add("Head", "head");
    for (const side of SIDES) {
      const S = cap(side);
      add(`${S}Eye`, vrm(side, "Eye"));
      add(`${S}Shoulder`, vrm(side, "Shoulder")); add(`${S}Arm`, vrm(side, "UpperArm"));
      add(`${S}ForeArm`, vrm(side, "LowerArm")); add(`${S}Hand`, vrm(side, "Hand"));
      add(`${S}UpLeg`, vrm(side, "UpperLeg")); add(`${S}Leg`, vrm(side, "LowerLeg"));
      add(`${S}Foot`, vrm(side, "Foot")); add(`${S}ToeBase`, vrm(side, "Toes"));
      THUMB_JOINTS.forEach((j, i) => add(`${S}HandThumb${i + 1}`, vrm(side, `Thumb${j}`)));
      add(`${S}HandThumb4`, vrm(side, "ThumbDistal"), END_SITE);
      for (const f of FINGERS) {
        const src = f === "Little" ? "Pinky" : f;
        FINGER_JOINTS.forEach((j, i) => add(`${S}Hand${src}${i + 1}`, vrm(side, `${f}${j}`)));
        add(`${S}Hand${src}4`, vrm(side, `${f}Distal`), END_SITE);
      }
    }
  },
  vrm(add) {
    for (const bone of VRM_HUMANOID_BONES) add(bone, bone);
  },
  unity(add) {
    // Unity HumanBodyBones (and VRM 0.x): thumbs are Proximal/Intermediate/Distal.
    for (const bone of VRM_HUMANOID_BONES) if (!bone.includes("Thumb")) add(bone, bone);
    for (const side of SIDES) {
      add(vrm(side, "ThumbProximal"), vrm(side, "ThumbMetacarpal"));
      add(vrm(side, "ThumbIntermediate"), vrm(side, "ThumbProximal"));
      add(vrm(side, "ThumbDistal"), vrm(side, "ThumbDistal"));
    }
  },
  vroid(add) {
    add("J_Bip_C_Hips", "hips"); add("J_Bip_C_Spine", "spine"); add("J_Bip_C_Chest", "chest");
    add("J_Bip_C_UpperChest", "upperChest"); add("J_Bip_C_Neck", "neck"); add("J_Bip_C_Head", "head");
    for (const side of SIDES) {
      const L = side === "left" ? "L" : "R";
      add(`J_Adj_${L}_FaceEye`, vrm(side, "Eye"));
      for (const part of ["Shoulder", "UpperArm", "LowerArm", "Hand", "UpperLeg", "LowerLeg", "Foot"]) {
        add(`J_Bip_${L}_${part}`, vrm(side, part));
      }
      add(`J_Bip_${L}_ToeBase`, vrm(side, "Toes"));
      THUMB_JOINTS.forEach((j, i) => add(`J_Bip_${L}_Thumb${i + 1}`, vrm(side, `Thumb${j}`)));
      for (const f of FINGERS) FINGER_JOINTS.forEach((j, i) => add(`J_Bip_${L}_${f}${i + 1}`, vrm(side, `${f}${j}`)));
    }
  },
  cc4(add) {
    add("CC_Base_Hip", "hips"); add("CC_Base_Waist", "spine"); add("CC_Base_Spine01", "chest");
    add("CC_Base_Spine02", "upperChest"); add("CC_Base_NeckTwist01", "neck"); add("CC_Base_Head", "head");
    add("CC_Base_JawRoot", "jaw");
    for (const side of SIDES) {
      const L = side === "left" ? "L" : "R";
      add(`CC_Base_${L}_Eye`, vrm(side, "Eye"));
      add(`CC_Base_${L}_Clavicle`, vrm(side, "Shoulder")); add(`CC_Base_${L}_Upperarm`, vrm(side, "UpperArm"));
      add(`CC_Base_${L}_Forearm`, vrm(side, "LowerArm")); add(`CC_Base_${L}_Hand`, vrm(side, "Hand"));
      add(`CC_Base_${L}_Thigh`, vrm(side, "UpperLeg")); add(`CC_Base_${L}_Calf`, vrm(side, "LowerLeg"));
      add(`CC_Base_${L}_Foot`, vrm(side, "Foot")); add(`CC_Base_${L}_ToeBase`, vrm(side, "Toes"));
      THUMB_JOINTS.forEach((j, i) => add(`CC_Base_${L}_Thumb${i + 1}`, vrm(side, `Thumb${j}`)));
      for (const f of FINGERS) {
        const src = f === "Little" ? "Pinky" : f === "Middle" ? "Mid" : f;
        FINGER_JOINTS.forEach((j, i) => add(`CC_Base_${L}_${src}${i + 1}`, vrm(side, `${f}${j}`)));
      }
    }
  },
  biped(add) {
    // `Bip01 L UpperArm` / `Bip001 L UpperArm`; the root `Bip01` itself is the COM, not the hips.
    for (const root of ["Bip01", "Bip001"]) {
      add(`${root} Pelvis`, "hips"); add(`${root} Spine`, "spine"); add(`${root} Spine1`, "chest");
      add(`${root} Spine2`, "upperChest"); add(`${root} Neck`, "neck"); add(`${root} Head`, "head");
      for (const side of SIDES) {
        const p = `${root} ${side === "left" ? "L" : "R"} `;
        add(`${p}Clavicle`, vrm(side, "Shoulder")); add(`${p}UpperArm`, vrm(side, "UpperArm"));
        add(`${p}Forearm`, vrm(side, "LowerArm")); add(`${p}Hand`, vrm(side, "Hand"));
        add(`${p}Thigh`, vrm(side, "UpperLeg")); add(`${p}Calf`, vrm(side, "LowerLeg"));
        add(`${p}Foot`, vrm(side, "Foot")); add(`${p}Toe0`, vrm(side, "Toes"));
        THUMB_JOINTS.forEach((j, i) => add(`${p}Finger0${i === 0 ? "" : i}`, vrm(side, `Thumb${j}`)));
        FINGERS.forEach((f, n) =>
          FINGER_JOINTS.forEach((j, i) => add(`${p}Finger${n + 1}${i === 0 ? "" : i}`, vrm(side, `${f}${j}`))));
      }
    }
  },
  unreal(add) {
    // UE4 has spine_01..03, UE5 spine_01..05; the greedy pass gives upperChest the highest present.
    add("pelvis", "hips"); add("spine_01", "spine");
    add("spine_03", "chest"); add("spine_02", "chest", 1);
    add("spine_05", "upperChest"); add("spine_04", "upperChest", 1); add("spine_03", "upperChest", 2);
    add("neck_01", "neck"); add("head", "head");
    for (const side of SIDES) {
      const s = side === "left" ? "l" : "r";
      add(`clavicle_${s}`, vrm(side, "Shoulder")); add(`upperarm_${s}`, vrm(side, "UpperArm"));
      add(`lowerarm_${s}`, vrm(side, "LowerArm")); add(`hand_${s}`, vrm(side, "Hand"));
      add(`thigh_${s}`, vrm(side, "UpperLeg")); add(`calf_${s}`, vrm(side, "LowerLeg"));
      add(`foot_${s}`, vrm(side, "Foot")); add(`ball_${s}`, vrm(side, "Toes"));
      THUMB_JOINTS.forEach((j, i) => add(`thumb_0${i + 1}_${s}`, vrm(side, `Thumb${j}`)));
      for (const f of FINGERS) {
        const src = f === "Little" ? "pinky" : f.toLowerCase();
        FINGER_JOINTS.forEach((j, i) => add(`${src}_0${i + 1}_${s}`, vrm(side, `${f}${j}`)));
      }
    }
  },
  meta(add) {
    // Meta Movement SDK full body and OpenXR XR_FB_body_tracking / XR_META_body_tracking_full_body.
    add("Hips", "hips"); add("SpineLower", "spine");
    add("SpineUpper", "chest"); add("SpineMiddle", "chest", 1);
    add("Chest", "upperChest"); add("SpineUpper", "upperChest", 1);
    add("Neck", "neck"); add("Head", "head");
    for (const side of SIDES) {
      const S = cap(side);
      add(`${S}Scapula`, vrm(side, "Shoulder")); add(`${S}Shoulder`, vrm(side, "Shoulder"), 1);
      add(`${S}ArmUpper`, vrm(side, "UpperArm")); add(`${S}ArmLower`, vrm(side, "LowerArm"));
      add(`${S}HandWrist`, vrm(side, "Hand"));
      add(`${S}UpperLeg`, vrm(side, "UpperLeg")); add(`${S}LowerLeg`, vrm(side, "LowerLeg"));
      add(`${S}FootAnkle`, vrm(side, "Foot")); add(`${S}FootBall`, vrm(side, "Toes"));
      THUMB_JOINTS.forEach((j) => add(`${S}HandThumb${j}`, vrm(side, `Thumb${j}`)));
      add(`${S}HandThumbTip`, vrm(side, "ThumbDistal"), END_SITE);
      for (const f of FINGERS) {
        FINGER_JOINTS.forEach((j) => add(`${S}Hand${f}${j}`, vrm(side, `${f}${j}`)));
        add(`${S}Hand${f}Tip`, vrm(side, `${f}Distal`), END_SITE);
      }
    }
  },
  arkit(add) {
    add("hips_joint", "hips"); add("spine_1_joint", "spine");
    add("spine_4_joint", "chest"); add("spine_3_joint", "chest", 1);
    add("spine_7_joint", "upperChest"); add("spine_6_joint", "upperChest", 1);
    add("neck_1_joint", "neck"); add("head_joint", "head"); add("jaw_joint", "jaw");
    for (const side of SIDES) {
      add(`${side}_eye_joint`, vrm(side, "Eye"));
      add(`${side}_shoulder_1_joint`, vrm(side, "Shoulder")); add(`${side}_arm_joint`, vrm(side, "UpperArm"));
      add(`${side}_forearm_joint`, vrm(side, "LowerArm")); add(`${side}_hand_joint`, vrm(side, "Hand"));
      add(`${side}_upLeg_joint`, vrm(side, "UpperLeg")); add(`${side}_leg_joint`, vrm(side, "LowerLeg"));
      add(`${side}_foot_joint`, vrm(side, "Foot")); add(`${side}_toes_joint`, vrm(side, "Toes"));
      add(`${side}_handThumbStart_joint`, vrm(side, "ThumbMetacarpal"));
      add(`${side}_handThumb_1_joint`, vrm(side, "ThumbProximal"));
      add(`${side}_handThumb_2_joint`, vrm(side, "ThumbDistal"));
      add(`${side}_handThumbEnd_joint`, vrm(side, "ThumbDistal"), END_SITE);
      for (const f of FINGERS) {
        const src = f === "Little" ? "Pinky" : f === "Middle" ? "Mid" : f;
        FINGER_JOINTS.forEach((j, i) => add(`${side}_hand${src}_${i + 1}_joint`, vrm(side, `${f}${j}`)));
        add(`${side}_hand${src}End_joint`, vrm(side, `${f}Distal`), END_SITE);
      }
    }
  }
};

/** Normalized source key → entries, per standard. Built once; collisions inside a table throw at load. */
const TABLES: ReadonlyMap<HumanoidStandard, ReadonlyMap<string, readonly TableEntry[]>> = (() => {
  const tables = new Map<HumanoidStandard, Map<string, TableEntry[]>>();
  for (const [standard, build] of Object.entries(TABLE_BUILDERS) as [HumanoidStandard, TableBuilder][]) {
    const table = new Map<string, TableEntry[]>();
    build((name, bone, priority = 0) => {
      const key = normalizeBoneName(name);
      const entries = table.get(key) ?? [];
      if (entries.some((e) => e.bone === bone)) {
        throw new Error(`humanoid table ${standard}: ${name} maps to ${bone} twice`);
      }
      entries.push({ bone, priority });
      table.set(key, entries);
    });
    tables.set(standard, table);
  }
  return tables;
})();

export const HUMANOID_STANDARDS: readonly HumanoidStandard[] = Object.keys(TABLE_BUILDERS) as HumanoidStandard[];

/** VRM 0.x (and Unity) thumb names → VRM 1.0. */
const VRM0_THUMB: Readonly<Record<string, VrmHumanoidBone>> = {
  leftThumbProximal: "leftThumbMetacarpal", leftThumbIntermediate: "leftThumbProximal",
  leftThumbDistal: "leftThumbDistal", rightThumbProximal: "rightThumbMetacarpal",
  rightThumbIntermediate: "rightThumbProximal", rightThumbDistal: "rightThumbDistal"
};

/** A glTF node index; callers use negative ids for objects with no node, so a declaration never may. */
function isNodeIndex(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a humanoid declaration from glTF JSON: HOLOIM_humanoid (our export)
 * first, then VRMC_vrm (1.0), then VRM (0.x). Node indices are not validated
 * here; `resolveHumanoidRig` checks them against the candidates.
 */
export function readHumanoidDeclaration(gltfJson: unknown): HumanoidDeclaration | undefined {
  const extensions = isRecord(gltfJson) && isRecord(gltfJson.extensions) ? gltfJson.extensions : undefined;
  if (!extensions) return undefined;
  const fromMap = (format: HumanoidDeclarationFormat, raw: unknown): HumanoidDeclaration | undefined => {
    if (!isRecord(raw)) return undefined;
    const bones: Partial<Record<VrmHumanoidBone, number>> = {};
    for (const [bone, value] of Object.entries(raw)) {
      if (isVrmHumanoidBone(bone) && isRecord(value) && isNodeIndex(value.node)) bones[bone] = value.node;
    }
    return { format, bones };
  };
  // A malformed declaration falls through to the next one the file carries.
  const holoim = extensions.HOLOIM_humanoid;
  const fromHoloim = isRecord(holoim) ? fromMap("holoim", holoim.humanBones) : undefined;
  if (fromHoloim) return fromHoloim;
  const vrm1 = extensions.VRMC_vrm;
  const fromVrm1 = isRecord(vrm1) && isRecord(vrm1.humanoid) ? fromMap("vrm1", vrm1.humanoid.humanBones) : undefined;
  if (fromVrm1) return fromVrm1;
  const vrm0 = extensions.VRM;
  if (isRecord(vrm0) && isRecord(vrm0.humanoid) && Array.isArray(vrm0.humanoid.humanBones)) {
    const bones: Partial<Record<VrmHumanoidBone, number>> = {};
    for (const entry of vrm0.humanoid.humanBones as unknown[]) {
      if (!isRecord(entry) || typeof entry.bone !== "string" || !isNodeIndex(entry.node)) continue;
      const bone = Object.hasOwn(VRM0_THUMB, entry.bone) ? VRM0_THUMB[entry.bone] : entry.bone;
      if (isVrmHumanoidBone(bone)) bones[bone] = entry.node;
    }
    return { format: "vrm0", bones };
  }
  return undefined;
}

/** Order the greedy pass fills bones: upper spine first so UE5/ARKit/Meta spines take the highest bone. */
const FILL_ORDER: readonly VrmHumanoidBone[] = [
  "upperChest", "chest", ...VRM_HUMANOID_BONES.filter((b) => b !== "upperChest" && b !== "chest")
];

/**
 * Maps a skeleton to VRM 1.0 bones. Candidates should be passed in the
 * caller's preference order (for example the avatar's main skin joints
 * first): among duplicate names, the earlier candidate wins and the rest are
 * reported as ambiguities.
 */
export function resolveHumanoidRig(
  candidates: readonly HumanoidNodeCandidate[],
  declaration?: HumanoidDeclaration
): HumanoidMapping {
  const bones: Partial<Record<VrmHumanoidBone, number>> = {};
  const used = new Set<number>();
  const declarationErrors: string[] = [];
  const ambiguities: HumanoidAmbiguity[] = [];
  const byIndex = new Map(candidates.map((c) => [c.index, c]));

  if (declaration) {
    for (const [bone, index] of Object.entries(declaration.bones) as [VrmHumanoidBone, number][]) {
      const candidate = byIndex.get(index);
      if (!candidate) declarationErrors.push(`${bone}: node ${index} is not in the avatar`);
      else if (!candidate.isJoint) declarationErrors.push(`${bone}: node ${index} (${candidate.name}) is not a joint`);
      else if (used.has(index)) declarationErrors.push(`${bone}: node ${index} is already ${boneOf(bones, index)}`);
      else { bones[bone] = index; used.add(index); }
    }
  }
  const declaredCount = Object.keys(bones).length;

  // Score each standard by how many distinct joints it names, then fill from the best, falling back to the rest.
  const joints = candidates.filter((c) => c.isJoint && !used.has(c.index));
  const keysByCandidate = new Map(joints.map((c) => [c.index, lookupKeys(normalizeBoneName(c.name))]));
  const scores = HUMANOID_STANDARDS.map((standard) => {
    const table = TABLES.get(standard)!;
    const named = new Set<VrmHumanoidBone>();
    for (const c of joints) {
      const entries = keysByCandidate.get(c.index)!.map((k) => table.get(k)).find(Boolean);
      entries?.forEach((e) => named.add(e.bone));
    }
    return { standard, score: named.size };
  }).sort((a, b) => b.score - a.score);
  const best = scores[0]!.score > 0 ? scores[0]!.standard : undefined;

  let namedCount = 0;
  for (const { standard, score } of scores) {
    if (score === 0) break;
    const table = TABLES.get(standard)!;
    for (const bone of FILL_ORDER) {
      if (bones[bone] !== undefined) continue;
      const matches: { index: number; priority: number; order: number }[] = [];
      joints.forEach((c, order) => {
        if (used.has(c.index)) return;
        const entries = keysByCandidate.get(c.index)!.map((k) => table.get(k)).find(Boolean);
        const entry = entries?.find((e) => e.bone === bone);
        if (entry) matches.push({ index: c.index, priority: entry.priority, order });
      });
      if (matches.length === 0) continue;
      matches.sort((a, b) => a.priority - b.priority || a.order - b.order);
      const chosen = matches[0]!;
      bones[bone] = chosen.index;
      used.add(chosen.index);
      namedCount += 1;
      const rejected = matches.filter((m) => m !== chosen && m.priority === chosen.priority).map((m) => m.index);
      if (rejected.length > 0) ambiguities.push({ bone, chosen: chosen.index, rejected });
    }
  }

  const source = declaredCount > 0 ? (namedCount > 0 ? "declaration+names" : "declaration") : namedCount > 0 ? "names" : "none";
  return {
    bones,
    source,
    ...(declaration ? { declarationFormat: declaration.format } : {}),
    ...(best && namedCount > 0 ? { standard: best } : {}),
    missingRequired: VRM_REQUIRED_BONES.filter((b) => bones[b] === undefined),
    unmatched: VRM_HUMANOID_BONES.filter((b) => bones[b] === undefined),
    ambiguities,
    declarationErrors
  };
}

function boneOf(bones: Partial<Record<VrmHumanoidBone, number>>, index: number): string {
  return Object.entries(bones).find(([, i]) => i === index)?.[0] ?? "?";
}
