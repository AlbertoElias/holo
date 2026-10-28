import * as THREE from 'three';
import type { VrmHumanoidBone } from '@holoim/meaning';

import { isThreeBone, isThreeMesh } from '../shared/threeTypeGuards';
import { type HumanoidBoneRef, HumanoidSkeleton, type HumanoidSource } from './HumanoidSkeleton';
import type { RuntimeConfig } from '../config/runtimeConfig';
import type { TrackedHandJointName, VrHandSide } from '../types/contracts';
import { palmFrameQuaternion } from '../xr/palmFrame';
import { clamp, isFiniteQuaternionLike, isFiniteVector3Like } from '../shared/math';

export interface ArmIkChain {
  side: VrHandSide;
  shoulder: THREE.Bone;
  upperArm: THREE.Bone;
  foreArm: THREE.Bone;
  hand: THREE.Bone;
  upperLength: number;
  lowerLength: number;
  upperBindQuaternion: THREE.Quaternion;
  foreBindQuaternion: THREE.Quaternion;
  handBindQuaternion: THREE.Quaternion;
  upperBindAimInParent: THREE.Vector3;
  foreBindAimInParent: THREE.Vector3;
  shoulderBindQuaternion: THREE.Quaternion;
  shoulderBindAimInParent: THREE.Vector3 | undefined;
  handGripRotationOffset: THREE.Quaternion;
  // Avatar palm frame expressed in the hand bone's space (see palmFrame.ts);
  // undefined when the rig lacks the index, middle, or pinky knuckle bones.
  palmInHand: THREE.Quaternion | undefined;
  elbowHintLocal: THREE.Vector3;
}

export interface HandFingerRetargetEntry {
  finger: HandFingerName;
  segmentIndex: number;
  bone: THREE.Bone;
  xrQuaternionSources: ReadonlyArray<{
    jointName: TrackedHandJointName;
    parentJointNames: readonly TrackedHandJointName[];
  }>;
  xrSourceJointNames: readonly TrackedHandJointName[];
  xrTargetJointNames: readonly TrackedHandJointName[];
  bindQuaternion: THREE.Quaternion;
  bindAimInParent: THREE.Vector3;
}

type FingerRetargetMapping = {
  finger: HandFingerName;
  segmentIndex: number;
  /** Canonical bone, with the side filled in by the chain builder. */
  bone: (side: VrHandSide) => HumanoidBoneRef;
  xrQuaternionSources: HandFingerRetargetEntry['xrQuaternionSources'];
  xrSourceJointNames: readonly TrackedHandJointName[];
  xrTargetJointNames: readonly TrackedHandJointName[];
};

// Each finger bone starts at a WebXR joint and must aim along the tracked
// segment that starts at that same joint: the proximal phalanx bone (from the
// knuckle) follows phalanx-proximal → phalanx-intermediate, and so on; the
// fourth segment is the distal bone's end site, when the rig has one.
// The metacarpal segment has no avatar bone; the hand bone covers it.
function fingerRetargetMappings(finger: 'index' | 'middle' | 'ring' | 'pinky'): FingerRetargetMapping[] {
  const joint = (name: string) => `${finger}-finger-${name}` as TrackedHandJointName;
  const metacarpal = joint('metacarpal');
  const proximal = joint('phalanx-proximal');
  const intermediate = joint('phalanx-intermediate');
  const distal = joint('phalanx-distal');
  const tip = joint('tip');
  const vrmFinger = finger === 'pinky' ? 'Little' : `${finger[0]!.toUpperCase()}${finger.slice(1)}`;
  const bone = (joint: string, tip = false) =>
    (side: VrHandSide): HumanoidBoneRef => `${side}${vrmFinger}${joint}${tip ? 'Tip' : ''}` as HumanoidBoneRef;
  return [
    {
      finger,
      segmentIndex: 0,
      bone: bone('Proximal'),
      xrQuaternionSources: [{ jointName: proximal, parentJointNames: [metacarpal, 'wrist'] }],
      xrSourceJointNames: [proximal],
      xrTargetJointNames: [intermediate, distal, tip]
    },
    {
      finger,
      segmentIndex: 1,
      bone: bone('Intermediate'),
      xrQuaternionSources: [{ jointName: intermediate, parentJointNames: [proximal, metacarpal] }],
      xrSourceJointNames: [intermediate],
      xrTargetJointNames: [distal, tip]
    },
    {
      finger,
      segmentIndex: 2,
      bone: bone('Distal'),
      xrQuaternionSources: [{ jointName: distal, parentJointNames: [intermediate, proximal] }],
      xrSourceJointNames: [distal],
      xrTargetJointNames: [tip]
    },
    {
      finger,
      segmentIndex: 3,
      bone: bone('Distal', true),
      xrQuaternionSources: [
        { jointName: tip, parentJointNames: [distal] },
        { jointName: distal, parentJointNames: [intermediate] }
      ],
      xrSourceJointNames: [distal],
      xrTargetJointNames: [tip]
    }
  ];
}

export interface HandFingerRetargetChain {
  side: VrHandSide;
  entries: HandFingerRetargetEntry[];
}

export type HandFingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';

interface CrouchBoneBinding {
  bone: THREE.Bone;
  bindQuaternion: THREE.Quaternion;
  fullPitchRad: number;
  /** Bone-local pitch axis. */
  axis: THREE.Vector3;
}

interface CrouchHipsBinding extends CrouchBoneBinding {
  bindPosition: THREE.Vector3;
  downInParent: THREE.Vector3;
  backInParent: THREE.Vector3;
}

/**
 * Controller grip → avatar palm frame (`palmFrame.ts`), per side. Measured on
 * the shipped rig, where the old offset was Euler(-90°, ∓90°, 180°) × inverse
 * hand bind; the grip offset is this times inverse(palmInHand) on any rig.
 */
/** The shipped rig's left eye from its head bone, in avatar space, per metre of hips-to-head length. */
const EYE_FROM_HEAD_PER_HIPS_TO_HEAD = [0.0656, 0.1487, 0.149] as const;

const GRIP_TO_PALM: Readonly<Record<VrHandSide, THREE.Quaternion>> = {
  left: new THREE.Quaternion(0.335312, 0.596293, 0.577675, 0.445299),
  right: new THREE.Quaternion(0.577203, 0.445464, 0.335794, 0.596356)
};

const CROUCH_POSE_EPSILON = 1e-4;
const CROUCH_MAX_POSE_AMOUNT = 1.45;
const CROUCH_FOOT_GROUND_CLEARANCE_RATIO = 0.015;
const CROUCH_MAX_HIPS_LIFT_RATIO = 0.16;
// A reach squat: the hips drop this much more (a fraction of height) beyond the full crouch, and the forward bend grows by this factor.
const SQUAT_EXTRA_HIPS_DROP_RATIO = 0.20;
// Past the full squat, a hand that still can't reach (a prop gripped near its bottom) takes the hips this much further down, a fraction of height: never more lean.
const SQUAT_DEEP_EXTRA_RATIO = 0.07;
// The crouch's leg bend is relaxed by this much at full squat: the leg solver bends the knees instead.
const SQUAT_LEG_RELAX = 0.85;
const CROUCH_WALK_BLEND_START_SPEED = 0.08;
const CROUCH_WALK_BLEND_END_SPEED = 0.28;
const CROUCH_WALK_HIPS_POSE_WEIGHT = 0.55;
const CROUCH_WALK_LEG_POSE_WEIGHT = 0.45;
const CROUCH_WALK_FOOT_POSE_WEIGHT = 0.25;
const CROUCH_WALK_EXTRA_GROUND_CLEARANCE_RATIO = 0.02;
const CROUCH_GROUND_SAMPLE_RADIUS_RATIO = 0.045;
const CROUCH_GROUND_SAMPLE_OFFSETS: readonly Readonly<[number, number]>[] = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [0.7, 0.7],
  [-0.7, 0.7],
  [0.7, -0.7],
  [-0.7, -0.7]
];
const CROUCH_FOOT_PITCH_DEG = 8;

export class AvatarRig {
  readonly avatarRoot = new THREE.Group();

  worldModel: THREE.Object3D | undefined;
  avatar: THREE.Object3D | undefined;
  /** Canonical bones of the loaded avatar; every system finds bones here, never by name. */
  humanoid: HumanoidSkeleton | undefined;
  headBone: THREE.Bone | undefined;
  leftEyeAnchor: THREE.Object3D | undefined;
  rightEyeAnchor: THREE.Object3D | undefined;
  avatarHeight = 1.8;
  avatarMinLocalY = 0;
  avatarEyeLocalY = 1.65;
  terrainCeilingY = Infinity;
  worldTopRayY = 1000;

  private readonly configuredScale = new THREE.Vector3(1, 1, 1);
  private configuredHeight = 1.8;
  private configuredMinY = 0;
  private configuredEyeY = 1.65;
  private neutralEyeAboveBase = 1.65;
  xrHeightScale = 1;

  /** Motor dimensions remain configured; compensate only the visual base. */
  get heightVisualOffsetY(): number {
    return this.configuredMinY - this.avatarMinLocalY;
  }

  setXrEyeHeight(eyeHeight: number | undefined): number {
    if (!this.avatar) return 1;
    const previous = this.xrHeightScale;
    const factor = eyeHeight === undefined ? 1 : eyeHeight / this.neutralEyeAboveBase;
    if (!Number.isFinite(factor) || factor <= 0 || factor === previous) return 1;
    this.xrHeightScale = factor;
    this.avatar.scale.copy(this.configuredScale).multiplyScalar(factor);
    this.avatarHeight = this.configuredHeight * factor;
    this.avatarMinLocalY = this.avatar.position.y + (this.configuredMinY - this.avatar.position.y) * factor;
    this.avatarEyeLocalY = this.avatarMinLocalY + (this.configuredEyeY - this.configuredMinY) * factor;
    this.avatar.updateWorldMatrix(true, true);
    return factor / previous;
  }

  private readonly firstPersonHiddenMeshes: THREE.Mesh[] = [];
  private readonly avatarMaterials: THREE.Material[] = [];
  private readonly avatarClipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  private readonly avatarMaterialClippingBackup = new WeakMap<THREE.Material, THREE.Plane[] | null>();
  private crouchRigReady = false;
  private crouchWarningLogged = false;
  private lastCrouchAmount = -1;
  private lastSquatAmount = 0;
  private lastDeepExtra = 0;
  /** Where each foot stood when the current reach began, before it bent the body. */
  readonly plantFeet = { left: new THREE.Vector3(), right: new THREE.Vector3() };
  /** The feet's world orientations when planted: a planted foot stays flat as it was, however far the legs fold. */
  readonly plantFootQuats = { left: new THREE.Quaternion(), right: new THREE.Quaternion() };
  private feetPlanted = false;
  private readonly preCrouchPose = new Map<THREE.Bone, { quaternion: THREE.Quaternion; position: THREE.Vector3 }>();
  private crouchHips: CrouchHipsBinding | undefined;
  private readonly crouchSpine: CrouchBoneBinding[] = [];
  private readonly crouchUpperLegs: CrouchBoneBinding[] = [];
  private readonly crouchLowerLegs: CrouchBoneBinding[] = [];
  private readonly crouchFeet: CrouchBoneBinding[] = [];
  private crouchLeftFoot: THREE.Bone | undefined;
  private crouchRightFoot: THREE.Bone | undefined;
  private readonly tmpBox = new THREE.Box3();
  private readonly tmpCenter = new THREE.Vector3();
  private readonly tmpSize = new THREE.Vector3();
  private readonly tmpBindBoneWorld = new THREE.Vector3();
  private readonly tmpVecA = new THREE.Vector3();
  private readonly tmpVecB = new THREE.Vector3();
  private readonly tmpUpperWorld = new THREE.Vector3();
  private readonly tmpForeWorld = new THREE.Vector3();
  private readonly tmpHandWorld = new THREE.Vector3();
  private readonly tmpParentWorldQuat = new THREE.Quaternion();
  private readonly tmpInvQuat = new THREE.Quaternion();
  private readonly tmpEyeWorld = new THREE.Vector3();
  private readonly tmpCrouchQuat = new THREE.Quaternion();
  private readonly crouchGroundRaycaster = new THREE.Raycaster();
  private readonly tmpLeftFootWorld = new THREE.Vector3();
  private readonly tmpRightFootWorld = new THREE.Vector3();

  constructor(private readonly worldGroup: THREE.Group, private readonly renderer: THREE.WebGLRenderer) {
    this.worldGroup.add(this.avatarRoot);
  }

  applyLoadedModels(worldModel: THREE.Object3D, avatar: THREE.Object3D, config: RuntimeConfig, humanoidSource?: HumanoidSource): void {
    this.worldModel = worldModel;
    this.worldGroup.add(worldModel);
    this.centerModelOnGround(worldModel);

    this.avatar = avatar;
    this.avatarRoot.add(avatar);
    // Facing first: bounds, height and eye metrics below assume +Y up and +Z forward.
    this.humanoid = HumanoidSkeleton.bind(avatar, humanoidSource);
    this.humanoid.normalizeFacing(avatar);
    this.centerModelXz(avatar);

    this.applyAvatarScaleAndMetrics(config);
    this.applySceneScaleAgainstAvatar(config);
    this.refreshWorldBounds();
    this.resolveHeadAndEyes();
    this.configuredScale.copy(avatar.scale);
    this.configuredHeight = this.avatarHeight;
    this.configuredMinY = this.avatarMinLocalY;
    this.configuredEyeY = this.avatarEyeLocalY;
    this.getEyeAnchorWorldPosition(this.tmpEyeWorld, 0);
    this.neutralEyeAboveBase = this.tmpEyeWorld.y - this.avatarRoot.position.y - this.avatarMinLocalY;
    if (!Number.isFinite(this.neutralEyeAboveBase) || this.neutralEyeAboveBase < this.avatarHeight * 0.3) {
      this.neutralEyeAboveBase = this.avatarHeight * 0.92;
    }
    this.disableAvatarFrustumCulling(avatar);
    this.classifyFirstPersonHeadMeshes(avatar);
    this.collectAvatarMaterials(avatar);
    this.resolveCrouchRig();
  }

  getEyeAnchorWorldPosition(out: THREE.Vector3, embodyOffset: number): THREE.Vector3 {
    if (this.leftEyeAnchor && this.rightEyeAnchor) {
      this.leftEyeAnchor.getWorldPosition(this.tmpVecA);
      this.rightEyeAnchor.getWorldPosition(this.tmpVecB);
      if (isFiniteVector3Like(this.tmpVecA) && isFiniteVector3Like(this.tmpVecB)) {
        out.copy(this.tmpVecA).add(this.tmpVecB).multiplyScalar(0.5);
        out.y += embodyOffset;
        return out;
      }
    }

    if (this.headBone) {
      this.headBone.getWorldPosition(out);
      if (isFiniteVector3Like(out)) {
        out.y += embodyOffset;
        return out;
      }
    }
    out.set(this.avatarRoot.position.x, this.avatarRoot.position.y + this.avatarEyeLocalY + embodyOffset, this.avatarRoot.position.z);
    return out;
  }

  syncAvatarPoseFromCharacter(position: THREE.Vector3, lookYaw: number, avatarVisualOffsetY: number, avatarForwardOffset: number): void {
    this.avatarRoot.position.set(position.x, position.y + avatarVisualOffsetY + this.heightVisualOffsetY, position.z);
    this.avatarRoot.rotation.y = lookYaw + avatarForwardOffset;
  }

  setFirstPersonVisualState(mode: 'off' | 'desktop' | 'vr'): void {
    const isFirstPerson = mode !== 'off';
    this.setFirstPersonHeadVisible(!isFirstPerson);
    // Local body clipping is only used for desktop first-person. In VR it creates
    // unnatural slicing artifacts when pitching the head down.
    this.setDesktopFirstPersonAvatarClip(mode === 'desktop');
  }

  // Unkeyed bones (especially VR idle) must not retain last frame's offsets.
  restoreCrouchPose(): void {
    for (const [bone, pose] of this.preCrouchPose) {
      bone.quaternion.copy(pose.quaternion);
      bone.position.copy(pose.position);
    }
    this.preCrouchPose.clear();
  }

  /** `plant`: a reach is driving the pose, so the feet stay where they stood when it began. */
  applyCrouchPose(amount: number, horizontalSpeed = 0, squat = 0, plant = false, deepExtra = 0): void {
    const clampedAmount = clamp(amount, 0, CROUCH_MAX_POSE_AMOUNT);
    if (!this.crouchRigReady || !this.crouchHips) return;
    if (!plant) this.feetPlanted = false;
    else if (!this.feetPlanted) {
      // Once, at the start of the reach, before any bend: planting keeps them there however the hips move.
      this.feetPlanted = true;
      this.crouchHips.bone.updateWorldMatrix(true, true);
      for (const [side, foot] of [['left', this.crouchLeftFoot], ['right', this.crouchRightFoot]] as const) {
        if (foot) {
          foot.getWorldPosition(this.plantFeet[side]);
          foot.getWorldQuaternion(this.plantFootQuats[side]);
        }
      }
    }
    const squatAmount = clamp(squat, 0, 1);
    const amountChanged = Math.abs(clampedAmount - this.lastCrouchAmount) > CROUCH_POSE_EPSILON || Math.abs(squatAmount - this.lastSquatAmount) > CROUCH_POSE_EPSILON || Math.abs(deepExtra - this.lastDeepExtra) > CROUCH_POSE_EPSILON;
    this.lastSquatAmount = squatAmount;
    this.lastDeepExtra = deepExtra;
    const wasCrouched = this.lastCrouchAmount > CROUCH_POSE_EPSILON;
    const isCrouched = clampedAmount > CROUCH_POSE_EPSILON;
    if (!amountChanged && !wasCrouched && !isCrouched) return;
    this.lastCrouchAmount = clampedAmount;
    const walkBlend = clamp(
      (horizontalSpeed - CROUCH_WALK_BLEND_START_SPEED) / (CROUCH_WALK_BLEND_END_SPEED - CROUCH_WALK_BLEND_START_SPEED),
      0,
      1
    );
    const hipsPoseWeight = THREE.MathUtils.lerp(1, CROUCH_WALK_HIPS_POSE_WEIGHT, walkBlend);
    const legPoseWeight = THREE.MathUtils.lerp(1, CROUCH_WALK_LEG_POSE_WEIGHT, walkBlend);
    const footPoseWeight = THREE.MathUtils.lerp(1, CROUCH_WALK_FOOT_POSE_WEIGHT, walkBlend);
    const lean = 1;
    const hipsAmount = Math.pow(clampedAmount, 0.9) * hipsPoseWeight;
    const legAmount = Math.pow(clampedAmount, 0.72) * legPoseWeight * (1 - SQUAT_LEG_RELAX * squatAmount);
    const spineAmount = Math.pow(clampedAmount, 0.78) * lean;
    const footAmount = Math.pow(clampedAmount, 0.9) * footPoseWeight * (1 - squatAmount);

    for (const binding of [this.crouchHips, ...this.crouchSpine, ...this.crouchUpperLegs, ...this.crouchLowerLegs, ...this.crouchFeet]) {
      this.preCrouchPose.set(binding.bone, {
        quaternion: binding.bone.quaternion.clone(), position: binding.bone.position.clone()
      });
    }
    // Bone translations use parent-local units; avatarHeight is world meters.
    const parentScale = this.crouchHips.bone.parent?.getWorldScale(this.tmpSize).y ?? 1;
    const heightInParent = this.avatarHeight / Math.max(1e-8, Math.abs(parentScale));
    this.crouchHips.bone.position
      .addScaledVector(this.crouchHips.downInParent, heightInParent * (0.11 * hipsAmount + (SQUAT_EXTRA_HIPS_DROP_RATIO * squatAmount + SQUAT_DEEP_EXTRA_RATIO * clamp(deepExtra, 0, 1))))
      .addScaledVector(this.crouchHips.backInParent, heightInParent * 0.045 * hipsAmount);
    this.applyCrouchBoneRotation(this.crouchHips, hipsAmount * lean);
    this.crouchHips.bone.updateMatrixWorld(true);

    for (const binding of this.crouchSpine) {
      this.applyCrouchBoneRotation(binding, spineAmount);
      binding.bone.updateMatrixWorld(true);
    }
    for (const binding of this.crouchUpperLegs) {
      this.applyCrouchBoneRotation(binding, legAmount);
      binding.bone.updateMatrixWorld(true);
    }
    for (const binding of this.crouchLowerLegs) {
      this.applyCrouchBoneRotation(binding, legAmount);
      binding.bone.updateMatrixWorld(true);
    }
    for (const binding of this.crouchFeet) {
      this.applyCrouchBoneRotation(binding, footAmount);
      binding.bone.updateMatrixWorld(true);
    }

    // Planted feet are pinned by the leg solver, so lifting the hips to clear the unplanted feet would only make the hips jump with the terrain probe.
    if (!plant) this.applyCrouchFootGroundCompensation(clampedAmount, walkBlend, squatAmount);
  }

  /** The avatar's canonical bone, or its end site for a `…Tip` reference. */
  bone(ref: HumanoidBoneRef): THREE.Bone | undefined {
    return this.humanoid?.resolve(ref);
  }

  getHandBoneWorldPosition(side: VrHandSide, out: THREE.Vector3): THREE.Vector3 | undefined {
    const hand = this.bone(`${side}Hand`);
    if (!hand) return undefined;
    hand.getWorldPosition(out);
    if (!isFiniteVector3Like(out)) {
      return undefined;
    }
    return out;
  }

  getBoneWorldPosition(ref: HumanoidBoneRef, out: THREE.Vector3): THREE.Vector3 | undefined {
    const bone = this.bone(ref);
    if (!bone) return undefined;
    bone.getWorldPosition(out);
    return isFiniteVector3Like(out) ? out : undefined;
  }

  getBoneLocalQuaternion(ref: HumanoidBoneRef, out: THREE.Quaternion): THREE.Quaternion | undefined {
    const bone = this.bone(ref);
    if (!bone) return undefined;
    out.copy(bone.quaternion);
    if (!isFiniteQuaternionLike(out)) {
      return undefined;
    }
    return out;
  }

  private computePalmInHand(side: VrHandSide, hand: THREE.Bone): THREE.Quaternion | undefined {
    const knuckle = (finger: string) => this.bone(`${side}${finger}Proximal` as VrmHumanoidBone)?.getWorldPosition(new THREE.Vector3());
    const index = knuckle('Index');
    const middle = knuckle('Middle');
    const pinky = knuckle('Little');
    if (!index || !middle || !pinky) return undefined;
    const palmWorld = palmFrameQuaternion(hand.getWorldPosition(new THREE.Vector3()), index, middle, pinky, new THREE.Quaternion());
    if (!palmWorld) return undefined;
    // palmInHand = inverse(handWorld) × palmWorld, captured at bind pose.
    return hand.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(palmWorld).normalize();
  }

  /**
   * The palm frame without knuckles: along the forearm → hand line, with the
   * index side toward the avatar's forward (true whether the rest palm faces
   * down or in), in the hand's bind frame.
   */
  private estimatePalmInHand(hand: THREE.Bone, foreArm: THREE.Object3D): THREE.Quaternion | undefined {
    const wrist = hand.getWorldPosition(new THREE.Vector3());
    const along = wrist.clone().sub(foreArm.getWorldPosition(new THREE.Vector3())).normalize();
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.canonicalFrameQuaternion());
    const across = forward.addScaledVector(along, -forward.dot(along));
    if (along.lengthSq() < 1e-10 || across.lengthSq() < 1e-10) return undefined;
    across.normalize();
    const middle = wrist.clone().addScaledVector(along, 0.08);
    const index = middle.clone().addScaledVector(across, 0.02);
    const pinky = middle.clone().addScaledVector(across, -0.02);
    const palmWorld = palmFrameQuaternion(wrist, index, middle, pinky, new THREE.Quaternion());
    return palmWorld ? hand.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(palmWorld).normalize() : undefined;
  }

  createArmIkChain(side: VrHandSide): ArmIkChain | undefined {
    const upperArm = this.bone(`${side}UpperArm`);
    const foreArm = this.bone(`${side}LowerArm`);
    const hand = this.bone(`${side}Hand`);
    // A rig without clavicles drives the upper arm's parent (usually the upper chest) as the shoulder.
    const shoulder = this.bone(`${side}Shoulder`) ?? (isThreeBone(upperArm?.parent) ? upperArm.parent : undefined);
    if (!shoulder || !upperArm || !foreArm || !hand || !upperArm.parent || !foreArm.parent || !hand.parent) {
      return undefined;
    }

    upperArm.getWorldPosition(this.tmpUpperWorld);
    foreArm.getWorldPosition(this.tmpForeWorld);
    hand.getWorldPosition(this.tmpHandWorld);

    const upperLength = this.tmpUpperWorld.distanceTo(this.tmpForeWorld);
    const lowerLength = this.tmpForeWorld.distanceTo(this.tmpHandWorld);
    if (!Number.isFinite(upperLength) || !Number.isFinite(lowerLength) || upperLength <= 0.001 || lowerLength <= 0.001) {
      return undefined;
    }

    const shoulderBindQuaternion = shoulder.quaternion.clone();
    const shoulderBindAimInParent = this.toBindAimInParent(shoulder, this.tmpUpperWorld, new THREE.Vector3());
    const upperBindQuaternion = upperArm.quaternion.clone();
    const foreBindQuaternion = foreArm.quaternion.clone();
    const handBindQuaternion = hand.quaternion.clone();

    const upperBindAimInParent = new THREE.Vector3();
    const foreBindAimInParent = new THREE.Vector3();
    if (!this.toBindAimInParent(upperArm, this.tmpForeWorld, upperBindAimInParent)) return undefined;
    if (!this.toBindAimInParent(foreArm, this.tmpHandWorld, foreBindAimInParent)) return undefined;

    // Grip → hand from the rig's own palm frame, so it holds for any hand bone
    // axes. Without finger bones the palm is estimated from the forearm and the
    // avatar's forward (about 12° off on the shipped rig), and the report says so.
    let palmInHand = this.computePalmInHand(side, hand);
    if (!palmInHand) {
      palmInHand = this.estimatePalmInHand(hand, foreArm);
      this.humanoid?.note(`${side} hand grip estimated from the forearm: no index, middle and little proximal bones`);
    }
    if (!palmInHand) return undefined;
    const handGripRotationOffset = GRIP_TO_PALM[side].clone().multiply(palmInHand.clone().invert());

    return {
      side,
      shoulder,
      upperArm,
      foreArm,
      hand,
      upperLength,
      lowerLength,
      upperBindQuaternion,
      foreBindQuaternion,
      handBindQuaternion,
      upperBindAimInParent,
      foreBindAimInParent,
      shoulderBindQuaternion,
      shoulderBindAimInParent,
      handGripRotationOffset,
      palmInHand,
      // Avatar space (ArmIkSolver applies the avatar root's rotation), so it holds once facing is normalized.
      elbowHintLocal: new THREE.Vector3(side === 'left' ? 1 : -1, -0.05, 0.25).normalize()
    };
  }

  createHandFingerRetargetChain(side: VrHandSide): HandFingerRetargetChain | undefined {
    const thumb = (joint: string, tip = false) =>
      (s: VrHandSide): HumanoidBoneRef => `${s}Thumb${joint}${tip ? 'Tip' : ''}` as HumanoidBoneRef;
    const mappings: FingerRetargetMapping[] = [
      {
        finger: 'thumb',
        segmentIndex: 0,
        bone: thumb('Metacarpal'),
        xrQuaternionSources: [{ jointName: 'thumb-metacarpal', parentJointNames: ['wrist'] }],
        xrSourceJointNames: ['thumb-metacarpal', 'wrist'],
        xrTargetJointNames: ['thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip']
      },
      {
        finger: 'thumb',
        segmentIndex: 1,
        bone: thumb('Proximal'),
        xrQuaternionSources: [{ jointName: 'thumb-phalanx-proximal', parentJointNames: ['thumb-metacarpal', 'wrist'] }],
        xrSourceJointNames: ['thumb-phalanx-proximal', 'thumb-metacarpal', 'wrist'],
        xrTargetJointNames: ['thumb-phalanx-distal', 'thumb-tip']
      },
      {
        finger: 'thumb',
        segmentIndex: 2,
        bone: thumb('Distal'),
        xrQuaternionSources: [{ jointName: 'thumb-phalanx-distal', parentJointNames: ['thumb-phalanx-proximal', 'thumb-metacarpal'] }],
        xrSourceJointNames: ['thumb-phalanx-distal', 'thumb-phalanx-proximal'],
        xrTargetJointNames: ['thumb-tip']
      },
      {
        finger: 'thumb',
        segmentIndex: 3,
        bone: thumb('Distal', true),
        xrQuaternionSources: [
          { jointName: 'thumb-tip', parentJointNames: ['thumb-phalanx-distal'] },
          { jointName: 'thumb-phalanx-distal', parentJointNames: ['thumb-phalanx-proximal'] }
        ],
        xrSourceJointNames: ['thumb-phalanx-distal', 'thumb-phalanx-proximal'],
        xrTargetJointNames: ['thumb-tip']
      },
      ...(['index', 'middle', 'ring', 'pinky'] as const).flatMap(fingerRetargetMappings)
    ];

    const entries: HandFingerRetargetEntry[] = [];
    for (const mapping of mappings) {
      const bone = this.bone(mapping.bone(side));
      if (!bone || !bone.parent) continue;
      const childBone = bone.children.find(isThreeBone);
      const bindAimInParent = new THREE.Vector3();
      if (childBone) {
        childBone.getWorldPosition(this.tmpVecA);
        if (!this.toBindAimInParent(bone, this.tmpVecA, bindAimInParent)) {
          // Some rigs contain zero-length child offsets; fall back to local translation direction.
          bindAimInParent.copy(bone.position);
          if (bindAimInParent.lengthSq() < 1e-8) continue;
          bindAimInParent.normalize();
        }
      } else {
        bindAimInParent.copy(bone.position);
        if (bindAimInParent.lengthSq() < 1e-8) continue;
        bindAimInParent.normalize();
      }
      entries.push({
        finger: mapping.finger,
        segmentIndex: mapping.segmentIndex,
        bone,
        xrQuaternionSources: mapping.xrQuaternionSources,
        xrSourceJointNames: mapping.xrSourceJointNames,
        xrTargetJointNames: mapping.xrTargetJointNames,
        bindQuaternion: bone.quaternion.clone(),
        bindAimInParent
      });
    }
    if (entries.length === 0) return undefined;
    return { side, entries };
  }

  // Ground height at (x, z), ignoring steep faces and the world's ceiling;
  // outNormal, when given, receives the upward surface normal there.
  sampleTerrainYAt(x: number, z: number, raycaster: THREE.Raycaster, outNormal?: THREE.Vector3): number | undefined {
    if (!this.worldModel) return undefined;
    this.tmpVecA.set(x, this.worldTopRayY, z);
    raycaster.set(this.tmpVecA, new THREE.Vector3(0, -1, 0));
    const hits = raycaster.intersectObject(this.worldModel, true);
    for (const hit of hits) {
      if (!hit.face) continue;
      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      if (normal.y > 0.2 && hit.point.y <= this.terrainCeilingY) {
        outNormal?.copy(normal);
        return hit.point.y + 0.01;
      }
    }
    return undefined;
  }

  private centerModelOnGround(model: THREE.Object3D): void {
    this.tmpBox.setFromObject(model);
    this.tmpBox.getCenter(this.tmpCenter);
    model.position.sub(new THREE.Vector3(this.tmpCenter.x, this.tmpBox.min.y, this.tmpCenter.z));
  }

  private centerModelXz(model: THREE.Object3D): void {
    this.tmpBox.setFromObject(model);
    this.tmpBox.getCenter(this.tmpCenter);
    model.position.sub(new THREE.Vector3(this.tmpCenter.x, 0, this.tmpCenter.z));
  }

  private getObjectHeight(model: THREE.Object3D): number {
    this.tmpBox.setFromObject(model);
    return this.tmpBox.getSize(this.tmpSize).y;
  }

  private applyAvatarScaleAndMetrics(config: RuntimeConfig): void {
    if (!this.avatar) return;

    const currentHeight = this.getObjectHeight(this.avatar);
    if (currentHeight > 0 && Number.isFinite(config.avatarHeightOverride) && config.avatarHeightOverride > 0) {
      const scaleToHeight = config.avatarHeightOverride / currentHeight;
      this.avatar.scale.multiplyScalar(scaleToHeight);
    }

    if (Number.isFinite(config.avatarScaleMultiplier) && config.avatarScaleMultiplier > 0 && config.avatarScaleMultiplier !== 1) {
      this.avatar.scale.multiplyScalar(config.avatarScaleMultiplier);
    }

    this.tmpBox.setFromObject(this.avatar);
    this.avatarMinLocalY = this.tmpBox.min.y;
    const avatarMaxLocalY = this.tmpBox.max.y;
    this.avatarHeight = Math.max(0.01, avatarMaxLocalY - this.avatarMinLocalY);
    this.avatarEyeLocalY = this.avatarMinLocalY + this.avatarHeight * 0.92;
  }

  private applySceneScaleAgainstAvatar(config: RuntimeConfig): void {
    if (!this.worldModel) return;

    if (Number.isFinite(config.sceneScaleOverride) && config.sceneScaleOverride > 0) {
      this.worldModel.scale.multiplyScalar(config.sceneScaleOverride);
      this.centerModelOnGround(this.worldModel);
      return;
    }

    this.tmpBox.setFromObject(this.worldModel);
    const worldSize = this.tmpBox.getSize(this.tmpSize);
    const worldSpan = Math.max(0.001, Math.min(worldSize.x, worldSize.z));
    const targetWorldSpan = this.avatarHeight * clamp(config.sceneSpanAvatars, 4, 200);
    const autoScale = clamp(targetWorldSpan / worldSpan, 0.001, 1000);

    this.worldModel.scale.multiplyScalar(autoScale);
    this.centerModelOnGround(this.worldModel);
  }

  private refreshWorldBounds(): void {
    if (!this.worldModel) return;
    this.tmpBox.setFromObject(this.worldModel);
    this.worldTopRayY = this.tmpBox.max.y + this.avatarHeight * 2 + 5;
    this.terrainCeilingY = this.tmpBox.min.y + (this.tmpBox.max.y - this.tmpBox.min.y) * 0.85;
  }

  private classifyFirstPersonHeadMeshes(model: THREE.Object3D): void {
    this.firstPersonHiddenMeshes.length = 0;

    const headNameRegex = /(head|face|hair|eye|brow|lash|teeth|tongue|glasses|hat|neck)/i;
    const rootX = this.avatarRoot.position.x;
    const rootZ = this.avatarRoot.position.z;
    this.getEyeAnchorWorldPosition(this.tmpEyeWorld, 0);
    const eyeYWorld = this.tmpEyeWorld.y;
    const headFloorYWorld = this.avatarRoot.position.y + this.avatarMinLocalY + this.avatarHeight * 0.58;
    const maxHeadHeight = this.avatarHeight * 0.6;
    const maxHeadRadius = this.avatarHeight * 0.42;

    model.traverse((obj) => {
      if (!isThreeMesh(obj)) return;

      this.tmpBox.setFromObject(obj);
      this.tmpBox.getCenter(this.tmpCenter);
      this.tmpBox.getSize(this.tmpSize);
      const byName = headNameRegex.test(obj.name);
      const horizontalFromRoot = Math.hypot(this.tmpCenter.x - rootX, this.tmpCenter.z - rootZ);
      const byBounds =
        this.tmpBox.max.y >= eyeYWorld - this.avatarHeight * 0.02 &&
        this.tmpBox.min.y >= headFloorYWorld &&
        this.tmpSize.y <= maxHeadHeight &&
        horizontalFromRoot <= maxHeadRadius;
      const byHeadRegion =
        this.tmpCenter.y >= eyeYWorld - this.avatarHeight * 0.03 &&
        this.tmpBox.max.y >= eyeYWorld &&
        this.tmpSize.y <= this.avatarHeight * 1.2 &&
        horizontalFromRoot <= maxHeadRadius * 1.3;
      const byContainsEye =
        this.tmpBox.containsPoint(this.tmpEyeWorld) &&
        this.tmpSize.y <= this.avatarHeight * 1.25 &&
        horizontalFromRoot <= maxHeadRadius * 1.6;

      if (byName || byBounds || byHeadRegion || byContainsEye) {
        this.firstPersonHiddenMeshes.push(obj);
      }
    });
  }

  private setFirstPersonHeadVisible(visible: boolean): void {
    for (const mesh of this.firstPersonHiddenMeshes) {
      mesh.visible = visible;
    }
  }

  private collectAvatarMaterials(model: THREE.Object3D): void {
    this.avatarMaterials.length = 0;
    const materialSet = new Set<THREE.Material>();
    model.traverse((obj) => {
      if (!isThreeMesh(obj)) return;
      const meshMaterial = obj.material;
      if (Array.isArray(meshMaterial)) {
        for (const material of meshMaterial) {
          if (material) materialSet.add(material);
        }
        return;
      }
      if (meshMaterial) materialSet.add(meshMaterial);
    });
    this.avatarMaterials.push(...materialSet);
  }

  private disableAvatarFrustumCulling(model: THREE.Object3D): void {
    model.traverse((obj) => {
      if (isThreeMesh(obj)) {
        obj.frustumCulled = false;
      }
    });
  }

  private setDesktopFirstPersonAvatarClip(enabled: boolean): void {
    if (!enabled) {
      for (const material of this.avatarMaterials) {
        const original = this.avatarMaterialClippingBackup.get(material);
        material.clippingPlanes = original ?? null;
        material.needsUpdate = true;
      }
      if (this.renderer.clippingPlanes.length === 0) {
        this.renderer.localClippingEnabled = false;
      }
      return;
    }

    this.renderer.localClippingEnabled = true;
    for (const material of this.avatarMaterials) {
      if (!this.avatarMaterialClippingBackup.has(material)) {
        this.avatarMaterialClippingBackup.set(material, material.clippingPlanes ? [...material.clippingPlanes] : null);
      }
      this.tmpVecA.set(
        this.avatarRoot.position.x,
        this.avatarRoot.position.y + this.avatarEyeLocalY - this.avatarHeight * 0.06,
        this.avatarRoot.position.z
      );
      // In first-person, clip upper-body geometry near the camera (head/neck/collar)
      // to avoid inside-mesh artifacts when looking down while keeping lower body visible.
      this.avatarClipPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, -1, 0), this.tmpVecA);
      material.clippingPlanes = [this.avatarClipPlane];
      material.needsUpdate = true;
    }
  }

  private resolveCrouchRig(): void {
    this.crouchRigReady = false;
    this.lastCrouchAmount = -1;
    this.crouchHips = undefined;
    this.crouchSpine.length = 0;
    this.crouchUpperLegs.length = 0;
    this.crouchLowerLegs.length = 0;
    this.crouchFeet.length = 0;
    this.crouchLeftFoot = undefined;
    this.crouchRightFoot = undefined;

    const hips = this.bone('hips');
    const spine = this.bone('spine');
    const chest = this.bone('chest');
    const upperChest = this.bone('upperChest');
    const leftUpLeg = this.bone('leftUpperLeg');
    const leftLeg = this.bone('leftLowerLeg');
    const rightUpLeg = this.bone('rightUpperLeg');
    const rightLeg = this.bone('rightLowerLeg');
    const leftFoot = this.bone('leftFoot');
    const rightFoot = this.bone('rightFoot');

    if (!hips || !spine || !leftUpLeg || !leftLeg || !rightUpLeg || !rightLeg) {
      this.humanoid?.disableFeature('crouch', 'needs hips, spine and both upper and lower legs');
      return;
    }

    this.crouchHips = {
      ...this.createCrouchBinding(hips, 12, 1),
      bindPosition: hips.position.clone(),
      ...this.crouchHipsOffsetAxes(hips)
    };
    // The shipped rig bends 16°/13°/10° over spine, chest and upper chest; a
    // shorter spine takes the whole 39° over the bones it has.
    const spineBones = [spine, chest, upperChest].filter((b): b is THREE.Bone => b !== undefined);
    const spinePitch = spineBones.length === 3 ? [16, 13, 10] : spineBones.length === 2 ? [21, 18] : [39];
    spineBones.forEach((bone, i) => this.crouchSpine.push(this.createCrouchBinding(bone, spinePitch[i]!, 1)));
    this.crouchUpperLegs.push(this.createCrouchBinding(leftUpLeg, 68, -1), this.createCrouchBinding(rightUpLeg, 68, -1));
    this.crouchLowerLegs.push(this.createCrouchBinding(leftLeg, -110, -1), this.createCrouchBinding(rightLeg, -110, -1));
    this.crouchLeftFoot = leftFoot;
    this.crouchRightFoot = rightFoot;
    if (leftFoot && rightFoot) {
      this.crouchFeet.push(
        this.createCrouchBinding(leftFoot, CROUCH_FOOT_PITCH_DEG, -1),
        this.createCrouchBinding(rightFoot, CROUCH_FOOT_PITCH_DEG, -1)
      );
    }
    this.crouchRigReady = true;
  }

  /**
   * Pitch axis in the bone's local frame: the avatar's lateral axis (+X, its
   * left, once facing is normalized) times `lateralSign`. The shipped rig
   * pitched every bone about local X, which is +lateral on the hips and spine
   * and −lateral on the legs and feet; the signs keep that. A local axis within
   * 10° of the wanted one is used as is, so the shipped rig's pose is unchanged.
   */
  private createCrouchBinding(bone: THREE.Bone, fullPitchDeg: number, lateralSign: 1 | -1): CrouchBoneBinding {
    const avatarQuat = this.canonicalFrameQuaternion();
    const wanted = new THREE.Vector3(lateralSign, 0, 0).applyQuaternion(avatarQuat);
    const toLocal = bone.getWorldQuaternion(new THREE.Quaternion()).invert();
    const axis = wanted.applyQuaternion(toLocal).normalize();
    const nearest = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]
      .map((a) => a.multiplyScalar(Math.sign(a.dot(axis)) || 1))
      .find((a) => a.dot(axis) > Math.cos(THREE.MathUtils.degToRad(10)));
    return {
      bone,
      bindQuaternion: bone.quaternion.clone(),
      fullPitchRad: THREE.MathUtils.degToRad(fullPitchDeg),
      axis: nearest ?? axis
    };
  }

  /**
   * World rotation of the avatar's +Z-forward, +Y-up frame: the avatar node
   * itself, since the facing correction sits on a child (`HumanoidFacing`)
   * whose own frame is still the file's.
   */
  private canonicalFrameQuaternion(): THREE.Quaternion {
    return this.avatar?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion();
  }

  /** Avatar-space down and back in the hips' parent frame, so the crouch drop holds for any armature orientation. */
  private crouchHipsOffsetAxes(hips: THREE.Bone): Pick<CrouchHipsBinding, 'downInParent' | 'backInParent'> {
    const avatarQuat = this.canonicalFrameQuaternion();
    const toParent = hips.parent?.getWorldQuaternion(new THREE.Quaternion()).invert() ?? new THREE.Quaternion();
    const inParent = (v: THREE.Vector3) => v.applyQuaternion(avatarQuat).applyQuaternion(toParent).normalize();
    return { downInParent: inParent(new THREE.Vector3(0, -1, 0)), backInParent: inParent(new THREE.Vector3(0, 0, -1)) };
  }

  private applyCrouchBoneRotation(binding: CrouchBoneBinding, crouchAmount: number): void {
    if (Math.abs(crouchAmount) <= CROUCH_POSE_EPSILON) {
      return;
    }
    this.tmpCrouchQuat.setFromAxisAngle(binding.axis, binding.fullPitchRad * crouchAmount);
    binding.bone.quaternion.multiply(this.tmpCrouchQuat).normalize();
  }

  private applyCrouchFootGroundCompensation(crouchAmount: number, walkBlend: number, squat: number): void {
    if (!this.crouchHips || !this.worldModel) return;
    if (crouchAmount <= 0.01) return;
    if (!this.crouchLeftFoot && !this.crouchRightFoot) return;

    const walkClearanceBoost = this.avatarHeight * CROUCH_WALK_EXTRA_GROUND_CLEARANCE_RATIO * clamp(walkBlend, 0, 1);
    const minClearance = this.avatarHeight * CROUCH_FOOT_GROUND_CLEARANCE_RATIO + walkClearanceBoost;
    // A squat keeps its hips low: the leg solver plants the feet instead.
    const maxLift = this.avatarHeight * CROUCH_MAX_HIPS_LIFT_RATIO * (1 - squat);
    let requiredLift = 0;

    if (this.crouchLeftFoot) {
      this.crouchLeftFoot.getWorldPosition(this.tmpLeftFootWorld);
      const leftGroundY = this.sampleStableTerrainYAt(this.tmpLeftFootWorld.x, this.tmpLeftFootWorld.z, this.crouchGroundRaycaster);
      if (leftGroundY !== undefined) {
        requiredLift = Math.max(requiredLift, leftGroundY + minClearance - this.tmpLeftFootWorld.y);
      }
    }

    if (this.crouchRightFoot) {
      this.crouchRightFoot.getWorldPosition(this.tmpRightFootWorld);
      const rightGroundY = this.sampleStableTerrainYAt(this.tmpRightFootWorld.x, this.tmpRightFootWorld.z, this.crouchGroundRaycaster);
      if (rightGroundY !== undefined) {
        requiredLift = Math.max(requiredLift, rightGroundY + minClearance - this.tmpRightFootWorld.y);
      }
    }

    if (requiredLift <= 1e-5) return;
    const parentScale = this.crouchHips.bone.parent?.getWorldScale(this.tmpSize).y ?? 1;
    this.crouchHips.bone.position.addScaledVector(this.crouchHips.downInParent, -Math.min(requiredLift, maxLift) / Math.max(1e-8, Math.abs(parentScale)));
    this.crouchHips.bone.updateMatrixWorld(true);
  }

  private sampleStableTerrainYAt(x: number, z: number, raycaster: THREE.Raycaster): number | undefined {
    const sampleRadius = Math.max(0.001, this.avatarHeight * CROUCH_GROUND_SAMPLE_RADIUS_RATIO);
    let bestY: number | undefined;
    for (const [offsetX, offsetZ] of CROUCH_GROUND_SAMPLE_OFFSETS) {
      const y = this.sampleTerrainYAt(x + offsetX * sampleRadius, z + offsetZ * sampleRadius, raycaster);
      if (y === undefined) continue;
      if (bestY === undefined || y > bestY) {
        bestY = y;
      }
    }
    return bestY;
  }

  private resolveHeadAndEyes(): void {
    this.headBone = this.bone('head');
    // Eye meshes are not anchors: skinned eye meshes sit at the armature origin.
    this.leftEyeAnchor = this.bone('leftEye') ?? this.estimateEyeAnchor('left');
    this.rightEyeAnchor = this.bone('rightEye') ?? this.estimateEyeAnchor('right');
  }

  /**
   * Rigs without eye bones (Mixamo downloads, the Unreal mannequin, Biped) get
   * an anchor on the head where the shipped rig's eye sits, scaled by the
   * hips-to-head length, so the camera and body solver still have eyes.
   */
  private estimateEyeAnchor(side: VrHandSide): THREE.Object3D | undefined {
    const head = this.bone('head');
    const hips = this.bone('hips');
    if (!head || !hips) return undefined;
    const hipsToHead = head.getWorldPosition(new THREE.Vector3()).distanceTo(hips.getWorldPosition(new THREE.Vector3()));
    const offset = new THREE.Vector3(...EYE_FROM_HEAD_PER_HIPS_TO_HEAD).multiplyScalar(hipsToHead);
    if (side === 'right') offset.x = -offset.x;
    const eyeWorld = offset.applyQuaternion(this.canonicalFrameQuaternion()).add(head.getWorldPosition(new THREE.Vector3()));
    const anchor = new THREE.Object3D();
    anchor.name = `${side}EyeEstimate`;
    head.add(anchor);
    anchor.position.copy(head.worldToLocal(eyeWorld));
    anchor.updateMatrixWorld(true);
    this.humanoid?.note(`${side} eye estimated on the head: no eye bone`);
    return anchor;
  }

  private toBindAimInParent(bone: THREE.Bone, childWorldPosition: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 | undefined {
    if (!bone.parent) return undefined;
    // Own scratch: callers pass tmpVecA as childWorldPosition, which once made
    // this direction zero and fell back to the parent segment's axis.
    bone.getWorldPosition(this.tmpBindBoneWorld);
    out.subVectors(childWorldPosition, this.tmpBindBoneWorld);
    if (out.lengthSq() < 1e-8) return undefined;
    out.normalize();
    bone.parent.getWorldQuaternion(this.tmpParentWorldQuat);
    out.applyQuaternion(this.tmpInvQuat.copy(this.tmpParentWorldQuat).invert());
    out.normalize();
    return out.lengthSq() < 1e-8 ? undefined : out;
  }
}
