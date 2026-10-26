// How the viewer plays a take's clips: all together, looping, the one ranked
// first at full weight and the rest under it. The feed, AR and the cloche's
// fit share it, so the dome is fitted to the pose the viewer draws.
import type { AnimationClip } from "three";

export const TAKE_CLIP_WEIGHT = { primary: 1, secondary: 0.35 } as const;

const MOTION_TERMS = ["body", "move", "walk", "run", "idle", "anim", "record"];

/** Sort order for a take's clips: named for motion first, then more tracks, then longer. */
export function compareTakeClips(a: AnimationClip, b: AnimationClip): number {
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
}
