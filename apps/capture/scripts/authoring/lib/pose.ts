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

/** Where a hand hangs when the arm is at rest, slightly bent and off the thigh. */
export function armRestTarget(a: LoadedAvatar, side: Side, out = new THREE.Vector3()): THREE.Vector3 {
  const chain = a.arms[side];
  const shoulder = a.bind.get(`${side}UpperArm`)!.rootPosition;
  const reach = chain.upperLength + chain.lowerLength;
  const sign = side === 'left' ? 1 : -1;
  return out.set(shoulder.x + sign * 0.09 * reach, shoulder.y - 0.95 * reach, shoulder.z + 0.06 * reach);
}

export interface ArmOptions {
  /** World direction the palm should face (rolled about the forearm); omitted keeps the neutral wrist. */
  readonly palmToward?: THREE.Vector3 | undefined;
  /** Bend the wrist back up to this much toward `palmToward` (radians), for a hand offered. */
  readonly wristBend?: number;
}

/** Puts the wrist at a world point with capture's arm solver; the hand keeps its bind wrist unless rolled. */
export function solveArm(a: LoadedAvatar, side: Side, wristWorld: THREE.Vector3, options: ArmOptions = {}): boolean {
  const chain = a.arms[side];
  const ok = solver.solve(chain, wristWorld, IDENTITY, a.frame);
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
    if (p.lengthSq() > 1e-6 && w.lengthSq() > 1e-6) {
      p.normalize(); w.normalize();
      const angle = Math.atan2(tmpV.crossVectors(p, w).dot(axis), p.dot(w));
      rotateBoneWorld(chain.hand, tmpQ.setFromAxisAngle(axis, angle));
    }
    if (options.wristBend) {
      const n = hand.palmNormal(new THREE.Vector3());
      const bendAxis = tmpV2.crossVectors(n, want);
      const bend = Math.min(options.wristBend, Math.acos(THREE.MathUtils.clamp(n.dot(want), -1, 1)));
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

/** Rotates a body-frame point about the body's up axis through the hips. */
export function yawAboutHips(a: LoadedAvatar, local: THREE.Vector3, yaw: number, out = new THREE.Vector3()): THREE.Vector3 {
  const hips = a.bind.get('hips')!.rootPosition;
  return out.copy(local).sub(hips).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw).add(hips);
}
