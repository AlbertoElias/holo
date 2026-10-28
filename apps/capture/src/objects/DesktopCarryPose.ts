import * as THREE from 'three';

import type { ArmIkChain, AvatarRig } from '../avatar/AvatarRig';
import { ArmIkSolver } from '../ik/ArmIkSolver';
import { isFiniteQuaternionLike } from '../shared/math';

const BLEND_IN_SEC = 0.2;
const BLEND_OUT_SEC = 0.3;
// The carried hand, as fractions of the arm's reach from the shoulder joint:
// forward of the chest, a little below the shoulder and toward the midline.
const FORWARD = 0.62;
const DOWN = 0.3;
const INWARD = 0.18;
// The lowest the carried hand goes: this fraction of full reach from the shoulder.
const REACHABLE = 0.95;

interface Driven {
  bone: THREE.Bone;
  // The pose animation last left on the bone, and what this module last wrote.
  rest: THREE.Quaternion;
  written: THREE.Quaternion;
  hasWritten: boolean;
  target: THREE.Quaternion;
}

/**
 * Desktop carry: while an object is held on desktop, the avatar's right arm
 * holds its hand in front of the chest through the arm IK, facing the body's
 * yaw, so the object sits in a hand rather than floating. Same blend pattern
 * as the desktop point action, which takes the arm while it is held.
 */
export class DesktopCarryPose {
  private chain: ArmIkChain | undefined;
  private readonly solver = new ArmIkSolver();
  private readonly driven: Driven[] = [];
  private weight = 0;
  private readonly target = new THREE.Vector3();
  private readonly targetQuat = new THREE.Quaternion();
  private readonly tmp = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(private readonly avatar: AvatarRig) {}

  /** Builds the chain once the avatar is loaded and still in its bind pose. */
  attach(): void {
    this.chain = this.avatar.createArmIkChain('right');
    if (!this.chain) return;
    for (const bone of [this.chain.shoulder, this.chain.upperArm, this.chain.foreArm, this.chain.hand]) {
      this.driven.push({ bone, rest: bone.quaternion.clone(), written: bone.quaternion.clone(), hasWritten: false, target: bone.quaternion.clone() });
    }
  }

  getWeight(): number {
    return this.weight;
  }

  /** The right arm's full reach from the shoulder joint, once attached. */
  getReach(): number | undefined {
    return this.chain ? this.chain.upperLength + this.chain.lowerLength : undefined;
  }

  /** How far below the carry pose the hand can still be placed within the arm's reach. */
  maxLowerM(): number {
    const reach = this.getReach();
    if (!reach) return 0;
    const horizontal = Math.hypot(FORWARD, INWARD);
    const vertical = Math.sqrt(Math.max(0, REACHABLE ** 2 - horizontal ** 2));
    return Math.max(0, (vertical - DOWN) * reach);
  }

  idle(): void {
    this.weight = 0;
    for (const driven of this.driven) driven.hasWritten = false;
  }

  /**
   * `worldTarget` sends the hand toward a world point instead of the carry pose, `blend` (0 to 1) of the way: the grasp when reaching
   * for a prop, easing back to the carry pose as the avatar stands.
   */
  update(step: { carrying: boolean; bodyYaw: number; deltaSec: number; lowerM?: number; worldTarget?: { point: THREE.Vector3; blend: number } }): void {
    const chain = this.chain;
    if (!chain) return;
    const rate = step.carrying ? 1 / BLEND_IN_SEC : -1 / BLEND_OUT_SEC;
    this.weight = THREE.MathUtils.clamp(this.weight + rate * step.deltaSec, 0, 1);
    if (this.weight <= 0 && !step.carrying) {
      this.idle();
      return;
    }

    // Animation rewrites only the bones its clips drive; the rest keep what we wrote.
    for (const driven of this.driven) {
      const untouched = driven.hasWritten && driven.bone.quaternion.equals(driven.written);
      if (!untouched) driven.rest.copy(driven.bone.quaternion);
      driven.bone.quaternion.copy(driven.rest);
    }
    chain.shoulder.updateMatrixWorld(true);

    const reach = chain.upperLength + chain.lowerLength;
    const forward = this.tmp.set(-Math.sin(step.bodyYaw), 0, -Math.cos(step.bodyYaw));
    chain.upperArm.getWorldPosition(this.target);
    this.target.addScaledVector(forward, reach * FORWARD).addScaledVector(this.up, -reach * DOWN);
    this.target.y -= step.lowerM ?? 0;
    // Toward the midline: the body's left, for the right hand.
    this.target.x += -Math.cos(step.bodyYaw) * reach * INWARD;
    this.target.z += Math.sin(step.bodyYaw) * reach * INWARD;
    if (step.worldTarget && step.worldTarget.blend > 0) this.target.lerp(step.worldTarget.point, step.worldTarget.blend);
    this.targetQuat.setFromAxisAngle(this.up, step.bodyYaw);
    const solved = this.solver.solve(chain, this.target, this.targetQuat, this.avatar.avatarRoot);
    for (const driven of this.driven) {
      driven.target.copy(solved && isFiniteQuaternionLike(driven.bone.quaternion) ? driven.bone.quaternion : driven.rest);
    }

    const t = this.weight * this.weight * (3 - 2 * this.weight);
    for (const driven of this.driven) {
      driven.bone.quaternion.copy(driven.rest).slerp(driven.target, t);
      driven.written.copy(driven.bone.quaternion);
      driven.hasWritten = true;
    }
    chain.shoulder.updateMatrixWorld(true);
  }
}
