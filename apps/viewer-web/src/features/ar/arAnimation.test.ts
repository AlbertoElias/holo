import { describe, expect, it } from "vitest";
import { AnimationClip, NumberKeyframeTrack, QuaternionKeyframeTrack, VectorKeyframeTrack } from "three";

import { freezeBubbleWrapperMotion } from "./arAnimation";

describe("freezeBubbleWrapperMotion", () => {
  it("removes bubble/wrapper transform tracks while keeping avatar motion tracks", () => {
    const clip = new AnimationClip("RecordedMotion", -1, [
      new VectorKeyframeTrack("RecordedBubbleSphere.position", [0, 1], [0, 0, 0, 1, 1, 1]),
      new QuaternionKeyframeTrack("RecordedSceneBubble.quaternion", [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
      new VectorKeyframeTrack("RecordedAvatar.position", [0, 1], [0, 0, 0, 0.4, 0, 0.5]),
      new NumberKeyframeTrack("RecordedAvatar.morphTargetInfluences[Smile]", [0, 1], [0, 1])
    ]);

    const filtered = freezeBubbleWrapperMotion([clip]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.tracks.map((track) => track.name)).toEqual([
      "RecordedSceneBubble.quaternion",
      "RecordedAvatar.position",
      "RecordedAvatar.morphTargetInfluences[Smile]"
    ]);
  });

  it("keeps non-transform bubble tracks", () => {
    const clip = new AnimationClip("RecordedMotion", -1, [
      new NumberKeyframeTrack("RecordedBubbleSphere.material.opacity", [0, 1], [0.1, 0.2]),
      new VectorKeyframeTrack("RecordedAvatar.position", [0, 1], [0, 0, 0, 0.3, 0.2, -0.1])
    ]);

    const filtered = freezeBubbleWrapperMotion([clip]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.tracks.map((track) => track.name)).toEqual([
      "RecordedBubbleSphere.material.opacity",
      "RecordedAvatar.position"
    ]);
  });

  it("returns original clips when no bubble transform tracks exist", () => {
    const clip = new AnimationClip("RecordedMotion", -1, [
      new VectorKeyframeTrack("RecordedAvatar.position", [0, 1], [0, 0, 0, 0.4, 0, 0.3])
    ]);

    const filtered = freezeBubbleWrapperMotion([clip]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toBe(clip);
  });
});
