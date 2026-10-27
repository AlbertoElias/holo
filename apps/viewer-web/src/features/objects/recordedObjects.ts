import { HOLOIM_OBJECTS_EXTENSION, RECORDED_OBJECT_NODE_NAME, readCredit, validateHoloimObjects } from "@holoim/objects";
import type { ObjectCredit, RecordedObjectEntry } from "@holoim/objects";
import type { Object3D } from "three";

import { mapNodeIndices, type MeaningGltf } from "../meaning/meaningLinks";

// Objects the author handled in the event (PRD-043). Their motion is plain
// glTF: a `RecordedObject` node whose tracks are in the take's clip, so the
// card's mixer plays them with the avatar and nothing here is needed for
// playback. The HOLOIM_objects root extension says which nodes they are,
// their origin and when they were held; old recordings have neither.

export type ResolvedObject = {
  entry: RecordedObjectEntry;
  /** The object's node in the card's clone. */
  node: Object3D;
};

/** glTF loaders make repeated names unique with a `_<n>` suffix. */
export function isRecordedObjectNode(object: Object3D): boolean {
  return object.name === RECORDED_OBJECT_NODE_NAME || object.name.startsWith(`${RECORDED_OBJECT_NODE_NAME}_`);
}

/** Whether `object` is a recorded object or part of one. */
export function isInsideRecordedObject(object: Object3D): boolean {
  for (let current: Object3D | null = object; current; current = current.parent) {
    if (isRecordedObjectNode(current)) return true;
  }
  return false;
}

export function readRecordedObjects(gltf: MeaningGltf, clone: Object3D): ResolvedObject[] {
  const extensions = gltf.userData?.gltfExtensions as Record<string, unknown> | undefined;
  const raw = extensions?.[HOLOIM_OBJECTS_EXTENSION];
  if (raw === undefined) return [];

  const result = validateHoloimObjects(raw);
  if (!result.ok) {
    console.warn(`Ignoring invalid ${HOLOIM_OBJECTS_EXTENSION}:`, result.errors.join("; "));
    return [];
  }

  const nodes = mapNodeIndices(gltf.scene, clone, gltf.parser?.associations);
  return result.value.objects.flatMap((entry) => {
    const node = nodes.get(entry.node);
    return node ? [{ entry, node }] : [];
  });
}

/**
 * The distinct credits carried by a take's recorded objects (PRD-060), once
 * per source page: summoning the same model twice credits it once. Nodes
 * without a credit, or with an invalid one, add nothing.
 */
export function readObjectCredits(objects: readonly ResolvedObject[]): ObjectCredit[] {
  const bySource = new Map<string, ObjectCredit>();
  for (const { node } of objects) {
    const credit = readCredit(node.userData);
    if (credit && !bySource.has(credit.sourceUrl)) bySource.set(credit.sourceUrl, credit);
  }
  return [...bySource.values()];
}
