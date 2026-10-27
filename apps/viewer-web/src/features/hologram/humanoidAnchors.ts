import {
  type HumanoidDeclarationFormat,
  type HumanoidNodeCandidate,
  readHumanoidDeclaration,
  resolveHumanoidRig,
  type VrmHumanoidBone
} from "@holoim/meaning";
import type { Object3D } from "three";

import { mapNodeIndices } from "../meaning/meaningLinks";

// The recorded author's bones on a loaded hologram, for any avatar format.
// Order: the export's HOLOIM_humanoid (or a VRM file's own map) by node
// index, then the shared name tables of @holoim/meaning, then the Ready
// Player Me names the viewer has always looked up. All within the
// RecordedAvatar subtree when the export names it, so a prop's "Head" never
// takes over.

/** Tags the resolved bones and the root: tests and debug tools read these, never object references in userData. */
export const HUMANOID_BONE_TAG = "holoimHumanoidBone";
export const HUMANOID_SOURCE_TAG = "holoimHumanoidSource";

const AVATAR_NAME = "RecordedAvatar";
const LEGACY_NAMES: Partial<Record<VrmHumanoidBone, readonly string[]>> = {
  hips: ["Hips", "mixamorigHips"],
  head: ["Head", "mixamorigHead"]
};

export type HumanoidAnchorSource = HumanoidDeclarationFormat | "names" | "legacy" | "none";

export type HumanoidAnchors = {
  /** The RecordedAvatar subtree, or the whole scene for files without one. */
  scope: Object3D;
  hips: Object3D | null;
  head: Object3D | null;
  bones: ReadonlyMap<VrmHumanoidBone, Object3D>;
  /** Where the hips came from. */
  source: HumanoidAnchorSource;
};

/** What the resolver needs of a loader result; the clone may be the loaded scene itself. */
export type HumanoidGltf = {
  scene: Object3D;
  parser?: { json?: unknown; associations?: Map<unknown, { nodes?: number } | undefined> };
};

type BoneLike = Object3D & { isBone?: boolean };
type SkinnedLike = Object3D & { isSkinnedMesh?: boolean; skeleton?: { bones: Object3D[] } };

export function resolveHumanoidAnchors(root: Object3D, gltf?: HumanoidGltf): HumanoidAnchors {
  const scope = root.getObjectByName(AVATAR_NAME) ?? root;
  const indexOf = new Map<Object3D, number>();
  if (gltf?.parser?.associations) {
    for (const [index, object] of mapNodeIndices(gltf.scene, root, gltf.parser.associations)) indexOf.set(object, index);
  }

  // Candidates in preference order, as capture binds them: joints of the
  // largest skin, then other bones, then everything else.
  const skins: Object3D[][] = [];
  const inScope = new Set<Object3D>();
  scope.traverse((object) => {
    inScope.add(object);
    const mesh = object as SkinnedLike;
    if (mesh.isSkinnedMesh && mesh.skeleton) skins.push(mesh.skeleton.bones);
  });
  skins.sort((a, b) => b.length - a.length);
  const ordered: Object3D[] = [];
  const seen = new Set<Object3D>();
  const push = (object: Object3D) => {
    if (seen.has(object) || !inScope.has(object)) return;
    seen.add(object);
    ordered.push(object);
  };
  for (const skin of skins) skin.forEach(push);
  scope.traverse((object) => { if ((object as BoneLike).isBone) push(object); });
  scope.traverse(push);

  let synthetic = -1;
  const byIndex = new Map<number, Object3D>();
  const candidates: HumanoidNodeCandidate[] = ordered.map((object) => {
    const index = indexOf.get(object) ?? synthetic--;
    byIndex.set(index, object);
    return { name: object.name, index, isJoint: (object as BoneLike).isBone === true };
  });
  const declaration = readHumanoidDeclaration(gltf?.parser?.json);
  const mapping = resolveHumanoidRig(candidates, declaration);

  const bones = new Map<VrmHumanoidBone, Object3D>();
  for (const [bone, index] of Object.entries(mapping.bones) as [VrmHumanoidBone, number][]) {
    const object = byIndex.get(index);
    if (object) bones.set(bone, object);
  }
  const declaredHips = declaration !== undefined && declaration.bones.hips === mapping.bones.hips;
  let source: HumanoidAnchorSource = !bones.has("hips") ? "none" : declaredHips ? declaration.format : "names";

  for (const [bone, names] of Object.entries(LEGACY_NAMES) as [VrmHumanoidBone, readonly string[]][]) {
    if (bones.has(bone)) continue;
    const found = findByName(scope, names);
    if (!found) continue;
    bones.set(bone, found);
    if (bone === "hips") source = "legacy";
  }

  for (const [bone, object] of bones) object.userData[HUMANOID_BONE_TAG] = bone;
  root.userData[HUMANOID_SOURCE_TAG] = source;
  return { scope, hips: bones.get("hips") ?? null, head: bones.get("head") ?? null, bones, source };
}

function findByName(root: Object3D, names: readonly string[]): Object3D | null {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  let match: Object3D | null = null;
  root.traverse((child) => {
    if (!match && child.name && wanted.has(child.name.toLowerCase())) match = child;
  });
  return match;
}
