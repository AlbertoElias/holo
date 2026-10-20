import * as THREE from 'three';
import { clamp, isFiniteQuaternionLike } from '../shared/math';
import type { ArmIkChain } from '../avatar/AvatarRig';

export class ArmIkSolver {
  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  private readonly tmpUpperWorld = new THREE.Vector3();
  private readonly tmpElbowWorld = new THREE.Vector3();
  private readonly tmpVecA = new THREE.Vector3();
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

  // handWorldQuaternion, when given, is the exact world rotation for the hand
  // bone (palm-aligned from tracked joints); otherwise the target rotation is
  // mapped through the rig's grip offset, as for controllers.
  solve(
    chain: ArmIkChain,
    targetPositionWorld: THREE.Vector3,
    targetQuaternionWorld: THREE.Quaternion,
    avatarRoot: THREE.Group,
    handWorldQuaternion?: THREE.Quaternion
  ): boolean {
    // Shoulder protraction: as the target nears full reach, swing the
    // clavicle toward it (as a real shoulder does). Without this the pinned
    // shoulder runs out of arm ~10 cm early on a stretch.
    chain.upperArm.getWorldPosition(this.tmpUpperWorld);
    if (chain.shoulderBindAimInParent) {
      const reach = chain.upperLength + chain.lowerLength;
      const dist = this.tmpUpperWorld.distanceTo(targetPositionWorld);
      const factor = THREE.MathUtils.smoothstep(dist / Math.max(reach, 1e-5), 0.75, 1.0);
      this.tmpVecA.subVectors(targetPositionWorld, this.tmpUpperWorld).normalize();
      if (this.aimBoneAtDirection(chain.shoulder, chain.shoulderBindQuaternion, chain.shoulderBindAimInParent, this.tmpVecA)) {
        chain.shoulder.quaternion.slerp(chain.shoulderBindQuaternion, 1 - factor * 0.9);
        chain.shoulder.updateMatrixWorld(true);
      }
    }
    chain.upperArm.getWorldPosition(this.tmpUpperWorld);
    this.tmpClampedTarget.copy(targetPositionWorld);

    this.tmpVecA.subVectors(this.tmpClampedTarget, this.tmpUpperWorld);
    const targetDistanceRaw = this.tmpVecA.length();
    if (!Number.isFinite(targetDistanceRaw) || targetDistanceRaw < 1e-5) return false;

    const minReach = Math.max(0.02, Math.abs(chain.upperLength - chain.lowerLength) + 0.01);
    const maxReach = Math.max(minReach + 0.01, chain.upperLength + chain.lowerLength - 0.01);
    const targetDistance = clamp(targetDistanceRaw, minReach, maxReach);
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
      (targetDistance * targetDistance + chain.upperLength * chain.upperLength - chain.lowerLength * chain.lowerLength) /
        (2 * targetDistance * chain.upperLength),
      -1,
      1
    );
    const along = chain.upperLength * cosAtShoulder;
    const perpendicular = Math.sqrt(Math.max(0, chain.upperLength * chain.upperLength - along * along));

    this.tmpElbowWorld.copy(this.tmpUpperWorld).addScaledVector(this.tmpVecA, along).addScaledVector(this.tmpVecB, perpendicular);
    this.tmpUpperDirWorld.subVectors(this.tmpElbowWorld, this.tmpUpperWorld).normalize();
    this.tmpForeDirWorld.subVectors(this.tmpClampedTarget, this.tmpElbowWorld).normalize();

    const upperOk = this.aimBoneAtDirection(chain.upperArm, chain.upperBindQuaternion, chain.upperBindAimInParent, this.tmpUpperDirWorld);
    const foreOk = this.aimBoneAtDirection(chain.foreArm, chain.foreBindQuaternion, chain.foreBindAimInParent, this.tmpForeDirWorld);
    if (!upperOk || !foreOk) return false;

    chain.foreArm.getWorldQuaternion(this.tmpQuatC);
    if (handWorldQuaternion) this.tmpQuat.copy(handWorldQuaternion);
    else this.tmpQuat.copy(targetQuaternionWorld).multiply(chain.handGripRotationOffset);
    chain.hand.quaternion.copy(this.tmpInvQuat.copy(this.tmpQuatC).invert().multiply(this.tmpQuat));
    if (!isFiniteQuaternionLike(chain.hand.quaternion)) {
      return false;
    }

    chain.hand.updateMatrixWorld(true);
    return true;
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
