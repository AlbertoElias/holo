/**
 * Posing a loaded avatar in Node: arms by capture's `ArmIkSolver`, legs by
 * capture's `solveTwoBoneLeg`, and the few things those leave out (wrist
 * roll, reaching with the palm instead of the wrist, a turn spread down the
 * spine, planted feet). Points are in the body frame (+Z forward, +Y up,
 * +X the performer's left, metres) unless a name says world.
 */
import * as THREE from 'three';
import type { VrmHumanoidBone } from '@holoim/meaning';

import { ArmIkSolver } from '../../../src/ik/ArmIkSolver.ts';
import { solveTwoBoneLeg } from '../../../src/body/legIk.ts';
import type { LoadedAvatar, Side } from './avatar.ts';

const solver = new ArmIkSolver();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const IDENTITY = new THREE.Quaternion();
const DEG = Math.PI / 180;
const wrapRad = (r: number): number => Math.atan2(Math.sin(r), Math.cos(r));

export const toWorld = (a: LoadedAvatar, local: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 => a.body.localToWorld(out.copy(local));
export const toBody = (a: LoadedAvatar, world: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 => a.body.worldToLocal(out.copy(world));
export const bodyQuaternion = (a: LoadedAvatar, out = new THREE.Quaternion()): THREE.Quaternion => a.body.getWorldQuaternion(out);
export const bodyUp = (a: LoadedAvatar, out = new THREE.Vector3()): THREE.Vector3 => out.set(0, 1, 0).applyQuaternion(bodyQuaternion(a, tmpQ2));

/** Rotates a bone by a world-space rotation about its own origin. */
export function rotateBoneWorld(bone: THREE.Object3D, rotation: THREE.Quaternion): void {
  const world = bone.getWorldQuaternion(new THREE.Quaternion());
  const parent = bone.parent!.getWorldQuaternion(new THREE.Quaternion());
  bone.quaternion.copy(parent.invert().multiply(rotation).multiply(world)).normalize();
  bone.updateMatrixWorld(true);
}

/** Moves a bone by a world-space offset (the hips, for weight and steps). */
export function moveBoneWorld(bone: THREE.Object3D, offsetWorld: THREE.Vector3): void {
  const at = bone.getWorldPosition(new THREE.Vector3()).add(offsetWorld);
  bone.position.copy(bone.parent!.worldToLocal(at));
  bone.updateMatrixWorld(true);
}

/**
 * Where the wrist hangs at rest, from the shoulder, in the avatar's frame: an
 * arm's length down, a little out from the thigh and forward, so the arm is
 * nearly straight with the hand at the side.
 */
export function armRestOffset(a: LoadedAvatar, side: Side, out = new THREE.Vector3()): THREE.Vector3 {
  const chain = a.arms[side];
  const reach = chain.upperLength + chain.lowerLength;
  return out.set((side === 'left' ? 1 : -1) * 0.18 * reach, -0.965 * reach, 0.05 * reach);
}

/**
 * The elbow of a hanging arm points back and only a little out. Capture's
 * solver bends the elbow outward (right for a tracked controller held in
 * front), which on a hanging arm reads as hands on hips.
 */
export function restElbowHint(a: LoadedAvatar, side: Side, out = new THREE.Vector3()): THREE.Vector3 {
  // Back and out in the body frame, turned as far as the chest has turned from bind: a hint that stays with the
  // feet while the chest turns sends one elbow into the side. The solver reads the hint in `a.frame`, so turn it by the facing correction.
  out.set(side === 'left' ? 0.3 : -0.3, 0, -1).normalize().applyAxisAngle(Y, chestYaw(a));
  return a.facingCorrection ? out.applyQuaternion(a.facingCorrection) : out;
}

const Y = new THREE.Vector3(0, 1, 0);

/** How far the chest has turned about the body's up axis from bind (radians), in the body frame. */
function chestYaw(a: LoadedAvatar): number {
  const name = a.bind.has('upperChest') ? 'upperChest' : a.bind.has('chest') ? 'chest' : 'spine';
  const bind = a.bind.get(name);
  if (!bind) return 0;
  a.body.updateWorldMatrix(true, false);
  bind.bone.updateWorldMatrix(true, false);
  const now = a.body.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(bind.bone.getWorldQuaternion(new THREE.Quaternion()));
  // The bind chest's forward, carried by the turn since bind, flattened onto the floor.
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(now.multiply(bind.rootQuaternion.clone().invert()));
  return Math.abs(forward.x) + Math.abs(forward.z) < 1e-9 ? 0 : Math.atan2(forward.x, forward.z);
}

/**
 * Where the elbow points while the hand works in front: down and a little
 * out. In recorded reaches (CMU, the VR arm work in B-073 to B-075) the elbow
 * sits 25-45° from straight down toward out in nearly every reach; 35° is the
 * middle. The rig's own hint points the elbow straight out, a wing.
 */
export function reachElbowHint(a: LoadedAvatar, side: Side, out = new THREE.Vector3()): THREE.Vector3 {
  out.set((side === 'left' ? 1 : -1) * Math.sin(35 * DEG), -Math.cos(35 * DEG), 0);
  return a.facingCorrection ? out.applyQuaternion(a.facingCorrection) : out;
}

/**
 * Hangs the arm at rest: the wrist `offsetWorld` from wherever the shoulder
 * settles. Capture's solver swings the clavicle toward a far target (its
 * shoulder protraction), so the target is re-aimed from the moved shoulder a
 * few times instead of from the bind shoulder.
 */
export function hangArm(a: LoadedAvatar, side: Side, offsetWorld: THREE.Vector3): void {
  const shoulder = a.arms[side].upperArm;
  const target = new THREE.Vector3();
  for (let i = 0; i < 4; i += 1) {
    a.frame.updateMatrixWorld(true);
    shoulder.getWorldPosition(target).add(offsetWorld);
    solveArm(a, side, target, { elbowHint: restElbowHint(a, side) });
  }
}

export interface ArmOptions {
  /** World direction the palm should face (rolled about the forearm); omitted keeps the neutral wrist. */
  readonly palmToward?: THREE.Vector3 | undefined;
  /** Bend the wrist back up to this much toward `palmToward` (radians), for a hand offered. */
  readonly wristBend?: number;
  /** Which way the elbow bends, in the avatar's frame; omitted keeps the rig's own hint. */
  readonly elbowHint?: THREE.Vector3 | undefined;
}

/** Forearm twist from neutral (bind: thumb forward), at most: pronation and supination are each about 80-90°; 85° keeps inside the 90° bar in `arm-quality.ts`, as the wrist roll in `WRIST_LIMITS` does. */
export const FOREARM_TWIST_LIMIT = 85 * DEG;

/**
 * Limits `x` to ±`limit` with a soft knee: it is unchanged up to 60% of the
 * limit, then comes to the limit gradually. A hard stop changes the turning
 * speed in one frame when a roll arrives at it (a snap about the forearm).
 */
export function softLimit(x: number, limit: number): number {
  const knee = 0.6 * limit;
  const size = Math.abs(x);
  if (size <= knee) return x;
  return Math.sign(x) * (knee + (limit - knee) * Math.tanh((size - knee) / (limit - knee)));
}
/** The forearm's own share of a palm roll; the hand takes the rest, as the radius turns over the ulna. */
const FOREARM_TWIST_SHARE = 0.5;
/** The elbow's flexion range: at most a little past straight, and about 150° bent. */
const ELBOW_FLEX = { min: -2 * DEG, max: 150 * DEG } as const;

/** The elbow's hinge in the upper arm's frame at bind (see `arm-quality.ts`, which measures against the same frame). */
interface Hinge { readonly u0: THREE.Vector3; readonly d0: THREE.Vector3; readonly h: THREE.Vector3; readonly flexDir: THREE.Vector3; readonly basis: THREE.Matrix4 }
const hinges = new WeakMap<object, Hinge>();
function hingeOf(a: LoadedAvatar, side: Side): Hinge {
  const ch = a.arms[side];
  const known = hinges.get(ch);
  if (known) return known;
  const bindQ = a.bind.get(side === 'left' ? 'leftUpperArm' : 'rightUpperArm')!.rootQuaternion;
  const u0 = ch.foreBindPosition.clone().normalize();
  const d0 = ch.handBindPosition.clone().applyQuaternion(ch.foreBindQuaternion).normalize();
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(bindQ.clone().invert());
  const h = d0.clone().cross(forward).normalize();
  const flexDir = h.clone().cross(d0).normalize();
  const y = h.clone().addScaledVector(u0, -h.dot(u0)).normalize();
  const basis = new THREE.Matrix4().makeBasis(u0, y, u0.clone().cross(y));
  const hinge = { u0, d0, h, flexDir, basis };
  hinges.set(ch, hinge);
  return hinge;
}

/**
 * Makes the elbow a hinge. Capture's solver aims the upper arm and the
 * forearm by the shortest turn, which leaves the upper arm's roll wherever
 * it was: the elbow then bends sideways or backward. This turns the upper
 * arm about its own line until its hinge is square to the plane of the bend,
 * and bends the forearm about that hinge only, within the elbow's range.
 */
function hingeElbow(a: LoadedAvatar, side: Side): void {
  const ch = a.arms[side];
  const hg = hingeOf(a, side);
  ch.upperArm.updateMatrixWorld(true);
  const S = ch.upperArm.getWorldPosition(new THREE.Vector3());
  const E = ch.foreArm.getWorldPosition(new THREE.Vector3());
  const W = ch.hand.getWorldPosition(new THREE.Vector3());
  const u = E.clone().sub(S).normalize();
  const f = W.clone().sub(E).normalize();
  const p = f.clone().addScaledVector(u, -f.dot(u));
  // The hinge a straight arm keeps: the bind hinge, swung (not rolled) to the arm's line.
  const bindQ = ch.upperArm.parent!.getWorldQuaternion(new THREE.Quaternion()).multiply(ch.upperBindQuaternion);
  const swing = new THREE.Quaternion().setFromUnitVectors(hg.u0.clone().applyQuaternion(bindQ), u);
  const hSwing = hg.h.clone().applyQuaternion(bindQ).applyQuaternion(swing);
  // A bend plane is sure only when the arm bends: near straight, a few millimetres turn it any way.
  const bend = p.length();
  const sure = THREE.MathUtils.smoothstep(bend, Math.sin(3 * DEG), Math.sin(20 * DEG));
  const hW = hSwing.clone();
  if (sure > 0) {
    const hPlane = u.clone().cross(p.divideScalar(bend));
    // Not sure of the plane: a bend the other way is a straight arm a little past, not an arm rolled over.
    if (sure < 1 && hPlane.dot(hSwing) < 0) hPlane.negate();
    hW.lerp(hPlane, sure);
  }
  hW.addScaledVector(u, -hW.dot(u)).normalize();
  const world = new THREE.Matrix4().makeBasis(u, hW, u.clone().cross(hW));
  const Ru = new THREE.Quaternion().setFromRotationMatrix(world.multiply(hg.basis.clone().transpose()));
  ch.upperArm.quaternion.copy(ch.upperArm.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(Ru));
  ch.upperArm.updateMatrixWorld(true);
  const fl = f.clone().applyQuaternion(Ru.clone().invert());
  const flex = THREE.MathUtils.clamp(Math.atan2(fl.dot(hg.flexDir), fl.dot(hg.d0)), ELBOW_FLEX.min, ELBOW_FLEX.max);
  ch.foreArm.quaternion.copy(new THREE.Quaternion().setFromAxisAngle(hg.h, flex).multiply(ch.foreBindQuaternion));
  ch.foreArm.updateMatrixWorld(true);
}

/** The elbow's flexion now, radians, about its hinge (0 is straight). */
function elbowFlex(a: LoadedAvatar, side: Side): number {
  const ch = a.arms[side];
  const hg = hingeOf(a, side);
  ch.upperArm.updateMatrixWorld(true);
  const E = ch.foreArm.getWorldPosition(new THREE.Vector3());
  const f = ch.hand.getWorldPosition(new THREE.Vector3()).sub(E).normalize().applyQuaternion(ch.upperArm.getWorldQuaternion(new THREE.Quaternion()).invert());
  return Math.atan2(f.dot(hg.flexDir), f.dot(hg.d0));
}

/** The forearm's twist from neutral (bind), radians, about its own line; the same measure as `armAngles` in `arm-quality.ts`. */
export function forearmTwist(a: LoadedAvatar, side: Side): number {
  const ch = a.arms[side];
  const hg = hingeOf(a, side);
  const H = new THREE.Quaternion().setFromAxisAngle(hg.h, elbowFlex(a, side)).invert();
  const T = H.multiply(ch.foreArm.quaternion).multiply(ch.hand.quaternion).multiply(ch.foreBindQuaternion.clone().multiply(ch.handBindQuaternion).invert());
  const sign = T.w < 0 ? -1 : 1;
  return 2 * Math.atan2(sign * (T.x * hg.d0.x + T.y * hg.d0.y + T.z * hg.d0.z), sign * T.w);
}

/** Rolls the hand about the forearm by `angle` (radians), no further than the forearm's twist range allows. */
export function rollHand(a: LoadedAvatar, side: Side, angle: number): void {
  const ch = a.arms[side];
  const axis = ch.hand.getWorldPosition(new THREE.Vector3()).sub(ch.foreArm.getWorldPosition(new THREE.Vector3())).normalize();
  const before = forearmTwist(a, side);
  rotateBoneWorld(ch.hand, tmpQ.setFromAxisAngle(axis, angle));
  const after = forearmTwist(a, side);
  if (Math.abs(after) <= FOREARM_TWIST_LIMIT || Math.abs(after) <= Math.abs(before)) return;
  // Past the range: take back the part beyond it.
  const back = (Math.abs(after) - Math.max(FOREARM_TWIST_LIMIT, Math.abs(before))) * Math.sign(angle);
  rotateBoneWorld(ch.hand, tmpQ.setFromAxisAngle(axis, -back));
}

/**
 * Takes back the hand's roll beyond the forearm's twist range (a hand set to
 * a held object's grip, say, can ask for more turn than a forearm has).
 */
export function limitTwist(a: LoadedAvatar, side: Side): void {
  const ch = a.arms[side];
  for (let k = 0; k < 3; k += 1) {
    const tw = forearmTwist(a, side);
    if (Math.abs(tw) <= FOREARM_TWIST_LIMIT + 1e-4) return;
    const axis = ch.hand.getWorldPosition(new THREE.Vector3()).sub(ch.foreArm.getWorldPosition(new THREE.Vector3())).normalize();
    rotateBoneWorld(ch.hand, tmpQ.setFromAxisAngle(axis, -(Math.abs(tw) - FOREARM_TWIST_LIMIT) * Math.sign(tw)));
  }
}

/** Scales the forearm's twist from neutral by `k` (0 neutral, 1 as it is), rolling the hand about the forearm. */
export function easeTwist(a: LoadedAvatar, side: Side, k: number): void {
  if (k >= 1) return;
  const ch = a.arms[side];
  const axis = ch.hand.getWorldPosition(new THREE.Vector3()).sub(ch.foreArm.getWorldPosition(new THREE.Vector3())).normalize();
  rotateBoneWorld(ch.hand, tmpQ.setFromAxisAngle(axis, (k - 1) * forearmTwist(a, side)));
}

/** How fast the forearm turns over at most (radians a second): a quick, deliberate turn of the palm. */
export const TWIST_SPEED = 540 * DEG;
/**
 * How fast the forearm's turning speed changes at most (radians a second, a
 * second): 6000°/s² is 200°/s between two frames at 30 fps, under the 250°/s
 * `turn` bar in `smoothness.ts`.
 */
export const TWIST_ACCEL = 6000 * DEG;
const lastTwist = new WeakMap<LoadedAvatar, Partial<Record<Side, { t: number; twist: number; speed: number }>>>();

/**
 * Keeps the forearm's twist continuous from frame to frame: within its range,
 * at most `TWIST_SPEED`, and from the last frame the short way. The wanted
 * palm can cross the far end of the range (a palm turned past what the
 * forearm can give, then let go), where the measured twist jumps from one
 * limit to the other; the hand then unwinds back through neutral instead.
 * Call once a frame, after the arm is solved; `t` is the take time.
 */
export function steadyTwist(a: LoadedAvatar, side: Side, t: number, dt: number): void {
  const ch = a.arms[side];
  const rec = lastTwist.get(a) ?? {};
  lastTwist.set(a, rec);
  const prev = rec[side];
  const tw = forearmTwist(a, side);
  let target = softLimit(tw, FOREARM_TWIST_LIMIT);
  let speed = 0;
  if (prev && t > prev.t && t - prev.t <= 2.5 * dt) {
    const d = THREE.MathUtils.euclideanModulo(tw - prev.twist + Math.PI, 2 * Math.PI) - Math.PI;
    const goal = softLimit(prev.twist + d, FOREARM_TWIST_LIMIT);
    // At most TWIST_SPEED, the speed changed by at most TWIST_ACCEL, and
    // slow enough to stop at the goal: a palm that turns back does not
    // start or stop at full speed in one frame.
    const span = t - prev.t;
    const err = goal - prev.twist;
    const most = Math.min(TWIST_SPEED, Math.sqrt(2 * TWIST_ACCEL * Math.abs(err)), Math.abs(err) / span);
    const give = TWIST_ACCEL * span;
    speed = THREE.MathUtils.clamp(Math.sign(err) * most, prev.speed - give, prev.speed + give);
    target = prev.twist + speed * span;
  }
  for (let k = 0; k < 3; k += 1) {
    const now = forearmTwist(a, side);
    const turn = THREE.MathUtils.euclideanModulo(target - now + Math.PI, 2 * Math.PI) - Math.PI;
    if (Math.abs(turn) < 1e-3) break;
    const axis = ch.hand.getWorldPosition(new THREE.Vector3()).sub(ch.foreArm.getWorldPosition(new THREE.Vector3())).normalize();
    rotateBoneWorld(ch.hand, tmpQ.setFromAxisAngle(axis, turn));
  }
  rec[side] = { t, twist: forearmTwist(a, side), speed };
}

/** The forearm bone's own twist about its line, radians (the part of `forearmTwist` it carries, not the hand). */
function foreBoneTwist(a: LoadedAvatar, side: Side): number {
  const ch = a.arms[side];
  const hg = hingeOf(a, side);
  const T = new THREE.Quaternion().setFromAxisAngle(hg.h, elbowFlex(a, side)).invert().multiply(ch.foreArm.quaternion).multiply(ch.foreBindQuaternion.clone().invert());
  const sign = T.w < 0 ? -1 : 1;
  return 2 * Math.atan2(sign * (T.x * hg.d0.x + T.y * hg.d0.y + T.z * hg.d0.z), sign * T.w);
}

/**
 * Gives the forearm bone a fixed share of the forearm's whole twist and the
 * hand the rest, with the hand's world pose kept. The palm roll in `solveArm`
 * splits a turn that can wrap past half a turn (B-097): from one frame to the
 * next its forearm half jumped from +42.5° to -42.5°, and `steadyTwist`
 * mended only the sum. Call once a frame, after `steadyTwist`.
 */
export function shareTwist(a: LoadedAvatar, side: Side): void {
  const ch = a.arms[side];
  const turn = FOREARM_TWIST_SHARE * forearmTwist(a, side) - foreBoneTwist(a, side);
  if (Math.abs(turn) < 1e-5) return;
  const axis = ch.hand.getWorldPosition(new THREE.Vector3()).sub(ch.foreArm.getWorldPosition(new THREE.Vector3())).normalize();
  const handWorld = ch.hand.getWorldQuaternion(new THREE.Quaternion());
  rotateBoneWorld(ch.foreArm, tmpQ.setFromAxisAngle(axis, turn));
  ch.hand.quaternion.copy(ch.foreArm.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(handWorld));
  ch.hand.updateMatrixWorld(true);
}

/**
 * Runs `move` (which re-solves the arm) and gives the forearm and the hand
 * back the twist and the wrist turn they had: a small move of the arm does
 * not turn the palm over.
 */
export function keepingTwist(a: LoadedAvatar, side: Side, move: () => void): void {
  const ch = a.arms[side];
  const hg = hingeOf(a, side);
  const fore = ch.foreArm.quaternion.clone();
  const hand = ch.hand.quaternion.clone();
  const before = elbowFlex(a, side);
  move();
  const after = elbowFlex(a, side);
  ch.foreArm.quaternion.copy(new THREE.Quaternion().setFromAxisAngle(hg.h, after - before).multiply(fore));
  ch.hand.quaternion.copy(hand);
  ch.foreArm.updateMatrixWorld(true);
}

/** How far off the forearm axis (sine of the angle) a wanted palm direction must be for no roll (from) and the full roll (to). */
const PALM_ROLL_SURE = { from: 0.1, to: 0.4 } as const;

/**
 * Puts the wrist at a world point with capture's arm solver, the elbow a
 * hinge; the hand keeps its bind wrist unless rolled. A roll toward
 * `palmToward` is shared between the forearm and the hand and stops at the
 * forearm's range: past it, the palm faces as near as the forearm can turn.
 */
export function solveArm(a: LoadedAvatar, side: Side, wristWorld: THREE.Vector3, options: ArmOptions = {}): boolean {
  const chain = a.arms[side];
  const rigHint = options.elbowHint ? chain.elbowHintLocal.clone() : undefined;
  if (options.elbowHint) chain.elbowHintLocal.copy(options.elbowHint).normalize();
  const ok = solver.solve(chain, wristWorld, IDENTITY, a.frame);
  if (rigHint) chain.elbowHintLocal.copy(rigHint);
  hingeElbow(a, side);
  chain.hand.quaternion.copy(chain.handBindQuaternion);
  chain.hand.updateMatrixWorld(true);
  const hand = a.hands[side];
  if (options.palmToward && hand) {
    // Roll about the forearm until the palm faces the wanted direction (projected off the forearm axis).
    const fore = chain.foreArm.getWorldPosition(new THREE.Vector3());
    const axis = chain.hand.getWorldPosition(new THREE.Vector3()).sub(fore).normalize();
    const now = hand.palmNormal(new THREE.Vector3());
    const want = options.palmToward.clone().normalize();
    const p = now.clone().addScaledVector(axis, -now.dot(axis));
    const w = want.clone().addScaledVector(axis, -want.dot(axis));
    // A wanted direction near the forearm axis gives no roll: its part off the axis is short, and its angle
    // swings by tens of degrees in one frame as that part passes near zero. So the roll fades out there.
    const sure = THREE.MathUtils.smoothstep(Math.sqrt(w.lengthSq()), PALM_ROLL_SURE.from, PALM_ROLL_SURE.to);
    if (p.lengthSq() > 1e-6 && sure > 0) {
      p.normalize(); w.normalize();
      const angle = sure * softLimit(Math.atan2(tmpV.crossVectors(p, w).dot(axis), p.dot(w)), FOREARM_TWIST_LIMIT);
      rotateBoneWorld(chain.foreArm, tmpQ.setFromAxisAngle(axis, angle * FOREARM_TWIST_SHARE));
      rotateBoneWorld(chain.hand, tmpQ.setFromAxisAngle(axis, angle * (1 - FOREARM_TWIST_SHARE)));
    }
    if (options.wristBend) {
      // A bend, not a roll: the turn's axis is kept across the forearm (the roll is limited above).
      const n = hand.palmNormal(new THREE.Vector3());
      const fore = chain.hand.getWorldPosition(new THREE.Vector3()).sub(chain.foreArm.getWorldPosition(new THREE.Vector3())).normalize();
      const bendAxis = tmpV2.crossVectors(n, want);
      bendAxis.addScaledVector(fore, -bendAxis.dot(fore));
      const bend = Math.min(options.wristBend, Math.asin(Math.min(1, bendAxis.length())));
      if (bendAxis.lengthSq() > 1e-8) rotateBoneWorld(chain.hand, tmpQ.setFromAxisAngle(bendAxis.normalize(), bend));
    }
  }
  return ok;
}

/**
 * Reaches so the palm (not the wrist) stops `stopShort` metres before a world
 * target, along the line from the shoulder. Corrects the wrist target a few
 * times against the measured palm, since the palm sits off the wrist.
 */
export function reachPalm(a: LoadedAvatar, side: Side, targetWorld: THREE.Vector3, stopShort: number, options: ArmOptions = {}): { palmWorld: THREE.Vector3; distance: number } {
  const hand = a.hands[side];
  const shoulder = a.arms[side].upperArm.getWorldPosition(new THREE.Vector3());
  const dir = targetWorld.clone().sub(shoulder).normalize();
  const goal = targetWorld.clone().addScaledVector(dir, -stopShort);
  const wrist = goal.clone();
  const palm = new THREE.Vector3();
  for (let i = 0; i < 6; i += 1) {
    solveArm(a, side, wrist, options);
    a.frame.updateMatrixWorld(true);
    if (hand) hand.palmCenter(palm); else a.arms[side].hand.getWorldPosition(palm);
    const err = goal.clone().sub(palm);
    if (err.length() < 5e-4) break;
    wrist.add(err);
  }
  return { palmWorld: palm.clone(), distance: palm.distanceTo(targetWorld) };
}

/** Plants both ankles at world points, knees along the body's forward, feet back to their bind rotation in the given yaw. */
export function plantFeet(a: LoadedAvatar, ankles: Readonly<Record<Side, THREE.Vector3>>, footYaw: Readonly<Record<Side, number>> = { left: 0, right: 0 }): void {
  const rootQuat = bodyQuaternion(a);
  const up = bodyUp(a);
  for (const side of ['left', 'right'] as const) {
    const leg = a.legs[side];
    const yaw = tmpQ.setFromAxisAngle(up, footYaw[side]);
    const pole = new THREE.Vector3(0, 0, 1).applyQuaternion(rootQuat).applyQuaternion(yaw);
    solveTwoBoneLeg(leg as never, ankles[side], pole, rootQuat);
    a.frame.updateMatrixWorld(true);
    // Foot flat on the floor in its own yaw.
    const want = yaw.clone().multiply(rootQuat).multiply(leg.foot.rootQuaternion);
    const parent = leg.foot.bone.parent!.getWorldQuaternion(new THREE.Quaternion());
    leg.foot.bone.quaternion.copy(parent.invert().multiply(want)).normalize();
    leg.foot.bone.updateMatrixWorld(true);
  }
}

/** Bind ankle positions in world space (before any posing). */
export function bindAnkles(a: LoadedAvatar): Record<Side, THREE.Vector3> {
  return { left: toWorld(a, a.legs.left.foot.rootPosition), right: toWorld(a, a.legs.right.foot.rootPosition) };
}

/** Turn share per bone, hips first: a look back is mostly the spine and head, little of the hips. */
export const TURN_SHARE: ReadonlyArray<readonly [VrmHumanoidBone, number]> = [
  ['hips', 0.25], ['spine', 0.15], ['chest', 0.15], ['upperChest', 0.1], ['neck', 0.15], ['head', 0.2]
];

/** Rotates the body about its up axis, spread down the spine; missing bones pass their share up. */
export function turnBody(a: LoadedAvatar, yaw: number, shares: ReadonlyArray<readonly [VrmHumanoidBone, number]> = TURN_SHARE): void {
  const up = bodyUp(a);
  let carry = 0;
  for (const [name, share] of shares) {
    const bone = a.humanoid.bone(name);
    if (!bone) { carry += share; continue; }
    rotateBoneWorld(bone, tmpQ.setFromAxisAngle(up, yaw * (share + carry)));
    carry = 0;
  }
  if (carry > 0) rotateBoneWorld(a.humanoid.bone('head')!, tmpQ.setFromAxisAngle(up, yaw * carry));
}


/** How far a hand turns from its neutral wrist, in degrees: forearm roll either way, then the wrist's bend. */
export const WRIST_LIMITS = { roll: 85, flex: 60, extend: 55, radial: 20, ulnar: 30 } as const;

/**
 * Turns a hand toward a wanted world orientation as far as an arm allows: the
 * part about the forearm is a roll (capped at ±85° from the bind wrist), the
 * rest a wrist bend within flexion and deviation limits; a turn about the
 * fingers' own axis is dropped. Returns how many degrees the hand ends short.
 */
export function orientHand(a: LoadedAvatar, side: Side, wanted: THREE.Quaternion): number {
  const chain = a.arms[side];
  const hand = chain.hand;
  const rig = a.hands[side];
  hand.updateMatrixWorld(true);
  const parent = hand.parent!.getWorldQuaternion(new THREE.Quaternion());
  const neutral = parent.clone().multiply(chain.handBindQuaternion);
  const delta = wanted.clone().multiply(neutral.clone().invert());
  if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
  const fore = hand.getWorldPosition(new THREE.Vector3()).sub(chain.foreArm.getWorldPosition(new THREE.Vector3())).normalize();
  // Swing-twist about the forearm: delta = swing · twist.
  const along = delta.x * fore.x + delta.y * fore.y + delta.z * fore.z;
  const rollAngle = 2 * Math.atan2(along, delta.w);
  const twist = new THREE.Quaternion().setFromAxisAngle(fore, rollAngle);
  const swing = delta.clone().multiply(twist.clone().invert());
  const roll = THREE.MathUtils.clamp(wrapRad(rollAngle), -WRIST_LIMITS.roll * DEG, WRIST_LIMITS.roll * DEG);
  const rolled = new THREE.Quaternion().setFromAxisAngle(fore, roll).multiply(neutral);
  let result = rolled;
  if (rig) {
    // The palm's axes in the hand's own frame, then in the rolled neutral frame.
    const toLocal = hand.getWorldQuaternion(new THREE.Quaternion()).invert();
    const palm = rig.palmFrame(new THREE.Quaternion());
    const local = (v: THREE.Vector3) => v.applyQuaternion(palm).applyQuaternion(toLocal).applyQuaternion(rolled);
    const fingers = local(new THREE.Vector3(0, 1, 0));
    const thumbSide = local(new THREE.Vector3(1, 0, 0));
    const normal = local(new THREE.Vector3(0, 0, side === 'right' ? 1 : -1));
    const flexAxis = new THREE.Vector3().crossVectors(fingers, normal).normalize();
    const radialAxis = new THREE.Vector3().crossVectors(fingers, thumbSide).normalize();
    if (swing.w < 0) swing.set(-swing.x, -swing.y, -swing.z, -swing.w);
    const angle = 2 * Math.acos(THREE.MathUtils.clamp(swing.w, -1, 1));
    const s = Math.sqrt(Math.max(0, 1 - swing.w * swing.w));
    const vec = s > 1e-8 ? new THREE.Vector3(swing.x / s, swing.y / s, swing.z / s).multiplyScalar(angle) : new THREE.Vector3();
    const flex = THREE.MathUtils.clamp(vec.dot(flexAxis), -WRIST_LIMITS.extend * DEG, WRIST_LIMITS.flex * DEG);
    const radial = THREE.MathUtils.clamp(vec.dot(radialAxis), -WRIST_LIMITS.ulnar * DEG, WRIST_LIMITS.radial * DEG);
    const bend = flexAxis.multiplyScalar(flex).addScaledVector(radialAxis, radial);
    const bendAngle = bend.length();
    if (bendAngle > 1e-8) result = new THREE.Quaternion().setFromAxisAngle(bend.normalize(), bendAngle).multiply(rolled);
  }
  hand.quaternion.copy(parent.clone().invert().multiply(result));
  hand.updateMatrixWorld(true);
  limitTwist(a, side);
  return hand.getWorldQuaternion(new THREE.Quaternion()).angleTo(wanted) / DEG;
}

