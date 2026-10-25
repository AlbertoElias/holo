import { Box3, Vector3 } from "three";
import type { AnimationClip, Object3D } from "three";

import { isInsideRecordedObject } from "../objects/recordedObjects";

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

/** Moves the recorded subject's anchor to the origin and its lowest point to y = 0. */
export function normalizeSceneAtOrigin(root: Object3D): void {
  const anchor = root.getObjectByName("RecordedAvatar")
    ?? root.getObjectByName("Hips")
    ?? root.getObjectByName("mixamorigHips")
    ?? root;

  const anchorPos = anchor.getWorldPosition(new Vector3());
  if (!Number.isFinite(anchorPos.x) || !Number.isFinite(anchorPos.y) || !Number.isFinite(anchorPos.z)) return;

  root.position.sub(anchorPos);

  const bounds = boundsWithoutObjects(root);
  if (!bounds.isEmpty() && Number.isFinite(bounds.min.y)) {
    root.position.y -= bounds.min.y;
  }
}

const MOTION_TERMS = ["body", "move", "walk", "run", "idle", "anim", "record"];

/** Clips ordered for playback: the recorded body motion first. */
export function rankClipsForPlayback<T extends AnimationClip>(clips: readonly T[]): T[] {
  return clips.slice().sort((a, b) => {
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    const aHasMotionName = MOTION_TERMS.some((term) => aName.includes(term)) ? 1 : 0;
    const bHasMotionName = MOTION_TERMS.some((term) => bName.includes(term)) ? 1 : 0;
    if (bHasMotionName !== aHasMotionName) {
      return bHasMotionName - aHasMotionName;
    }
    if (b.tracks.length !== a.tracks.length) {
      return b.tracks.length - a.tracks.length;
    }
    return b.duration - a.duration;
  });
}
