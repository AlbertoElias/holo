import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { ARM_LENGTH_FIT_MAX, type ArmIkChain, type AvatarRig, type HandFingerRetargetChain } from '../avatar/AvatarRig';
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
// The forearm rolls by half the wrist twist (no rig has twist bones), so the
// skin twists along the forearm and not all at the wrist.
const FOREARM_TWIST_SHARE = 0.5;
// The camera tracker's tracked hands may stretch an arm up to 8% past full
// reach (ArmIkSolver); its controllers keep the unstretched arm.
const ARM_REACH_STRETCH = 0.08;
// The stretch was set on the stock avatar, whose arm (upper arm plus forearm) is this share of its eye height.
// An avatar with a shorter arm at the same eye height stretches further, to the same reach in metres: the
// house base's arm is 0.276 of its eye height, and at 8% its wrist stopped 2 to 7 cm short of a long reach.
const REFERENCE_ARM_PER_EYE_HEIGHT = 0.3222;
// In VR the arm has a constant human length (ArmIkChain.armLengthFit) and the
// recorded arm model; past full reach it may stretch by this small reserve,
// for both sources (under AvatarColliders' 2% rebuild step, and not visible).
const VR_REACH_RESERVE = 0.018;
// A VR target past the arm's reach leans the chest toward it (T-18dd51), as a
// person does: the chest bone (the arms' torso frame) turns about its own
// joint, so the shoulder comes closer. The lean starts at full reach and turns
// the shoulder as far as the target is out of reach, within these limits: a
// twist about the torso's up axis (it moves one shoulder forward and keeps the
// head on its axis) and a bend (it moves both shoulders and carries the head
// with them, a few centimetres off the tracked head). Pending owner confirmation.
const CHEST_LEAN_START = 1;
const CHEST_TWIST_MAX_RAD = THREE.MathUtils.degToRad(25);
const CHEST_BEND_MAX_RAD = THREE.MathUtils.degToRad(12);
// The lean eases with this time constant (s), so a target that jumps does not snap the chest.
const CHEST_LEAN_EASE_SEC = 0.15;

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
  /** Whether each arm is solved with the tracked-hand reach (an XR hand drives it). */
  private readonly handReach: Record<VrHandSide, boolean> = { left: false, right: false };
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
  // The chest lean toward far VR targets: its eased rotation vector (world, radians), the chest's local rotation
  // before and after the lean (the lean is taken back next frame if nothing else posed the chest since).
  private readonly chestLean = new THREE.Vector3();
  private readonly chestLeanWanted = new THREE.Vector3();
  private chestLeanBone: THREE.Object3D | undefined;
  private readonly chestBefore = new THREE.Quaternion();
  private readonly chestAfter = new THREE.Quaternion();
  private readonly leanVecA = new THREE.Vector3();
  private readonly leanVecB = new THREE.Vector3();
  private readonly leanPivot = new THREE.Vector3();
  private readonly leanAxis = new THREE.Vector3();
  private readonly leanUp = new THREE.Vector3();
  private readonly leanQuat = new THREE.Quaternion();
  private readonly leanQuatB = new THREE.Quaternion();
  private readonly headWorldBefore = new THREE.Quaternion();

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
    for (const side of SIDES) {
      const chain = this.armChains[side];
      if (chain) chain.clavicleAngles = undefined;
    }
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

  /** Arms nothing tracks any more (out of VR) go back to their bind lengths. */
  restArmLengths(): void {
    for (const side of SIDES) {
      const chain = this.armChains[side];
      if (chain) this.ikSolver.restLengths(chain);
    }
  }

  /**
   * How far past full reach this arm may stretch (a share of its length). `past`: the share a tracked hand adds
   * (a controller adds none). An arm shorter than the stock avatar's for its eye height also stretches to that
   * arm's reach: the user's reach is fitted by height, so a short arm went straight while the hand still moved,
   * and a prop thrown from it left at the stopped hand's speed.
   */
  private reachStretch(chain: ArmIkChain, past: number): number {
    const arm = chain.upperLength + chain.lowerLength;
    const eyeHeight = this.avatar.avatarEyeLocalY - this.avatar.avatarMinLocalY;
    if (!(arm > 0) || !(eyeHeight > 0)) return past;
    return Math.max(past, ((1 + past) * REFERENCE_ARM_PER_EYE_HEIGHT * eyeHeight) / arm - 1);
  }

  /**
   * The constant length ratio of this arm in VR. The human fit has a limit (ARM_LENGTH_FIT_MAX), set on the stock
   * avatar, whose arm reaches it. An arm shorter than the stock avatar's for its eye height grows to that arm's
   * VR length: at the limit the house base's wrist stopped 7 cm short of a long reach, and its open hand missed
   * a prop it should bat away.
   */
  private vrArmFit(chain: ArmIkChain): number {
    const arm = chain.upperLength + chain.lowerLength;
    const eyeHeight = this.avatar.avatarEyeLocalY - this.avatar.avatarMinLocalY;
    if (!(arm > 0) || !(eyeHeight > 0)) return chain.armLengthFit;
    return Math.max(chain.armLengthFit, (ARM_LENGTH_FIT_MAX * REFERENCE_ARM_PER_EYE_HEIGHT * eyeHeight) / arm);
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
   * `vr` (with the step's `deltaSec`) selects the VR arm: the recorded arm
   * model and the fitted arm length; the camera tracker passes none.
   */
  update(headAnchor: (out: THREE.Vector3) => THREE.Vector3, vr?: { deltaSec: number }): void {
    if (!this.rigReady || !this.avatar.avatar) return;

    this.tracking.updateHandTrackingTargets(headAnchor);
    this.ensureSensors();
    this.leanChest(vr);

    for (const side of SIDES) {
      const chain = this.armChains[side];
      const trackingState = this.tracking.getHandTrackingState(side);
      if (!chain) continue;
      if (!trackingState.poseValid) {
        // In VR the arm keeps its fitted length while the hand is lost, so it
        // does not shrink and grow again on regain (and the take records no pop).
        if (!vr) this.ikSolver.restLengths(chain);
        continue;
      }

      const handWorld = this.resolveTrackedHandWorldQuaternion(side, chain, this.handWorldScratch);
      // A held pose keeps the reach of the source it holds, so a lost hand's arm does not snap.
      const source = this.tracking.getHandPoseSource(side);
      if (source !== 'held') this.handReach[side] = source === 'xr-hand';
      // In VR the arm has a constant length: the fit grows it, never a reach stretch past the small reserve.
      const fit = vr ? this.vrArmFit(chain) : 1;
      const maxStretch = vr ? VR_REACH_RESERVE : this.reachStretch(chain, this.handReach[side] ? ARM_REACH_STRETCH : 0);
      // Nothing else poses the clavicle in VR, so it still holds the last
      // solve's swing. Start from bind: the protraction reads the reach from
      // the resting shoulder, not from last frame's swing (that feedback made
      // the shoulder pop up to 70° in one frame on near-body reaches).
      chain.shoulder.quaternion.copy(chain.shoulderBindQuaternion);
      chain.shoulder.updateMatrixWorld(true);
      if (!this.ikSolver.solve(chain, trackingState.targetPosition, trackingState.targetQuaternion, this.avatar.avatarRoot, {
        handWorldQuaternion: handWorld,
        maxStretch,
        forearmTwistShare: FOREARM_TWIST_SHARE,
        armModel: vr,
        armLengthRatio: fit
      })) {
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

  /**
   * Leans the chest toward VR targets past the arm's reach (see CHEST_LEAN_START). Each such arm asks for the turn
   * about the chest joint that brings its shoulder toward its target by the distance it is out of reach; the sum is
   * split into a twist about the torso's up axis and a bend, each limited, and eased. The head keeps its world rotation.
   */
  private leanChest(vr: { deltaSec: number } | undefined): void {
    const bone = this.armChains.left?.torso;
    if (!bone || bone !== this.armChains.right?.torso || !bone.parent) return;
    // Take back last frame's lean when nothing posed the chest since (the body solver poses it from bind each frame).
    if (this.chestLeanBone === bone && bone.quaternion.equals(this.chestAfter)) bone.quaternion.copy(this.chestBefore);
    this.chestLeanBone = bone;
    this.chestBefore.copy(bone.quaternion);
    const wanted = this.chestLeanWanted.set(0, 0, 0);
    if (vr) {
      bone.updateWorldMatrix(true, false);
      const pivot = bone.getWorldPosition(this.leanPivot);
      for (const side of SIDES) {
        const chain = this.armChains[side]!;
        const state = this.tracking.getHandTrackingState(side);
        if (!state.poseValid) continue;
        chain.shoulder.quaternion.copy(chain.shoulderBindQuaternion);
        chain.shoulder.updateMatrixWorld(true);
        const shoulder = chain.upperArm.getWorldPosition(this.leanVecA);
        const reach = (chain.upperLength + chain.lowerLength) * this.vrArmFit(chain) * (1 + VR_REACH_RESERVE);
        const past = shoulder.distanceTo(state.targetPosition) - reach * CHEST_LEAN_START;
        if (!(past > 0)) continue;
        const arm = shoulder.sub(pivot);
        const toTarget = this.leanVecB.copy(state.targetPosition).sub(pivot);
        const lever = arm.length();
        if (!(lever > 1e-3) || toTarget.lengthSq() < 1e-6) continue;
        const axis = this.leanAxis.crossVectors(arm, toTarget);
        if (axis.lengthSq() < 1e-10) continue;
        const angle = Math.min(arm.angleTo(toTarget), past / lever);
        wanted.addScaledVector(axis.normalize(), angle);
      }
      // Split into the twist about the avatar's up axis and the bend, each within its limit.
      const up = this.leanUp.set(0, 1, 0).applyQuaternion(this.avatar.avatarRoot.getWorldQuaternion(this.leanQuat));
      const twist = THREE.MathUtils.clamp(wanted.dot(up), -CHEST_TWIST_MAX_RAD, CHEST_TWIST_MAX_RAD);
      wanted.addScaledVector(up, -wanted.dot(up));
      if (wanted.length() > CHEST_BEND_MAX_RAD) wanted.setLength(CHEST_BEND_MAX_RAD);
      wanted.addScaledVector(up, twist);
    }
    const dt = Math.max(0, vr?.deltaSec ?? 1);
    this.chestLean.lerp(wanted, 1 - Math.exp(-dt / CHEST_LEAN_EASE_SEC));
    const angle = this.chestLean.length();
    if (!vr && angle < 1e-4) this.chestLean.set(0, 0, 0);
    if (angle < 1e-4) {
      this.chestAfter.copy(bone.quaternion);
      return;
    }
    const head = this.avatar.humanoid?.bone('head');
    if (head) head.getWorldQuaternion(this.headWorldBefore);
    // world' = lean · world; local' = parentWorld⁻¹ · world'.
    const lean = this.leanQuat.setFromAxisAngle(this.leanVecA.copy(this.chestLean).divideScalar(angle), angle);
    const world = bone.getWorldQuaternion(this.leanQuatB).premultiply(lean);
    bone.quaternion.copy(bone.parent.getWorldQuaternion(this.leanQuat).invert().multiply(world));
    bone.updateMatrixWorld(true);
    if (head?.parent) {
      head.quaternion.copy(head.parent.getWorldQuaternion(this.leanQuat).invert().multiply(this.headWorldBefore));
      head.updateMatrixWorld(true);
    }
    this.chestAfter.copy(bone.quaternion);
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
      const twist = this.wristTwistDeg(side);
      if (twist !== undefined) result.wristTwistDeg = twist;
      return result;
    };
    return { left: sample('left'), right: sample('right') };
  }

  // Swing-twist split of the hand's rotation from bind, about the forearm-to-hand axis.
  private wristTwistDeg(side: VrHandSide): number | undefined {
    const chain = this.armChains[side];
    if (!chain) return undefined;
    const delta = this.tmpQuat.copy(chain.handBindQuaternion).invert().multiply(chain.hand.quaternion);
    const axis = this.tmpVec.copy(chain.handBindPosition).normalize().applyQuaternion(this.handWorldScratch.copy(chain.handBindQuaternion).invert());
    const along = delta.x * axis.x + delta.y * axis.y + delta.z * axis.z;
    const sign = delta.w < 0 ? -1 : 1;
    return THREE.MathUtils.radToDeg(2 * Math.atan2(along * sign, delta.w * sign));
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
    // A held camera hand keeps its joints through the hold; held XR and mock hands have none, so they fall through below.
    if (source !== 'xr-hand' && source !== 'mock' && source !== 'camera-hand' && source !== 'held') return undefined;
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
