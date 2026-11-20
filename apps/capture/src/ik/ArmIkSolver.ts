import * as THREE from 'three';
import { clamp, isFiniteQuaternionLike } from '../shared/math';
import type { ArmIkChain } from '../avatar/AvatarRig';

export type ArmIkOptions = {
  // handWorldQuaternion, when given, is the exact world rotation for the hand
  // bone (palm-aligned from tracked joints); otherwise the target rotation is
  // mapped through the rig's grip offset, as for controllers.
  handWorldQuaternion?: THREE.Quaternion | undefined;
  // Reach stretch: past full reach the arm may lengthen by up to this share
  // of its length, easing in (tanh, slope 1 at full reach, so the wrist never
  // snaps) instead of stopping dead. A height-fitted avatar's arm is about
  // 0.30 of its height against a person's 0.33, so a real long reach runs
  // past it: the Quest 3 hand recording reaches 4-6% (and briefly 19%) past
  // full protraction. A stretching solve also swings the clavicle all the
  // way and stops 1 mm short of straight (not 90% and 1 cm), so the wrist
  // lands on the tracked one. Only tracked hands pass it; controllers,
  // desktop and camera keep the reach their object and aim checks are tuned on.
  maxStretch?: number;
  // Share of the hand's twist about the forearm (from bind) that the forearm
  // bone rolls by, so the skin twists along the forearm instead of all at the
  // wrist (candy-wrapper). The hand keeps its exact world rotation. 0 keeps the
  // forearm on its minimal-rotation aim.
  forearmTwistShare?: number;
};

// The forearm roll stops here, so a twist past anatomy does not wind the elbow.
const MAX_FOREARM_ROLL = THREE.MathUtils.degToRad(90);

export class ArmIkSolver {
  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  private readonly tmpUpperWorld = new THREE.Vector3();
  private readonly tmpElbowWorld = new THREE.Vector3();
  private readonly tmpVecA = new THREE.Vector3();
  private readonly tmpPlace = new THREE.Vector3();
  private readonly tmpVecB = new THREE.Vector3();
  private readonly tmpClampedTarget = new THREE.Vector3();
  private readonly tmpUpperDirWorld = new THREE.Vector3();
  private readonly tmpForeDirWorld = new THREE.Vector3();
  private readonly tmpParentWorldQuat = new THREE.Quaternion();
  private readonly tmpDesiredDirParent = new THREE.Vector3();
  private readonly tmpInvQuat = new THREE.Quaternion();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpQuatB = new THREE.Quaternion();
  private readonly tmpQuatC = new THREE.Quaternion();

  solve(
    chain: ArmIkChain,
    targetPositionWorld: THREE.Vector3,
    targetQuaternionWorld: THREE.Quaternion,
    avatarRoot: THREE.Group,
    { handWorldQuaternion, maxStretch = 0, forearmTwistShare = 0 }: ArmIkOptions = {}
  ): boolean {
    // Shoulder protraction: as the target nears full reach, swing the
    // clavicle toward it (as a real shoulder does). Without this the pinned
    // shoulder runs out of arm ~10 cm early on a stretch. A stretching
    // (tracked-hand) solve swings all the way: stopping at 90% left the
    // Quest 3 recording's wrists 1-2 cm short on every long reach.
    const fullReach = maxStretch > 0;
    chain.upperArm.getWorldPosition(this.tmpUpperWorld);
    if (chain.shoulderBindAimInParent) {
      const reach = chain.upperLength + chain.lowerLength;
      const dist = this.tmpUpperWorld.distanceTo(targetPositionWorld);
      const factor = THREE.MathUtils.smoothstep(dist / Math.max(reach, 1e-5), 0.75, 1.0);
      this.tmpVecA.subVectors(targetPositionWorld, this.tmpUpperWorld).normalize();
      if (this.aimBoneAtDirection(chain.shoulder, chain.shoulderBindQuaternion, chain.shoulderBindAimInParent, this.tmpVecA)) {
        chain.shoulder.quaternion.slerp(chain.shoulderBindQuaternion, 1 - factor * (fullReach ? 1 : 0.9));
        chain.shoulder.updateMatrixWorld(true);
      }
    }
    chain.upperArm.getWorldPosition(this.tmpUpperWorld);
    this.tmpClampedTarget.copy(targetPositionWorld);

    this.tmpVecA.subVectors(this.tmpClampedTarget, this.tmpUpperWorld);
    const targetDistanceRaw = this.tmpVecA.length();
    if (!Number.isFinite(targetDistanceRaw) || targetDistanceRaw < 1e-5) return false;

    const minReach = Math.max(0.02, Math.abs(chain.upperLength - chain.lowerLength) + 0.01);
    // 1 mm short of straight keeps the elbow's bend plane defined; the 1 cm
    // margin cost a tracked wrist a centimetre on every full reach.
    const maxReach = Math.max(minReach + 0.01, chain.upperLength + chain.lowerLength - (fullReach ? 0.001 : 0.01));
    let stretch = 1;
    if (maxStretch > 0 && targetDistanceRaw > maxReach) {
      const room = maxStretch * (chain.upperLength + chain.lowerLength);
      stretch = (maxReach + room * Math.tanh((targetDistanceRaw - maxReach) / room)) / maxReach;
    }
    const upperLength = chain.upperLength * stretch;
    const lowerLength = chain.lowerLength * stretch;
    const targetDistance = clamp(targetDistanceRaw, minReach, maxReach * stretch);
    this.tmpVecA.multiplyScalar(1 / targetDistanceRaw);
    this.tmpClampedTarget.copy(this.tmpUpperWorld).addScaledVector(this.tmpVecA, targetDistance);

    this.tmpVecB.copy(chain.elbowHintLocal).applyQuaternion(avatarRoot.quaternion).normalize();
    this.tmpVecB.addScaledVector(this.tmpVecA, -this.tmpVecB.dot(this.tmpVecA));
    if (this.tmpVecB.lengthSq() < 1e-8) {
      this.tmpVecB.crossVectors(this.tmpVecA, this.worldUp);
      if (this.tmpVecB.lengthSq() < 1e-8) {
        this.tmpVecB.set(chain.side === 'left' ? 1 : -1, 0, 0).applyQuaternion(avatarRoot.quaternion);
        this.tmpVecB.addScaledVector(this.tmpVecA, -this.tmpVecB.dot(this.tmpVecA));
      }
    }
    if (this.tmpVecB.lengthSq() < 1e-8) return false;
    this.tmpVecB.normalize();

    const cosAtShoulder = clamp(
      (targetDistance * targetDistance + upperLength * upperLength - lowerLength * lowerLength) /
        (2 * targetDistance * upperLength),
      -1,
      1
    );
    const along = upperLength * cosAtShoulder;
    const perpendicular = Math.sqrt(Math.max(0, upperLength * upperLength - along * along));

    this.tmpElbowWorld.copy(this.tmpUpperWorld).addScaledVector(this.tmpVecA, along).addScaledVector(this.tmpVecB, perpendicular);
    this.tmpUpperDirWorld.subVectors(this.tmpElbowWorld, this.tmpUpperWorld).normalize();
    this.tmpForeDirWorld.subVectors(this.tmpClampedTarget, this.tmpElbowWorld).normalize();

    const upperOk = this.aimBoneAtDirection(chain.upperArm, chain.upperBindQuaternion, chain.upperBindAimInParent, this.tmpUpperDirWorld);
    if (upperOk && (stretch > 1 || chain.stretch > 1)) this.placeChild(chain.foreArm, chain.foreBindPosition, stretch, this.tmpElbowWorld);
    const foreOk = this.aimBoneAtDirection(chain.foreArm, chain.foreBindQuaternion, chain.foreBindAimInParent, this.tmpForeDirWorld);
    if (!upperOk || !foreOk) return false;
    if (stretch > 1 || chain.stretch > 1) this.placeChild(chain.hand, chain.handBindPosition, stretch, this.tmpClampedTarget);
    chain.stretch = stretch;

    chain.foreArm.getWorldQuaternion(this.tmpQuatC);
    if (handWorldQuaternion) this.tmpQuat.copy(handWorldQuaternion);
    else this.tmpQuat.copy(targetQuaternionWorld).multiply(chain.handGripRotationOffset);
    chain.hand.quaternion.copy(this.tmpInvQuat.copy(this.tmpQuatC).invert().multiply(this.tmpQuat));
    if (forearmTwistShare > 0) this.rollForearm(chain, forearmTwistShare);
    if (!isFiniteQuaternionLike(chain.hand.quaternion)) {
      return false;
    }

    chain.hand.updateMatrixWorld(true);
    return true;
  }

  /** Puts the arm back at its bind lengths (a stretched arm that stops being solved). */
  restLengths(chain: ArmIkChain): void {
    if (chain.stretch === 1) return;
    chain.foreArm.position.copy(chain.foreBindPosition);
    chain.hand.position.copy(chain.handBindPosition);
    chain.stretch = 1;
    chain.upperArm.updateMatrixWorld(true);
  }

  // A stretched arm puts the joint at its solved world point (any twist bones
  // in between keep their offsets); an unstretched one restores the bind.
  private placeChild(bone: THREE.Bone, bindPosition: THREE.Vector3, stretch: number, worldPoint: THREE.Vector3): void {
    if (stretch > 1 && bone.parent) bone.position.copy(bone.parent.worldToLocal(this.tmpPlace.copy(worldPoint)));
    else bone.position.copy(bindPosition);
    bone.updateMatrixWorld(true);
  }

  // Swing-twist split of the hand's local rotation from bind about the forearm
  // axis (the hand's bind offset); the forearm rolls by a share of the twist and
  // the hand takes the rest, so the hand's world rotation does not change. The
  // twist is unwrapped against the last frame, so it does not jump at 180°.
  private rollForearm(chain: ArmIkChain, share: number): void {
    const axis = this.tmpVecA.copy(chain.handBindPosition);
    if (axis.lengthSq() < 1e-10) return;
    axis.normalize();
    const delta = this.tmpQuatB.copy(chain.hand.quaternion).multiply(this.tmpInvQuat.copy(chain.handBindQuaternion).invert());
    const sign = delta.w < 0 ? -1 : 1;
    let twist = 2 * Math.atan2(sign * (delta.x * axis.x + delta.y * axis.y + delta.z * axis.z), sign * delta.w);
    const previous = chain.wristTwist ?? 0;
    twist += 2 * Math.PI * Math.round((previous - twist) / (2 * Math.PI));
    chain.wristTwist = twist;
    const roll = clamp(twist * share, -MAX_FOREARM_ROLL, MAX_FOREARM_ROLL);
    if (Math.abs(roll) < 1e-6) return;
    const rollQuat = this.tmpQuatC.setFromAxisAngle(axis, roll);
    chain.foreArm.quaternion.multiply(rollQuat);
    chain.hand.quaternion.premultiply(rollQuat.invert());
    chain.foreArm.updateMatrixWorld(true);
  }

  private aimBoneAtDirection(
    bone: THREE.Bone,
    bindQuaternion: THREE.Quaternion,
    bindAimInParent: THREE.Vector3,
    desiredDirectionWorld: THREE.Vector3
  ): boolean {
    if (!bone.parent || desiredDirectionWorld.lengthSq() < 1e-8) return false;
    bone.parent.getWorldQuaternion(this.tmpParentWorldQuat);
    this.tmpDesiredDirParent.copy(desiredDirectionWorld).normalize();
    this.tmpDesiredDirParent.applyQuaternion(this.tmpInvQuat.copy(this.tmpParentWorldQuat).invert()).normalize();
    if (this.tmpDesiredDirParent.lengthSq() < 1e-8) return false;

    this.tmpQuat.setFromUnitVectors(bindAimInParent, this.tmpDesiredDirParent);
    bone.quaternion.copy(this.tmpQuat.multiply(this.tmpQuatB.copy(bindQuaternion)));
    bone.updateMatrixWorld(true);
    return true;
  }

}
