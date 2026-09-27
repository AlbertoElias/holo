import * as THREE from 'three';

import { isThreeBone } from '../shared/threeTypeGuards';
import type { HandFingerName, HandFingerRetargetChain, HandFingerRetargetEntry } from '../avatar/AvatarRig';
import type { TrackedHandJointName, Vec3Like, VrHandSide } from '../types/contracts';
import type { XrSessionService } from './XrSessionService';

const HOLD_TTL_FRAMES_DEFAULT = 12;
const RECOVERY_BLEND_DEFAULT = 0.35;
const BIND_BLEND_DEFAULT = 0.2;
const PINCH_ACTIVATION_RATIO = 0.6;
const PINCH_REFERENCE_MIN_SOURCE_DISTANCE_METERS = 0.055;
const PINCH_SOLVER_ITERATIONS = 4;
const PINCH_MAX_STEP_RADIANS = 0.35;

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
  entriesByFinger: Partial<Record<HandFingerName, HandFingerRetargetEntry[]>>;
  tipEntryByFinger: Partial<Record<HandFingerName, HandFingerRetargetEntry>>;
  sourceRestPinchDistanceMeters: number | null;
  avatarRestPinchDistanceMeters: number | null;
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
  private readonly tmpPinchThumbPosition = new THREE.Vector3();
  private readonly tmpPinchIndexPosition = new THREE.Vector3();
  private readonly tmpPinchMidpoint = new THREE.Vector3();
  private readonly tmpPinchAxis = new THREE.Vector3();
  private readonly tmpPinchThumbTarget = new THREE.Vector3();
  private readonly tmpPinchIndexTarget = new THREE.Vector3();
  private readonly tmpPinchPivot = new THREE.Vector3();
  private readonly tmpPinchToEffector = new THREE.Vector3();
  private readonly tmpPinchToTarget = new THREE.Vector3();
  private readonly tmpPinchParentWorldQuaternion = new THREE.Quaternion();
  private readonly tmpPinchWorldDelta = new THREE.Quaternion();
  private readonly tmpPinchLocalDelta = new THREE.Quaternion();

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
    nextState.entriesByFinger = {};
    nextState.tipEntryByFinger = {};
    nextState.sourceRestPinchDistanceMeters = null;
    nextState.avatarRestPinchDistanceMeters = null;
    this.resetQuality(nextState.quality);

    const nextSegments = new Map<string, SegmentRuntimeState>();
    if (chain) {
      for (const entry of chain.entries) {
        const previous = nextState.segmentsByBoneUuid.get(entry.bone.uuid);
        nextSegments.set(entry.bone.uuid, previous ?? this.createSegmentRuntimeState());

        const fingerEntries = nextState.entriesByFinger[entry.finger] ?? [];
        fingerEntries.push(entry);
        nextState.entriesByFinger[entry.finger] = fingerEntries;

        const existingTip = nextState.tipEntryByFinger[entry.finger];
        if (!existingTip || entry.segmentIndex > existingTip.segmentIndex) {
          nextState.tipEntryByFinger[entry.finger] = entry;
        }
      }
      for (const fingerEntries of Object.values(nextState.entriesByFinger)) {
        fingerEntries.sort((a, b) => b.segmentIndex - a.segmentIndex);
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

    this.ensurePinchReference(side, sideState);
    this.applyPinchContactCorrection(side, sideState);
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
      sideState.sourceRestPinchDistanceMeters = null;
      sideState.avatarRestPinchDistanceMeters = null;
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
      const tipObject = tipEntry.bone.children.find(isThreeBone) ?? tipEntry.bone;
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
      entriesByFinger: {},
      tipEntryByFinger: {},
      sourceRestPinchDistanceMeters: null,
      avatarRestPinchDistanceMeters: null,
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
    this.capturePinchReference(side, sideState);
    return true;
  }

  private capturePinchReference(side: VrHandSide, sideState: SideRuntimeState): void {
    sideState.sourceRestPinchDistanceMeters = this.getSourcePinchDistance(side);
    sideState.avatarRestPinchDistanceMeters = this.getAvatarPinchDistance(sideState);
  }

  private ensurePinchReference(side: VrHandSide, sideState: SideRuntimeState): void {
    if (sideState.sourceRestPinchDistanceMeters !== null && sideState.avatarRestPinchDistanceMeters !== null) return;
    const sourceDistance = this.getSourcePinchDistance(side);
    if (sourceDistance === null || sourceDistance < PINCH_REFERENCE_MIN_SOURCE_DISTANCE_METERS) return;
    const avatarDistance = this.getAvatarPinchDistance(sideState);
    if (avatarDistance === null || avatarDistance <= 1e-4) return;
    sideState.sourceRestPinchDistanceMeters = sourceDistance;
    sideState.avatarRestPinchDistanceMeters = avatarDistance;
  }

  private applyPinchContactCorrection(side: VrHandSide, sideState: SideRuntimeState): void {
    const sourceRestDistance = sideState.sourceRestPinchDistanceMeters;
    const avatarRestDistance = sideState.avatarRestPinchDistanceMeters;
    const sourceDistance = this.getSourcePinchDistance(side);
    if (
      sourceRestDistance === null ||
      avatarRestDistance === null ||
      sourceDistance === null ||
      sourceRestDistance <= 1e-4 ||
      avatarRestDistance <= 1e-4
    ) {
      return;
    }

    const sourceRatio = sourceDistance / sourceRestDistance;
    if (!Number.isFinite(sourceRatio) || sourceRatio >= PINCH_ACTIVATION_RATIO) return;

    const thumbTip = this.getTipObject(sideState, 'thumb');
    const indexTip = this.getTipObject(sideState, 'index');
    if (!thumbTip || !indexTip) return;

    const desiredDistance = avatarRestDistance * THREE.MathUtils.clamp(sourceRatio, 0.08, 1);
    const correctionStrength = THREE.MathUtils.smoothstep(
      PINCH_ACTIVATION_RATIO - sourceRatio,
      0,
      PINCH_ACTIVATION_RATIO - 0.08
    );
    if (correctionStrength <= 0) return;

    const thumbEntries = sideState.entriesByFinger.thumb ?? [];
    const indexEntries = sideState.entriesByFinger.index ?? [];
    for (let iteration = 0; iteration < PINCH_SOLVER_ITERATIONS; iteration += 1) {
      thumbTip.getWorldPosition(this.tmpPinchThumbPosition);
      indexTip.getWorldPosition(this.tmpPinchIndexPosition);
      const currentDistance = this.tmpPinchThumbPosition.distanceTo(this.tmpPinchIndexPosition);
      if (!Number.isFinite(currentDistance) || currentDistance <= desiredDistance + 5e-4) break;

      this.tmpPinchMidpoint.copy(this.tmpPinchThumbPosition).add(this.tmpPinchIndexPosition).multiplyScalar(0.5);
      this.tmpPinchAxis.subVectors(this.tmpPinchIndexPosition, this.tmpPinchThumbPosition);
      if (this.tmpPinchAxis.lengthSq() < 1e-8) break;
      this.tmpPinchAxis.normalize();
      this.tmpPinchThumbTarget
        .copy(this.tmpPinchMidpoint)
        .addScaledVector(this.tmpPinchAxis, -desiredDistance * 0.5);
      this.tmpPinchIndexTarget
        .copy(this.tmpPinchMidpoint)
        .addScaledVector(this.tmpPinchAxis, desiredDistance * 0.5);

      this.solveFingerTowardTarget(thumbEntries, thumbTip, this.tmpPinchThumbTarget, correctionStrength);
      this.solveFingerTowardTarget(indexEntries, indexTip, this.tmpPinchIndexTarget, correctionStrength);
    }
  }

  private solveFingerTowardTarget(
    entries: readonly HandFingerRetargetEntry[],
    tipObject: THREE.Object3D,
    targetWorld: THREE.Vector3,
    correctionStrength: number
  ): void {
    for (const entry of entries) {
      const parent = entry.bone.parent;
      if (!parent) continue;

      entry.bone.getWorldPosition(this.tmpPinchPivot);
      tipObject.getWorldPosition(this.tmpPinchThumbPosition);
      this.tmpPinchToEffector.subVectors(this.tmpPinchThumbPosition, this.tmpPinchPivot);
      this.tmpPinchToTarget.subVectors(targetWorld, this.tmpPinchPivot);
      if (this.tmpPinchToEffector.lengthSq() < 1e-8 || this.tmpPinchToTarget.lengthSq() < 1e-8) continue;

      this.tmpPinchToEffector.normalize();
      this.tmpPinchToTarget.normalize();
      this.tmpPinchWorldDelta.setFromUnitVectors(this.tmpPinchToEffector, this.tmpPinchToTarget).normalize();
      const stepAngle = Math.min(2 * Math.acos(THREE.MathUtils.clamp(this.tmpPinchWorldDelta.w, -1, 1)), PINCH_MAX_STEP_RADIANS);
      if (!Number.isFinite(stepAngle) || stepAngle < 1e-5) continue;

      this.tmpAxis.set(this.tmpPinchWorldDelta.x, this.tmpPinchWorldDelta.y, this.tmpPinchWorldDelta.z);
      if (this.tmpAxis.lengthSq() < 1e-8) continue;
      this.tmpAxis.normalize();
      this.tmpPinchWorldDelta.setFromAxisAngle(this.tmpAxis, stepAngle * correctionStrength);

      parent.getWorldQuaternion(this.tmpPinchParentWorldQuaternion);
      this.tmpPinchLocalDelta
        .copy(this.tmpPinchParentWorldQuaternion)
        .invert()
        .multiply(this.tmpPinchWorldDelta)
        .multiply(this.tmpPinchParentWorldQuaternion)
        .normalize();
      entry.bone.quaternion.premultiply(this.tmpPinchLocalDelta).normalize();
      entry.bone.updateMatrixWorld(true);
    }
  }

  private getSourcePinchDistance(side: VrHandSide): number | null {
    if (
      !this.xrService.getTrackedHandJointPosition(side, 'thumb-tip', this.tmpPinchThumbPosition) ||
      !this.xrService.getTrackedHandJointPosition(side, 'index-finger-tip', this.tmpPinchIndexPosition)
    ) {
      return null;
    }
    const distance = this.tmpPinchThumbPosition.distanceTo(this.tmpPinchIndexPosition);
    return Number.isFinite(distance) ? distance : null;
  }

  private getAvatarPinchDistance(sideState: SideRuntimeState): number | null {
    const thumbTip = this.getTipObject(sideState, 'thumb');
    const indexTip = this.getTipObject(sideState, 'index');
    if (!thumbTip || !indexTip) return null;
    thumbTip.getWorldPosition(this.tmpPinchThumbPosition);
    indexTip.getWorldPosition(this.tmpPinchIndexPosition);
    const distance = this.tmpPinchThumbPosition.distanceTo(this.tmpPinchIndexPosition);
    return Number.isFinite(distance) ? distance : null;
  }

  private getTipObject(sideState: SideRuntimeState, finger: HandFingerName): THREE.Object3D | undefined {
    const tipEntry = sideState.tipEntryByFinger[finger];
    if (!tipEntry) return undefined;
    return tipEntry.bone.children.find(isThreeBone) ?? tipEntry.bone;
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
