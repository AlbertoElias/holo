// The cloche is fitted once to the author's reach through the whole take
// (styleguide 3.4), on whatever card is on screen, playing or not. Failure
// modes, listed before the tests: the viewer's playback is paused (feed cards
// out of focus) or its mixer is stopped by a zero time scale (paused AR), so
// sampling by the viewer's mixer reads one instant; a second clip's reach is
// missed; sampling moves the viewer's paused pose or its action's time, or
// leaves the pose at the last sample when nothing was playing; a take with no
// motion yields points.
import { AnimationClip, AnimationMixer, Bone, Group, LoopRepeat, VectorKeyframeTrack } from "three";
import type { Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { motionPoints } from "./drawnPoints";

/** An author whose head bone rises from 1.0 m to `peak` halfway through a 1 s take. */
function author(peak = 2.5, name = "rise"): { root: Group; head: Bone; clip: AnimationClip } {
  const root = new Group();
  const head = new Bone();
  head.name = "head";
  head.position.set(0, 1, 0);
  root.add(head);
  const clip = new AnimationClip(name, 1, [new VectorKeyframeTrack("head.position", [0, 0.5, 1], [0, 1, 0, 0, peak, 0, 0, 1, 0])]);
  return { root, head, clip };
}

function highest(points: Vector3[]): number {
  return Math.max(...points.map((point) => point.y));
}

describe("motionPoints: the author's reach through the take (3.4)", () => {
  it("reads the whole take while the viewer's playback is paused", () => {
    const { root, clip } = author();
    const viewer = new AnimationMixer(root);
    const action = viewer.clipAction(clip).setLoop(LoopRepeat, Infinity).play();
    action.paused = true;
    viewer.update(0);
    expect(highest(motionPoints(root, [clip]))).toBeGreaterThan(2.4);
  });

  it("reads the whole take while the viewer's mixer is stopped by a zero time scale (paused AR)", () => {
    const { root, clip } = author();
    const viewer = new AnimationMixer(root);
    viewer.clipAction(clip).play();
    viewer.timeScale = 0;
    viewer.update(0);
    expect(highest(motionPoints(root, [clip]))).toBeGreaterThan(2.4);
  });

  it("leaves a paused viewer where it was: the same pose, time and pause", () => {
    const { root, head, clip } = author();
    const viewer = new AnimationMixer(root);
    const action = viewer.clipAction(clip).play();
    viewer.update(0.25);
    action.paused = true;
    const pose = head.position.clone();
    motionPoints(root, [clip]);
    expect(action.time).toBeCloseTo(0.25, 6);
    expect(action.paused).toBe(true);
    expect(head.position.distanceTo(pose)).toBeLessThan(1e-6);
    viewer.update(0.1);
    expect(head.position.distanceTo(pose), "the paused viewer still holds its pose").toBeLessThan(1e-6);
  });

  it("puts the pose back when nothing was playing", () => {
    const { root, head, clip } = author();
    motionPoints(root, [clip]);
    expect(head.position.y).toBe(1);
  });

  it("covers every clip's reach", () => {
    const { root, clip } = author(2.5, "rise");
    const crouch = new AnimationClip("crouch", 2, [new VectorKeyframeTrack("head.position", [0, 1, 2], [0, 1, 0, 3, 0.4, 0, 0, 1, 0])]);
    const points = motionPoints(root, [clip, crouch]);
    expect(highest(points)).toBeGreaterThan(2.4);
    expect(Math.min(...points.map((point) => point.y)), "the crouch's low point").toBeLessThan(0.6);
    expect(Math.max(...points.map((point) => point.x)), "the crouch's reach sideways").toBeGreaterThan(2.9);
  });

  it("yields nothing for a take with no motion", () => {
    const { root } = author();
    expect(motionPoints(root, [])).toEqual([]);
    expect(motionPoints(root, [new AnimationClip("still", 0, [])])).toEqual([]);
  });
});
