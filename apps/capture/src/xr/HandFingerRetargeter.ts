import * as THREE from 'three';
import type { HandFingerName, HandFingerRetargetChain, HandFingerRetargetEntry } from '../avatar/AvatarRig';
import type { TrackedHandJointName, Vec3Like, VrHandSide } from '../types/contracts';
import type { XrSessionService } from './XrSessionService';

const HOLD_TTL_FRAMES_DEFAULT = 12;
const RECOVERY_BLEND_DEFAULT = 0.35;
const BIND_BLEND_DEFAULT = 0.2;

const FINGER_NAMES: readonly HandFingerName[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];

export interface HandRetargetDataQuality {
  trackedSegments: number;
  heldSegments: number;
  fallbackSegments: number;
}

export interface HandRetargetDebugSnapshot {
  calibrated: boolean;
  pinchDistanceMeters: number | null;
  fingerTips: Record<HandFingerName, Vec3Like | null>;
  retargetDataQuality: HandRetargetDataQuality;
}

interface HandRetargeterOptions {
  twistGain?: number;
  holdTtlFrames?: number;
  recoveryBlend?: number;
  bindBlend?: number;
}

interface SegmentCalibrationState {
  sourceJointName: TrackedHandJointName;
  sourceParentJointName: TrackedHandJointName;
  sourceRestLocalQuaternion: THREE.Quaternion;
  sourceRestDirectionInParent: THREE.Vector3;
  sourceRestUpInParent: THREE.Vector3;
  targetFromSourceDirection: THREE.Quaternion;
}

interface SegmentRuntimeState {
  calibration: SegmentCalibrationState | undefined;
  hasHeldQuaternion: boolean;
  heldQuaternion: THREE.Quaternion;
  holdFramesRemaining: number;
  missingFrames: number;
}

interface SideRuntimeState {
  chain: HandFingerRetargetChain | undefined;
  segmentsByBoneUuid: Map<string, SegmentRuntimeState>;
  tipEntryByFinger: Partial<Record<HandFingerName, HandFingerRetargetEntry>>;
  quality: HandRetargetDataQuality;
}

export class HandFingerRetargeter {
  private readonly sideState: Record<VrHandSide, SideRuntimeState> = {
    left: this.createSideRuntimeState(),
    right: this.createSideRuntimeState()
  };

  private readonly twistGain: number;
  private readonly holdTtlFrames: number;
  private readonly recoveryBlend: number;
  private readonly bindBlend: number;

  private readonly tmpSourcePosition = new THREE.Vector3();
  private readonly tmpTargetPosition = new THREE.Vector3();
  private readonly tmpSourceDirectionWorld = new THREE.Vector3();
  private readonly tmpSourceDirectionInParent = new THREE.Vector3();
  private readonly tmpMappedDirectionInTargetParent = new THREE.Vector3();
  private readonly tmpSourceJointQuaternion = new THREE.Quaternion();
  private readonly tmpSourceParentQuaternion = new THREE.Quaternion();
  private readonly tmpTargetParentQuaternion = new THREE.Quaternion();
  private readonly tmpSourceLocalQuaternion = new THREE.Quaternion();
  private readonly tmpSourceDeltaQuaternion = new THREE.Quaternion();
  private readonly tmpSwingQuaternion = new THREE.Quaternion();
  private readonly tmpTwistQuaternion = new THREE.Quaternion();
  private readonly tmpResultQuaternion = new THREE.Quaternion();
  private readonly tmpQuaternionA = new THREE.Quaternion();
  private readonly tmpQuaternionB = new THREE.Quaternion();
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpAxis = new THREE.Vector3();
  private readonly tmpUp = new THREE.Vector3();
  private readonly tmpVecA = new THREE.Vector3();
  private readonly tmpVecB = new THREE.Vector3();

  constructor(
    private readonly xrService: XrSessionService,
    options: HandRetargeterOptions = {}
  ) {
    this.twistGain = Number.isFinite(options.twistGain) ? Number(options.twistGain) : 1;
    this.holdTtlFrames = Math.max(1, Math.round(options.holdTtlFrames ?? HOLD_TTL_FRAMES_DEFAULT));
    this.recoveryBlend = THREE.MathUtils.clamp(options.recoveryBlend ?? RECOVERY_BLEND_DEFAULT, 0.01, 1);
    this.bindBlend = THREE.MathUtils.clamp(options.bindBlend ?? BIND_BLEND_DEFAULT, 0.01, 1);
  }

  setChain(side: VrHandSide, chain: HandFingerRetargetChain | undefined): void {
    const nextState = this.sideState[side]!;
    nextState.chain = chain;
    nextState.tipEntryByFinger = {};
    this.resetQuality(nextState.quality);

    const nextSegments = new Map<string, SegmentRuntimeState>();
    if (chain) {
      for (const entry of chain.entries) {
        const previous = nextState.segmentsByBoneUuid.get(entry.bone.uuid);
        nextSegments.set(entry.bone.uuid, previous ?? this.createSegmentRuntimeState());

        const existingTip = nextState.tipEntryByFinger[entry.finger];
        if (!existingTip || entry.segmentIndex > existingTip.segmentIndex) {
          nextState.tipEntryByFinger[entry.finger] = entry;
        }
      }
    }
    nextState.segmentsByBoneUuid = nextSegments;
  }

  apply(side: VrHandSide): void {
    const sideState = this.sideState[side]!;
    const chain = sideState.chain;
    this.resetQuality(sideState.quality);
    if (!chain) return;

    for (const entry of chain.entries) {
      if (!entry.bone.parent) continue;
      const runtime = sideState.segmentsByBoneUuid.get(entry.bone.uuid) ?? this.createSegmentRuntimeState();
      sideState.segmentsByBoneUuid.set(entry.bone.uuid, runtime);

      if (this.computeLiveQuaternion(side, entry, runtime, this.tmpResultQuaternion)) {
        if (runtime.missingFrames > 0) {
          entry.bone.quaternion.slerp(this.tmpResultQuaternion, this.recoveryBlend);
        } else {
          entry.bone.quaternion.copy(this.tmpResultQuaternion);
        }
        runtime.missingFrames = 0;
        runtime.holdFramesRemaining = this.holdTtlFrames;
        runtime.hasHeldQuaternion = true;
        runtime.heldQuaternion.copy(entry.bone.quaternion);
        sideState.quality.trackedSegments += 1;
      } else {
        runtime.missingFrames += 1;
        if (runtime.hasHeldQuaternion && runtime.holdFramesRemaining > 0) {
          runtime.holdFramesRemaining -= 1;
          entry.bone.quaternion.copy(runtime.heldQuaternion);
          sideState.quality.heldSegments += 1;
        } else {
          entry.bone.quaternion.slerp(entry.bindQuaternion, this.bindBlend);
          runtime.hasHeldQuaternion = true;
          runtime.heldQuaternion.copy(entry.bone.quaternion);
          sideState.quality.fallbackSegments += 1;
        }
      }
      entry.bone.updateMatrixWorld(true);
    }
  }

  captureCalibrationPose(side?: VrHandSide): Record<VrHandSide, boolean> {
    const result: Record<VrHandSide, boolean> = { left: false, right: false };
    const sides: readonly VrHandSide[] = side ? [side] : ['left', 'right'];
    for (const nextSide of sides) {
      result[nextSide] = this.captureCalibrationForSide(nextSide);
    }
    return result;
  }

  resetCalibrationPose(side?: VrHandSide): void {
    const sides: readonly VrHandSide[] = side ? [side] : ['left', 'right'];
    for (const nextSide of sides) {
      const sideState = this.sideState[nextSide]!;
      for (const runtime of sideState.segmentsByBoneUuid.values()) {
        runtime.calibration = undefined;
        runtime.hasHeldQuaternion = false;
        runtime.holdFramesRemaining = 0;
        runtime.missingFrames = 0;
      }
      this.resetQuality(sideState.quality);
    }
  }

  resetRuntimeState(side?: VrHandSide): void {
    const sides: readonly VrHandSide[] = side ? [side] : ['left', 'right'];
    for (const nextSide of sides) {
      const sideState = this.sideState[nextSide]!;
      for (const runtime of sideState.segmentsByBoneUuid.values()) {
        runtime.hasHeldQuaternion = false;
        runtime.holdFramesRemaining = 0;
        runtime.missingFrames = 0;
      }
      this.resetQuality(sideState.quality);
    }
  }

  getDebugSnapshot(side: VrHandSide): HandRetargetDebugSnapshot {
    const sideState = this.sideState[side]!;
    const fingerTips: Record<HandFingerName, Vec3Like | null> = {
      thumb: null,
      index: null,
      middle: null,
      ring: null,
      pinky: null
    };

    for (const finger of FINGER_NAMES) {
      const tipEntry = sideState.tipEntryByFinger[finger];
      if (!tipEntry) continue;
      const tipObject =
        tipEntry.bone.children.find((child): child is THREE.Bone => child instanceof THREE.Bone) ?? tipEntry.bone;
      tipObject.getWorldPosition(this.tmpVecA);
      if (Number.isFinite(this.tmpVecA.x) && Number.isFinite(this.tmpVecA.y) && Number.isFinite(this.tmpVecA.z)) {
        fingerTips[finger] = { x: this.tmpVecA.x, y: this.tmpVecA.y, z: this.tmpVecA.z };
      }
    }

    const thumbTip = fingerTips.thumb;
    const indexTip = fingerTips.index;
    const pinchDistanceMeters =
      thumbTip && indexTip
        ? Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y, thumbTip.z - indexTip.z)
        : null;

    return {
      calibrated: this.isSideCalibrated(side),
      pinchDistanceMeters,
      fingerTips,
      retargetDataQuality: {
        trackedSegments: sideState.quality.trackedSegments,
        heldSegments: sideState.quality.heldSegments,
        fallbackSegments: sideState.quality.fallbackSegments
      }
    };
  }

  private createSideRuntimeState(): SideRuntimeState {
    return {
      chain: undefined,
      segmentsByBoneUuid: new Map(),
      tipEntryByFinger: {},
      quality: {
        trackedSegments: 0,
        heldSegments: 0,
        fallbackSegments: 0
      }
    };
  }

  private createSegmentRuntimeState(): SegmentRuntimeState {
    return {
      calibration: undefined,
      hasHeldQuaternion: false,
      heldQuaternion: new THREE.Quaternion(),
      holdFramesRemaining: 0,
      missingFrames: 0
    };
  }

  private resetQuality(quality: HandRetargetDataQuality): void {
    quality.trackedSegments = 0;
    quality.heldSegments = 0;
    quality.fallbackSegments = 0;
  }

  private isSideCalibrated(side: VrHandSide): boolean {
    const sideState = this.sideState[side]!;
    const chain = sideState.chain;
    if (!chain || chain.entries.length === 0) return false;
    for (const entry of chain.entries) {
      const runtime = sideState.segmentsByBoneUuid.get(entry.bone.uuid);
      if (!runtime?.calibration) return false;
    }
    return true;
  }

  private captureCalibrationForSide(side: VrHandSide): boolean {
    const sideState = this.sideState[side]!;
    const chain = sideState.chain;
    if (!chain || chain.entries.length === 0) return false;

    const pendingCalibrations = new Map<string, SegmentCalibrationState>();
    for (const entry of chain.entries) {
      if (!this.resolveTrackedPositionPair(side, entry.xrSourceJointNames, entry.xrTargetJointNames, this.tmpSourcePosition, this.tmpTargetPosition)) {
        return false;
      }
      const resolvedPair = this.resolveTrackedQuaternionPair(side, entry, this.tmpSourceJointQuaternion, this.tmpSourceParentQuaternion);
      if (!resolvedPair) return false;

      this.tmpSourceDirectionWorld.subVectors(this.tmpTargetPosition, this.tmpSourcePosition);
      if (this.tmpSourceDirectionWorld.lengthSq() < 1e-8) return false;
      this.tmpSourceDirectionWorld.normalize();

      this.tmpSourceDirectionInParent
        .copy(this.tmpSourceDirectionWorld)
        .applyQuaternion(this.tmpQuaternionA.copy(this.tmpSourceParentQuaternion).invert())
        .normalize();
      if (this.tmpSourceDirectionInParent.lengthSq() < 1e-8) return false;

      this.tmpSourceLocalQuaternion
        .copy(this.tmpSourceParentQuaternion)
        .invert()
        .multiply(this.tmpSourceJointQuaternion)
        .normalize();
      this.computeStableUpVector(this.tmpSourceDirectionInParent, this.tmpSourceLocalQuaternion, this.tmpUp);
      this.tmpVecA.set(0, 1, 0).applyQuaternion(entry.bindQuaternion);
      this.orthonormalizeUpVector(entry.bindAimInParent, this.tmpVecA, this.tmpVecA);
      this.buildFrameQuaternion(this.tmpSourceDirectionInParent, this.tmpUp, this.tmpQuaternionA);
      this.buildFrameQuaternion(entry.bindAimInParent, this.tmpVecA, this.tmpQuaternionB);
      this.tmpQuaternionB.multiply(this.tmpTargetParentQuaternion.copy(this.tmpQuaternionA).invert()).normalize();

      pendingCalibrations.set(entry.bone.uuid, {
        sourceJointName: resolvedPair.jointName,
        sourceParentJointName: resolvedPair.parentJointName,
        sourceRestLocalQuaternion: this.tmpSourceLocalQuaternion.clone(),
        sourceRestDirectionInParent: this.tmpSourceDirectionInParent.clone(),
        sourceRestUpInParent: this.tmpUp.clone(),
        targetFromSourceDirection: this.tmpQuaternionB.clone().normalize()
      });
    }

    for (const [boneUuid, calibration] of pendingCalibrations) {
      const runtime = sideState.segmentsByBoneUuid.get(boneUuid) ?? this.createSegmentRuntimeState();
      runtime.calibration = calibration;
      runtime.hasHeldQuaternion = false;
      runtime.holdFramesRemaining = 0;
      runtime.missingFrames = 0;
      sideState.segmentsByBoneUuid.set(boneUuid, runtime);
    }
    return true;
  }

  private computeLiveQuaternion(
    side: VrHandSide,
    entry: HandFingerRetargetEntry,
    runtime: SegmentRuntimeState,
    outQuaternion: THREE.Quaternion
  ): boolean {
    if (!entry.bone.parent) return false;
    if (!this.resolveTrackedPositionPair(side, entry.xrSourceJointNames, entry.xrTargetJointNames, this.tmpSourcePosition, this.tmpTargetPosition)) {
      return false;
    }

    this.tmpSourceDirectionWorld.subVectors(this.tmpTargetPosition, this.tmpSourcePosition);
    if (this.tmpSourceDirectionWorld.lengthSq() < 1e-8) return false;
    this.tmpSourceDirectionWorld.normalize();

    let hasMappedDirection = false;
    const calibration = runtime.calibration;
    if (
      calibration &&
      this.xrService.getTrackedHandJointQuaternion(side, calibration.sourceParentJointName, this.tmpSourceParentQuaternion)
    ) {
      this.tmpSourceDirectionInParent
        .copy(this.tmpSourceDirectionWorld)
        .applyQuaternion(this.tmpQuaternionA.copy(this.tmpSourceParentQuaternion).invert())
        .normalize();
      if (this.tmpSourceDirectionInParent.lengthSq() >= 1e-8) {
        this.tmpMappedDirectionInTargetParent
          .copy(this.tmpSourceDirectionInParent)
          .applyQuaternion(calibration.targetFromSourceDirection)
          .normalize();
        hasMappedDirection = this.tmpMappedDirectionInTargetParent.lengthSq() >= 1e-8;
      }
    }

    if (!hasMappedDirection) {
      entry.bone.parent.getWorldQuaternion(this.tmpTargetParentQuaternion);
      this.tmpMappedDirectionInTargetParent
        .copy(this.tmpSourceDirectionWorld)
        .applyQuaternion(this.tmpQuaternionA.copy(this.tmpTargetParentQuaternion).invert())
        .normalize();
      if (this.tmpMappedDirectionInTargetParent.lengthSq() < 1e-8) return false;
    }

    this.tmpSwingQuaternion.setFromUnitVectors(entry.bindAimInParent, this.tmpMappedDirectionInTargetParent).normalize();
    outQuaternion.copy(this.tmpSwingQuaternion).multiply(entry.bindQuaternion).normalize();

    if (
      calibration &&
      this.xrService.getTrackedHandJointQuaternion(side, calibration.sourceJointName, this.tmpSourceJointQuaternion) &&
      this.xrService.getTrackedHandJointQuaternion(side, calibration.sourceParentJointName, this.tmpSourceParentQuaternion)
    ) {
      this.tmpSourceLocalQuaternion
        .copy(this.tmpSourceParentQuaternion)
        .invert()
        .multiply(this.tmpSourceJointQuaternion)
        .normalize();
      this.tmpSourceDeltaQuaternion
        .copy(this.tmpSourceLocalQuaternion)
        .multiply(this.tmpQuaternionA.copy(calibration.sourceRestLocalQuaternion).invert())
        .normalize();
      const twistAngle = this.extractSignedTwistAngle(this.tmpSourceDeltaQuaternion, calibration.sourceRestDirectionInParent);
      if (Number.isFinite(twistAngle) && Math.abs(twistAngle) > 1e-5) {
        this.tmpAxis.copy(this.tmpMappedDirectionInTargetParent).normalize();
        this.tmpTwistQuaternion.setFromAxisAngle(this.tmpAxis, twistAngle * this.twistGain).normalize();
        outQuaternion.premultiply(this.tmpTwistQuaternion).normalize();
      }
    }

    return (
      Number.isFinite(outQuaternion.x) &&
      Number.isFinite(outQuaternion.y) &&
      Number.isFinite(outQuaternion.z) &&
      Number.isFinite(outQuaternion.w)
    );
  }

  private resolveTrackedQuaternionPair(
    side: VrHandSide,
    entry: HandFingerRetargetEntry,
    outJointQuaternion: THREE.Quaternion,
    outParentQuaternion: THREE.Quaternion
  ): { jointName: TrackedHandJointName; parentJointName: TrackedHandJointName } | undefined {
    for (const source of entry.xrQuaternionSources) {
      if (!this.xrService.getTrackedHandJointQuaternion(side, source.jointName, outJointQuaternion)) continue;
      for (const parentJointName of source.parentJointNames) {
        if (!this.xrService.getTrackedHandJointQuaternion(side, parentJointName, outParentQuaternion)) continue;
        return {
          jointName: source.jointName,
          parentJointName
        };
      }
    }
    return undefined;
  }

  private resolveTrackedPositionPair(
    side: VrHandSide,
    sourceCandidates: readonly TrackedHandJointName[],
    targetCandidates: readonly TrackedHandJointName[],
    outSourcePosition: THREE.Vector3,
    outTargetPosition: THREE.Vector3
  ): boolean {
    return (
      this.getTrackedJointPosition(side, sourceCandidates, outSourcePosition) &&
      this.getTrackedJointPosition(side, targetCandidates, outTargetPosition)
    );
  }

  private getTrackedJointPosition(side: VrHandSide, candidates: readonly TrackedHandJointName[], outPosition: THREE.Vector3): boolean {
    for (const candidate of candidates) {
      if (!this.xrService.getTrackedHandJointPosition(side, candidate, outPosition)) continue;
      if (Number.isFinite(outPosition.x) && Number.isFinite(outPosition.y) && Number.isFinite(outPosition.z)) {
        return true;
      }
    }
    return false;
  }

  private computeStableUpVector(
    directionInParent: THREE.Vector3,
    referenceQuaternion: THREE.Quaternion,
    outUp: THREE.Vector3
  ): void {
    const tryAxis = (x: number, y: number, z: number): boolean => {
      outUp.set(x, y, z).applyQuaternion(referenceQuaternion);
      outUp.addScaledVector(directionInParent, -outUp.dot(directionInParent));
      if (outUp.lengthSq() > 1e-8) {
        outUp.normalize();
        return true;
      }
      return false;
    };

    if (tryAxis(0, 1, 0)) return;
    if (tryAxis(0, 0, 1)) return;
    if (tryAxis(1, 0, 0)) return;

    outUp.set(0, 0, 1).cross(directionInParent);
    if (outUp.lengthSq() < 1e-8) {
      outUp.set(1, 0, 0).cross(directionInParent);
    }
    if (outUp.lengthSq() < 1e-8) {
      outUp.set(0, 1, 0);
      return;
    }
    outUp.normalize();
  }

  private orthonormalizeUpVector(forward: THREE.Vector3, sourceUp: THREE.Vector3, outUp: THREE.Vector3): void {
    outUp.copy(sourceUp).addScaledVector(forward, -sourceUp.dot(forward));
    if (outUp.lengthSq() > 1e-8) {
      outUp.normalize();
      return;
    }
    outUp.set(0, 0, 1).cross(forward);
    if (outUp.lengthSq() < 1e-8) {
      outUp.set(1, 0, 0).cross(forward);
    }
    if (outUp.lengthSq() < 1e-8) {
      outUp.set(0, 1, 0);
      return;
    }
    outUp.normalize();
  }

  private buildFrameQuaternion(forward: THREE.Vector3, up: THREE.Vector3, outQuaternion: THREE.Quaternion): void {
    this.tmpVecA.copy(forward).normalize();
    this.tmpVecB.copy(up).normalize();
    this.tmpAxis.crossVectors(this.tmpVecB, this.tmpVecA);
    if (this.tmpAxis.lengthSq() < 1e-8) {
      this.tmpAxis.set(1, 0, 0).cross(this.tmpVecA);
      if (this.tmpAxis.lengthSq() < 1e-8) {
        this.tmpAxis.set(0, 0, 1).cross(this.tmpVecA);
      }
    }
    this.tmpAxis.normalize();
    this.tmpVecB.crossVectors(this.tmpVecA, this.tmpAxis).normalize();
    this.tmpMatrix.makeBasis(this.tmpAxis, this.tmpVecB, this.tmpVecA);
    outQuaternion.setFromRotationMatrix(this.tmpMatrix).normalize();
  }

  private extractSignedTwistAngle(deltaQuaternion: THREE.Quaternion, axis: THREE.Vector3): number {
    this.tmpAxis.copy(axis).normalize();
    const projection =
      this.tmpAxis.x * deltaQuaternion.x + this.tmpAxis.y * deltaQuaternion.y + this.tmpAxis.z * deltaQuaternion.z;
    this.tmpTwistQuaternion.set(
      this.tmpAxis.x * projection,
      this.tmpAxis.y * projection,
      this.tmpAxis.z * projection,
      deltaQuaternion.w
    );
    if (this.tmpTwistQuaternion.lengthSq() < 1e-10) return 0;
    this.tmpTwistQuaternion.normalize();
    const sinHalf = Math.hypot(this.tmpTwistQuaternion.x, this.tmpTwistQuaternion.y, this.tmpTwistQuaternion.z);
    const angle = 2 * Math.atan2(sinHalf, this.tmpTwistQuaternion.w);
    const sign = Math.sign(
      this.tmpTwistQuaternion.x * this.tmpAxis.x +
        this.tmpTwistQuaternion.y * this.tmpAxis.y +
        this.tmpTwistQuaternion.z * this.tmpAxis.z
    );
    return angle * (sign === 0 ? 1 : sign);
  }
}
