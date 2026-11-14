/**
 * Hand shapes for directed takes. `HandFingerRetargeter` follows tracked
 * joints and needs a browser, so shapes are new here: each finger curls
 * toward the palm about an axis measured once at bind (joint direction ×
 * palm normal, from capture's own palm frame), so the same shape reads the
 * same on any rig whatever its bone axes.
 */
import * as THREE from 'three';
import type { VrmHumanoidBone } from '@holoim/meaning';

import type { HumanoidSkeleton } from '../../../src/avatar/HumanoidSkeleton.ts';
import { palmFrameQuaternion } from '../../../src/xr/palmFrame.ts';

export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'little'] as const;
export type FingerName = (typeof FINGERS)[number];

/** Curl per finger, 0 (straight) to 1 (fist), plus spread (0 closed to 1 splayed). */
export interface HandPose {
  readonly curl: Readonly<Record<FingerName, number>>;
  readonly spread: number;
}

export const HAND_SHAPES = {
  relaxed: { curl: { thumb: 0.2, index: 0.18, middle: 0.24, ring: 0.3, little: 0.36 }, spread: 0.15 },
  open: { curl: { thumb: 0.02, index: 0.02, middle: 0.02, ring: 0.03, little: 0.04 }, spread: 0.7 },
  reach: { curl: { thumb: 0.12, index: 0.08, middle: 0.12, ring: 0.16, little: 0.2 }, spread: 0.35 },
  fist: { curl: { thumb: 0.85, index: 1, middle: 1, ring: 1, little: 1 }, spread: 0 },
  point: { curl: { thumb: 0.8, index: 0.02, middle: 1, ring: 1, little: 1 }, spread: 0 },
  grip: { curl: { thumb: 0.55, index: 0.62, middle: 0.66, ring: 0.7, little: 0.74 }, spread: 0.1 },
  // The hand held back: fingers half-closed, not a fist.
  withheld: { curl: { thumb: 0.45, index: 0.48, middle: 0.55, ring: 0.6, little: 0.66 }, spread: 0.05 }
} as const satisfies Record<string, HandPose>;
export type HandShapeName = keyof typeof HAND_SHAPES;

export function blendPose(a: HandPose, b: HandPose, f: number): HandPose {
  const curl = {} as Record<FingerName, number>;
  for (const k of FINGERS) curl[k] = a.curl[k] + (b.curl[k] - a.curl[k]) * f;
  return { curl, spread: a.spread + (b.spread - a.spread) * f };
}

/** `grip` strength scales a shape's curl from the relaxed hand (0) to the shape (1) and past it, capped at a fist. */
export function shapePose(name: HandShapeName, strength = 1): HandPose {
  const base = blendPose(HAND_SHAPES.relaxed, HAND_SHAPES[name], Math.min(strength, 1));
  if (strength <= 1) return base;
  const curl = {} as Record<FingerName, number>;
  for (const k of FINGERS) curl[k] = Math.min(1, base.curl[k] * strength);
  return { curl, spread: base.spread };
}

// Full-curl angle per joint (radians), proximal → distal.
const FINGER_MAX = [1.45, 1.6, 1.05] as const;
const THUMB_MAX = [0.45, 0.7, 0.85] as const;
const SPREAD_MAX = 0.22;
const SPREAD_SIGN: Record<FingerName, number> = { thumb: 0.8, index: 1, middle: 0.2, ring: -0.6, little: -1.2 };

interface Joint {
  readonly bone: THREE.Bone;
  readonly bindLocal: THREE.Quaternion;
  readonly curlAxis: THREE.Vector3;
  readonly spreadAxis: THREE.Vector3;
  readonly max: number;
}

const JOINT_NAMES: Record<FingerName, readonly string[]> = {
  thumb: ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal'],
  index: ['IndexProximal', 'IndexIntermediate', 'IndexDistal'],
  middle: ['MiddleProximal', 'MiddleIntermediate', 'MiddleDistal'],
  ring: ['RingProximal', 'RingIntermediate', 'RingDistal'],
  little: ['LittleProximal', 'LittleIntermediate', 'LittleDistal']
};

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const q1 = new THREE.Quaternion();
const q2 = new THREE.Quaternion();

export class HandRig {
  private constructor(
    readonly side: 'left' | 'right',
    readonly hand: THREE.Bone,
    private readonly joints: Readonly<Record<FingerName, readonly Joint[]>>,
    private readonly tipBones: Readonly<Record<FingerName, { bone: THREE.Object3D; offset: THREE.Vector3 } | undefined>>,
    private readonly knuckles: { index: THREE.Bone; middle: THREE.Bone; little: THREE.Bone },
    /** Hand length (wrist → middle fingertip) at bind, metres. */
    readonly length: number
  ) {}

  /** undefined when the rig has no index, middle and little proximal bones. */
  static create(humanoid: HumanoidSkeleton, side: 'left' | 'right', body: THREE.Object3D): HandRig | undefined {
    const hand = humanoid.bone(`${side}Hand`);
    const bone = (n: string) => humanoid.bone(`${side}${n}` as VrmHumanoidBone);
    const index = bone('IndexProximal');
    const middle = bone('MiddleProximal');
    const little = bone('LittleProximal');
    if (!hand || !index || !middle || !little) return undefined;
    body.updateWorldMatrix(true, true);
    const at = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
    const wrist = at(hand);
    const palm = palmFrameQuaternion(wrist, at(index), at(middle), at(little), new THREE.Quaternion());
    if (!palm) return undefined;
    const across = new THREE.Vector3(1, 0, 0).applyQuaternion(palm);
    // Palm-side normal: +Z of the palm frame on a right hand, −Z on a left one.
    const normal = new THREE.Vector3(0, 0, side === 'right' ? 1 : -1).applyQuaternion(palm);
    const towardLittle = across.clone().negate();

    const joints = {} as Record<FingerName, Joint[]>;
    const tips = {} as Record<FingerName, { bone: THREE.Object3D; offset: THREE.Vector3 } | undefined>;
    for (const finger of FINGERS) {
      const bones = JOINT_NAMES[finger].map(bone).filter((b): b is THREE.Bone => b !== undefined);
      const distalName = `${side}${JOINT_NAMES[finger][2]}` as VrmHumanoidBone;
      const tip = humanoid.tip(distalName);
      const list: Joint[] = [];
      bones.forEach((b, i) => {
        const p = at(b);
        let child = bones[i + 1] ? at(bones[i + 1]!) : tip ? at(tip) : undefined;
        if (!child) {
          // No end site: extend the last segment by the one before it.
          const prev = i > 0 ? at(bones[i - 1]!) : wrist;
          child = p.clone().add(p.clone().sub(prev).multiplyScalar(0.8));
        }
        const d = child.sub(p).normalize();
        const toward = finger === 'thumb' ? normal.clone().multiplyScalar(0.6).addScaledVector(towardLittle, 0.8).normalize() : normal;
        const curlWorld = new THREE.Vector3().crossVectors(d, toward);
        if (curlWorld.lengthSq() < 1e-8) curlWorld.copy(across);
        curlWorld.normalize();
        const inv = b.getWorldQuaternion(new THREE.Quaternion()).invert();
        const max = (finger === 'thumb' ? THUMB_MAX : FINGER_MAX)[Math.min(i, 2)]!;
        list.push({ bone: b, bindLocal: b.quaternion.clone(), curlAxis: curlWorld.applyQuaternion(inv), spreadAxis: normal.clone().applyQuaternion(inv).normalize(), max });
      });
      joints[finger] = list;
      const last = bones[bones.length - 1];
      if (tip) tips[finger] = { bone: tip, offset: new THREE.Vector3() };
      else if (last && bones.length >= 2) {
        const seg = at(last).sub(at(bones[bones.length - 2]!));
        const inv = last.getWorldQuaternion(new THREE.Quaternion()).invert();
        const scale = last.getWorldScale(new THREE.Vector3());
        tips[finger] = { bone: last, offset: seg.multiplyScalar(0.8).applyQuaternion(inv).divide(scale) };
      } else tips[finger] = undefined;
    }
    const middleTip = tips.middle ? tipWorld(tips.middle, new THREE.Vector3()) : at(middle);
    return new HandRig(side, hand, joints, tips, { index, middle, little }, middleTip.distanceTo(wrist));
  }

  /** Sets finger bones from the bind pose; call `updateMatrixWorld` after. */
  apply(pose: HandPose): void {
    for (const finger of FINGERS) {
      const c = THREE.MathUtils.clamp(pose.curl[finger], -0.1, 1.05);
      this.joints[finger].forEach((j, i) => {
        // Distal joints lag at low curl, as real fingers do.
        const k = i === 0 ? c : Math.pow(Math.max(c, 0), 1 + 0.25 * i);
        j.bone.quaternion.copy(j.bindLocal).multiply(q1.setFromAxisAngle(j.curlAxis, k * j.max));
        if (i === 0 && finger !== 'thumb') j.bone.quaternion.multiply(q2.setFromAxisAngle(j.spreadAxis, pose.spread * SPREAD_MAX * SPREAD_SIGN[finger] * (this.side === 'right' ? 1 : -1)));
      });
    }
  }

  fingerJointCount(): number {
    return FINGERS.reduce((n, f) => n + this.joints[f].length, 0);
  }

  bones(): THREE.Bone[] {
    return FINGERS.flatMap((f) => this.joints[f].map((j) => j.bone));
  }

  tip(finger: FingerName, out: THREE.Vector3): THREE.Vector3 | undefined {
    const t = this.tipBones[finger];
    return t ? tipWorld(t, out) : undefined;
  }

  /** A point on the palm surface, between the wrist and the middle knuckle: the hand's effector. */
  palmCenter(out: THREE.Vector3): THREE.Vector3 {
    const wrist = this.hand.getWorldPosition(v1);
    const knuckle = this.knuckles.middle.getWorldPosition(v2);
    out.lerpVectors(wrist, knuckle, 0.6);
    return out.addScaledVector(this.palmNormal(v2), 0.1 * this.length);
  }

  palmNormal(out: THREE.Vector3): THREE.Vector3 {
    const at = (o: THREE.Object3D, v: THREE.Vector3) => o.getWorldPosition(v);
    const q = palmFrameQuaternion(at(this.hand, new THREE.Vector3()), at(this.knuckles.index, new THREE.Vector3()), at(this.knuckles.middle, new THREE.Vector3()), at(this.knuckles.little, new THREE.Vector3()), q2);
    return out.set(0, 0, this.side === 'right' ? 1 : -1).applyQuaternion(q ?? q2.identity());
  }
}

function tipWorld(t: { bone: THREE.Object3D; offset: THREE.Vector3 }, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(t.offset).applyMatrix4(t.bone.matrixWorld);
}
