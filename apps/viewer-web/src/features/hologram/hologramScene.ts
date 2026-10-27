import { Box3, Vector3 } from "three";
import type { AnimationClip, Object3D } from "three";

import { isInsideRecordedObject } from "../objects/recordedObjects";
import { type HumanoidGltf, resolveHumanoidAnchors } from "./humanoidAnchors";
import { compareTakeClips } from "./takePlayback";

// Recorded holograms are already at true scale; these helpers only place the
// root and pick what to play. Plain three, shared by the R3F and IWSDK views.

/**
 * Bounds of the recording without the objects the author handled: a prop
 * held below the feet or at arm's length must not lift or shrink the avatar.
 */
export function boundsWithoutObjects(root: Object3D): Box3 {
  const bounds = new Box3();
  const scratch = new Box3();
  root.updateWorldMatrix(true, true);
  root.traverse((child) => {
    const mesh = child as Object3D & { isMesh?: boolean };
    if (!mesh.isMesh || isInsideRecordedObject(child)) return;
    scratch.setFromObject(child);
    if (!scratch.isEmpty()) bounds.union(scratch);
  });
  return bounds;
}

/**
 * A take the author's phone camera made (a handheld AR capture): nobody
 * performed, so there is no `RecordedAvatar`, and the author is a camera node
 * animated by the take's clip. The set stands in the take's own frame, whose
 * origin is the recorded floor.
 */
export function isCameraTake(root: Object3D): boolean {
  return !root.getObjectByName("RecordedAvatar") && Boolean(root.getObjectByName("RecordedAuthorCamera"));
}

/**
 * Puts the recorded floor at the origin, under the author. A capture's
 * avatar origin is on its floor (B-022): the scene around it (terrain
 * flanks, water, the bubble sphere) reaches far below and must not lift it.
 * A camera take has no avatar; its set's origin is the floor, so it stays
 * where it is, whatever bones or props the set holds. Other files stand on
 * their lowest drawn point, under their hips when they are a humanoid.
 * Resolving the humanoid (any format; `gltf` lets the file's own declaration
 * count) also tags its bones for every view.
 */
export function normalizeSceneAtOrigin(root: Object3D, gltf?: HumanoidGltf): void {
  const recordedAvatar = root.getObjectByName("RecordedAvatar");
  const cameraTake = isCameraTake(root);
  const { hips } = resolveHumanoidAnchors(root, gltf);
  const anchor = recordedAvatar ?? (cameraTake ? root : null) ?? hips ?? root;

  const anchorPos = anchor.getWorldPosition(new Vector3());
  if (!Number.isFinite(anchorPos.x) || !Number.isFinite(anchorPos.y) || !Number.isFinite(anchorPos.z)) return;

  root.position.sub(anchorPos);
  if (recordedAvatar || cameraTake) return;

  const bounds = boundsWithoutObjects(root);
  if (!bounds.isEmpty() && Number.isFinite(bounds.min.y)) {
    root.position.y -= bounds.min.y;
  }
}

/** Clips ordered for playback: the recorded body motion first (the feed's take order). */
export function rankClipsForPlayback<T extends AnimationClip>(clips: readonly T[]): T[] {
  return clips.slice().sort(compareTakeClips);
}
