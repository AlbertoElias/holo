import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { ArmIkChain, AvatarRig, HandFingerRetargetChain } from '../avatar/AvatarRig';
import type { RuntimeConfig } from '../config/runtimeConfig';
import { ArmIkSolver } from '../ik/ArmIkSolver';
import { isFiniteVector3Like } from '../shared/math';
import { TRACKED_HAND_JOINT_NAMES, type HandPoseSnapshot, type HandSample, type QuatLike, type TrackedHandJointName, type VrHandSide } from '../types/contracts';
import { HandFingerRetargeter } from './HandFingerRetargeter';
import { LegacyFingerRetargeter } from './LegacyFingerRetargeter';
import type { HumanoidBoneRef } from '../avatar/HumanoidSkeleton';
import { palmFrameQuaternion } from './palmFrame';
import type { XrTracking } from './XrTracking';

const SIDES = ['left', 'right'] as const;

// Avatar bones that sit on the same anatomical joint as each WebXR hand joint;
// tips are the distal bones' end sites, when the rig has them.
const AVATAR_BONE_FOR_HAND_JOINT: ReadonlyArray<readonly [TrackedHandJointName, (side: VrHandSide) => HumanoidBoneRef]> = [
  ['wrist', (side) => `${side}Hand`],
  ['thumb-metacarpal', (side) => `${side}ThumbMetacarpal`],
  ['thumb-phalanx-proximal', (side) => `${side}ThumbProximal`],
  ['thumb-phalanx-distal', (side) => `${side}ThumbDistal`],
  ['thumb-tip', (side) => `${side}ThumbDistalTip`],
  ...(['index', 'middle', 'ring', 'pinky'] as const).flatMap((finger) => {
    const vrm = finger === 'pinky' ? 'Little' : `${finger[0]!.toUpperCase()}${finger.slice(1)}`;
    const ref = (joint: string) => (side: VrHandSide) => `${side}${vrm}${joint}` as HumanoidBoneRef;
    return [
      [`${finger}-finger-phalanx-proximal`, ref('Proximal')],
      [`${finger}-finger-phalanx-intermediate`, ref('Intermediate')],
      [`${finger}-finger-phalanx-distal`, ref('Distal')],
      [`${finger}-finger-tip`, ref('DistalTip')]
    ] as const;
  })
];

const FINGER_DEBUG_BONES: Readonly<Record<VrHandSide, { thumb: HumanoidBoneRef; index: HumanoidBoneRef; middle: HumanoidBoneRef }>> = {
  left: { thumb: 'leftThumbProximal', index: 'leftIndexDistal', middle: 'leftMiddleDistal' },
  right: { thumb: 'rightThumbProximal', index: 'rightIndexDistal', middle: 'rightMiddleDistal' }
};

/**
 * The avatar's arms and fingers follow tracked hands or controllers: arm IK to
 * the tracked wrist, palm alignment from the hand joints, finger retargeting,
 * and a kinematic Rapier sensor at each hand.
 */
export class HandEmbodiment {
  private readonly armChains: Partial<Record<VrHandSide, ArmIkChain>> = {};
  private readonly fingerChains: Partial<Record<VrHandSide, HandFingerRetargetChain>> = {};
  private readonly ikSolver = new ArmIkSolver();
  readonly fingerRetargeter: HandFingerRetargeter;
  private readonly legacyRetargeter: LegacyFingerRetargeter | undefined;
  private readonly sensors: Record<VrHandSide, { body?: RAPIER.RigidBody; radius: number }> = {
    left: { radius: 0.08 },
    right: { radius: 0.08 }
  };
  private rigReady = false;
  private ikWarningLogged = false;
  private readonly tmpHandWorld = new THREE.Vector3();
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly handWorldScratch = new THREE.Quaternion();
  private readonly palmJointScratch = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] as const;

  constructor(
    private readonly tracking: XrTracking,
    private readonly avatar: AvatarRig,
    private readonly getPhysicsWorld: () => RAPIER.World | undefined,
    config: RuntimeConfig
  ) {
    this.fingerRetargeter = new HandFingerRetargeter(tracking, { twistGain: config.handFingerCurlGain });
    this.legacyRetargeter = config.handRetargetMode === 'legacy' ? new LegacyFingerRetargeter(tracking) : undefined;
  }

  /** Builds the IK and retarget chains once the avatar has loaded. */
  attach(): void {
    for (const side of SIDES) {
      const arm = this.avatar.createArmIkChain(side);
      if (arm) this.armChains[side] = arm;
    }
    for (const side of SIDES) {
      const fingers = this.avatar.createHandFingerRetargetChain(side);
      if (fingers) this.fingerChains[side] = fingers;
    }
    for (const side of SIDES) this.fingerRetargeter.setChain(side, this.fingerChains[side]);
    this.resetRuntimeState();
    this.rigReady = Boolean(this.armChains.left && this.armChains.right);
    if (!this.rigReady) this.avatar.humanoid?.disableFeature('arm IK', 'needs both upper arms, lower arms and hands');
    for (const side of SIDES) {
      if (!this.fingerChains[side]) this.avatar.humanoid?.disableFeature(`${side} fingers`, 'no finger bones');
    }
  }

  /** Clears per-session retarget state on XR entry and exit. */
  resetRuntimeState(): void {
    this.legacyRetargeter?.reset();
    this.fingerRetargeter.resetRuntimeState();
  }

  captureCalibrationPose(): Record<VrHandSide, boolean> {
    return this.fingerRetargeter.captureCalibrationPose();
  }

  resetCalibrationPose(): void {
    this.fingerRetargeter.resetCalibrationPose();
    this.fingerRetargeter.resetRuntimeState();
    this.legacyRetargeter?.reset();
  }

  /** Arm lengths are cached in world units; refitting the avatar rescales them. */
  rescale(ratio: number): void {
    for (const side of SIDES) {
      const chain = this.armChains[side];
      if (!chain) continue;
      chain.upperLength *= ratio;
      chain.lowerLength *= ratio;
    }
  }

  /**
   * Solves both arms toward the tracked hands. `headAnchor` gives the world
   * point tracked hand offsets are measured from (the tracked or avatar eyes).
   */
  update(headAnchor: (out: THREE.Vector3) => THREE.Vector3): void {
    if (!this.rigReady || !this.avatar.avatar) return;

    this.tracking.updateHandTrackingTargets(headAnchor);
    this.ensureSensors();

    for (const side of SIDES) {
      const chain = this.armChains[side];
      const trackingState = this.tracking.getHandTrackingState(side);
      if (!chain || !trackingState.poseValid) continue;

      const handWorld = this.resolveTrackedHandWorldQuaternion(side, chain, this.handWorldScratch);
      if (!this.ikSolver.solve(chain, trackingState.targetPosition, trackingState.targetQuaternion, this.avatar.avatarRoot, handWorld)) {
        if (!this.ikWarningLogged) {
          console.warn('VR arm IK solve produced invalid output; skipping frame write.');
          this.ikWarningLogged = true;
        }
        continue;
      }
      const fingers = this.fingerChains[side];
      if (this.legacyRetargeter) {
        if (fingers) this.legacyRetargeter.apply(side, fingers);
      } else {
        this.fingerRetargeter.apply(side);
      }

      chain.hand.getWorldPosition(this.tmpHandWorld);
      if (isFiniteVector3Like(this.tmpHandWorld)) this.moveSensor(side, this.tmpHandWorld);
    }
  }

  /** Tracked joints and the avatar bones on the same anatomical joints, in world space. */
  sample(): Record<VrHandSide, HandSample> {
    const sample = (side: VrHandSide): HandSample => {
      const result: HandSample = { source: this.tracking.getHandPoseSource(side), tracked: {}, avatar: {} };
      for (const jointName of TRACKED_HAND_JOINT_NAMES) {
        if (this.tracking.getTrackedHandJointPosition(side, jointName, this.tmpVec)) {
          result.tracked[jointName] = [this.tmpVec.x, this.tmpVec.y, this.tmpVec.z];
        }
      }
      for (const [jointName, bone] of AVATAR_BONE_FOR_HAND_JOINT) {
        if (this.avatar.getBoneWorldPosition(bone(side), this.tmpVec)) {
          result.avatar[jointName] = [this.tmpVec.x, this.tmpVec.y, this.tmpVec.z];
        }
      }
      return result;
    };
    return { left: sample('left'), right: sample('right') };
  }

  /** Per-hand tracking and retarget diagnostics for the text state. */
  snapshot(side: VrHandSide): HandPoseSnapshot {
    const tracking = this.tracking.getHandTrackingState(side);
    const bone = this.avatar.getHandBoneWorldPosition(side, new THREE.Vector3());
    const sensor = this.sensors[side].body?.translation();
    const retarget = this.fingerRetargeter.getDebugSnapshot(side);
    const debugBones = FINGER_DEBUG_BONES[side];
    return {
      poseValid: tracking.poseValid,
      targetPosition: { x: tracking.targetPosition.x, y: tracking.targetPosition.y, z: tracking.targetPosition.z },
      targetQuaternion: { x: tracking.targetQuaternion.x, y: tracking.targetQuaternion.y, z: tracking.targetQuaternion.z, w: tracking.targetQuaternion.w },
      bonePosition: bone ? { x: bone.x, y: bone.y, z: bone.z } : null,
      sensorPosition: sensor ? { x: sensor.x, y: sensor.y, z: sensor.z } : null,
      jointTrackedCount: this.tracking.getTrackedFingerJointCount(side),
      fingerLocalQuaternions: {
        thumb: this.boneLocalQuaternion(debugBones.thumb),
        index: this.boneLocalQuaternion(debugBones.index),
        middle: this.boneLocalQuaternion(debugBones.middle)
      },
      calibrated: retarget.calibrated,
      pinchDistanceMeters: retarget.pinchDistanceMeters,
      fingerTips: retarget.fingerTips,
      retargetDataQuality: retarget.retargetDataQuality
    };
  }

  /** Creates the hand sensors once Rapier is up; their radius follows avatar size. */
  ensureSensors(): void {
    const world = this.getPhysicsWorld();
    if (!world) return;
    const radius = Math.max(0.05, Math.min(this.avatar.avatarHeight * 0.06, 0.14));
    for (const side of SIDES) {
      const sensor = this.sensors[side];
      sensor.radius = radius;
      if (sensor.body) continue;
      sensor.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      world.createCollider(RAPIER.ColliderDesc.ball(radius).setSensor(true), sensor.body);
    }
  }

  private moveSensor(side: VrHandSide, position: THREE.Vector3): void {
    const body = this.sensors[side].body;
    const world = this.getPhysicsWorld();
    if (!body || !world) return;
    body.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    body.setNextKinematicTranslation({ x: position.x, y: position.y, z: position.z });
    world.propagateModifiedBodyPositionsToColliders();
  }

  private boneLocalQuaternion(bone: HumanoidBoneRef): QuatLike | null {
    const q = this.avatar.getBoneLocalQuaternion(bone, this.tmpQuat);
    return q ? { x: q.x, y: q.y, z: q.z, w: q.w } : null;
  }

  // Aligns the avatar palm to the tracked palm when hand joints are available,
  // replacing hand-tuned rotation offsets with a rig-independent mapping.
  private resolveTrackedHandWorldQuaternion(side: VrHandSide, chain: ArmIkChain, out: THREE.Quaternion): THREE.Quaternion | undefined {
    if (!chain.palmInHand) return undefined;
    const source = this.tracking.getHandPoseSource(side);
    if (source !== 'xr-hand' && source !== 'mock') return undefined;
    const [wrist, index, middle, pinky] = this.palmJointScratch;
    if (
      !this.tracking.getTrackedHandJointPosition(side, 'wrist', wrist) ||
      !this.tracking.getTrackedHandJointPosition(side, 'index-finger-phalanx-proximal', index) ||
      !this.tracking.getTrackedHandJointPosition(side, 'middle-finger-phalanx-proximal', middle) ||
      !this.tracking.getTrackedHandJointPosition(side, 'pinky-finger-phalanx-proximal', pinky)
    ) {
      return undefined;
    }
    const palmWorld = palmFrameQuaternion(wrist, index, middle, pinky, out);
    return palmWorld?.multiply(this.tmpQuat.copy(chain.palmInHand).invert()).normalize();
  }
}
