import * as THREE from 'three';

import { isThreeBone, isThreeMesh } from '../shared/threeTypeGuards';
import type { RuntimeConfig } from '../config/runtimeConfig';
import type { TrackedHandJointName, VrHandSide } from '../types/contracts';
import { palmFrameQuaternion } from '../xr/palmFrame';
import { clamp } from '../shared/math';

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
  boneSuffix: string;
  xrQuaternionSources: HandFingerRetargetEntry['xrQuaternionSources'];
  xrSourceJointNames: readonly TrackedHandJointName[];
  xrTargetJointNames: readonly TrackedHandJointName[];
};

// Each finger bone starts at a WebXR joint and must aim along the tracked
// segment that starts at that same joint: Hand<Finger>1 (proximal phalanx,
// from the knuckle) follows phalanx-proximal → phalanx-intermediate, and so on.
// The metacarpal segment has no avatar bone; the hand bone covers it.
function fingerRetargetMappings(finger: 'index' | 'middle' | 'ring' | 'pinky'): FingerRetargetMapping[] {
  const joint = (name: string) => `${finger}-finger-${name}` as TrackedHandJointName;
  const metacarpal = joint('metacarpal');
  const proximal = joint('phalanx-proximal');
  const intermediate = joint('phalanx-intermediate');
  const distal = joint('phalanx-distal');
  const tip = joint('tip');
  const bone = `Hand${finger[0]!.toUpperCase()}${finger.slice(1)}`;
  return [
    {
      finger,
      segmentIndex: 0,
      boneSuffix: `${bone}1`,
      xrQuaternionSources: [{ jointName: proximal, parentJointNames: [metacarpal, 'wrist'] }],
      xrSourceJointNames: [proximal],
      xrTargetJointNames: [intermediate, distal, tip]
    },
    {
      finger,
      segmentIndex: 1,
      boneSuffix: `${bone}2`,
      xrQuaternionSources: [{ jointName: intermediate, parentJointNames: [proximal, metacarpal] }],
      xrSourceJointNames: [intermediate],
      xrTargetJointNames: [distal, tip]
    },
    {
      finger,
      segmentIndex: 2,
      boneSuffix: `${bone}3`,
      xrQuaternionSources: [{ jointName: distal, parentJointNames: [intermediate, proximal] }],
      xrSourceJointNames: [distal],
      xrTargetJointNames: [tip]
    },
    {
      finger,
      segmentIndex: 3,
      boneSuffix: `${bone}4`,
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
}

interface CrouchHipsBinding extends CrouchBoneBinding {
  bindPosition: THREE.Vector3;
}

const CROUCH_POSE_EPSILON = 1e-4;
const CROUCH_MAX_POSE_AMOUNT = 1.45;
const CROUCH_FOOT_GROUND_CLEARANCE_RATIO = 0.015;
const CROUCH_MAX_HIPS_LIFT_RATIO = 0.16;
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
  private readonly localXAxis = new THREE.Vector3(1, 0, 0);
  private readonly crouchGroundRaycaster = new THREE.Raycaster();
  private readonly tmpLeftFootWorld = new THREE.Vector3();
  private readonly tmpRightFootWorld = new THREE.Vector3();

  constructor(private readonly scene: THREE.Scene, private readonly worldGroup: THREE.Group, private readonly renderer: THREE.WebGLRenderer) {
    this.worldGroup.add(this.avatarRoot);
  }

  applyLoadedModels(worldModel: THREE.Object3D, avatar: THREE.Object3D, config: RuntimeConfig): void {
    this.worldModel = worldModel;
    this.worldGroup.add(worldModel);
    this.centerModelOnGround(worldModel);

    this.avatar = avatar;
    this.avatarRoot.add(avatar);
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
      if (
        Number.isFinite(this.tmpVecA.x) &&
        Number.isFinite(this.tmpVecA.y) &&
        Number.isFinite(this.tmpVecA.z) &&
        Number.isFinite(this.tmpVecB.x) &&
        Number.isFinite(this.tmpVecB.y) &&
        Number.isFinite(this.tmpVecB.z)
      ) {
        out.copy(this.tmpVecA).add(this.tmpVecB).multiplyScalar(0.5);
        out.y += embodyOffset;
        return out;
      }
    }

    if (this.headBone) {
      this.headBone.getWorldPosition(out);
      if (Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z)) {
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

  applyCrouchPose(amount: number, horizontalSpeed = 0): void {
    const clampedAmount = clamp(amount, 0, CROUCH_MAX_POSE_AMOUNT);
    if (!this.crouchRigReady || !this.crouchHips) return;
    const amountChanged = Math.abs(clampedAmount - this.lastCrouchAmount) > CROUCH_POSE_EPSILON;
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
    const hipsAmount = Math.pow(clampedAmount, 0.9) * hipsPoseWeight;
    const legAmount = Math.pow(clampedAmount, 0.72) * legPoseWeight;
    const spineAmount = Math.pow(clampedAmount, 0.78);
    const footAmount = Math.pow(clampedAmount, 0.9) * footPoseWeight;

    this.crouchHips.bone.position.copy(this.crouchHips.bindPosition);
    // Bone translations use parent-local units; avatarHeight is world meters.
    const parentScale = this.crouchHips.bone.parent?.getWorldScale(this.tmpSize).y ?? 1;
    const heightInParent = this.avatarHeight / Math.max(1e-8, Math.abs(parentScale));
    this.crouchHips.bone.position.y -= heightInParent * 0.11 * hipsAmount;
    this.crouchHips.bone.position.z -= heightInParent * 0.045 * hipsAmount;
    this.applyCrouchBoneRotation(this.crouchHips, hipsAmount);
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

    this.applyCrouchFootGroundCompensation(clampedAmount, walkBlend);
  }

  getHandBoneWorldPosition(side: VrHandSide, out: THREE.Vector3): THREE.Vector3 | undefined {
    const handName = side === 'left' ? 'LeftHand' : 'RightHand';
    const hand = this.avatar?.getObjectByName(handName);
    if (!isThreeBone(hand)) return undefined;
    hand.getWorldPosition(out);
    if (!Number.isFinite(out.x) || !Number.isFinite(out.y) || !Number.isFinite(out.z)) {
      return undefined;
    }
    return out;
  }

  getBoneWorldPosition(name: string, out: THREE.Vector3): THREE.Vector3 | undefined {
    const bone = this.findAvatarBone(name);
    if (!bone) return undefined;
    bone.getWorldPosition(out);
    return Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z) ? out : undefined;
  }

  getBoneLocalQuaternion(name: string, out: THREE.Quaternion): THREE.Quaternion | undefined {
    const bone = this.findAvatarBone(name);
    if (!bone) return undefined;
    out.copy(bone.quaternion);
    if (!Number.isFinite(out.x) || !Number.isFinite(out.y) || !Number.isFinite(out.z) || !Number.isFinite(out.w)) {
      return undefined;
    }
    return out;
  }

  private computePalmInHand(side: VrHandSide, hand: THREE.Bone): THREE.Quaternion | undefined {
    const prefix = side === 'left' ? 'Left' : 'Right';
    const knuckle = (finger: string) => this.findAvatarBone(`${prefix}Hand${finger}1`)?.getWorldPosition(new THREE.Vector3());
    const index = knuckle('Index');
    const middle = knuckle('Middle');
    const pinky = knuckle('Pinky');
    if (!index || !middle || !pinky) return undefined;
    const palmWorld = palmFrameQuaternion(hand.getWorldPosition(new THREE.Vector3()), index, middle, pinky, new THREE.Quaternion());
    if (!palmWorld) return undefined;
    // palmInHand = inverse(handWorld) × palmWorld, captured at bind pose.
    return hand.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(palmWorld).normalize();
  }

  createArmIkChain(side: VrHandSide): ArmIkChain | undefined {
    const shoulder = this.findAvatarBone(side === 'left' ? 'LeftShoulder' : 'RightShoulder');
    const upperArm = this.findAvatarBone(side === 'left' ? 'LeftArm' : 'RightArm');
    const foreArm = this.findAvatarBone(side === 'left' ? 'LeftForeArm' : 'RightForeArm');
    const hand = this.findAvatarBone(side === 'left' ? 'LeftHand' : 'RightHand');
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

    const upperBindQuaternion = upperArm.quaternion.clone();
    const foreBindQuaternion = foreArm.quaternion.clone();
    const handBindQuaternion = hand.quaternion.clone();

    const upperBindAimInParent = new THREE.Vector3();
    const foreBindAimInParent = new THREE.Vector3();
    if (!this.toBindAimInParent(upperArm, this.tmpForeWorld, upperBindAimInParent)) return undefined;
    if (!this.toBindAimInParent(foreArm, this.tmpHandWorld, foreBindAimInParent)) return undefined;

    const palmInHand = this.computePalmInHand(side, hand);
    const sideTwist = side === 'left' ? -Math.PI * 0.5 : Math.PI * 0.5;
    const handGripRotationOffset = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(-Math.PI * 0.5, sideTwist, Math.PI, 'XYZ'))
      .multiply(handBindQuaternion.clone().invert());

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
      handGripRotationOffset,
      palmInHand,
      elbowHintLocal: new THREE.Vector3(side === 'left' ? 1 : -1, -0.05, 0.25).normalize()
    };
  }

  createHandFingerRetargetChain(side: VrHandSide): HandFingerRetargetChain | undefined {
    const sidePrefix = side === 'left' ? 'Left' : 'Right';
    const mappings: Array<{
      finger: HandFingerName;
      segmentIndex: number;
      boneSuffix: string;
      xrQuaternionSources: HandFingerRetargetEntry['xrQuaternionSources'];
      xrSourceJointNames: readonly TrackedHandJointName[];
      xrTargetJointNames: readonly TrackedHandJointName[];
    }> = [
      {
        finger: 'thumb',
        segmentIndex: 0,
        boneSuffix: 'HandThumb1',
        xrQuaternionSources: [{ jointName: 'thumb-metacarpal', parentJointNames: ['wrist'] }],
        xrSourceJointNames: ['thumb-metacarpal', 'wrist'],
        xrTargetJointNames: ['thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip']
      },
      {
        finger: 'thumb',
        segmentIndex: 1,
        boneSuffix: 'HandThumb2',
        xrQuaternionSources: [{ jointName: 'thumb-phalanx-proximal', parentJointNames: ['thumb-metacarpal', 'wrist'] }],
        xrSourceJointNames: ['thumb-phalanx-proximal', 'thumb-metacarpal', 'wrist'],
        xrTargetJointNames: ['thumb-phalanx-distal', 'thumb-tip']
      },
      {
        finger: 'thumb',
        segmentIndex: 2,
        boneSuffix: 'HandThumb3',
        xrQuaternionSources: [{ jointName: 'thumb-phalanx-distal', parentJointNames: ['thumb-phalanx-proximal', 'thumb-metacarpal'] }],
        xrSourceJointNames: ['thumb-phalanx-distal', 'thumb-phalanx-proximal'],
        xrTargetJointNames: ['thumb-tip']
      },
      {
        finger: 'thumb',
        segmentIndex: 3,
        boneSuffix: 'HandThumb4',
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
      const bone = this.findAvatarBone(`${sidePrefix}${mapping.boneSuffix}`);
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

  sampleTerrainYAt(x: number, z: number, raycaster: THREE.Raycaster): number | undefined {
    if (!this.worldModel) return undefined;
    this.tmpVecA.set(x, this.worldTopRayY, z);
    raycaster.set(this.tmpVecA, new THREE.Vector3(0, -1, 0));
    const hits = raycaster.intersectObject(this.worldModel, true);
    for (const hit of hits) {
      if (!hit.face) continue;
      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      if (normal.y > 0.2 && hit.point.y <= this.terrainCeilingY) {
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

    const hips = this.findAvatarBoneAny(['Hips', 'hips', 'mixamorigHips']);
    const spine = this.findAvatarBoneAny(['Spine', 'spine', 'mixamorigSpine']);
    const spine1 = this.findAvatarBoneAny(['Spine1', 'spine1', 'mixamorigSpine1']);
    const spine2 = this.findAvatarBoneAny(['Spine2', 'spine2', 'mixamorigSpine2']);
    const leftUpLeg = this.findAvatarBoneAny(['LeftUpLeg', 'leftUpLeg', 'mixamorigLeftUpLeg']);
    const leftLeg = this.findAvatarBoneAny(['LeftLeg', 'leftLeg', 'mixamorigLeftLeg']);
    const rightUpLeg = this.findAvatarBoneAny(['RightUpLeg', 'rightUpLeg', 'mixamorigRightUpLeg']);
    const rightLeg = this.findAvatarBoneAny(['RightLeg', 'rightLeg', 'mixamorigRightLeg']);
    const leftFoot = this.findAvatarBoneAny(['LeftFoot', 'leftFoot', 'mixamorigLeftFoot']);
    const rightFoot = this.findAvatarBoneAny(['RightFoot', 'rightFoot', 'mixamorigRightFoot']);

    if (!hips || !spine || !spine1 || !spine2 || !leftUpLeg || !leftLeg || !rightUpLeg || !rightLeg) {
      if (!this.crouchWarningLogged) {
        console.warn('Crouch pose disabled: expected hips/spine/leg bones were not found on avatar rig.');
        this.crouchWarningLogged = true;
      }
      return;
    }

    this.crouchHips = {
      bone: hips,
      bindQuaternion: hips.quaternion.clone(),
      bindPosition: hips.position.clone(),
      fullPitchRad: THREE.MathUtils.degToRad(12)
    };
    this.crouchSpine.push(
      this.createCrouchBinding(spine, 16),
      this.createCrouchBinding(spine1, 13),
      this.createCrouchBinding(spine2, 10)
    );
    this.crouchUpperLegs.push(this.createCrouchBinding(leftUpLeg, 68), this.createCrouchBinding(rightUpLeg, 68));
    this.crouchLowerLegs.push(this.createCrouchBinding(leftLeg, -110), this.createCrouchBinding(rightLeg, -110));
    this.crouchLeftFoot = leftFoot;
    this.crouchRightFoot = rightFoot;
    if (leftFoot && rightFoot) {
      this.crouchFeet.push(
        this.createCrouchBinding(leftFoot, CROUCH_FOOT_PITCH_DEG),
        this.createCrouchBinding(rightFoot, CROUCH_FOOT_PITCH_DEG)
      );
    }
    this.crouchRigReady = true;
  }

  private createCrouchBinding(bone: THREE.Bone, fullPitchDeg: number): CrouchBoneBinding {
    return {
      bone,
      bindQuaternion: bone.quaternion.clone(),
      fullPitchRad: THREE.MathUtils.degToRad(fullPitchDeg)
    };
  }

  private applyCrouchBoneRotation(binding: CrouchBoneBinding, crouchAmount: number): void {
    if (Math.abs(crouchAmount) <= CROUCH_POSE_EPSILON) {
      binding.bone.quaternion.copy(binding.bindQuaternion);
      return;
    }
    this.tmpCrouchQuat.setFromAxisAngle(this.localXAxis, binding.fullPitchRad * crouchAmount);
    binding.bone.quaternion.copy(binding.bindQuaternion).multiply(this.tmpCrouchQuat).normalize();
  }

  private applyCrouchFootGroundCompensation(crouchAmount: number, walkBlend: number): void {
    if (!this.crouchHips || !this.worldModel) return;
    if (crouchAmount <= 0.01) return;
    if (!this.crouchLeftFoot && !this.crouchRightFoot) return;

    const walkClearanceBoost = this.avatarHeight * CROUCH_WALK_EXTRA_GROUND_CLEARANCE_RATIO * clamp(walkBlend, 0, 1);
    const minClearance = this.avatarHeight * CROUCH_FOOT_GROUND_CLEARANCE_RATIO + walkClearanceBoost;
    const maxLift = this.avatarHeight * CROUCH_MAX_HIPS_LIFT_RATIO;
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
    this.crouchHips.bone.position.y += Math.min(requiredLift, maxLift) / Math.max(1e-8, Math.abs(parentScale));
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

  private findAvatarBone(name: string): THREE.Bone | undefined {
    if (!this.avatar) return undefined;
    const found = this.avatar.getObjectByName(name);
    return isThreeBone(found) ? found : undefined;
  }

  private findAvatarBoneAny(names: readonly string[]): THREE.Bone | undefined {
    for (const name of names) {
      const bone = this.findAvatarBone(name);
      if (bone) return bone;
    }
    return undefined;
  }

  private resolveHeadAndEyes(): void {
    this.headBone =
      this.findAvatarBone('Head') ??
      this.findAvatarBone('head') ??
      this.findAvatarBone('Wolf3D_Head') ??
      this.findAvatarBone('mixamorigHead');

    this.leftEyeAnchor = this.findEyeAnchorAny(['LeftEye', 'EyeLeft', 'leftEye']);
    this.rightEyeAnchor = this.findEyeAnchorAny(['RightEye', 'EyeRight', 'rightEye']);
  }

  private findEyeAnchorAny(names: readonly string[]): THREE.Object3D | undefined {
    if (!this.avatar) return undefined;
    for (const name of names) {
      const candidate = this.avatar.getObjectByName(name);
      if (!candidate) continue;
      // Some GLBs expose eyes as skinned meshes whose object transform sits at
      // armature origin. Those are not valid anchors for camera placement.
      if (isThreeMesh(candidate)) continue;
      return candidate;
    }
    return undefined;
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
