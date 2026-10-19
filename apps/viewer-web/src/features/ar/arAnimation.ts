import { AnimationClip } from "three";
import type { KeyframeTrack } from "three";

const STATIC_BUBBLE_NODE_TERMS = ["RecordedBubbleSphere"] as const;
const STATIC_BUBBLE_TRANSFORM_SUFFIXES = [".position", ".quaternion", ".scale"] as const;

function isStaticBubbleTransformTrack(track: KeyframeTrack): boolean {
  const trackName = track.name;
  const separatorIndex = trackName.lastIndexOf(".");
  if (separatorIndex <= 0) {
    return false;
  }

  const targetPath = trackName.slice(0, separatorIndex);
  const propertySuffix = trackName.slice(separatorIndex);
  const isTransformTrack = STATIC_BUBBLE_TRANSFORM_SUFFIXES.some((suffix) => suffix === propertySuffix);
  if (!isTransformTrack) {
    return false;
  }

  return STATIC_BUBBLE_NODE_TERMS.some((term) => targetPath.includes(term));
}

export function freezeBubbleWrapperMotion(clips: readonly AnimationClip[]): AnimationClip[] {
  const filteredClips: AnimationClip[] = [];
  let didStripAnyTrack = false;

  for (const clip of clips) {
    const keptTracks = clip.tracks.filter((track) => !isStaticBubbleTransformTrack(track));
    if (keptTracks.length !== clip.tracks.length) {
      didStripAnyTrack = true;
    }
    if (keptTracks.length === 0) {
      continue;
    }

    if (keptTracks.length === clip.tracks.length) {
      filteredClips.push(clip);
    } else {
      filteredClips.push(new AnimationClip(clip.name, clip.duration, keptTracks.map((track) => track.clone())));
    }
  }

  if (!didStripAnyTrack) {
    return [...clips];
  }

  return filteredClips;
}
