import * as THREE from 'three';
import type { HandFingerRetargetChain } from '../avatar/AvatarRig';
import { isFiniteQuaternionLike, isFiniteVector3Like } from '../shared/math';
import type { TrackedHandJointName, VrHandSide } from '../types/contracts';
import type { XrTracking } from './XrTracking';

interface FingerQuatCalibration {
  jointName: TrackedHandJointName;
  parentJointName: TrackedHandJointName;
  targetFromSourceLocalQuaternion: THREE.Quaternion;
  missingFrames: number;
}

type FingerEntry = HandFingerRetargetChain['entries'][number];

const CALIBRATION_STALE_FRAMES = 24;

/**
 * `?handRetargetMode=legacy`: each finger bone follows its tracked joint's
 * local rotation, calibrated against bind on first sight, or aims at the next
 * tracked joint when rotations are missing.
 */
export class LegacyFingerRetargeter {
  private readonly calibration: Record<VrHandSide, Map<string, FingerQuatCalibration>> = { left: new Map(), right: new Map() };
  private readonly tmpVecA = new THREE.Vector3();
  private readonly tmpVecB = new THREE.Vector3();
  private readonly tmpVecC = new THREE.Vector3();
  private readonly tmpVecD = new THREE.Vector3();
  private readonly tmpQuatA = new THREE.Quaternion();
  private readonly tmpQuatB = new THREE.Quaternion();
  private readonly tmpQuatC = new THREE.Quaternion();
  private readonly tmpQuatD = new THREE.Quaternion();

  constructor(private readonly tracking: XrTracking) {}

  reset(): void {
    this.calibration.left.clear();
    this.calibration.right.clear();
  }

  apply(side: VrHandSide, chain: HandFingerRetargetChain): void {
    for (const entry of chain.entries) {
      if (!entry.bone.parent) continue;
      if (this.applyFromQuaternion(side, entry)) continue;
      const hasSource = this.getTrackedJointWorldPosition(side, entry.xrSourceJointNames, this.tmpVecA);
      const hasTarget = this.getTrackedJointWorldPosition(side, entry.xrTargetJointNames, this.tmpVecB);
      if (hasSource && hasTarget) {
        this.tmpVecC.subVectors(this.tmpVecB, this.tmpVecA);
        if (this.tmpVecC.lengthSq() >= 1e-8) {
          this.aimBoneAtDirection(entry.bone, entry.bindQuaternion, entry.bindAimInParent, this.tmpVecC);
        }
      }
    }
  }

  private getTrackedJointWorldPosition(side: VrHandSide, jointCandidates: readonly TrackedHandJointName[], out: THREE.Vector3): boolean {
    for (const jointName of jointCandidates) {
      if (!this.tracking.getTrackedHandJointPosition(side, jointName, out)) continue;
      if (isFiniteVector3Like(out)) return true;
    }
    return false;
  }

  private applyFromQuaternion(side: VrHandSide, entry: FingerEntry): boolean {
    if (!entry.bone.parent) return false;
    const calibrationByBone = this.calibration[side];
    let selectedJointName: TrackedHandJointName | undefined;
    let selectedParentJointName: TrackedHandJointName | undefined;

    for (const source of entry.xrQuaternionSources) {
      if (!this.tracking.getTrackedHandJointQuaternion(side, source.jointName, this.tmpQuatA)) continue;
      for (const parentJointName of source.parentJointNames) {
        if (!this.tracking.getTrackedHandJointQuaternion(side, parentJointName, this.tmpQuatB)) continue;
        selectedJointName = source.jointName;
        selectedParentJointName = parentJointName;
        break;
      }
      if (selectedJointName && selectedParentJointName) break;
    }

    if (!selectedJointName || !selectedParentJointName) {
      const calibration = calibrationByBone.get(entry.bone.uuid);
      if (calibration) {
        calibration.missingFrames += 1;
        if (calibration.missingFrames >= CALIBRATION_STALE_FRAMES) {
          calibrationByBone.delete(entry.bone.uuid);
        }
      }
      return false;
    }

    // Source local rotation = inverse(parentJointWorld) * jointWorld.
    this.tmpQuatC.copy(this.tmpQuatB).invert().multiply(this.tmpQuatA).normalize();
    let calibration = calibrationByBone.get(entry.bone.uuid);
    const needsRecalibration =
      !calibration ||
      calibration.jointName !== selectedJointName ||
      calibration.parentJointName !== selectedParentJointName ||
      calibration.missingFrames >= CALIBRATION_STALE_FRAMES;
    if (needsRecalibration) {
      calibration = {
        jointName: selectedJointName,
        parentJointName: selectedParentJointName,
        targetFromSourceLocalQuaternion: entry.bindQuaternion.clone().multiply(this.tmpQuatD.copy(this.tmpQuatC).invert()).normalize(),
        missingFrames: 0
      };
      calibrationByBone.set(entry.bone.uuid, calibration);
    }
    if (!calibration) return false;
    calibration.missingFrames = 0;

    // Target local rotation = calibration * source local.
    this.tmpQuatA.copy(calibration.targetFromSourceLocalQuaternion).multiply(this.tmpQuatC).normalize();
    if (!isFiniteQuaternionLike(this.tmpQuatA)) return false;

    entry.bone.quaternion.copy(this.tmpQuatA);
    entry.bone.updateMatrixWorld(true);
    return true;
  }

  private aimBoneAtDirection(bone: THREE.Bone, bindQuaternion: THREE.Quaternion, bindAimInParent: THREE.Vector3, desiredDirectionWorld: THREE.Vector3): boolean {
    if (!bone.parent || desiredDirectionWorld.lengthSq() < 1e-8) return false;
    bone.parent.getWorldQuaternion(this.tmpQuatA);
    this.tmpVecD.copy(desiredDirectionWorld).normalize();
    this.tmpVecD.applyQuaternion(this.tmpQuatB.copy(this.tmpQuatA).invert()).normalize();
    if (this.tmpVecD.lengthSq() < 1e-8) return false;

    this.tmpQuatC.setFromUnitVectors(bindAimInParent, this.tmpVecD);
    this.tmpQuatB.copy(this.tmpQuatC).multiply(bindQuaternion).normalize();
    if (!isFiniteQuaternionLike(this.tmpQuatB)) return false;

    bone.quaternion.copy(this.tmpQuatB);
    bone.updateMatrixWorld(true);
    return true;
  }
}

