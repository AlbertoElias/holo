import * as THREE from 'three';
import { VRM_HUMANOID_BONES, type VrmHumanoidBone } from '@holoim/meaning';

import type { HumanoidSkeleton } from '../avatar/HumanoidSkeleton';

/** A loaded avatar at rest: its root (facing already normalized) and its bound humanoid. */
export interface RetargetRig {
  readonly root: THREE.Object3D;
  readonly humanoid: HumanoidSkeleton;
}

export interface RetargetResult {
  readonly clips: THREE.AnimationClip[];
  /** Rest-pose correction per limb bone, in degrees (only bones corrected by more than 0.5°). */
  readonly correctionDeg: Partial<Record<VrmHumanoidBone, number>>;
}

// Arm bones whose rest is turned onto the source's: the T-pose and A-pose
// correction. Each aims at its child; the forearm and hand also roll so the
// knuckle line (index → little) matches, which undoes a palms-forward rest.
// Legs, feet, spine and head keep their own rest shape: the desktop idle
// leaves the legs at rest, so a leg correction would pop at every stop.
const CORRECTED: ReadonlyArray<readonly [VrmHumanoidBone, VrmHumanoidBone, boolean]> = [
  ['leftUpperArm', 'leftLowerArm', false], ['leftLowerArm', 'leftHand', true], ['leftHand', 'leftMiddleProximal', true],
  ['rightUpperArm', 'rightLowerArm', false], ['rightLowerArm', 'rightHand', true], ['rightHand', 'rightMiddleProximal', true]
];
// A target bone whose local rotation never leaves its rest by more than this gets no track.
const TRACK_EPSILON_RAD = THREE.MathUtils.degToRad(0.05);
const REPORT_EPSILON_DEG = 0.5;

/** Rotation of `obj` in `root`'s frame, from the current local transforms. */
function rotationInRoot(obj: THREE.Object3D, root: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion {
  out.identity();
  for (let at: THREE.Object3D | null = obj; at && at !== root; at = at.parent) out.premultiply(at.quaternion);
  return out;
}

function humanoidBoneOf(obj: THREE.Object3D, humanoid: HumanoidSkeleton): VrmHumanoidBone | undefined {
  return VRM_HUMANOID_BONES.find((b) => humanoid.bone(b) === obj);
}

/** An arm bone's rest direction to its child, and its knuckle line when the roll is matched too. */
interface Aim { readonly direction: THREE.Vector3; readonly knuckles?: THREE.Vector3 }

function aimOf(rig: RetargetRig, bone: VrmHumanoidBone, child: VrmHumanoidBone, side?: 'left' | 'right'): Aim | undefined {
  const b = rig.humanoid.bone(bone);
  const c = rig.humanoid.bone(child);
  if (!b || !c) return undefined;
  const direction = positionInRoot(c, rig.root).sub(positionInRoot(b, rig.root));
  if (direction.lengthSq() < 1e-12) return undefined;
  direction.normalize();
  const index = side && rig.humanoid.bone(`${side}IndexProximal`);
  const little = side && rig.humanoid.bone(`${side}LittleProximal`);
  if (!index || !little) return { direction };
  const knuckles = positionInRoot(little, rig.root).sub(positionInRoot(index, rig.root));
  knuckles.addScaledVector(direction, -knuckles.dot(direction));
  return knuckles.lengthSq() < 1e-12 ? { direction } : { direction, knuckles: knuckles.normalize() };
}

/** The root-frame rotation that turns the target's aim (already carried by `carried`) onto the source's. */
function alignAim(target: Aim, carried: THREE.Quaternion, source: Aim): THREE.Quaternion {
  const direction = target.direction.clone().applyQuaternion(carried);
  if (!target.knuckles || !source.knuckles) return new THREE.Quaternion().setFromUnitVectors(direction, source.direction);
  const frame = (x: THREE.Vector3, k: THREE.Vector3) => {
    const z = k.clone().addScaledVector(x, -k.dot(x)).normalize();
    return new THREE.Matrix4().makeBasis(x, new THREE.Vector3().crossVectors(z, x), z);
  };
  const from = frame(direction, target.knuckles.clone().applyQuaternion(carried));
  const to = frame(source.direction, source.knuckles);
  return new THREE.Quaternion().setFromRotationMatrix(to.multiply(from.transpose()));
}

/** Throws when a node between the root and a canonical bone mirrors or scales unevenly: rotations alone no longer describe it. */
function assertRigidChain(rig: RetargetRig, label: string): void {
  for (const b of VRM_HUMANOID_BONES) {
    for (let at: THREE.Object3D | null = rig.humanoid.bone(b) ?? null; at && at !== rig.root; at = at.parent) {
      const { x, y, z } = at.scale;
      if (x <= 0 || y <= 0 || z <= 0 || Math.max(x, y, z) - Math.min(x, y, z) > 1e-3 * Math.max(x, y, z)) {
        throw new Error(`${label}: ${at.name || 'a node'} has a mirrored or uneven scale (${x}, ${y}, ${z})`);
      }
    }
  }
}

function positionInRoot(obj: THREE.Object3D, root: THREE.Object3D): THREE.Vector3 {
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  return obj.getWorldPosition(new THREE.Vector3()).applyMatrix4(toRoot);
}

/**
 * Retargets clips authored on `source` onto `target`
 * (docs/features/locomotion-retarget.md). Motion moves as a rotation in the
 * shared root frame (+Z forward, +Y up after the facing correction), so bone
 * axes, armature nodes and scale do not matter: per canonical bone the target
 * takes T(t) = S(t) · Rs⁻¹ · A · Rt, where S is the source bone's root-frame
 * rotation, Rs and Rt the rest rotations, and A the turn that puts the
 * target's rest arm onto the source's. Both rigs must be at rest, with no
 * mirrored or uneven scale between root and bones (that throws).
 * Tracks bind by the target bone's uuid.
 */
export function retargetClips(source: RetargetRig, clips: readonly THREE.AnimationClip[], target: RetargetRig): RetargetResult {
  assertRigidChain(source, 'clip source');
  assertRigidChain(target, 'avatar');
  const bones = VRM_HUMANOID_BONES.filter((b) => source.humanoid.bone(b) && target.humanoid.bone(b));
  const sourceBone = (b: VrmHumanoidBone) => source.humanoid.bone(b)!;
  const targetBone = (b: VrmHumanoidBone) => target.humanoid.bone(b)!;

  const sourceRest = new Map<THREE.Object3D, THREE.Quaternion>();
  source.root.traverse((obj) => sourceRest.set(obj, obj.quaternion.clone()));
  const restoreSource = () => { for (const [obj, q] of sourceRest) obj.quaternion.copy(q); };

  // The target's corrected rest E = A · Rt. A is applied parent-first: a
  // corrected upper arm carries the forearm, hand and fingers with it, and
  // each arm bone only turns what is left.
  const aims = new Map<THREE.Object3D, { target: Aim; source: Aim }>();
  for (const [bone, child, roll] of CORRECTED) {
    const side = bone.startsWith('left') ? 'left' : 'right';
    const s = aimOf(source, bone, child, roll ? side : undefined);
    const t = aimOf(target, bone, child, roll ? side : undefined);
    if (s && t) aims.set(target.humanoid.bone(bone)!, { target: t, source: s });
  }
  // Target nodes in parent-first order, with their rest locals, below the root.
  const targetNodes: THREE.Object3D[] = [];
  target.root.traverse((obj) => { if (obj !== target.root) targetNodes.push(obj); });
  const targetRest = new Map(targetNodes.map((obj) => [obj, obj.quaternion.clone()]));
  const applied = new Map<THREE.Object3D, THREE.Quaternion>();
  const correctionDeg: Partial<Record<VrmHumanoidBone, number>> = {};
  for (const obj of targetNodes) {
    const own = ((obj.parent && applied.get(obj.parent)) ?? new THREE.Quaternion()).clone();
    const aim = aims.get(obj);
    if (aim) {
      const turn = alignAim(aim.target, own, aim.source);
      own.premultiply(turn);
      const deg = THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(turn.w))));
      const b = humanoidBoneOf(obj, target.humanoid);
      if (b && deg > REPORT_EPSILON_DEG) correctionDeg[b] = Math.round(deg * 10) / 10;
    }
    applied.set(obj, own);
  }
  const rs = new Map<VrmHumanoidBone, THREE.Quaternion>();
  const corrected = new Map<VrmHumanoidBone, THREE.Quaternion>();
  for (const b of bones) {
    rs.set(b, rotationInRoot(sourceBone(b), source.root, new THREE.Quaternion()));
    corrected.set(b, rotationInRoot(targetBone(b), target.root, new THREE.Quaternion()).premultiply(applied.get(targetBone(b))!));
  }
  const canonicalOf = new Map(bones.map((b) => [targetBone(b) as THREE.Object3D, b]));

  const delta = new THREE.Quaternion();
  const s = new THREE.Quaternion();
  const out: THREE.AnimationClip[] = [];
  for (const clip of clips) {
    const tracks = clip.tracks.flatMap((track) => {
      if (!(track instanceof THREE.QuaternionKeyframeTrack)) return [];
      const { nodeName } = THREE.PropertyBinding.parseTrackName(track.name);
      const node = THREE.PropertyBinding.findNode(source.root, nodeName) as THREE.Object3D | null;
      return node ? [{ node, interpolant: track.createInterpolant() }] : [];
    });
    const times = [...new Set(clip.tracks.flatMap((t) => [...t.times]))].sort((a, b) => a - b);
    const values = new Map<VrmHumanoidBone, number[]>(bones.map((b) => [b, []]));
    const moved = new Set<VrmHumanoidBone>();
    const world = new Map<THREE.Object3D, THREE.Quaternion>();
    for (const time of times) {
      restoreSource();
      for (const { node, interpolant } of tracks) {
        const v = interpolant.evaluate(time);
        node.quaternion.set(v[0]!, v[1]!, v[2]!, v[3]!).normalize();
      }
      world.clear();
      for (const obj of targetNodes) {
        const parentWorld = (obj.parent && world.get(obj.parent)) ?? new THREE.Quaternion();
        const b = canonicalOf.get(obj);
        let local = targetRest.get(obj)!;
        let objWorld: THREE.Quaternion;
        if (b) {
          rotationInRoot(sourceBone(b), source.root, s);
          delta.copy(s).multiply(rs.get(b)!.clone().invert());
          objWorld = delta.clone().multiply(corrected.get(b)!);
          local = parentWorld.clone().invert().multiply(objWorld).normalize();
          const series = values.get(b)!;
          const n = series.length;
          // Keep consecutive keys in the same hemisphere so interpolation takes the short way.
          if (n >= 4 && series[n - 4]! * local.x + series[n - 3]! * local.y + series[n - 2]! * local.z + series[n - 1]! * local.w < 0) {
            local.set(-local.x, -local.y, -local.z, -local.w);
          }
          series.push(local.x, local.y, local.z, local.w);
          if (local.angleTo(targetRest.get(obj)!) > TRACK_EPSILON_RAD) moved.add(b);
        } else {
          objWorld = parentWorld.clone().multiply(local);
        }
        world.set(obj, objWorld);
      }
    }
    restoreSource();
    const retargeted = bones
      .filter((b) => moved.has(b))
      .map((b) => new THREE.QuaternionKeyframeTrack(`${targetBone(b).uuid}.quaternion`, times, values.get(b)!));
    if (retargeted.length === 0) continue;
    const result = new THREE.AnimationClip(clip.name, clip.duration, retargeted);
    result.blendMode = clip.blendMode;
    out.push(result);
  }
  return { clips: out, correctionDeg };
}
