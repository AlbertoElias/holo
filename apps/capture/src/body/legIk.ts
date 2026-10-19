import * as THREE from 'three';

import { clamp } from '../shared/math';

interface LegBones {
  upLeg: { bone: THREE.Bone; rootPosition: THREE.Vector3; rootQuaternion: THREE.Quaternion };
  leg: { bone: THREE.Bone; rootPosition: THREE.Vector3; rootQuaternion: THREE.Quaternion };
  foot: { rootPosition: THREE.Vector3 };
  thighLength: number;
  shinLength: number;
}

const BIND_FORWARD = new THREE.Vector3(0, 0, 1);
const SOFT_REACH = 0.05;
const hip = new THREE.Vector3();
const toAnkle = new THREE.Vector3();
const reachDir = new THREE.Vector3();
const bend = new THREE.Vector3();
const knee = new THREE.Vector3();
const ankle = new THREE.Vector3();
const axis = new THREE.Vector3();
const bindAxis = new THREE.Vector3();
const bindBend = new THREE.Vector3();
const frameBind = new THREE.Matrix4();
const frameNow = new THREE.Matrix4();
const third = new THREE.Vector3();
const thirdBind = new THREE.Vector3();
const frameQuat = new THREE.Quaternion();
const boneQuat = new THREE.Quaternion();
const parentQuat = new THREE.Quaternion();

// Unit vector of `v` with its component along `along` removed.
function perpendicular(v: THREE.Vector3, along: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  out.copy(v).addScaledVector(along, -v.dot(along));
  if (out.lengthSq() < 1e-10) out.set(1, 0, 0).addScaledVector(along, -along.x);
  return out.normalize();
}

// Rotates a bone so the frame (bone axis, knee-forward) it had at bind maps
// onto the solved frame; this controls twist, so the knee hinge stays in the
// plane of the leg and points along the pole.
function aimBone(
  bone: THREE.Bone,
  bindRootQuaternion: THREE.Quaternion,
  bindFrom: THREE.Vector3,
  bindTo: THREE.Vector3,
  from: THREE.Vector3,
  to: THREE.Vector3,
  pole: THREE.Vector3,
  rootQuat: THREE.Quaternion
): void {
  bindAxis.subVectors(bindTo, bindFrom).applyQuaternion(rootQuat).normalize();
  perpendicular(bindBend.copy(BIND_FORWARD).applyQuaternion(rootQuat), bindAxis, bindBend);
  thirdBind.crossVectors(bindAxis, bindBend);
  frameBind.makeBasis(bindAxis, bindBend, thirdBind);

  axis.subVectors(to, from).normalize();
  perpendicular(pole, axis, bend);
  third.crossVectors(axis, bend);
  frameNow.makeBasis(axis, bend, third);

  frameQuat.setFromRotationMatrix(frameNow.multiply(frameBind.transpose()));
  boneQuat.copy(rootQuat).multiply(bindRootQuaternion).premultiply(frameQuat);
  bone.parent!.getWorldQuaternion(parentQuat);
  bone.quaternion.copy(parentQuat.invert()).multiply(boneQuat).normalize();
}

// Two-bone leg IK: hip joint fixed, ankle to `ankleTarget` (pulled in when out
// of reach), knee toward `pole`.
export function solveTwoBoneLeg(leg: LegBones, ankleTarget: THREE.Vector3, pole: THREE.Vector3, rootQuat: THREE.Quaternion): void {
  leg.upLeg.bone.getWorldPosition(hip);
  toAnkle.subVectors(ankleTarget, hip);
  const rawDistance = toAnkle.length();
  if (rawDistance < 1e-6) return;
  const upper = leg.thighLength;
  const lower = leg.shinLength;
  // Soft IK: near full extension the knee moves infinitely fast with reach,
  // so the last few percent of reach are approached asymptotically; the foot
  // falls a few millimetres short instead of the knee snapping.
  const fullReach = (upper + lower) * 0.9995;
  const softStart = fullReach * (1 - SOFT_REACH);
  const soft = rawDistance > softStart
    ? softStart + (fullReach - softStart) * (1 - Math.exp(-(rawDistance - softStart) / (fullReach - softStart)))
    : rawDistance;
  const distance = clamp(soft, Math.abs(upper - lower) + 1e-3, fullReach);
  reachDir.copy(toAnkle).multiplyScalar(1 / rawDistance);
  ankle.copy(hip).addScaledVector(reachDir, distance);

  const along = (upper * upper - lower * lower + distance * distance) / (2 * distance);
  const height = Math.sqrt(Math.max(0, upper * upper - along * along));
  perpendicular(pole, reachDir, bend);
  knee.copy(hip).addScaledVector(reachDir, along).addScaledVector(bend, height);

  aimBone(leg.upLeg.bone, leg.upLeg.rootQuaternion, leg.upLeg.rootPosition, leg.leg.rootPosition, hip, knee, pole, rootQuat);
  aimBone(leg.leg.bone, leg.leg.rootQuaternion, leg.leg.rootPosition, leg.foot.rootPosition, knee, ankle, pole, rootQuat);
}
