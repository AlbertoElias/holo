// The cloche is fitted once to the author's reach through the whole take
// (styleguide 3.4), on whatever card is on screen, playing or not. Failure
// modes, listed before the tests: the viewer's playback is paused (feed cards
// out of focus) or its mixer is stopped by a zero time scale (paused AR), so
// sampling by the viewer's mixer reads one instant; a second clip's reach is
// missed; clips sampled one at a time miss what the viewer draws, which plays
// them together (the first ranked at full weight, the rest at 0.35), so a
// clip on a child bone stacks on its parent's and one on the same bone
// blends; sampling moves the viewer's paused pose or its action's time, or
// leaves the pose at the last sample when nothing was playing; a take with no
// motion yields points.
import { AnimationClip, AnimationMixer, Bone, Group, LoopRepeat, Vector3 as Point, VectorKeyframeTrack } from "three";
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

/**
 * Where `bone` goes as the feed plays the take, written out by hand: every
 * clip looping together, `ranked[0]` at full weight and the rest at 0.35,
 * read densely through the longest clip.
 */
function viewerReach(root: Group, bone: Bone, ranked: AnimationClip[]): { top: number; bottom: number; side: number } {
  const viewer = new AnimationMixer(root);
  ranked.forEach((clip, index) => viewer.clipAction(clip).setLoop(LoopRepeat, Infinity).setEffectiveWeight(index === 0 ? 1 : 0.35).play());
  const span = Math.max(...ranked.map((clip) => clip.duration));
  const reach = { top: -Infinity, bottom: Infinity, side: -Infinity };
  const at = new Point();
  for (let step = 0; step <= 400; step += 1) {
    viewer.setTime((span * step) / 400);
    root.updateWorldMatrix(true, true);
    bone.getWorldPosition(at);
    reach.top = Math.max(reach.top, at.y);
    reach.bottom = Math.min(reach.bottom, at.y);
    reach.side = Math.max(reach.side, at.x);
  }
  viewer.stopAllAction();
  viewer.uncacheRoot(root);
  return reach;
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

  it("covers a take as the viewer plays it: clips of different lengths, looping, blended on one bone", () => {
    const { root, head, clip } = author(2.5, "rise");
    const crouch = new AnimationClip("crouch", 2, [new VectorKeyframeTrack("head.position", [0, 1, 2], [0, 1, 0, 3, 0.4, 0, 0, 1, 0])]);
    // The viewer ranks the longer clip first when neither is named for motion.
    const viewer = viewerReach(root, head, [crouch, clip]);
    const points = motionPoints(root, [clip, crouch]);
    expect(highest(points), "over the highest the viewer draws, with head room").toBeGreaterThan(viewer.top + 0.17);
    expect(Math.min(...points.map((point) => point.y)), "down to the lowest").toBeLessThan(viewer.bottom + 0.01);
    expect(Math.max(...points.map((point) => point.x)), "out to the furthest sideways").toBeGreaterThan(viewer.side - 0.01);
  });

  it("covers a head nodding on a rising body: a second clip on a child bone stacks on the first", () => {
    const root = new Group();
    const hips = new Bone();
    hips.name = "hips";
    hips.position.set(0, 1, 0);
    const head = new Bone();
    head.name = "head";
    head.position.set(0, 0.5, 0);
    hips.add(head);
    root.add(hips);
    const body = new AnimationClip("record body", 1, [new VectorKeyframeTrack("hips.position", [0, 0.5, 1], [0, 1, 0, 0, 2, 0, 0, 1, 0])]);
    const nod = new AnimationClip("nod", 1, [new VectorKeyframeTrack("head.position", [0, 0.5, 1], [0, 0.5, 0, 0, 1, 0, 0, 0.5, 0])]);
    const viewer = viewerReach(root, head, [body, nod]);
    expect(viewer.top, "the nod at 0.35 lifts the head over the body's own reach").toBeGreaterThan(2.6);
    // Listed nod first: the fit ranks the clips as the viewer does.
    expect(highest(motionPoints(root, [nod, body]))).toBeGreaterThan(viewer.top + 0.17);
  });

  it("yields nothing for a take with no motion", () => {
    const { root } = author();
    expect(motionPoints(root, [])).toEqual([]);
    expect(motionPoints(root, [new AnimationClip("still", 0, [])])).toEqual([]);
  });
});
