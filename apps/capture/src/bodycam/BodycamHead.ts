import * as THREE from 'three';
import type { AvatarRig } from '../avatar/AvatarRig';
import type { HumanoidBoneRef } from '../avatar/HumanoidSkeleton';
import type { Quat4 } from './types';

// Neck and head share the turn; together they carry all of it.
const NECK_SHARE = 0.4;
const WRITTEN_EPSILON = 1e-6;
/** With no head frame, the turn eases back to the animated pose over this long. */
const RELEASE_EASE_SEC = 0.4;

const IDENTITY = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Turns the neck and head from the camera's head rotation, in the body's frame
 * (the body itself never turns). Nothing else rotates the head outside the VR
 * body solver. The rotation is applied in the world on top of whatever the
 * animation left on the bone, so idle sway survives, and it never compounds
 * when the animation does not key the bone: the bone's pre-write value is
 * remembered and reused while the bone still holds what this wrote.
 */
export class BodycamHead {
  private readonly bones = new Map<HumanoidBoneRef, { bone: THREE.Bone; base: THREE.Quaternion; written: THREE.Quaternion; has: boolean }>();
  private readonly turn = new THREE.Quaternion();
  private readonly yawQ = new THREE.Quaternion();
  private readonly share = new THREE.Quaternion();
  private readonly world = new THREE.Quaternion();
  private readonly parent = new THREE.Quaternion();
  // How much of the last turn still applies: 1 while frames arrive, easing to 0 when they stop.
  private strength = 0;

  apply(avatar: AvatarRig, head: Quat4 | null, worldYaw: number, deltaSec: number): void {
    if (head) {
      this.yawQ.setFromAxisAngle(UP, worldYaw);
      // The head's turn about the body, expressed in the world: yaw * turn * yaw^-1.
      this.turn.set(head[0], head[1], head[2], head[3]).normalize();
      this.turn.premultiply(this.yawQ).multiply(this.yawQ.clone().invert());
      this.strength = 1;
    } else if (this.strength > 0) {
      this.strength = Math.max(0, this.strength - deltaSec / RELEASE_EASE_SEC);
      if (this.strength === 0) {
        this.forget();
        return;
      }
    } else {
      return;
    }
    const eased = THREE.MathUtils.smoothstep(this.strength, 0, 1);
    const neck = avatar.bone('neck');
    this.turnBone('neck', neck, (neck ? NECK_SHARE : 0) * eased);
    this.turnBone('head', avatar.bone('head'), (neck ? 1 - NECK_SHARE : 1) * eased);
  }

  /** The head is not driven this step; the next drive starts from the animation again. */
  private forget(): void {
    for (const state of this.bones.values()) {
      if (state.has && state.bone.quaternion.angleTo(state.written) < WRITTEN_EPSILON) state.bone.quaternion.copy(state.base);
      state.has = false;
    }
  }

  private turnBone(ref: HumanoidBoneRef, bone: THREE.Bone | undefined, share: number): void {
    if (!bone?.parent) return;
    let state = this.bones.get(ref);
    if (!state) {
      state = { bone, base: new THREE.Quaternion(), written: new THREE.Quaternion(), has: false };
      this.bones.set(ref, state);
    }
    // Untouched since the last write: the animation did not key this bone, so build on what it held before.
    if (state.has && bone.quaternion.angleTo(state.written) < WRITTEN_EPSILON) bone.quaternion.copy(state.base);
    state.base.copy(bone.quaternion);
    this.share.copy(IDENTITY).slerp(this.turn, share);
    bone.parent.getWorldQuaternion(this.parent);
    // local' = parent^-1 * share * parent * local
    this.world.copy(this.parent).invert().multiply(this.share).multiply(this.parent);
    bone.quaternion.premultiply(this.world).normalize();
    bone.updateMatrixWorld(true);
    state.written.copy(bone.quaternion);
    state.has = true;
  }
}
