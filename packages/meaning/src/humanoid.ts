/** VRM 1.0 humanoid bone names (https://github.com/vrm-c/vrm-specification), the vocabulary of `HOLOIM_meaning` bones. */
export const VRM_HUMANOID_BONES = [
  "hips", "spine", "chest", "upperChest", "neck", "head",
  "leftEye", "rightEye", "jaw",
  "leftUpperLeg", "leftLowerLeg", "leftFoot", "leftToes",
  "rightUpperLeg", "rightLowerLeg", "rightFoot", "rightToes",
  "leftShoulder", "leftUpperArm", "leftLowerArm", "leftHand",
  "rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand",
  "leftThumbMetacarpal", "leftThumbProximal", "leftThumbDistal",
  "leftIndexProximal", "leftIndexIntermediate", "leftIndexDistal",
  "leftMiddleProximal", "leftMiddleIntermediate", "leftMiddleDistal",
  "leftRingProximal", "leftRingIntermediate", "leftRingDistal",
  "leftLittleProximal", "leftLittleIntermediate", "leftLittleDistal",
  "rightThumbMetacarpal", "rightThumbProximal", "rightThumbDistal",
  "rightIndexProximal", "rightIndexIntermediate", "rightIndexDistal",
  "rightMiddleProximal", "rightMiddleIntermediate", "rightMiddleDistal",
  "rightRingProximal", "rightRingIntermediate", "rightRingDistal",
  "rightLittleProximal", "rightLittleIntermediate", "rightLittleDistal"
] as const;

export type VrmHumanoidBone = (typeof VRM_HUMANOID_BONES)[number];

const VRM_BONE_SET: ReadonlySet<string> = new Set(VRM_HUMANOID_BONES);

export function isVrmHumanoidBone(name: unknown): name is VrmHumanoidBone {
  return typeof name === "string" && VRM_BONE_SET.has(name);
}

type Side = "Left" | "Right";

/**
 * Mixamo rig names (without the `mixamorig` prefix) to VRM bones, built for
 * both sides. Mixamo finger joints are numbered 1..4 where 4 is the end site
 * (the fingertip), which has no VRM bone; it aliases to the distal bone because
 * a fingertip anchor belongs to that bone. Thumbs: 1 metacarpal, 2 proximal,
 * 3 and 4 distal. Mixamo has no eyes, jaw or upperChest-less spine: Spine,
 * Spine1, Spine2 map to spine, chest, upperChest.
 */
function buildMixamoTable(): Readonly<Record<string, VrmHumanoidBone>> {
  const table: Record<string, VrmHumanoidBone> = {
    Hips: "hips",
    Spine: "spine",
    Spine1: "chest",
    Spine2: "upperChest",
    Neck: "neck",
    Head: "head"
  };
  const sides: Side[] = ["Left", "Right"];
  for (const side of sides) {
    const lower = side.toLowerCase();
    const set = (mixamo: string, vrm: string): void => {
      table[`${side}${mixamo}`] = `${lower}${vrm}` as VrmHumanoidBone;
    };
    set("Shoulder", "Shoulder");
    set("Arm", "UpperArm");
    set("ForeArm", "LowerArm");
    set("Hand", "Hand");
    set("UpLeg", "UpperLeg");
    set("Leg", "LowerLeg");
    set("Foot", "Foot");
    set("ToeBase", "Toes");
    const thumb = ["ThumbMetacarpal", "ThumbProximal", "ThumbDistal", "ThumbDistal"];
    thumb.forEach((vrm, i) => set(`HandThumb${i + 1}`, vrm));
    for (const finger of ["Index", "Middle", "Ring", "Pinky"]) {
      const vrmFinger = finger === "Pinky" ? "Little" : finger;
      const joints = ["Proximal", "Intermediate", "Distal", "Distal"];
      joints.forEach((joint, i) => set(`Hand${finger}${i + 1}`, `${vrmFinger}${joint}`));
    }
  }
  return table;
}

export const MIXAMO_TO_VRM: Readonly<Record<string, VrmHumanoidBone>> = buildMixamoTable();

/** Matches `mixamorig`, `mixamorig:` and Blender/Maya-numbered `mixamorig1:` / `mixamorig1`. */
const MIXAMO_PREFIX = /^mixamorig\d*:?/;

/**
 * Resolves a VRM bone name or a Mixamo rig name (bare or prefixed) to the VRM
 * humanoid bone, or undefined when it is neither. Lookup is case-sensitive
 * and never touches the prototype chain.
 */
export function resolveHumanoidBone(name: string): VrmHumanoidBone | undefined {
  if (isVrmHumanoidBone(name)) return name;
  const bare = name.replace(MIXAMO_PREFIX, "");
  return Object.hasOwn(MIXAMO_TO_VRM, bare) ? MIXAMO_TO_VRM[bare] : undefined;
}
