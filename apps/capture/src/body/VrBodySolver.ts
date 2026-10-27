import * as THREE from 'three';
import type { VrmHumanoidBone } from '@holoim/meaning';

import type { AvatarRig } from '../avatar/AvatarRig';
import { clamp } from '../shared/math';
import { solveTwoBoneLeg } from './legIk';

// Drives the avatar's whole body from the tracked head while the user moves
// physically in VR: where the body stands (root), which way it faces (body
// yaw), where each foot is planted and when it steps, and the pelvis, spine,
// neck, and head pose that put the avatar's eyes on the user's eyes. Runs
// after the locomotion mixer and before arm IK, and owns every bone it writes.
//
// Distances scale with the avatar's leg length so a different avatar keeps the
// same proportions of lean, step, and stance.

export type BodyFault =
  | 'root-ignores-head'
  | 'body-yaw-snaps'
  | 'feet-glued-to-root'
  | 'pelvis-ignores-crouch'
  | 'no-spine-lean'
  | 'head-not-rotated'
  | 'root-overshoots'
  | 'feet-float'
  | 'pelvis-jitter'
  | 'rig-follows-avatar'
  | 'feet-cross'
  | 'fidget-steps';

export interface BodyHeadInput {
  worldPosition: THREE.Vector3;
  worldQuaternion: THREE.Quaternion;
  yaw: number;
}

export type GroundSampler = (x: number, z: number, outNormal: THREE.Vector3) => number | undefined;

interface BindBone {
  bone: THREE.Bone;
  local: THREE.Quaternion;
  // Position and rotation in avatarRoot space at bind (avatar faces +Z).
  rootPosition: THREE.Vector3;
  rootQuaternion: THREE.Quaternion;
}

interface LegBind {
  side: 'left' | 'right';
  upLeg: BindBone;
  leg: BindBone;
  foot: BindBone;
  toe: BindBone | undefined;
  thighLength: number;
  shinLength: number;
  // Bind ankle position on the floor, in avatarRoot space.
  slotLocal: THREE.Vector3;
  // Bind distance from the ankle forward to the ball of the foot.
  toeForward: number;
}

interface FootState {
  planted: THREE.Vector3;
  normal: THREE.Vector3;
  yaw: number;
  swinging: boolean;
  from: THREE.Vector3;
  to: THREE.Vector3;
  toNormal: THREE.Vector3;
  fromYaw: number;
  toYaw: number;
  t: number;
  duration: number;
  lift: number;
  // Walking steps re-aim every frame toward a landing this many seconds of
  // body motion ahead of the moving slot; corrective steps aim at the slot.
  landLeadSec: number;
  walking: boolean;
  current: THREE.Vector3;
  currentNormal: THREE.Vector3;
  currentYaw: number;
  // Signed roll: heel up (positive) or toes up (negative), rate-limited.
  roll: number;
  // How close the planted leg came to running out of reach last frame
  // (0 flat foot … 1 fully rolled or overstretched).
  strain: number;
}

export interface BodySolverDebug {
  aligned: boolean;
  translating: boolean;
  turning: boolean;
  bodyYaw: number;
  steps: number;
  feet: Record<'left' | 'right', { swinging: boolean; planted: [number, number, number] }>;
}

export interface BodyDimensions {
  legLength: number;
  ankleHeight: number;
  toeHeight: number;
  toeForward: number;
  eyeHeight: number;
  hipHeight: number;
  stanceWidth: number;
}

// Neck: the head may turn this far from the body before the body follows,
// and never further than the hard limit.
// Once triggered, the body turns until it nearly faces the head again, so a
// later glance inside the deadzone leaves it alone.
const NECK_DEADZONE_RAD = THREE.MathUtils.degToRad(40);
const NECK_RELEASE_RAD = THREE.MathUtils.degToRad(3);
const NECK_LIMIT_RAD = THREE.MathUtils.degToRad(70);
const BODY_TURN_TIME_SEC = 0.22;
const BODY_WALK_TURN_TIME_SEC = 0.25;
// Head speed (EMA) that reads as walking rather than leaning or swaying.
// Leans move the head at up to ~0.5 m/s, so walking needs more speed and an
// upright head (a lean pivots the head down).
const TRANSLATE_ON_SPEED = 0.55;
const TRANSLATE_OFF_SPEED = 0.3;
const TRANSLATE_MAX_DROP_METERS = 0.03;
const TRANSLATE_RELEASE_DROP_METERS = 0.06;
const HEAD_SPEED_TIME_SEC = 0.1;
const ROOT_CATCH_UP_TIME_SEC = 0.25;
const ROOT_SETTLE_TIME_SEC = 0.6;
// Lean allowance around the root, in leg lengths (forward, back, side).
const LEAN_FORWARD = 0.32;
const LEAN_BACK = 0.15;
const LEAN_SIDE = 0.18;
const SETTLE_RADIUS = 0.15;
// Head offset from the root that a standing body keeps without leaning.
const LEAN_BASE_METERS = 0.04;
// Head drop below standing that still counts as standing upright.
const UPRIGHT_DROP_METERS = 0.01;
const STANDING_RECOVERY_PER_SEC = 0.2;
const NEUTRAL_HEAD_STILL_SPEED = 0.1;
const TARGET_SPEED_TIME_SEC = 0.08;
// Walking bobs the head about 2 Hz; a lean is slower. Filter the drop so a
// bob does not read as a lean.
const LEAN_DROP_TIME_SEC = 0.3;
// The root may outrun the head by this much while catching up.
const CATCH_UP_EXTRA_SPEED = 0.3;
// Stepping.
const GAIT_ON_SPEED = 0.25;
const GAIT_OFF_SPEED = 0.15;
const STATIC_STEP_DISTANCE = 0.12;
const STATIC_STEP_YAW_RAD = THREE.MathUtils.degToRad(25);
const STATIC_STEP_DURATION_SEC = 0.32;
const MIN_STANCE_SEC = 0.08;
const MAX_STEP_LENGTH = 1.0;
// A swing re-aims its landing at most this fast, so velocity changes bend
// the step's path instead of snapping the foot.
const MAX_REAIM_SPEED = 1.5;
// Feet keep at least this much of the bind stance width between them, side
// to side.
const MIN_FOOT_GAP = 0.4;
const ROOT_SPEED_TIME_SEC = 0.15;
// Spine: share of the lean and of the head–body twist per bone.
const LEAN_WEIGHTS = { hips: 0.2, spine: 0.3, spine1: 0.27, spine2: 0.23 } as const;
const TWIST_WEIGHTS = { spine: 0.12, spine1: 0.12, spine2: 0.16, neck: 0.25 } as const;

interface SpineLink {
  binding: BindBone;
  lean: number;
  twist: number;
}

/** Spine, chest, upper chest with the shipped rig's shares; a missing bone's share goes to the one below it. */
function spineChain(spine: BindBone, chest: BindBone | undefined, upperChest: BindBone | undefined): SpineLink[] {
  const chain: SpineLink[] = [{ binding: spine, lean: LEAN_WEIGHTS.spine, twist: TWIST_WEIGHTS.spine }];
  for (const [binding, key] of [[chest, 'spine1'], [upperChest, 'spine2']] as const) {
    if (binding) chain.push({ binding, lean: LEAN_WEIGHTS[key], twist: TWIST_WEIGHTS[key] });
    else {
      chain.at(-1)!.lean += LEAN_WEIGHTS[key];
      chain.at(-1)!.twist += TWIST_WEIGHTS[key];
    }
  }
  return chain;
}
const NECK_HEAD_SHARE = 0.4;
const PELVIS_PASSES = 3;
const SPINE_LEAN_PASSES = 3;
const MAX_PELVIS_REACH_DROP = 0.05;
const PELVIS_REACH_DROP_TIME_SEC = 0.06;
const PELVIS_HOLD_STEP_METERS = 0.01;
// Feet tuck this far (leg lengths) above the capsule's floor level in the air.
const AIRBORNE_FOOT_TUCK = 0.08;
// Standing knee flex is capped (leg lengths); a head lower than that is a crouch.
const MAX_STANDING_KNEE_FLEX = 0.08;
// To reach a lean the pelvis may rise this far (leg lengths) above standing.
const LEAN_KNEE_STRAIGHTEN = 0.015;
// A trailing foot this far (leg lengths) from its slot steps at once, even
// mid-cadence.
const URGENT_STEP_DISTANCE = 0.4;
// Feet roll (heel up about the toe, or toe up about the heel) at most this far
// when the planted ankle is out of the leg's reach.
const MAX_FOOT_ROLL_RAD = THREE.MathUtils.degToRad(50);
const FOOT_ROLL_RATE_RAD = THREE.MathUtils.degToRad(400);
// A planted foot rolled this far toward its reach limit steps.
const STRAIN_STEP = 0.6;
// A swing lasts long enough that the foot averages at most this speed (peak
// about 1.7×, near human swing speeds).
const MAX_MEAN_SWING_SPEED = 3.0;

const UP = new THREE.Vector3(0, 1, 0);

function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

// Horizontal swing progress: the foot lifts before it travels and settles
// after, which keeps toe-off and landing from scuffing.
function swingProgress(t: number): number {
  const u = clamp((t - 0.05) / 0.9, 0, 1);
  return u * u * (3 - 2 * u);
}

function swingHeight(t: number): number {
  return Math.sin(Math.PI * t);
}

export class VrBodySolver {
  readonly faults = new Set<BodyFault>();

  private readonly hipsBindPosition = new THREE.Vector3();
  private airborne = false;
  private bind: {
    hips: BindBone;
    spine: BindBone;
    /** Spine bones above the hips with their lean and twist shares (chest and upper chest are optional). */
    spineChain: SpineLink[];
    neck: BindBone;
    head: BindBone;
    legs: Record<'left' | 'right', LegBind>;
    eyeMid: THREE.Vector3;
    eyeInHead: THREE.Vector3;
    hipsToHead: number;
    groundLocalY: number;
    dims: BodyDimensions;
  } | undefined;

  private aligned = false;
  private bodyYawValue = 0;
  private turning = false;
  private translating = false;
  private gaitActive = false;
  private gaitSteps = 0;
  private nextGaitSide: 'left' | 'right' = 'left';
  private sinceLastStepStart = 0;
  private sinceLastLanding = 0;
  private stepCount = 0;
  private headSpeed = 0;
  private pelvisReachDrop = 0;
  private leanDrop = 0;
  private lastDt = 1 / 60;
  private standingHeadHeight = 0;
  // The user's standing eye height above the ground, raised only while the
  // head is still, so a walking bob does not straighten the avatar's knees.
  private neutralHeadHeight = 0;
  private hipsToEyes = 0.6;
  private faultTime = 0;
  private readonly rootTarget = new THREE.Vector3();
  private readonly prevRootTarget = new THREE.Vector3();
  private readonly root = new THREE.Vector3();
  private readonly prevRoot = new THREE.Vector3();
  private readonly rootVelocity = new THREE.Vector3();
  private readonly targetVelocity = new THREE.Vector3();
  private readonly gaitVelocity = new THREE.Vector3();
  private readonly rootOvershootVelocity = new THREE.Vector3();
  private readonly prevHead = new THREE.Vector3();
  private readonly feet: Record<'left' | 'right', FootState>;

  // Scratch, one set per stage so stages never share a vector.
  private readonly planA = new THREE.Vector3();
  private readonly planB = new THREE.Vector3();
  private readonly planQuat = new THREE.Quaternion();
  private readonly stepSlot = new THREE.Vector3();
  private readonly stepTarget = new THREE.Vector3();
  private readonly stepOther = new THREE.Vector3();
  private readonly stepNormal = new THREE.Vector3();
  private readonly aimTarget = new THREE.Vector3();
  private readonly footBall = new THREE.Vector3();
  private readonly footBallNormal = new THREE.Vector3();
  private readonly aimNormal = new THREE.Vector3();
  private readonly stepQuat = new THREE.Quaternion();
  private readonly poseRootPos = new THREE.Vector3();
  private readonly poseRootQuat = new THREE.Quaternion();
  private readonly poseHeadQuat = new THREE.Quaternion();
  private readonly poseHeadTarget = new THREE.Vector3();
  private readonly poseHipsStanding = new THREE.Vector3();
  private readonly poseHips = new THREE.Vector3();
  private readonly poseVecA = new THREE.Vector3();
  private readonly poseVecB = new THREE.Vector3();
  private readonly poseVecC = new THREE.Vector3();
  private readonly poseQuatA = new THREE.Quaternion();
  private readonly poseQuatB = new THREE.Quaternion();
  private readonly poseQuatC = new THREE.Quaternion();
  private readonly poseQuatD = new THREE.Quaternion();
  private readonly poseForward = new THREE.Vector3();
  private readonly legAnkle = new THREE.Vector3();
  private readonly legPole = new THREE.Vector3();
  private readonly legQuat = new THREE.Quaternion();
  private readonly legTilt = new THREE.Quaternion();
  private readonly legRoll = new THREE.Quaternion();
  private readonly legForward = new THREE.Vector3();
  private readonly legRight = new THREE.Vector3();
  private readonly legHip = new THREE.Vector3();
  private readonly legVec = new THREE.Vector3();
  private readonly legPivot = new THREE.Vector3();
  private readonly legLever = new THREE.Vector3();

  constructor(private readonly avatarRig: AvatarRig, private readonly forwardOffset: number) {
    const foot = (): FootState => ({
      planted: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 1, 0),
      yaw: 0,
      swinging: false,
      from: new THREE.Vector3(),
      to: new THREE.Vector3(),
      toNormal: new THREE.Vector3(0, 1, 0),
      fromYaw: 0,
      toYaw: 0,
      t: 0,
      duration: STATIC_STEP_DURATION_SEC,
      lift: 0,
      landLeadSec: 0,
      walking: false,
      current: new THREE.Vector3(),
      currentNormal: new THREE.Vector3(0, 1, 0),
      currentYaw: 0,
      roll: 0,
      strain: 0
    });
    this.feet = { left: foot(), right: foot() };
  }

  get bodyYaw(): number {
    return this.bodyYawValue;
  }

  get isAligned(): boolean {
    return this.aligned;
  }

  get dimensions(): BodyDimensions | undefined {
    return this.bind?.dims;
  }

  // Measures the rig at its bind pose. Call once after the avatar loads and
  // before any animation runs. Returns false when bones are missing.
  measureBindPose(): boolean {
    const rig = this.avatarRig;
    const avatarRoot = rig.avatarRoot;
    avatarRoot.updateMatrixWorld(true);
    const rootQuatInv = avatarRoot.getWorldQuaternion(new THREE.Quaternion()).invert();
    const bindBone = (name: VrmHumanoidBone): BindBone | undefined => {
      const bone = rig.bone(name);
      if (!bone) return undefined;
      return {
        bone,
        local: bone.quaternion.clone(),
        rootPosition: avatarRoot.worldToLocal(bone.getWorldPosition(new THREE.Vector3())),
        rootQuaternion: rootQuatInv.clone().multiply(bone.getWorldQuaternion(new THREE.Quaternion()))
      };
    };
    const hips = bindBone('hips');
    if (hips) this.hipsBindPosition.copy(hips.bone.position);
    const spine = bindBone('spine');
    const chest = bindBone('chest');
    const upperChest = bindBone('upperChest');
    const neck = bindBone('neck');
    const head = bindBone('head');
    const leftEye = rig.leftEyeAnchor;
    const rightEye = rig.rightEyeAnchor;
    if (!hips || !spine || !neck || !head || !leftEye || !rightEye) return false;

    const leg = (side: 'left' | 'right'): LegBind | undefined => {
      const upLeg = bindBone(`${side}UpperLeg`);
      const lowerLeg = bindBone(`${side}LowerLeg`);
      const foot = bindBone(`${side}Foot`);
      const toe = bindBone(`${side}Toes`);
      if (!upLeg || !lowerLeg || !foot) return undefined;
      return {
        side,
        upLeg,
        leg: lowerLeg,
        foot,
        toe,
        thighLength: upLeg.rootPosition.distanceTo(lowerLeg.rootPosition),
        shinLength: lowerLeg.rootPosition.distanceTo(foot.rootPosition),
        slotLocal: new THREE.Vector3(foot.rootPosition.x, 0, foot.rootPosition.z),
        toeForward: toe ? Math.max(0.02, toe.rootPosition.z - foot.rootPosition.z) : 0.12
      };
    };
    const left = leg('left');
    const right = leg('right');
    if (!left || !right) return false;

    const eyeMid = avatarRoot
      .worldToLocal(leftEye.getWorldPosition(new THREE.Vector3()))
      .add(avatarRoot.worldToLocal(rightEye.getWorldPosition(new THREE.Vector3())))
      .multiplyScalar(0.5);
    const groundLocalY = rig.avatarMinLocalY;
    const sole = (bone: BindBone | undefined) => (bone ? bone.rootPosition.y - groundLocalY : 0);
    const legLength = (left.thighLength + left.shinLength + right.thighLength + right.shinLength) / 2;
    this.bind = {
      hips,
      spine,
      spineChain: spineChain(spine, chest, upperChest),
      neck,
      head,
      legs: { left, right },
      eyeMid,
      eyeInHead: eyeMid.clone().sub(head.rootPosition).applyQuaternion(head.rootQuaternion.clone().invert()),
      hipsToHead: hips.rootPosition.distanceTo(head.rootPosition),
      groundLocalY,
      dims: {
        legLength,
        ankleHeight: (sole(left.foot) + sole(right.foot)) / 2,
        toeHeight: (sole(left.toe) + sole(right.toe)) / 2,
        toeForward: (left.toeForward + right.toeForward) / 2,
        eyeHeight: eyeMid.y - groundLocalY,
        hipHeight: (left.upLeg.rootPosition.y + right.upLeg.rootPosition.y) / 2 - groundLocalY,
        stanceWidth: Math.abs(left.slotLocal.x - right.slotLocal.x)
      }
    };
    return true;
  }

  // Standing eye position (straight legs, on the real ground) for the root at
  // `rootPosition` facing `yaw`: the rig maps the user's eyes here, so the
  // camera sits at the user's real eye height above the floor.
  getStandingEyeWorld(rootPosition: THREE.Vector3, yaw: number, ground: GroundSampler, out: THREE.Vector3): THREE.Vector3 {
    const bind = this.bind;
    if (!bind) return out.copy(rootPosition);
    this.planQuat.setFromAxisAngle(UP, yaw + this.forwardOffset);
    out.copy(bind.eyeMid).applyQuaternion(this.planQuat).add(rootPosition);
    out.y = this.groundUnder(rootPosition, ground) + bind.dims.eyeHeight;
    return out;
  }

  private groundUnder(rootPosition: THREE.Vector3, ground: GroundSampler): number {
    const at = this.planB.set(rootPosition.x, 0, rootPosition.z);
    this.groundAt(at, this.stepNormal, ground, rootPosition.y + this.bind!.groundLocalY);
    return at.y;
  }

  // Starts tracking from the current pose: the body faces the head, and the
  // feet stand in their bind slots around the root.
  align(head: BodyHeadInput, rootPosition: THREE.Vector3, ground: GroundSampler): void {
    this.bodyYawValue = head.yaw;
    this.root.copy(rootPosition);
    this.prevRoot.copy(rootPosition);
    this.rootTarget.copy(rootPosition);
    this.prevRootTarget.copy(rootPosition);
    this.prevHead.copy(head.worldPosition);
    this.rootVelocity.set(0, 0, 0);
    this.targetVelocity.set(0, 0, 0);
    this.rootOvershootVelocity.set(0, 0, 0);
    const bindDims = this.bind!.dims;
    this.hipsToEyes = bindDims.eyeHeight - bindDims.hipHeight;
    this.standingHeadHeight = head.worldPosition.y - this.groundUnder(rootPosition, ground);
    this.neutralHeadHeight = this.standingHeadHeight;
    this.headSpeed = 0;
    this.turning = false;
    this.translating = false;
    this.gaitActive = false;
    this.sinceLastStepStart = 0;
    this.sinceLastLanding = 0;
    this.airborne = false;
    for (const side of ['left', 'right'] as const) {
      const foot = this.feet[side];
      this.slotWorld(side, rootPosition, this.bodyYawValue, foot.planted);
      this.footGroundAt(foot.planted, this.bodyYawValue, foot.normal, ground, rootPosition.y + this.bind!.groundLocalY, this.bind!.legs[side].toeForward);
      foot.yaw = this.bodyYawValue;
      foot.swinging = false;
      foot.current.copy(foot.planted);
      foot.currentNormal.copy(foot.normal);
      foot.currentYaw = foot.yaw;
    }
    this.aligned = true;
  }

  reset(): void {
    this.aligned = false;
    this.stepCount = 0;
  }

  // The avatar was uniformly rescaled by `ratio` about its node's origin (XR
  // height fit): scale every measurement taken in avatarRoot space to match.
  // Bone-local positions and all rotations are unchanged by the scale.
  rescale(ratio: number): void {
    const bind = this.bind;
    const origin = this.avatarRig.avatar?.position;
    if (!bind || !origin || !Number.isFinite(ratio) || ratio <= 0 || ratio === 1) return;
    const about = (point: THREE.Vector3) => point.sub(origin).multiplyScalar(ratio).add(origin);
    const bones = [bind.hips, ...bind.spineChain.map((l) => l.binding), bind.neck, bind.head];
    for (const side of ['left', 'right'] as const) {
      const leg = bind.legs[side];
      bones.push(leg.upLeg, leg.leg, leg.foot);
      if (leg.toe) bones.push(leg.toe);
      leg.thighLength *= ratio;
      leg.shinLength *= ratio;
      leg.toeForward *= ratio;
      leg.slotLocal.x = origin.x + (leg.slotLocal.x - origin.x) * ratio;
      leg.slotLocal.z = origin.z + (leg.slotLocal.z - origin.z) * ratio;
    }
    for (const bone of bones) about(bone.rootPosition);
    about(bind.eyeMid);
    bind.eyeInHead.multiplyScalar(ratio);
    bind.hipsToHead *= ratio;
    bind.groundLocalY = this.avatarRig.avatarMinLocalY;
    for (const key of Object.keys(bind.dims) as (keyof BodyDimensions)[]) bind.dims[key] *= ratio;
  }

  // Hands the skeleton back to the animation path: every bone the solver
  // writes returns to its bind pose (the hips also to their bind position).
  restoreBindPose(): void {
    const bind = this.bind;
    if (!bind) return;
    for (const bone of [bind.hips, ...bind.spineChain.map((l) => l.binding), bind.neck, bind.head]) bone.bone.quaternion.copy(bone.local);
    bind.hips.bone.position.copy(this.hipsBindPosition);
    for (const side of ['left', 'right'] as const) {
      const leg = bind.legs[side];
      for (const bone of [leg.upLeg, leg.leg, leg.foot, leg.toe]) bone?.bone.quaternion.copy(bone.local);
    }
    this.avatarRig.avatar?.updateMatrixWorld(true);
  }

  // Before physics: turns the body and returns where the root should move
  // (horizontal displacement) so the body stays under the head.
  planRoot(head: BodyHeadInput, rootPosition: THREE.Vector3, deltaSec: number, ground: GroundSampler, outDisplacement: THREE.Vector3): THREE.Vector3 {
    outDisplacement.set(0, 0, 0);
    if (!this.bind || !this.aligned || deltaSec <= 0) return outDisplacement;
    const dt = deltaSec;
    this.faultTime += dt;

    const headStep = this.planA.subVectors(head.worldPosition, this.prevHead).setY(0);
    this.prevHead.copy(head.worldPosition);
    const instantSpeed = headStep.length() / dt;
    this.headSpeed += (instantSpeed - this.headSpeed) * (1 - Math.exp(-dt / HEAD_SPEED_TIME_SEC));

    // How far the head has dropped below standing tells a lean (the torso
    // pivots at the hips, so the head comes down) from a step (it does not).
    const headHeight = head.worldPosition.y - this.groundUnder(rootPosition, ground);
    if (headHeight > this.standingHeadHeight) {
      this.standingHeadHeight = Math.min(headHeight, this.standingHeadHeight + STANDING_RECOVERY_PER_SEC * dt);
    }
    if (headHeight > this.neutralHeadHeight && this.headSpeed < NEUTRAL_HEAD_STILL_SPEED) {
      this.neutralHeadHeight = Math.min(headHeight, this.neutralHeadHeight + STANDING_RECOVERY_PER_SEC * dt);
    }
    const drop = Math.max(0, this.standingHeadHeight - headHeight);
    if (!this.translating && this.headSpeed > TRANSLATE_ON_SPEED && drop < TRANSLATE_MAX_DROP_METERS) this.translating = true;
    else if (this.translating && (this.headSpeed < TRANSLATE_OFF_SPEED || drop > TRANSLATE_RELEASE_DROP_METERS)) this.translating = false;
    this.updateBodyYaw(head.yaw, dt);

    // Where the root would stand for an upright body under this head.
    const leg = this.bind.dims.legLength;
    this.planQuat.setFromAxisAngle(UP, this.bodyYawValue + this.forwardOffset);
    const eyeOverRoot = this.planB.set(this.bind.eyeMid.x, 0, this.bind.eyeMid.z).applyQuaternion(this.planQuat);
    this.prevRootTarget.copy(this.rootTarget);
    this.rootTarget.set(head.worldPosition.x - eyeOverRoot.x, rootPosition.y, head.worldPosition.z - eyeOverRoot.z);
    const targetStep = this.planB.subVectors(this.rootTarget, this.prevRootTarget).setY(0).multiplyScalar(1 / dt);
    this.targetVelocity.lerp(targetStep, 1 - Math.exp(-dt / TARGET_SPEED_TIME_SEC));

    this.leanDrop += (drop - this.leanDrop) * (1 - Math.exp(-dt / LEAN_DROP_TIME_SEC));
    const spine = this.hipsToEyes;
    // Fault: the root chases every head sway (no lean allowance).
    const leanReach = this.faults.has('fidget-steps') ? 0.005 : LEAN_BASE_METERS + Math.sqrt(Math.max(0, spine * spine - Math.max(0, spine - this.leanDrop) ** 2));

    this.root.set(rootPosition.x, rootPosition.y, rootPosition.z);
    const next = this.planA.copy(this.root);
    if (this.faults.has('root-ignores-head')) return outDisplacement;
    if (this.faults.has('root-overshoots')) {
      // Underdamped spring: a classic follow bug that swings past the target.
      const k = 60;
      const c = 4;
      this.rootOvershootVelocity.x += ((this.rootTarget.x - next.x) * k - this.rootOvershootVelocity.x * c) * dt;
      this.rootOvershootVelocity.z += ((this.rootTarget.z - next.z) * k - this.rootOvershootVelocity.z * c) * dt;
      next.x += this.rootOvershootVelocity.x * dt;
      next.z += this.rootOvershootVelocity.z * dt;
      return outDisplacement.subVectors(next, this.root).setY(0);
    }

    if (this.translating) {
      // Move with the head, and close the remaining gap exponentially so the
      // root never passes the target.
      next.x += this.rootTarget.x - this.prevRootTarget.x;
      next.z += this.rootTarget.z - this.prevRootTarget.z;
      const k = 1 - Math.exp(-dt / ROOT_CATCH_UP_TIME_SEC);
      const headMoveX = next.x - this.root.x;
      const headMoveZ = next.z - this.root.z;
      let catchX = (this.rootTarget.x - next.x) * k;
      let catchZ = (this.rootTarget.z - next.z) * k;
      const catchLength = Math.hypot(catchX, catchZ);
      const maxCatch = CATCH_UP_EXTRA_SPEED * dt;
      if (catchLength > maxCatch) {
        catchX *= maxCatch / catchLength;
        catchZ *= maxCatch / catchLength;
      }
      next.x = this.root.x + headMoveX + catchX;
      next.z = this.root.z + headMoveZ + catchZ;
    } else if (drop < UPRIGHT_DROP_METERS) {
      // Upright and slow: drift the root back under the head (after a walk
      // or a step); a held lean or crouch keeps its offset.
      const gap = Math.hypot(this.rootTarget.x - next.x, this.rootTarget.z - next.z);
      if (gap < SETTLE_RADIUS * leg) {
        const k = 1 - Math.exp(-dt / ROOT_SETTLE_TIME_SEC);
        next.x += (this.rootTarget.x - next.x) * k;
        next.z += (this.rootTarget.z - next.z) * k;
      }
    }

    // Leash: the head may lean only so far from the root before it drags it.
    const forwardX = -Math.sin(this.bodyYawValue);
    const forwardZ = -Math.cos(this.bodyYawValue);
    const offX = this.rootTarget.x - next.x;
    const offZ = this.rootTarget.z - next.z;
    const along = offX * forwardX + offZ * forwardZ;
    const across = offX * -forwardZ + offZ * forwardX;
    const limitAlong = Math.min((along >= 0 ? LEAN_FORWARD : LEAN_BACK) * leg, leanReach);
    const limitAcross = Math.min(LEAN_SIDE * leg, leanReach);
    const excess = Math.hypot(along / limitAlong, across / limitAcross);
    if (excess > 1) {
      const keep = 1 / excess;
      const clampedAlong = along * keep;
      const clampedAcross = across * keep;
      next.x = this.rootTarget.x - (clampedAlong * forwardX + clampedAcross * -forwardZ);
      next.z = this.rootTarget.z - (clampedAlong * forwardZ + clampedAcross * forwardX);
    }
    return outDisplacement.subVectors(next, this.root).setY(0);
  }

  // After physics: plants and steps the feet around the new root and poses the
  // pelvis, spine, neck, head, and legs.
  // grounded: whether the physics capsule stands on the ground. In the air
  // (a jump) the feet leave their plants and the pelvis rides the capsule.
  solve(head: BodyHeadInput, rootPosition: THREE.Vector3, deltaSec: number, ground: GroundSampler, embodyOffset: number, grounded = true): void {
    const bind = this.bind;
    if (!bind || !this.aligned) return;
    const dt = Math.max(deltaSec, 1e-4);
    this.lastDt = dt;
    const velocityStep = this.planA.subVectors(rootPosition, this.prevRoot).setY(0).multiplyScalar(1 / dt);
    this.prevRoot.copy(rootPosition);
    this.rootVelocity.lerp(velocityStep, 1 - Math.exp(-dt / ROOT_SPEED_TIME_SEC));
    const landed = this.airborne && grounded;
    this.airborne = !grounded;
    if (this.airborne || landed) this.placeFeetUnderRoot(rootPosition, ground, this.airborne);
    else this.updateFeet(rootPosition, dt, ground);
    this.solvePose(head, rootPosition, ground, embodyOffset);
  }

  getDebugSnapshot(): BodySolverDebug {
    const foot = (side: 'left' | 'right') => {
      const state = this.feet[side];
      return { swinging: state.swinging, planted: [state.planted.x, state.planted.y, state.planted.z] as [number, number, number] };
    };
    return {
      aligned: this.aligned,
      translating: this.translating,
      turning: this.turning,
      bodyYaw: this.bodyYawValue,
      steps: this.stepCount,
      feet: { left: foot('left'), right: foot('right') }
    };
  }

  private updateBodyYaw(headYaw: number, dt: number): void {
    if (this.faults.has('body-yaw-snaps')) {
      this.bodyYawValue = headYaw;
      return;
    }
    let delta = wrapAngle(headYaw - this.bodyYawValue);
    if (Math.abs(delta) > NECK_DEADZONE_RAD) this.turning = true;
    if (this.translating) {
      this.bodyYawValue += delta * (1 - Math.exp(-dt / BODY_WALK_TURN_TIME_SEC));
    } else if (this.turning) {
      this.bodyYawValue += delta * (1 - Math.exp(-dt / BODY_TURN_TIME_SEC));
    }
    delta = wrapAngle(headYaw - this.bodyYawValue);
    if (Math.abs(delta) > NECK_LIMIT_RAD) {
      this.bodyYawValue = wrapAngle(headYaw - Math.sign(delta) * NECK_LIMIT_RAD);
      delta = Math.sign(delta) * NECK_LIMIT_RAD;
    }
    if (Math.abs(delta) < NECK_RELEASE_RAD) this.turning = false;
    this.bodyYawValue = wrapAngle(this.bodyYawValue);
  }

  private slotWorld(side: 'left' | 'right', rootPosition: THREE.Vector3, yaw: number, out: THREE.Vector3): THREE.Vector3 {
    this.stepQuat.setFromAxisAngle(UP, yaw + this.forwardOffset);
    out.copy(this.bind!.legs[side].slotLocal);
    if (this.faults.has('feet-cross')) out.x = -out.x;
    return out.applyQuaternion(this.stepQuat).add(rootPosition);
  }

  // Sets out.y to the real ground surface (the terrain helper reports 1 cm
  // above it) and the surface normal; falls back to the root's height.
  private groundAt(out: THREE.Vector3, outNormal: THREE.Vector3, ground: GroundSampler, fallbackY: number): void {
    const y = ground(out.x, out.z, outNormal);
    // A surface far above or below the body (a ledge, an overhang) is not
    // where this foot can stand; keep it level with the root instead.
    const reach = 0.5 * (this.bind?.dims.legLength ?? 0.9);
    if (y === undefined || Math.abs(y - 0.01 - fallbackY) > reach) {
      out.y = fallbackY;
      outNormal.set(0, 1, 0);
      return;
    }
    out.y = y - 0.01;
  }

  // Airborne: feet hang in their slots a little above the capsule's floor
  // level; on landing they plant there on the ground.
  private placeFeetUnderRoot(rootPosition: THREE.Vector3, ground: GroundSampler, inAir: boolean): void {
    const bind = this.bind!;
    for (const side of ['left', 'right'] as const) {
      const foot = this.feet[side];
      this.slotWorld(side, rootPosition, this.bodyYawValue, foot.planted);
      if (inAir) {
        foot.planted.y = rootPosition.y + bind.groundLocalY + AIRBORNE_FOOT_TUCK * bind.dims.legLength;
        foot.normal.set(0, 1, 0);
      } else {
        this.footGroundAt(foot.planted, this.bodyYawValue, foot.normal, ground, rootPosition.y + bind.groundLocalY, bind.legs[side].toeForward);
        this.sinceLastLanding = 0;
      }
      foot.yaw = this.bodyYawValue;
      foot.swinging = false;
      foot.roll = 0;
      foot.current.copy(foot.planted);
      foot.currentNormal.copy(foot.normal);
      foot.currentYaw = foot.yaw;
    }
  }

  private updateFeet(rootPosition: THREE.Vector3, dt: number, ground: GroundSampler): void {
    const bind = this.bind!;
    const leg = bind.dims.legLength;
    this.sinceLastStepStart += dt;
    this.sinceLastLanding += dt;

    for (const side of ['left', 'right'] as const) {
      const foot = this.feet[side];
      if (this.faults.has('feet-glued-to-root')) {
        this.slotWorld(side, rootPosition, this.bodyYawValue, foot.planted);
        this.groundAt(foot.planted, foot.normal, ground, rootPosition.y + this.bind!.groundLocalY);
        foot.yaw = this.bodyYawValue;
        foot.swinging = false;
      }
      if (!foot.swinging) {
        foot.current.copy(foot.planted);
        foot.currentNormal.copy(foot.normal);
        foot.currentYaw = foot.yaw;
        continue;
      }
      foot.t = Math.min(1, foot.t + dt / foot.duration);
      // Re-aim the landing as the body moves, so a step started while
      // accelerating still lands where the gait needs it.
      if (foot.t < 0.85) {
        const lead = foot.walking ? (1 - foot.t) * foot.duration + foot.landLeadSec : 0;
        const aim = this.stepTargetFor(side, rootPosition, this.gaitVelocity, lead, ground, this.aimTarget, this.aimNormal, foot.walking);
        const shift = aim.distanceTo(foot.to);
        const allowed = MAX_REAIM_SPEED * dt;
        foot.to.lerp(aim, shift > allowed ? allowed / shift : 1);
        foot.toNormal.copy(this.aimNormal);
        foot.toYaw = this.bodyYawValue;
      }
      const s = swingProgress(foot.t);
      foot.current.lerpVectors(foot.from, foot.to, s);
      foot.current.y = THREE.MathUtils.lerp(foot.from.y, foot.to.y, s) + foot.lift * swingHeight(foot.t);
      foot.currentNormal.lerpVectors(foot.normal, foot.toNormal, s).normalize();
      foot.currentYaw = foot.fromYaw + wrapAngle(foot.toYaw - foot.fromYaw) * s;
      if (foot.t >= 1) {
        foot.swinging = false;
        foot.planted.copy(foot.to);
        foot.normal.copy(foot.toNormal);
        foot.yaw = foot.toYaw;
        foot.current.copy(foot.planted);
        foot.currentYaw = foot.yaw;
        this.sinceLastLanding = 0;
      }
    }
    if (this.faults.has('feet-glued-to-root')) return;
    if (this.feet.left.swinging || this.feet.right.swinging) return;

    // Walking follows the head's motion; otherwise the root's own motion
    // (dragged by a lean or a small step) drives the feet.
    const gaitVelocity = this.translating ? this.targetVelocity : this.rootVelocity;
    this.gaitVelocity.copy(gaitVelocity);
    const speed = gaitVelocity.length();
    if (!this.gaitActive && speed > GAIT_ON_SPEED) {
      this.gaitActive = true;
      this.gaitSteps = 0;
    } else if (this.gaitActive && speed < GAIT_OFF_SPEED) {
      this.gaitActive = false;
    }

    if (this.gaitActive) {
      // Walking: alternate feet at a speed-dependent cadence; each foot lands
      // as far ahead of its moving slot as it will end up behind it at
      // lift-off, so a planted foot never needs to slide.
      // Steps per second rise with speed (about 2.2/s at 1.2 m/s); each swing
      // takes 80% of a step, 40% of the gait cycle, as in human walking.
      const cadence = clamp(1.6 + 0.5 * speed, 1.6, 2.6);
      const period = 1 / cadence;
      if (this.sinceLastLanding < MIN_STANCE_SEC * 0.5) return;
      let side = this.nextGaitSide;
      let urgent = false;
      // Urgent only for a foot left behind, never one planted ahead.
      for (const candidate of ['left', 'right'] as const) {
        const slot = this.slotWorld(candidate, rootPosition, this.bodyYawValue, this.stepSlot);
        const planted = this.feet[candidate].planted;
        const behind = ((slot.x - planted.x) * gaitVelocity.x + (slot.z - planted.z) * gaitVelocity.z) / Math.max(speed, 1e-6);
        if (behind > URGENT_STEP_DISTANCE * leg || this.feet[candidate].strain >= 1) {
          side = candidate;
          urgent = true;
        }
      }
      if (!urgent && this.sinceLastStepStart < period * (this.gaitSteps < 2 ? 0.7 : 1)) return;
      // Land slightly short of symmetric: the trailing foot has more reach
      // (heel roll) than the leading one.
      // The first steps from standing are quicker, as the body accelerates.
      const starting = this.gaitSteps < 2 ? 0.7 : 1;
      const duration = period * 0.8 * starting;
      this.startStep(side, rootPosition, 0.85 * (period - duration / 2), duration, true, ground);
      this.gaitSteps += 1;
      this.nextGaitSide = side === 'left' ? 'right' : 'left';
      return;
    }

    // Standing: step only when a foot has drifted out of its slot or is
    // turned too far from the body.
    if (this.sinceLastLanding < MIN_STANCE_SEC) return;
    let worst: 'left' | 'right' | undefined;
    let worstScore = 1;
    for (const side of ['left', 'right'] as const) {
      const foot = this.feet[side];
      const slot = this.slotWorld(side, rootPosition, this.bodyYawValue, this.stepSlot);
      const distance = Math.hypot(slot.x - foot.planted.x, slot.z - foot.planted.z);
      const yawError = Math.abs(wrapAngle(foot.yaw - this.bodyYawValue));
      const stepDistance = STATIC_STEP_DISTANCE * leg * (this.faults.has('fidget-steps') ? 0.1 : 1);
      // Feet that hold the pelvis below the eyes square up, the further one
      // from its slot first.
      const holdingDown = this.pelvisReachDrop > PELVIS_HOLD_STEP_METERS ? 1 + distance / leg : 0;
      const strained = Math.max(foot.strain > STRAIN_STEP ? 1 + foot.strain : 0, holdingDown);
      const score = Math.max(distance / stepDistance, yawError / STATIC_STEP_YAW_RAD, strained);
      if (score > worstScore) {
        worstScore = score;
        worst = side;
      }
    }
    if (worst) {
      // Side steps lead with the foot on the side of travel, so the other
      // foot never has to pass it.
      const leading = this.leadingSideFor(rootPosition);
      if (leading && leading !== worst) {
        const slot = this.slotWorld(leading, rootPosition, this.bodyYawValue, this.stepSlot);
        const planted = this.feet[leading].planted;
        if (Math.hypot(slot.x - planted.x, slot.z - planted.z) > 0.5 * STATIC_STEP_DISTANCE * leg) worst = leading;
      }
      this.startStep(worst, rootPosition, 0, STATIC_STEP_DURATION_SEC, false, ground);
      this.nextGaitSide = worst === 'left' ? 'right' : 'left';
    }
  }

  // The foot on the side the body is moving toward, when the move is mostly
  // sideways.
  private leadingSideFor(rootPosition: THREE.Vector3): 'left' | 'right' | undefined {
    const left = this.slotWorld('left', rootPosition, this.bodyYawValue, this.stepSlot);
    let moveX = left.x - this.feet.left.planted.x;
    let moveZ = left.z - this.feet.left.planted.z;
    const right = this.slotWorld('right', rootPosition, this.bodyYawValue, this.stepSlot);
    moveX += right.x - this.feet.right.planted.x;
    moveZ += right.z - this.feet.right.planted.z;
    const rightX = Math.cos(this.bodyYawValue);
    const rightZ = -Math.sin(this.bodyYawValue);
    const lateral = (moveX * rightX + moveZ * rightZ) / 2;
    const along = (moveX * -rightZ + moveZ * rightX) / 2;
    if (Math.abs(lateral) < 0.03 || Math.abs(lateral) < Math.abs(along)) return undefined;
    return lateral > 0 ? 'right' : 'left';
  }

  // Where a step should land: the foot's slot around the root, led by the
  // body's velocity, kept on its own side and within a stride of the other
  // foot, on the ground.
  private stepTargetFor(side: 'left' | 'right', rootPosition: THREE.Vector3, velocity: THREE.Vector3, leadSec: number, ground: GroundSampler, out: THREE.Vector3, outNormal: THREE.Vector3, walking = false): THREE.Vector3 {
    const bind = this.bind!;
    const leg = bind.dims.legLength;
    const otherSide = side === 'left' ? 'right' : 'left';
    const target = this.slotWorld(side, rootPosition, this.bodyYawValue, out);
    if (walking) {
      // Strides swing about the hip joints, which sit ahead of the bind
      // ankles (avatarRoot space faces +Z), so walking slots move forward.
      // Half the offset: trailing feet gain more reach from rolling than
      // leading ones.
      const ankleBehind = 0.5 * (bind.hips.rootPosition.z - bind.legs[side].slotLocal.z);
      target.x += -Math.sin(this.bodyYawValue) * ankleBehind;
      target.z += -Math.cos(this.bodyYawValue) * ankleBehind;
    }
    target.addScaledVector(velocity, leadSec);

    const rightX = Math.cos(this.bodyYawValue);
    const rightZ = -Math.sin(this.bodyYawValue);
    const lateral = (target.x - rootPosition.x) * rightX + (target.z - rootPosition.z) * rightZ;
    const minLateral = bind.dims.stanceWidth * 0.3;
    const sign = side === 'right' ? 1 : -1;
    if (lateral * sign < minLateral && !this.faults.has('feet-cross')) {
      const fix = minLateral * sign - lateral;
      target.x += rightX * fix;
      target.z += rightZ * fix;
    }
    const other = this.stepOther.copy(this.feet[otherSide].planted);
    const gap = ((target.x - other.x) * rightX + (target.z - other.z) * rightZ) * sign;
    const minGap = MIN_FOOT_GAP * bind.dims.stanceWidth;
    if (gap < minGap && !this.faults.has('feet-cross')) {
      target.x += rightX * sign * (minGap - gap);
      target.z += rightZ * sign * (minGap - gap);
    }
    const reach = Math.hypot(target.x - other.x, target.z - other.z);
    if (reach > MAX_STEP_LENGTH * leg) {
      const keep = (MAX_STEP_LENGTH * leg) / reach;
      target.x = other.x + (target.x - other.x) * keep;
      target.z = other.z + (target.z - other.z) * keep;
    }
    this.footGroundAt(target, this.bodyYawValue, outNormal, ground, rootPosition.y + bind.groundLocalY, bind.legs[side].toeForward);
    return target;
  }

  // Ground for a foot facing `yaw` with its heel at `out`: height under the
  // heel, and a surface normal pitched to meet the ground under the ball of
  // the foot too, so a foot across a slope change neither sinks nor floats.
  private footGroundAt(out: THREE.Vector3, yaw: number, outNormal: THREE.Vector3, ground: GroundSampler, fallbackY: number, toeForward: number): void {
    this.groundAt(out, outNormal, ground, fallbackY);
    const forwardX = -Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);
    const ball = this.footBall.set(out.x + forwardX * toeForward, 0, out.z + forwardZ * toeForward);
    this.groundAt(ball, this.footBallNormal, ground, out.y);
    const slope = (ball.y - out.y) / toeForward;
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    const up = Math.max(outNormal.y, 1e-3);
    const lateral = -(outNormal.x * rightX + outNormal.z * rightZ) / up;
    outNormal.set(-forwardX * slope - rightX * lateral, 1, -forwardZ * slope - rightZ * lateral).normalize();
  }

  private startStep(side: 'left' | 'right', rootPosition: THREE.Vector3, landLeadSec: number, duration: number, walking: boolean, ground: GroundSampler): void {
    const leg = this.bind!.dims.legLength;
    const foot = this.feet[side];
    const lead = walking ? duration + landLeadSec : 0;
    const target = this.stepTargetFor(side, rootPosition, this.gaitVelocity, lead, ground, this.stepTarget, this.stepNormal, walking);
    const distance = Math.hypot(target.x - foot.planted.x, target.z - foot.planted.z);
    foot.swinging = true;
    foot.walking = walking;
    foot.landLeadSec = landLeadSec;
    foot.from.copy(foot.planted);
    foot.to.copy(target);
    foot.toNormal.copy(this.stepNormal);
    foot.fromYaw = foot.yaw;
    foot.toYaw = this.bodyYawValue;
    foot.t = 0;
    foot.duration = Math.max(duration, distance / MAX_MEAN_SWING_SPEED);
    foot.lift = clamp(0.02 + 0.12 * distance, 0.02, 0.08 * leg);
    this.sinceLastStepStart = 0;
    this.stepCount += 1;
  }

  private solvePose(head: BodyHeadInput, rootPosition: THREE.Vector3, ground: GroundSampler, embodyOffset: number): void {
    const bind = this.bind!;
    const leg = bind.dims.legLength;
    const avatarRoot = this.avatarRig.avatarRoot;
    avatarRoot.updateMatrixWorld(true);
    const rootPos = this.poseRootPos.copy(rootPosition);
    const rootQuat = avatarRoot.getWorldQuaternion(this.poseRootQuat);
    const toWorld = (local: THREE.Vector3, out: THREE.Vector3) => out.copy(local).applyQuaternion(rootQuat).add(rootPos);
    // In the air the floor level moves with the capsule.
    const groundY = this.airborne ? rootPos.y + bind.groundLocalY : this.groundUnder(rootPos, ground);

    // Tracked head mapped onto the avatar head bone: the bind head rotation
    // turned by the tracked head's world rotation.
    const headQuat = this.poseHeadQuat.setFromAxisAngle(UP, this.forwardOffset).premultiply(head.worldQuaternion).multiply(bind.head.rootQuaternion);
    if (this.faults.has('head-not-rotated')) {
      headQuat.setFromAxisAngle(UP, this.bodyYawValue + this.forwardOffset).multiply(bind.head.rootQuaternion);
    }
    const headTarget = this.poseHeadTarget.copy(bind.eyeInHead).applyQuaternion(headQuat).negate().add(head.worldPosition);
    headTarget.y -= embodyOffset;

    // First guess for the pelvis: standing over the root, dropped when the
    // head comes closer than the spine is long, and shifted back as the
    // torso leans forward or the hips sink. Standing height is the user's:
    // knees flex by however much the avatar's straight-leg eyes stand above
    // the tracked standing eyes; only a lean straightens them, a little.
    const standing = toWorld(bind.hips.rootPosition, this.poseHipsStanding);
    const kneeFlex = clamp(bind.dims.eyeHeight - (this.neutralHeadHeight - embodyOffset), 0, MAX_STANDING_KNEE_FLEX * leg);
    standing.y = groundY + bind.hips.rootPosition.y - bind.groundLocalY - kneeFlex;
    const hips = this.poseHips.copy(standing);
    const forward = this.poseForward.set(-Math.sin(this.bodyYawValue), 0, -Math.cos(this.bodyYawValue));
    const toHead = this.poseVecA.subVectors(headTarget, standing);
    const forwardOffset = toHead.dot(forward);
    if (!this.faults.has('no-spine-lean')) hips.addScaledVector(forward, -0.3 * Math.max(0, forwardOffset));
    const horizontal = Math.hypot(headTarget.x - hips.x, headTarget.z - hips.z);
    const reachY = headTarget.y - Math.sqrt(Math.max(bind.hipsToHead ** 2 - horizontal ** 2, (0.25 * bind.hipsToHead) ** 2));
    hips.y = Math.min(standing.y, reachY);
    if (!this.faults.has('no-spine-lean')) hips.addScaledVector(forward, -0.25 * (standing.y - hips.y));
    if (this.faults.has('pelvis-ignores-crouch')) hips.y = standing.y;

    const twist = clamp(wrapAngle(head.yaw - this.bodyYawValue), -NECK_LIMIT_RAD, NECK_LIMIT_RAD);
    const passes = this.faults.has('pelvis-ignores-crouch') || this.faults.has('no-spine-lean') ? 1 : PELVIS_PASSES;
    for (let pass = 0; pass < passes; pass += 1) {
      this.clampPelvis(hips, standing, groundY, leg);
      this.placeHips(hips);
      this.poseSpine(headTarget, headQuat, rootQuat, twist);
      if (pass === passes - 1) break;
      const error = this.poseVecB.subVectors(headTarget, bind.head.bone.getWorldPosition(this.poseVecC));
      hips.add(error);
    }
    // Planted feet win over eye height: lower the pelvis until each planted
    // foot is within reach of its hip joint with the foot fully rolled.
    // Only a few centimetres, eased: a foot further out than that has to
    // step instead.
    const wantedDrop = this.faults.has('feet-float') || this.airborne ? 0 : clamp(this.pelvisExcessOverFeet(), 0, MAX_PELVIS_REACH_DROP * leg);
    this.pelvisReachDrop += (wantedDrop - this.pelvisReachDrop) * (1 - Math.exp(-this.lastDt / PELVIS_REACH_DROP_TIME_SEC));
    if (this.pelvisReachDrop > 1e-4) {
      hips.y -= this.pelvisReachDrop;
      this.placeHips(hips);
      this.poseSpine(headTarget, headQuat, rootQuat, twist);
    }
    if (this.faults.has('pelvis-jitter')) {
      const phase = this.faultTime * 97;
      hips.x += Math.sin(phase) * 0.012;
      hips.z += Math.cos(phase * 1.3) * 0.012;
      this.placeHips(hips);
    }

    for (const side of ['left', 'right'] as const) this.poseLeg(side, rootQuat);
    for (const side of ['left', 'right'] as const) {
      const toe = bind.legs[side].toe;
      if (toe) toe.bone.quaternion.copy(toe.local);
    }
    this.avatarRig.avatar?.updateMatrixWorld(true);
  }

  // How far the hip joints sit above where planted feet can reach them.
  private pelvisExcessOverFeet(): number {
    const bind = this.bind!;
    let excess = 0;
    for (const side of ['left', 'right'] as const) {
      const foot = this.feet[side];
      if (foot.swinging) continue;
      const legBind = bind.legs[side];
      const hip = legBind.upLeg.bone.getWorldPosition(this.legHip);
      const maxReach = (legBind.thighLength + legBind.shinLength) * 0.995;
      // Best case for this foot: rolled fully toward the hip.
      const forwardX = -Math.sin(foot.currentYaw);
      const forwardZ = -Math.cos(foot.currentYaw);
      const towardHip = Math.sign((hip.x - foot.current.x) * forwardX + (hip.z - foot.current.z) * forwardZ) || 1;
      // Heel up about the ball (trailing foot) or toes up about the heel.
      const lever = Math.hypot(bind.dims.ankleHeight, legBind.toeForward);
      const leverAngle = Math.atan2(bind.dims.ankleHeight, legBind.toeForward) + MAX_FOOT_ROLL_RAD;
      const shift = towardHip > 0 ? legBind.toeForward - lever * Math.cos(leverAngle) : bind.dims.ankleHeight * Math.sin(MAX_FOOT_ROLL_RAD);
      const rise = towardHip > 0 ? lever * Math.sin(leverAngle) : bind.dims.ankleHeight * Math.cos(MAX_FOOT_ROLL_RAD);
      const ankleX = foot.current.x + forwardX * towardHip * shift;
      const ankleZ = foot.current.z + forwardZ * towardHip * shift;
      const ankleY = foot.current.y + rise;
      const horizontal = Math.hypot(hip.x - ankleX, hip.z - ankleZ);
      if (horizontal >= maxReach) continue;
      const maxHipY = ankleY + Math.sqrt(maxReach * maxReach - horizontal * horizontal);
      excess = Math.max(excess, hip.y - maxHipY);
    }
    return excess;
  }

  private clampPelvis(hips: THREE.Vector3, standing: THREE.Vector3, groundY: number, leg: number): void {
    // Only a lean (the head pivoting down and forward) straightens the knees.
    const straighten = LEAN_KNEE_STRAIGHTEN * leg * THREE.MathUtils.smoothstep(this.leanDrop, 0.01, 0.03);
    hips.y = clamp(hips.y, groundY + 0.25 * leg, standing.y + straighten);
    const dx = hips.x - standing.x;
    const dz = hips.z - standing.z;
    const horizontal = Math.hypot(dx, dz);
    const limit = 0.5 * leg;
    if (horizontal > limit) {
      hips.x = standing.x + (dx * limit) / horizontal;
      hips.z = standing.z + (dz * limit) / horizontal;
    }
  }

  private placeHips(world: THREE.Vector3): void {
    const hips = this.bind!.hips.bone;
    hips.parent!.updateWorldMatrix(true, false);
    hips.position.copy(hips.parent!.worldToLocal(this.poseVecC.copy(world)));
  }

  private poseSpine(headTarget: THREE.Vector3, headQuat: THREE.Quaternion, rootQuat: THREE.Quaternion, twist: number): void {
    const bind = this.bind!;
    for (const bone of [bind.hips, ...bind.spineChain.map((l) => l.binding), bind.neck, bind.head]) bone.bone.quaternion.copy(bone.local);

    // Lean: rotate the bind pelvis→head axis onto the pelvis→head-target
    // direction, spread down the spine.
    const bindAxis = this.poseVecA.subVectors(bind.head.rootPosition, bind.hips.rootPosition).applyQuaternion(rootQuat).normalize();
    const desiredAxis = this.poseVecB.subVectors(headTarget, bind.hips.bone.getWorldPosition(this.poseVecC)).normalize();
    const lean = this.poseQuatA.setFromUnitVectors(bindAxis, desiredAxis);
    if (this.faults.has('no-spine-lean')) lean.identity();
    const identity = this.poseQuatD.identity();
    const delta = this.poseQuatB;
    const twistQuat = this.poseQuatC;

    // Bones above the hips pivot higher up, so one spread rotation leaves the
    // head short of the target direction; repeat with the residual.
    for (let pass = 0; pass < SPINE_LEAN_PASSES; pass += 1) {
      delta.slerpQuaternions(identity, lean, LEAN_WEIGHTS.hips);
      this.applyWorldDelta(bind.hips.bone, delta);
      for (const link of bind.spineChain) {
        delta.slerpQuaternions(identity, lean, link.lean);
        if (pass === 0) delta.multiply(twistQuat.setFromAxisAngle(UP, twist * link.twist));
        this.applyWorldDelta(link.binding.bone, delta);
      }
      if (this.faults.has('no-spine-lean')) break;
      const actualAxis = this.poseVecA.subVectors(bind.head.bone.getWorldPosition(this.poseVecC), bind.hips.bone.getWorldPosition(this.legVec)).normalize();
      lean.setFromUnitVectors(actualAxis, desiredAxis);
    }
    twistQuat.setFromAxisAngle(UP, twist * TWIST_WEIGHTS.neck);
    this.applyWorldDelta(bind.neck.bone, twistQuat);
    // The neck takes part of what remains to reach the tracked head.
    const neckWorld = bind.neck.bone.getWorldQuaternion(this.poseQuatA);
    const headWorldNow = this.poseQuatB.copy(neckWorld).multiply(bind.head.local);
    const remaining = this.poseQuatC.copy(headQuat).multiply(headWorldNow.invert());
    this.applyWorldDelta(bind.neck.bone, delta.slerpQuaternions(identity, remaining, NECK_HEAD_SHARE));
    this.setWorldQuaternion(bind.head.bone, headQuat);
  }

  private poseLeg(side: 'left' | 'right', rootQuat: THREE.Quaternion): void {
    const bind = this.bind!;
    const legBind = bind.legs[side];
    const foot = this.feet[side];
    const ankleLift = bind.dims.ankleHeight + (this.faults.has('feet-float') ? 0.04 : 0);
    const forward = this.legForward.set(-Math.sin(foot.currentYaw), 0, -Math.cos(foot.currentYaw));
    const right = this.legRight.set(Math.cos(foot.currentYaw), 0, -Math.sin(foot.currentYaw));
    // Knee points along the foot, a little outward.
    const outward = side === 'left' ? -1 : 1;
    const pole = this.legPole.copy(forward).addScaledVector(right, 0.15 * outward).normalize();

    // A planted ankle the leg cannot reach rolls the foot like a real step:
    // a trailing foot lifts its heel about the ball of the foot, a leading
    // foot lifts its toes about the heel, so the sole keeps ground contact.
    const hip = legBind.upLeg.bone.getWorldPosition(this.legHip);
    const maxReach = (legBind.thighLength + legBind.shinLength) * 0.995;
    const ankle = this.legAnkle;
    const roll = this.legRoll;
    const trailing = this.legVec.subVectors(hip, foot.current).dot(forward) > 0;
    const pivot = this.legPivot;
    const lever = this.legLever;
    // Positive roll lifts the heel about the ball; negative lifts the toes
    // about the heel.
    const rollAt = (signedAngle: number): THREE.Vector3 => {
      pivot.copy(foot.current);
      lever.copy(UP).multiplyScalar(ankleLift);
      if (signedAngle > 0) {
        // The ball of the foot, on the foot's ground plane (higher uphill).
        const rise = (-(foot.currentNormal.x * forward.x + foot.currentNormal.z * forward.z) / Math.max(foot.currentNormal.y, 1e-3)) * legBind.toeForward;
        pivot.addScaledVector(forward, legBind.toeForward);
        pivot.y += rise;
        lever.addScaledVector(forward, -legBind.toeForward);
        lever.y -= rise;
      }
      roll.setFromAxisAngle(right, -signedAngle);
      return ankle.copy(lever).applyQuaternion(roll).add(pivot);
    };
    let wanted = 0;
    if (rollAt(0).distanceTo(hip) > maxReach && !this.faults.has('feet-float')) {
      const sign = trailing ? 1 : -1;
      let low = 0;
      let high = MAX_FOOT_ROLL_RAD;
      for (let i = 0; i < 12; i += 1) {
        const mid = (low + high) / 2;
        if (rollAt(sign * mid).distanceTo(hip) > maxReach) low = mid;
        else high = mid;
      }
      wanted = sign * high;
    }
    // Ease into and out of a roll; changing pivots passes through flat.
    const maxChange = FOOT_ROLL_RATE_RAD * this.lastDt;
    foot.roll += clamp(wanted - foot.roll, -maxChange, maxChange);
    rollAt(foot.roll);
    foot.strain = foot.swinging ? 0 : ankle.distanceTo(hip) > maxReach * 1.001 ? 1 : Math.abs(wanted) / MAX_FOOT_ROLL_RAD;
    solveTwoBoneLeg(legBind, ankle, pole, rootQuat);

    // Foot: bind orientation turned to the foot's yaw, rolled, and tilted to
    // the ground.
    const footQuat = this.legQuat.setFromAxisAngle(UP, foot.currentYaw - this.bodyYawValue).multiply(rootQuat).multiply(legBind.foot.rootQuaternion);
    footQuat.premultiply(roll);
    const tilt = this.legTilt.setFromUnitVectors(UP, foot.currentNormal);
    footQuat.premultiply(tilt);
    this.setWorldQuaternion(legBind.foot.bone, footQuat);
  }

  private applyWorldDelta(bone: THREE.Bone, delta: THREE.Quaternion): void {
    const parentWorld = bone.parent!.getWorldQuaternion(this.planQuat);
    // local' = parent⁻¹ · delta · parent · local
    bone.quaternion.premultiply(parentWorld).premultiply(delta).premultiply(parentWorld.invert()).normalize();
  }

  private setWorldQuaternion(bone: THREE.Bone, world: THREE.Quaternion): void {
    const parentWorld = bone.parent!.getWorldQuaternion(this.planQuat);
    bone.quaternion.copy(parentWorld.invert()).multiply(world).normalize();
  }
}
