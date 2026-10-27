import { describe, expect, it } from "vitest";

import { readHumanoidDeclaration, resolveHumanoidRig, type HumanoidNodeCandidate } from "./humanoidRig.js";

// Cases come from the failure list in docs/features/avatar-formats.md.
const joints = (names: readonly string[]): HumanoidNodeCandidate[] =>
  names.map((name, index) => ({ name, index, isJoint: true }));
const named = (names: readonly string[], declaration?: Parameters<typeof resolveHumanoidRig>[1]) => {
  const mapping = resolveHumanoidRig(joints(names), declaration);
  return { mapping, bone: (b: keyof typeof mapping.bones) => (mapping.bones[b] === undefined ? undefined : names[mapping.bones[b]!]) };
};

describe("resolveHumanoidRig", () => {
  it("matches three.js-sanitized and raw Mixamo, Blender-suffixed and Biped names alike", () => {
    expect(named(["mixamorig1Hips", "mixamorig1:Spine"]).bone("spine")).toBe("mixamorig1:Spine");
    expect(named(["mixamorig1Hips"]).bone("hips")).toBe("mixamorig1Hips");
    expect(named(["Hips.001"]).bone("hips")).toBe("Hips.001");
    expect(named(["Hips001"]).bone("hips")).toBe("Hips001");
    expect(named(["Bip01_L_UpperArm", "Bip01 R UpperArm"]).bone("leftUpperArm")).toBe("Bip01_L_UpperArm");
    expect(named(["Bip01_L_UpperArm", "Bip01 R UpperArm"]).bone("rightUpperArm")).toBe("Bip01 R UpperArm");
  });

  it("strips Blender suffixes after a digit, and stacked or vendor prefixes", () => {
    const blender = named(["Hips.001", "Spine.001", "Spine1.001", "Spine2.001", "LeftHandIndex1.001"]);
    expect([blender.bone("spine"), blender.bone("chest"), blender.bone("upperChest")]).toEqual(["Spine.001", "Spine1.001", "Spine2.001"]);
    expect(blender.bone("leftIndexProximal")).toBe("LeftHandIndex1.001");
    expect(named(["Armature|mixamorig:Hips"]).bone("hips")).toBe("Armature|mixamorig:Hips");
    expect(named(["Character1_Hips"]).bone("hips")).toBe("Character1_Hips");
    expect(named(["FullBody_Hips", "FullBody_LeftArmUpper"]).bone("leftUpperArm")).toBe("FullBody_LeftArmUpper");
  });

  it("never lets an end site beat the real distal bone, whatever the order", () => {
    const r = named(["LeftHandIndex4", "LeftHandIndex3", "LeftHandIndex2", "LeftHandIndex1"]);
    expect(r.bone("leftIndexDistal")).toBe("LeftHandIndex3");
    expect(r.mapping.ambiguities).toEqual([]);
  });

  it("gives the Unreal upper chest the highest spine present (UE4 vs UE5)", () => {
    const ue4 = named(["pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "head"]);
    expect([ue4.bone("spine"), ue4.bone("chest"), ue4.bone("upperChest")]).toEqual(["spine_01", "spine_02", "spine_03"]);
    const ue5 = named(["pelvis", "spine_01", "spine_02", "spine_03", "spine_04", "spine_05", "neck_01", "head"]);
    expect([ue5.bone("spine"), ue5.bone("chest"), ue5.bone("upperChest")]).toEqual(["spine_01", "spine_03", "spine_05"]);
  });

  it("reads Unity/VRM 0.x thumbs (Proximal/Intermediate/Distal) as VRM 1.0 metacarpal/proximal/distal", () => {
    const unity = named(["LeftThumbProximal", "LeftThumbIntermediate", "LeftThumbDistal", "LeftIndexProximal"]);
    expect(unity.mapping.standard).toBe("unity");
    expect(unity.bone("leftThumbMetacarpal")).toBe("LeftThumbProximal");
    expect(unity.bone("leftThumbProximal")).toBe("LeftThumbIntermediate");
    const vrm1 = named(["leftThumbMetacarpal", "leftThumbProximal", "leftThumbDistal"]);
    expect(vrm1.bone("leftThumbProximal")).toBe("leftThumbProximal");
  });

  it("prefers the earlier candidate among duplicate names and reports the rest", () => {
    const r = named(["Hips", "Spine", "Hips"]);
    expect(r.mapping.bones.hips).toBe(0);
    expect(r.mapping.ambiguities).toEqual([{ bone: "hips", chosen: 0, rejected: [2] }]);
  });

  it("ignores meshes even when they carry a bone name", () => {
    const mapping = resolveHumanoidRig([{ name: "Head", index: 0, isJoint: false }]);
    expect(mapping.bones.head).toBeUndefined();
    expect(mapping.source).toBe("none");
  });

  it("uses a declaration by node index, reports bad entries and fills the rest from names", () => {
    const candidates: HumanoidNodeCandidate[] = [
      { name: "bone_0", index: 0, isJoint: true },
      { name: "Spine", index: 1, isJoint: true },
      { name: "mesh", index: 2, isJoint: false }
    ];
    const mapping = resolveHumanoidRig(candidates, { format: "vrm1", bones: { hips: 0, head: 2, chest: 9 } });
    expect(mapping.bones).toMatchObject({ hips: 0, spine: 1 });
    expect(mapping.bones.head).toBeUndefined();
    expect(mapping.source).toBe("declaration+names");
    expect(mapping.declarationErrors).toEqual(["head: node 2 (mesh) is not a joint", "chest: node 9 is not in the avatar"]);
  });

  it("reports every required bone missing on an unmappable rig", () => {
    const mapping = resolveHumanoidRig(joints(["j0", "j1", "j2"]));
    expect(mapping.source).toBe("none");
    expect(mapping.missingRequired).toHaveLength(15);
  });
});

describe("readHumanoidDeclaration", () => {
  it("reads HOLOIM_humanoid before VRMC_vrm, and converts VRM 0.x thumbs", () => {
    expect(readHumanoidDeclaration({
      extensions: { HOLOIM_humanoid: { humanBones: { hips: { node: 1 } } }, VRMC_vrm: { humanoid: { humanBones: { hips: { node: 2 } } } } }
    })).toEqual({ format: "holoim", bones: { hips: 1 } });
    expect(readHumanoidDeclaration({
      extensions: { VRM: { humanoid: { humanBones: [{ bone: "leftThumbProximal", node: 4 }, { bone: "leftThumbIntermediate", node: 5 }, { bone: "nope", node: 6 }] } } }
    })).toEqual({ format: "vrm0", bones: { leftThumbMetacarpal: 4, leftThumbProximal: 5 } });
    expect(readHumanoidDeclaration({ extensions: { VRMC_vrm: { humanoid: { humanBones: { hips: { node: "3" } } } } } }))
      .toEqual({ format: "vrm1", bones: {} });
    // Negative ids name objects without a node in the apps' adapters; a declaration must never reach them.
    expect(readHumanoidDeclaration({ extensions: { HOLOIM_humanoid: { humanBones: { hips: { node: -1 }, head: { node: 0 } } } } }))
      .toEqual({ format: "holoim", bones: { head: 0 } });
    expect(readHumanoidDeclaration({ extensions: { VRM: { humanoid: { humanBones: [{ bone: "hips", node: -2 }] } } } }))
      .toEqual({ format: "vrm0", bones: {} });
    expect(readHumanoidDeclaration({ extensions: { HOLOIM_humanoid: { humanBones: [] }, VRMC_vrm: { humanoid: { humanBones: { hips: { node: 2 } } } } } }))
      .toEqual({ format: "vrm1", bones: { hips: 2 } });
    expect(readHumanoidDeclaration({})).toBeUndefined();
    expect(readHumanoidDeclaration(null)).toBeUndefined();
  });
});
