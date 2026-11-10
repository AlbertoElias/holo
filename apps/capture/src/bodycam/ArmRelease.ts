import * as THREE from 'three';
import type { AvatarRig } from '../avatar/AvatarRig';
import type { HumanoidBoneRef } from '../avatar/HumanoidSkeleton';
import type { VrHandSide } from '../types/contracts';

const FINGER_BONES = ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal', 'IndexProximal', 'IndexIntermediate', 'IndexDistal', 'MiddleProximal', 'MiddleIntermediate', 'MiddleDistal', 'RingProximal', 'RingIntermediate', 'RingDistal', 'LittleProximal', 'LittleIntermediate', 'LittleDistal'];
const ARM_BONES = ['Shoulder', 'UpperArm', 'LowerArm', 'Hand'];
const WRITTEN_EPSILON = 1e-6;
/** After the camera stops, an arm and its fingers go back to the idle pose over this long. */
const FADE_OUT_SEC = 0.3;

interface Driven {
  bone: THREE.Bone;
  /** The pose the animation (or the bind pose, for a bone no clip drives) leaves on the bone. */
  rest: THREE.Quaternion;
  written: THREE.Quaternion;
  has: boolean;
}

/**
 * Blends the camera-driven arms between the arm IK's pose and the idle animation's, so a hand that rests (or
 * returns) never snaps. The animation rewrites only the bones its clips drive and the rest keep what the IK wrote,
 * so, as the desktop point action does, a bone untouched since our last write keeps its remembered rest pose, and
 * any other bone's current value is its rest pose. `capture` runs before the arm IK, `blend` after.
 */
export class ArmRelease {
  private readonly driven: Record<VrHandSide, Driven[]> = { left: [], right: [] };
  private active = false;

  capture(avatar: AvatarRig): void {
    this.active = true;
    for (const side of ['left', 'right'] as const) {
      if (this.driven[side].length === 0) this.driven[side] = this.bonesFor(avatar, side);
      for (const d of this.driven[side]) {
        if (!(d.has && d.bone.quaternion.angleTo(d.written) < WRITTEN_EPSILON)) d.rest.copy(d.bone.quaternion);
      }
    }
  }

  /** Shows `weight` of the pose the IK left on the bones, the rest idle. At 1 the IK pose stands. */
  blend(side: VrHandSide, weight: number): void {
    for (const d of this.driven[side]) {
      if (weight < 1) d.bone.quaternion.copy(d.rest).slerp(d.bone.quaternion, THREE.MathUtils.smoothstep(weight, 0, 1)).normalize();
      d.written.copy(d.bone.quaternion);
      d.has = true;
    }
    this.driven[side][0]?.bone.updateMatrixWorld(true);
  }

  /** The camera stopped: bones nothing else rewrites go back to their rest pose rather than freezing in the last IK pose. */
  fadeOut(deltaSec: number): void {
    if (!this.active) return;
    let remaining = false;
    for (const side of ['left', 'right'] as const) {
      for (const d of this.driven[side]) {
        if (!d.has) continue;
        if (d.bone.quaternion.angleTo(d.written) >= WRITTEN_EPSILON) {
          d.has = false;
          continue;
        }
        d.bone.quaternion.slerp(d.rest, Math.min(1, deltaSec / FADE_OUT_SEC));
        d.written.copy(d.bone.quaternion);
        if (d.bone.quaternion.angleTo(d.rest) < 1e-4) d.has = false;
        else remaining = true;
      }
      this.driven[side][0]?.bone.updateMatrixWorld(true);
    }
    this.active = remaining;
  }

  private bonesFor(avatar: AvatarRig, side: VrHandSide): Driven[] {
    const out: Driven[] = [];
    for (const name of [...ARM_BONES, ...FINGER_BONES]) {
      const bone = avatar.bone(`${side}${name}` as HumanoidBoneRef);
      if (bone) out.push({ bone, rest: bone.quaternion.clone(), written: bone.quaternion.clone(), has: false });
    }
    return out;
  }
}
