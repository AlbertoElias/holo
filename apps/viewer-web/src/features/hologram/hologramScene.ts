import { Box3, Vector3 } from "three";
import type { AnimationClip, Object3D } from "three";

// Recorded holograms are already at true scale; these helpers only place the
// root and pick what to play. Plain three, shared by the R3F and IWSDK views.

/** Moves the recorded subject's anchor to the origin and its lowest point to y = 0. */
export function normalizeSceneAtOrigin(root: Object3D): void {
  const anchor = root.getObjectByName("RecordedAvatar")
    ?? root.getObjectByName("Hips")
    ?? root.getObjectByName("mixamorigHips")
    ?? root;

  const anchorPos = anchor.getWorldPosition(new Vector3());
  if (!Number.isFinite(anchorPos.x) || !Number.isFinite(anchorPos.y) || !Number.isFinite(anchorPos.z)) return;

  root.position.sub(anchorPos);

  const bounds = new Box3().setFromObject(root);
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
