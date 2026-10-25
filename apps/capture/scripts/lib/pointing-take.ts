import type { Page } from 'playwright';

import type {} from '../../src/runtime/automationHooks';
import { TARGETS, type Vec3 } from './pointing-scene.ts';

type Quat = [number, number, number, number];
/** What window.__applyPointState takes: the right hand's pose parameters and the left hand's position. */
export type PointState = {
  right: { s: number; rest: Vec3; tip?: Vec3; aim?: Vec3 };
  left: { pos: Vec3 };
};
/** One labelled point of the scripted take. */
export type PointingTakeLabel = { referent: string | null; brief?: true; start: number; end: number };

declare global {
  interface Window {
    __applyPointState?: (state: PointState) => void;
  }
}

// The scripted pointing take: the right index finger points at things in the
// generated pointing-targets scene while the left hand rests, except where the
// left hand is itself the thing pointed at. Aiming is solved from IWER's
// captured 'point' pose, so the fingertip sits at TIP and the index finger
// lies along the line to the aim point. Used by generate-iwer-pose-fixture.ts.

export const REST: { right: Vec3; left: Vec3 } = { right: [0.22, 1.05, -0.25], left: [-0.22, 1.05, -0.25] };
// Where the pointing fingertip is while pointing: in front of the right shoulder.
const TIP: Vec3 = [0.26, 1.3, -0.5];
// Where the left hand is held when it is the referent: across the chest.
const LEFT_OFFERED: Vec3 = [-0.12, 1.25, -0.45];

const center = (name: string) => TARGETS[name]!.center;
const SKY = (() => {
  const d: Vec3 = [0.15, 0.9, -0.4];
  const n = Math.hypot(...d);
  return TIP.map((v, i) => v + (d[i]! / n) * 5) as Vec3;
})();

const BLEND_SEC = 0.5;
const HOLD_SEC = 1.4;
const REST_SEC = 0.8;
// Shorter than any plausible dwell: raise, hold nothing, lower.
const BRIEF_BLEND_SEC = 0.1;
const BRIEF_HOLD_SEC = 0.0;

/** Adds window.__applyPointState({ right: { s, tip, aim }, left: { pos } }) to an IWER page. */
export function installPointingRig() {
  const conj = ([x, y, z, w]: Quat): Quat => [-x, -y, -z, w];
  const qmul = ([ax, ay, az, aw]: Quat, [bx, by, bz, bw]: Quat): Quat => [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz
  ];
  const rotate = (q: Quat, v: Vec3): Vec3 => qmul(qmul(q, [v[0], v[1], v[2], 0]), conj(q)).slice(0, 3) as Vec3;
  const norm = (v: Vec3): Vec3 => {
    const n = Math.hypot(...v);
    return v.map((x) => x / n) as Vec3;
  };
  const fromTo = (a: Vec3, b: Vec3): Quat => {
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    if (dot < -0.9999) return [0, 1, 0, 0];
    const axis: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const q: Quat = [axis[0], axis[1], axis[2], 1 + dot];
    const n = Math.hypot(...q);
    return q.map((x) => x / n) as Quat;
  };
  const slerp = (a: Quat, b: Quat, t: number): Quat => {
    let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    const sign = cos < 0 ? -1 : 1;
    cos *= sign;
    if (cos > 0.9995) {
      const out = a.map((v, i) => v + (sign * b[i]! - v) * t);
      const n = Math.hypot(...out);
      return out.map((v) => v / n) as Quat;
    }
    const theta = Math.acos(cos);
    const wa = Math.sin((1 - t) * theta) / Math.sin(theta);
    const wb = (sign * Math.sin(t * theta)) / Math.sin(theta);
    return a.map((v, i) => wa * v + wb * b[i]!) as Quat;
  };
  const IDENTITY: Quat = [0, 0, 0, 1];
  // The point pose's fingertip and index direction, in the hand's own frame.
  const pointGeometry = (hand: object) => {
    // IWER keeps the poses under a private symbol key; XRHandInput's types hide it.
    const internals = hand as Record<symbol, { poses: Record<string, { jointTransforms: Record<string, { offsetMatrix: Float32Array }> }> } | undefined>;
    const key = Object.getOwnPropertySymbols(hand).find((symbol) => internals[symbol]?.poses)!;
    const { jointTransforms } = internals[key]!.poses.point!;
    // The right hand's tracked joints are the stored pose mirrored in x (measured: tracked tip - wrist is (-0.089, 0.046, -0.153) where the stored offset is (0.089, 0.046, -0.153)).
    const translation = (joint: string): Vec3 => [-jointTransforms[joint]!.offsetMatrix[12]!, jointTransforms[joint]!.offsetMatrix[13]!, jointTransforms[joint]!.offsetMatrix[14]!];
    const tip = translation('index-finger-tip');
    const proximal = translation('index-finger-phalanx-proximal');
    return { tip, direction: norm(tip.map((v, i) => v - proximal[i]!) as Vec3) };
  };
  window.__applyPointState = ({ right, left }) => {
    const devices = window.IWER_DEVICE!.hands;
    devices.left!.position.set(...left.pos);
    devices.left!.quaternion.set(...IDENTITY);
    window.__blendHands!('default', 'default', 1, ['left']);
    const hand = devices.right!;
    const s = right.s;
    window.__blendHands!('default', 'point', s, ['right']);
    if (s <= 0) {
      hand.position.set(...right.rest);
      hand.quaternion.set(...IDENTITY);
      return;
    }
    const { tip, direction } = pointGeometry(hand);
    const wanted = norm(right.aim!.map((v, i) => v - right.tip![i]!) as Vec3);
    const aimed = qmul(fromTo(direction, wanted), IDENTITY);
    const rotatedTip = rotate(aimed, tip);
    const aimedPosition = right.tip!.map((v, i) => v - rotatedTip[i]!);
    const q = slerp(IDENTITY, aimed, s);
    const position = right.rest.map((v, i) => v + (aimedPosition[i]! - v) * s) as Vec3;
    hand.position.set(...position);
    hand.quaternion.set(...q);
  };
}

const ease = (u: number) => u * u * (3 - 2 * u);

/**
 * The page's tracked fingertip sits a fixed offset from where the IWER hand
 * math puts it (the tracking space is offset from IWER's). Points the hand for
 * a few frames and returns tracked tip minus intended tip, which the take
 * subtracts so the tracked fingertip, not IWER's, lands on TIP. Call before
 * recording starts.
 */
export async function calibrateTipShift({ page, stepMs, readRightTip }: {
  page: Page;
  stepMs: number;
  readRightTip: () => Promise<number[]>;
}): Promise<Vec3> {
  const apply = (s: number) => page.evaluate((arg) => window.__applyPointState!(arg), {
    right: { s, tip: TIP, aim: center('TargetA'), rest: REST.right },
    left: { pos: REST.left }
  });
  await apply(1);
  await page.clock.runFor(stepMs * 8);
  const tracked = await readRightTip();
  await apply(0);
  await page.clock.runFor(stepMs * 8);
  return tracked.map((v, i) => v - TIP[i]!) as Vec3;
}
const lerp3 = (a: Vec3, b: Vec3, t: number) => a.map((v, i) => v + (b[i]! - v) * t) as Vec3;

/**
 * Plays the take after recording has started, one `stepMs` step at a time, and
 * returns labels for the check: every point's intended referent and the times
 * it was held, in seconds from the first stepped frame.
 */
export async function runPointingTake({ page, stepMs, readLeftPalm, tipShift = [0, 0, 0] }: {
  page: Page;
  stepMs: number;
  readLeftPalm: () => Promise<Vec3>;
  tipShift?: Vec3;
}): Promise<{ labels: PointingTakeLabel[]; durationSec: number }> {
  const stepSec = stepMs / 1000;
  let elapsed = 0;
  const labels: PointingTakeLabel[] = [];
  const state = { s: 0, aim: center('TargetA'), left: REST.left };
  const apply = async () => {
    await page.evaluate((arg) => window.__applyPointState!(arg), {
      right: { s: ease(state.s), tip: TIP.map((v, i) => v - tipShift[i]!) as Vec3, aim: state.aim.map((v, i) => v - tipShift[i]!) as Vec3, rest: REST.right },
      left: { pos: state.left }
    });
    await page.clock.runFor(stepMs);
    elapsed += stepSec;
  };
  const steps = (seconds: number) => Math.max(0, Math.round(seconds / stepSec));
  // Raises the hand (s 0 → 1), holds, lowers it; each phase moves the aim.
  const raise = async (aim: Vec3, seconds: number) => {
    state.aim = aim;
    const n = steps(seconds);
    for (let i = 1; i <= n; i += 1) {
      state.s = i / n;
      await apply();
    }
  };
  const hold = async (seconds: number) => {
    for (let i = 0; i < steps(seconds); i += 1) await apply();
  };
  const sweep = async (to: Vec3, seconds: number) => {
    const from = state.aim;
    const n = steps(seconds);
    for (let i = 1; i <= n; i += 1) {
      state.aim = lerp3(from, to, ease(i / n));
      await apply();
    }
  };
  const lower = async (seconds: number) => {
    const n = steps(seconds);
    for (let i = 1; i <= n; i += 1) {
      state.s = 1 - i / n;
      await apply();
    }
  };
  const moveLeft = async (to: Vec3, seconds: number) => {
    const from = state.left;
    const n = steps(seconds);
    for (let i = 1; i <= n; i += 1) {
      state.left = lerp3(from, to, ease(i / n));
      await apply();
    }
  };
  // One labelled point: `referent` is the intended target, held from the
  // moment the pose completes to the moment it starts to release.
  const point = (referent: string | null, start: number) => labels.push({ referent, start: Number(start.toFixed(2)), end: Number(elapsed.toFixed(2)) });

  await hold(1.0);

  // 1. TargetA.
  await raise(center('TargetA'), BLEND_SEC);
  let start = elapsed;
  await hold(HOLD_SEC);
  point('TargetA', start);
  await lower(BLEND_SEC);
  await hold(REST_SEC);

  // 2. The avatar's own left hand.
  await moveLeft(LEFT_OFFERED, 0.5);
  // Let the tracked hand settle before reading where its palm is. Aim at the
  // palm centre, not the wrist: the wrist is the forearm/hand boundary, so a
  // ray at it is as much a point at the forearm as at the hand.
  await hold(0.4);
  const palm = await readLeftPalm();
  await raise(palm, BLEND_SEC);
  start = elapsed;
  await hold(HOLD_SEC);
  point('leftHand', start);
  await lower(BLEND_SEC);
  await moveLeft(REST.left, 0.5);
  await hold(REST_SEC);

  // 3. "This one … and that one" in one held point: TargetB, then TargetA.
  await raise(center('TargetB'), BLEND_SEC);
  start = elapsed;
  await hold(HOLD_SEC);
  point('TargetB', start);
  await sweep(center('TargetA'), 0.4);
  start = elapsed;
  await hold(HOLD_SEC);
  point('TargetA', start);
  await lower(BLEND_SEC);
  await hold(REST_SEC);

  // 4. Into empty sky: no referent, no link.
  await raise(SKY, BLEND_SEC);
  start = elapsed;
  await hold(HOLD_SEC);
  point(null, start);
  await lower(BLEND_SEC);
  await hold(REST_SEC);

  // 5. Too brief: up and straight back down; no deliberate point. The label
  // spans the whole raise and lower.
  start = elapsed;
  await raise(center('TargetB'), BRIEF_BLEND_SEC);
  await hold(BRIEF_HOLD_SEC);
  await lower(BRIEF_BLEND_SEC);
  labels.push({ referent: 'TargetB', brief: true, start: Number(start.toFixed(2)), end: Number(elapsed.toFixed(2)) });
  await hold(1.0);

  return { labels, durationSec: Number(elapsed.toFixed(2)) };
}
