import * as THREE from 'three';
import type { VrmHumanoidBone } from '@holoim/meaning';

import type { AvatarRig } from '../avatar/AvatarRig';
import { sampleWalkTrajectory, type WalkTrajectory } from '../animation/LocomotionAnimator';
import { clamp } from '../shared/math';
import { LEG_SOFT_REACH_START, solveTwoBoneLeg } from './legIk';

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
  /** The head in tracking space: its motion there is the user's own (room scale), not the stick's. */
  localPosition?: THREE.Vector3;
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
  // A walking step on the recorded walk's clock and shape: it lifts at
  // startPhase and lands span later (clip phase).
  recorded: boolean;
  startPhase: number;
  span: number;
  // The clock passed this foot's lift while the other foot was in the air.
  pendingLift: boolean;
  // The recorded walk's foot pitch this frame (radians, heel up positive).
  recordedRoll: number;
  // A recorded swing's heel lift (roll) at lift-off.
  liftRoll: number;
}

export interface BodySolverDebug {
  aligned: boolean;
  translating: boolean;
  turning: boolean;
  bodyYaw: number;
  steps: number;
  // Steps laid on the recorded walk (a subset of steps).
  recordedSteps: number;
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
// A recorded stride may reach further: the clip's feet stand about 1.04 legs
// apart at double support, and a walk that starts slow and lands short
// regains its stride in one step instead of staying short.
const RECORDED_MAX_STEP_LENGTH = 1.2;
// The recorded foot pitch shows only this high above the ground, in eye
// heights (desktop: 2.5-15% of the avatar's height).
const ROLL_GROUND_FADE = [0.027, 0.16] as const;
// The push-off's heel lift holds through this share of the swing.
const PUSH_OFF_HOLD = 0.25;
// A recorded swing's clearance eases in over this share of the swing.
const LIFT_EASE = 0.2;
// The least sole clearance in a recorded swing, in eye heights (about 3 cm
// above the sampled floor, which sits 1 cm under the surface): a real
// walk's toe clears the ground by 1-2 cm at mid-swing.
const SWING_MIN_CLEARANCE = 0.02;
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
const PELVIS_PASSES = 5;
const SPINE_LEAN_PASSES = 3;
const MAX_PELVIS_REACH_DROP = 0.05;
const PELVIS_REACH_DROP_TIME_SEC = 0.06;
const PELVIS_HOLD_STEP_METERS = 0.01;
// Feet tuck this far (leg lengths) above the capsule's floor level in the air.
const AIRBORNE_FOOT_TUCK = 0.08;
// The tuck grows with the height above the ground over this many tucks, so the
// feet leave the ground and meet it again with the body instead of jumping by
// the tuck in one frame.
const AIRBORNE_TUCK_FADE_TUCKS = 2;
// In the air the feet ease to their slots under the body with this time
// constant (s), from where they left the ground.
const AIRBORNE_FOOT_SETTLE_SEC = 0.08;
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
// A planted leg reaches at most this share of thigh + shin; past it the foot
// rolls. It stays under the soft end of leg IK (legIk.ts), which holds the
// ankle short of its target: there a planted foot would lift off the floor.
const PLANTED_REACH_SHARE = Math.min(0.98, LEG_SOFT_REACH_START - 0.004);
// The pelvis drops only when a planted foot, fully rolled, still could not
// reach this share: lowering it sooner pulls the eyes under the tracked head,
// and past the soft end of leg IK the planted ankle would lift.
const PELVIS_REACH_SHARE = LEG_SOFT_REACH_START - 0.0005;
const FOOT_ROLL_RATE_RAD = THREE.MathUtils.degToRad(400);
// A planted foot rolled this far toward its reach limit steps.
const STRAIN_STEP = 0.6;
// A swing lasts long enough that the foot averages at most this speed (peak
// about 1.7×, near human swing speeds).
const MAX_MEAN_SWING_SPEED = 3.0;
// A walking swing may go faster: the swing foot covers a stride in 40% of the
// gait cycle, so its mean speed is about 2.5× the body's. Capped at 3.0, a
// 1.8 m/s walk's swings took 0.55 s, and the planted foot stayed down until
// it was past the leg's reach and lifted 30 cm off the ground.
const WALK_SWING_SPEED_RATIO = 2.5;

// The recorded walk (docs/features/archive/vr-recorded-walk.md): walking steps take
// their timing and shape from the desktop walk clip. Its clock runs at the
// travel speed over the clip's stance speed; below that speed at the square
// root of the ratio (cadence and step length each rise with about the square
// root of walking speed). The travel speed eases at the desktop walk's rate.
const WALK_SPEED_EASE_PER_SEC = 12;
// Never slower: a swing in flight at a stop still lands.
const WALK_RATE_MIN = 0.5;
const WALK_RATE_MAX = 3;
// Sideways and backward travel keep the procedural step (decision 4).
const RECORDED_ON_COS = Math.cos(THREE.MathUtils.degToRad(40));
const RECORDED_OFF_COS = Math.cos(THREE.MathUtils.degToRad(50));
// The clip's hips bob, weighted by how much of the travel is not the user's
// own head motion (a stick walk), eased (decision 3).
const BOB_WEIGHT_SEC = 0.3;
const LOCAL_HEAD_SPEED_SEC = 0.15;
const MAX_LOCAL_HEAD_SPEED = 5;

const UP = new THREE.Vector3(0, 1, 0);

function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

// Horizontal swing progress: the foot travels from toe-off (the lift, linear
// at the start, leads the trapezoid's quadratic start) and settles for the
// last 5% before landing, which keeps the heel from scuffing in. A still
// start too cost a tenth of the swing time and raised its peak acceleration
// past the pop target, with no less scuffing. The travel speeds up,
// cruises and slows down in thirds (a trapezoid): the same top speed as a
// smoothstep with three quarters of its peak acceleration.
const SWING_RAMP = 1 / 3;
function swingProgress(t: number): number {
  const u = clamp(t / 0.95, 0, 1);
  const a = 1 / (SWING_RAMP * (1 - SWING_RAMP));
  if (u < SWING_RAMP) return 0.5 * a * u * u;
  if (u > 1 - SWING_RAMP) return 1 - 0.5 * a * (1 - u) ** 2;
  return 0.5 * a * SWING_RAMP * SWING_RAMP + a * SWING_RAMP * (u - SWING_RAMP);
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
  private recordedStepCount = 0;
  private walk: WalkTrajectory | undefined;
  private walkPhase = 0;
  private prevWalkPhase = 0;
  private walkRate = 1;
  private walkSpeed = 0;
  private walkFacing = true;
  private recordedMode = false;
  private bobWeight = 0;
  private localHeadSpeed = 0;
  private hasPrevHeadLocal = false;
  private readonly prevHeadLocal = new THREE.Vector3();
  private readonly swingGround = new THREE.Vector3();
  private readonly swingGroundNormal = new THREE.Vector3();
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
  private readonly stepOtherSlot = new THREE.Vector3();
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
  private readonly rollTilt = new THREE.Quaternion();
  private readonly rollAxis = new THREE.Vector3();

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
      strain: 0,
      recorded: false,
      startPhase: 0,
      span: 1,
      pendingLift: false,
      recordedRoll: 0,
      liftRoll: 0
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
    this.recordedStepCount = 0;
    this.clearWalk();
  }

  // The walk clip's measured step shape (LocomotionAnimator), or undefined
  // for the procedural steps alone. A new table restarts the walk clock.
  setWalkTrajectory(walk: WalkTrajectory | undefined): void {
    if (walk === this.walk) return;
    this.walk = walk;
    this.clearWalk();
  }

  private clearWalk(): void {
    this.recordedMode = false;
    this.walkPhase = 0;
    this.prevWalkPhase = 0;
    this.walkSpeed = 0;
    this.bobWeight = 0;
    this.localHeadSpeed = 0;
    this.hasPrevHeadLocal = false;
    for (const foot of Object.values(this.feet)) {
      foot.recorded = false;
      foot.pendingLift = false;
      foot.recordedRoll = 0;
    }
  }

  // Rest hips height above the sole: the recorded walk's unit of length.
  private hipsHeight(): number {
    const bind = this.bind!;
    return bind.hips.rootPosition.y - bind.groundLocalY;
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
    if (head.localPosition) {
      if (this.hasPrevHeadLocal) {
        const local = Math.min(MAX_LOCAL_HEAD_SPEED, Math.hypot(head.localPosition.x - this.prevHeadLocal.x, head.localPosition.z - this.prevHeadLocal.z) / dt);
        this.localHeadSpeed += (local - this.localHeadSpeed) * (1 - Math.exp(-dt / LOCAL_HEAD_SPEED_SEC));
      }
      this.prevHeadLocal.copy(head.localPosition);
      this.hasPrevHeadLocal = true;
    }

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
    if (this.airborne || landed) this.placeFeetUnderRoot(rootPosition, ground, this.airborne, dt);
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
      recordedSteps: this.recordedStepCount,
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

  // Airborne: the feet ease from where they left the ground to their slots,
  // tucked a little above the capsule's floor level as the body rises off the
  // ground; on landing each plants on the ground where it is.
  private placeFeetUnderRoot(rootPosition: THREE.Vector3, ground: GroundSampler, inAir: boolean, dt: number): void {
    const bind = this.bind!;
    const leg = bind.dims.legLength;
    const floorY = rootPosition.y + bind.groundLocalY;
    const follow = 1 - Math.exp(-dt / AIRBORNE_FOOT_SETTLE_SEC);
    for (const side of ['left', 'right'] as const) {
      const foot = this.feet[side];
      if (inAir) {
        const slot = this.slotWorld(side, rootPosition, this.bodyYawValue, this.stepTarget);
        foot.planted.x = foot.current.x + (slot.x - foot.current.x) * follow;
        foot.planted.z = foot.current.z + (slot.z - foot.current.z) * follow;
        // No ground under the foot (off a ledge) is all the height in the world.
        const groundY = ground(foot.planted.x, foot.planted.z, this.stepNormal);
        const height = groundY === undefined ? Infinity : floorY - (groundY - 0.01);
        const tuck = AIRBORNE_FOOT_TUCK * leg;
        foot.planted.y = floorY + tuck * clamp(height / (AIRBORNE_TUCK_FADE_TUCKS * tuck), 0, 1);
        foot.normal.set(0, 1, 0);
        foot.yaw = foot.currentYaw + wrapAngle(this.bodyYawValue - foot.currentYaw) * follow;
      } else {
        foot.planted.x = foot.current.x;
        foot.planted.z = foot.current.z;
        this.footGroundAt(foot.planted, foot.currentYaw, foot.normal, ground, floorY, bind.legs[side].toeForward);
        foot.yaw = foot.currentYaw;
        this.sinceLastLanding = 0;
      }
      foot.swinging = false;
      foot.recorded = false;
      foot.pendingLift = false;
      foot.recordedRoll = 0;
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
    this.advanceWalkClock(rootPosition, dt);

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
      if (foot.recorded && this.walk) {
        this.updateRecordedSwing(side, rootPosition, dt, ground);
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
    this.recordedLifts(rootPosition, ground);
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
      let mostBehind = -Infinity;
      // Urgent only for a foot left behind, never one planted ahead. With both left behind the further one goes
      // first: taking the last one checked, the right foot took every step and the left stayed planted (B-041).
      // A strained foot counts only when it is behind too: a short leg lands strained ahead of the hip, and
      // stepping it again left the other foot behind until its leg locked straight.
      for (const candidate of ['left', 'right'] as const) {
        const slot = this.slotWorld(candidate, rootPosition, this.bodyYawValue, this.stepSlot);
        const planted = this.feet[candidate].planted;
        const behind = ((slot.x - planted.x) * gaitVelocity.x + (slot.z - planted.z) * gaitVelocity.z) / Math.max(speed, 1e-6);
        if ((behind > URGENT_STEP_DISTANCE * leg || (behind > 0 && this.feet[candidate].strain >= 1)) && behind > mostBehind) {
          side = candidate;
          urgent = true;
          mostBehind = behind;
        }
      }
      // Forward walking lifts on the recorded walk's clock (recordedLifts);
      // only a foot left behind or strained steps here.
      if (!urgent && this.walk && this.walkFacing) return;
      if (!urgent && this.sinceLastStepStart < period * (this.gaitSteps < 2 ? 0.7 : 1)) return;
      // Land slightly short of symmetric: the trailing foot has more reach
      // (heel roll) than the leading one.
      // The first steps from standing are quicker, as the body accelerates.
      // The swing takes most of the step (a short double support): at 0.8 the
      // swing foot's acceleration read over the pop target on a brisk walk.
      const starting = this.gaitSteps < 2 ? 0.7 : 1;
      const duration = period * 0.85 * starting;
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

  // The recorded walk's clock: the clip phase advances at the travel speed
  // over the clip's stance speed (square root below it). It runs while the
  // body walks forward, and on after a stop until a recorded swing lands.
  private advanceWalkClock(rootPosition: THREE.Vector3, dt: number): void {
    const walk = this.walk;
    this.prevWalkPhase = this.walkPhase;
    if (!walk) return;
    const travel = this.translating ? this.targetVelocity : this.rootVelocity;
    const speed = Math.hypot(travel.x, travel.z);
    this.walkSpeed += (speed - this.walkSpeed) * (1 - Math.exp(-WALK_SPEED_EASE_PER_SEC * dt));
    const forwardDot = speed > 1e-3 ? (-travel.x * Math.sin(this.bodyYawValue) - travel.z * Math.cos(this.bodyYawValue)) / speed : 1;
    this.walkFacing = forwardDot >= (this.walkFacing ? RECORDED_OFF_COS : RECORDED_ON_COS);
    const wasRecorded = this.recordedMode;
    this.recordedMode = this.gaitActive && this.walkFacing;
    // A recorded walk seldom has both feet down, where the procedural gait
    // refreshes its lead velocity: refresh it here, or the steps aim with
    // the walk's start-up speed and land short.
    if (this.recordedMode) this.gaitVelocity.copy(travel);
    const ratio = this.walkSpeed / Math.max(1e-6, walk.stanceSpeed * this.hipsHeight());
    let rate = ratio >= 1 ? ratio : Math.sqrt(ratio);
    // The first steps from standing are quicker, as the body accelerates.
    if (this.gaitSteps < 2) rate /= 0.7;
    this.walkRate = clamp(rate, WALK_RATE_MIN, WALK_RATE_MAX);
    const inFlight = (this.feet.left.swinging && this.feet.left.recorded) || (this.feet.right.swinging && this.feet.right.recorded);
    const stickShare = this.walkSpeed > 0.1 && this.hasPrevHeadLocal ? clamp(1 - this.localHeadSpeed / this.walkSpeed, 0, 1) : 0;
    this.bobWeight += ((this.recordedMode ? stickShare : 0) - this.bobWeight) * (1 - Math.exp(-dt / BOB_WEIGHT_SEC));
    if (!this.recordedMode && !inFlight) return;
    if (this.recordedMode && !wasRecorded && !inFlight) {
      // The walk starts with the foot furthest behind: the clock jumps to
      // just before its lift. A recorded swing still in the air keeps the
      // clock, or it lands in one frame.
      const side = this.furthestBehind(rootPosition, travel);
      this.walkPhase = (walk.gait.stance[side].lift - 1e-4 + 1) % 1;
      this.prevWalkPhase = this.walkPhase;
    }
    this.walkPhase = (this.walkPhase + (this.walkRate * dt) / walk.duration) % 1;
  }

  private furthestBehind(rootPosition: THREE.Vector3, velocity: THREE.Vector3): 'left' | 'right' {
    let best: 'left' | 'right' = this.nextGaitSide;
    let most = -Infinity;
    const speed = Math.max(1e-6, Math.hypot(velocity.x, velocity.z));
    for (const side of ['left', 'right'] as const) {
      if (this.feet[side].swinging) continue;
      const slot = this.slotWorld(side, rootPosition, this.bodyYawValue, this.stepSlot);
      const planted = this.feet[side].planted;
      const behind = ((slot.x - planted.x) * velocity.x + (slot.z - planted.z) * velocity.z) / speed;
      if (behind > most) {
        most = behind;
        best = side;
      }
    }
    return best;
  }

  // A planted foot lifts when the clock passes its recorded lift-off, once
  // the other foot is down (walking has no flight). A lift held up past half
  // its swing is skipped: the foot then steps when it is left behind.
  private recordedLifts(rootPosition: THREE.Vector3, ground: GroundSampler): void {
    const walk = this.walk;
    for (const side of ['left', 'right'] as const) {
      const foot = this.feet[side];
      // A planted foot stays flat, as on desktop; a heel the reach lifts
      // stays up into the swing (updateRecordedSwing).
      if (!foot.swinging) foot.recordedRoll = 0;
    }
    if (!walk || !this.recordedMode) {
      this.feet.left.pendingLift = false;
      this.feet.right.pendingLift = false;
      return;
    }
    const prev = this.prevWalkPhase;
    const advanced = (this.walkPhase - prev + 1) % 1;
    for (const side of ['left', 'right'] as const) {
      const foot = this.feet[side];
      const other = this.feet[side === 'left' ? 'right' : 'left'];
      if (foot.swinging) {
        foot.pendingLift = false;
        continue;
      }
      const { land, lift } = walk.gait.stance[side];
      const swingLength = (land - lift + 1) % 1 || 1;
      if ((lift - prev + 1) % 1 <= advanced && advanced > 0) foot.pendingLift = true;
      const intoSwing = (this.walkPhase - lift + 1) % 1;
      if (foot.pendingLift && intoSwing > 0.5 * swingLength) foot.pendingLift = false;
      if (!foot.pendingLift || other.swinging) continue;
      foot.pendingLift = false;
      const span = (land - this.walkPhase + 1) % 1;
      if (span <= 1e-3) continue;
      const toSec = walk.duration / this.walkRate;
      // Land ahead of the moving slot by a little under half the stance's
      // travel, so the planted foot ends as far behind it at lift-off.
      const stanceSec = (1 - swingLength) * toSec;
      this.startStep(side, rootPosition, 0.85 * (stanceSec / 2), span * toSec, true, ground, RECORDED_MAX_STEP_LENGTH);
      foot.recorded = true;
      foot.liftRoll = Math.max(0, foot.roll);
      foot.startPhase = this.walkPhase;
      foot.span = span;
      this.recordedStepCount += 1;
      this.gaitSteps += 1;
      this.nextGaitSide = side === 'left' ? 'right' : 'left';
    }
  }

  // A recorded swing: its progress, clearance and pitch come from the walk
  // clip at the matching phase of the clip's own swing; the planner still
  // re-aims the landing. The sole never dips below the ground under it.
  private updateRecordedSwing(side: 'left' | 'right', rootPosition: THREE.Vector3, dt: number, ground: GroundSampler): void {
    const walk = this.walk!;
    const foot = this.feet[side];
    const { land, lift } = walk.gait.stance[side];
    const swingLength = (land - lift + 1) % 1 || 1;
    const u = clamp(((this.walkPhase - foot.startPhase + 1) % 1) / foot.span, 0, 1);
    foot.t = Math.max(foot.t, u);
    if (foot.t < 0.85) {
      const remaining = ((1 - foot.t) * foot.span * walk.duration) / this.walkRate;
      const aim = this.stepTargetFor(side, rootPosition, this.gaitVelocity, remaining + foot.landLeadSec, ground, this.aimTarget, this.aimNormal, true, RECORDED_MAX_STEP_LENGTH);
      const shift = aim.distanceTo(foot.to);
      const allowed = MAX_REAIM_SPEED * dt;
      foot.to.lerp(aim, shift > allowed ? allowed / shift : 1);
      foot.toNormal.copy(this.aimNormal);
      foot.toYaw = this.bodyYawValue;
    }
    const clipPhase = lift + foot.t * swingLength;
    const s = foot.t >= 1 ? 1 : clamp(sampleWalkTrajectory(walk.legs[side].progress, clipPhase), 0, 1);
    // The clip's sole already rises at its lift-off (its heel rose in
    // stance); a flat stance foot eases into that rise instead.
    const liftEase = THREE.MathUtils.smoothstep(foot.t, 0, LIFT_EASE);
    const clearance = foot.t >= 1 ? 0 : liftEase * sampleWalkTrajectory(walk.legs[side].clearance, clipPhase) * this.hipsHeight();
    foot.current.lerpVectors(foot.from, foot.to, s);
    foot.currentNormal.lerpVectors(foot.normal, foot.toNormal, s).normalize();
    foot.currentYaw = foot.fromYaw + wrapAngle(foot.toYaw - foot.fromYaw) * s;
    const sole = THREE.MathUtils.lerp(foot.from.y, foot.to.y, s);
    // The clip's toe clearance is small at mid-swing: keep the sole clear of
    // the ground under the heel and under the ball (higher on an upslope).
    this.swingGround.copy(foot.current);
    this.footGroundAt(this.swingGround, foot.currentYaw, this.swingGroundNormal, ground, sole, this.bind!.legs[side].toeForward);
    const floor = Math.max(this.swingGround.y, this.footBall.y);
    const eye = this.bind!.dims.eyeHeight;
    const minLift = foot.t >= 1 ? 0 : SWING_MIN_CLEARANCE * eye * liftEase * (1 - THREE.MathUtils.smoothstep(foot.t, 0.8, 1));
    foot.current.y = Math.max(sole + clearance, floor + minLift);
    // As on desktop (TerrainLegSolver), the clip's pitch fades out near the
    // ground, so the foot leaves and lands flat. The heel the push-off had
    // at lift-off eases down over the early swing instead of dropping.
    const air = THREE.MathUtils.smoothstep(foot.current.y - floor, ROLL_GROUND_FADE[0] * eye, ROLL_GROUND_FADE[1] * eye);
    const held = foot.liftRoll * Math.max(0, 1 - foot.t / PUSH_OFF_HOLD);
    const clipRoll = air * sampleWalkTrajectory(walk.legs[side].roll, clipPhase);
    foot.recordedRoll = foot.t >= 1 ? 0 : held > clipRoll ? held : clipRoll;
    if (foot.t >= 1) {
      foot.swinging = false;
      foot.recorded = false;
      foot.planted.copy(foot.to);
      foot.normal.copy(foot.toNormal);
      foot.yaw = foot.toYaw;
      foot.current.copy(foot.planted);
      foot.currentYaw = foot.yaw;
      this.sinceLastLanding = 0;
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
  private stepTargetFor(side: 'left' | 'right', rootPosition: THREE.Vector3, velocity: THREE.Vector3, leadSec: number, ground: GroundSampler, out: THREE.Vector3, outNormal: THREE.Vector3, walking = false, maxStepLegs = MAX_STEP_LENGTH): THREE.Vector3 {
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
    // A stride is measured from a foot that holds the body up. One left more than a stride from its own slot (the
    // body moved faster than the feet could follow) holds nothing: measured from it, both feet leapfrog back a stride
    // at a time with the legs stretched out level behind the body for seconds (B-041).
    const otherSlot = this.slotWorld(otherSide, rootPosition, this.bodyYawValue, this.stepOtherSlot);
    const otherStranded = Math.hypot(otherSlot.x - other.x, otherSlot.z - other.z) > MAX_STEP_LENGTH * leg;
    if (reach > maxStepLegs * leg && !otherStranded) {
      const keep = (maxStepLegs * leg) / reach;
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

  private startStep(side: 'left' | 'right', rootPosition: THREE.Vector3, landLeadSec: number, duration: number, walking: boolean, ground: GroundSampler, maxStepLegs = MAX_STEP_LENGTH): void {
    const leg = this.bind!.dims.legLength;
    const foot = this.feet[side];
    const lead = walking ? duration + landLeadSec : 0;
    const target = this.stepTargetFor(side, rootPosition, this.gaitVelocity, lead, ground, this.stepTarget, this.stepNormal, walking, maxStepLegs);
    const distance = Math.hypot(target.x - foot.planted.x, target.z - foot.planted.z);
    foot.swinging = true;
    foot.recorded = false;
    foot.recordedRoll = 0;
    foot.walking = walking;
    foot.landLeadSec = landLeadSec;
    foot.from.copy(foot.planted);
    foot.to.copy(target);
    foot.toNormal.copy(this.stepNormal);
    foot.fromYaw = foot.yaw;
    foot.toYaw = this.bodyYawValue;
    foot.t = 0;
    const maxSwingSpeed = walking ? Math.max(MAX_MEAN_SWING_SPEED, WALK_SWING_SPEED_RATIO * this.gaitVelocity.length()) : MAX_MEAN_SWING_SPEED;
    foot.duration = Math.max(duration, distance / maxSwingSpeed);
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
    // A stick walk takes the recorded walk's hips bob: the avatar's head dips
    // below the tracked head by up to the clip's bob (decision 3).
    const bob = this.walk && this.bobWeight > 1e-3 && !this.airborne ? sampleWalkTrajectory(this.walk.bob, this.walkPhase) * this.bobWeight * this.hipsHeight() : 0;
    if (bob < 0) {
      hips.y = Math.max(hips.y + bob, groundY + 0.25 * leg);
      this.placeHips(hips);
      this.poseSpine(headTarget, headQuat, rootQuat, twist);
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
      const maxReach = (legBind.thighLength + legBind.shinLength) * PELVIS_REACH_SHARE;
      // Best case for this foot: rolled fully toward the hip, as poseLeg would.
      const towardHip = this.legVec.subVectors(hip, foot.current).dot(this.legForward.set(-Math.sin(foot.currentYaw), 0, -Math.cos(foot.currentYaw))) > 0 ? 1 : -1;
      const rolled = this.rolledAnkle(side, towardHip * MAX_FOOT_ROLL_RAD, bind.dims.ankleHeight, this.legAnkle, this.legRoll);
      const ankleX = rolled.x;
      const ankleZ = rolled.z;
      const ankleY = rolled.y;
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
    const maxReach = (legBind.thighLength + legBind.shinLength) * PLANTED_REACH_SHARE;
    const ankle = this.legAnkle;
    const roll = this.legRoll;
    const trailing = this.legVec.subVectors(hip, foot.current).dot(forward) > 0;
    const tilt = this.legTilt.setFromUnitVectors(UP, foot.currentNormal);
    const rollAt = (signedAngle: number) => this.rolledAnkle(side, signedAngle, ankleLift, ankle, roll);
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
    // The recorded walk's pitch (heel strike, push-off) where the reach asks
    // for none or for more of the same; a reach that needs the other pivot
    // wins.
    const reachWanted = wanted;
    const recorded = this.faults.has('feet-float') ? 0 : clamp(foot.recordedRoll, -MAX_FOOT_ROLL_RAD, MAX_FOOT_ROLL_RAD);
    if (recorded !== 0 && (reachWanted === 0 || Math.sign(recorded) === Math.sign(reachWanted))) {
      wanted = Math.abs(recorded) > Math.abs(reachWanted) ? recorded : reachWanted;
    }
    // Ease into and out of a roll; changing pivots passes through flat.
    const maxChange = FOOT_ROLL_RATE_RAD * this.lastDt;
    foot.roll += clamp(wanted - foot.roll, -maxChange, maxChange);
    rollAt(foot.roll);
    foot.strain = foot.swinging ? 0 : ankle.distanceTo(hip) > maxReach * 1.001 ? 1 : Math.abs(reachWanted) / MAX_FOOT_ROLL_RAD;
    solveTwoBoneLeg(legBind, ankle, pole, rootQuat);

    // Foot: bind orientation turned to the foot's yaw, tilted to the ground,
    // then rolled about the pivot with the ankle.
    const footQuat = this.legQuat.setFromAxisAngle(UP, foot.currentYaw - this.bodyYawValue).multiply(rootQuat).multiply(legBind.foot.rootQuaternion);
    footQuat.premultiply(tilt).premultiply(roll);
    this.setWorldQuaternion(legBind.foot.bone, footQuat);
    const toe = legBind.toe;
    if (toe) {
      toe.bone.quaternion.copy(toe.local);
      // Heel up: the toes bend at the ball and stay on the ground.
      if (foot.roll > 0 && !(foot.swinging && foot.recorded)) {
        const toeQuat = this.legQuat.setFromAxisAngle(UP, foot.currentYaw - this.bodyYawValue).multiply(rootQuat).multiply(toe.rootQuaternion).premultiply(tilt);
        this.setWorldQuaternion(toe.bone, toeQuat);
      }
    }
  }

  // Where a planted foot's ankle sits rolled by signedAngle; `roll` gets the
  // rotation. Positive roll lifts the heel about the ball joint, negative
  // lifts the toes about the heel. The pivot is where that point sits on the
  // flat foot tilted to the ground, and the whole foot turns about it, so the
  // ball neither dips into a slope nor slides forward as the heel rises.
  private rolledAnkle(side: 'left' | 'right', signedAngle: number, ankleLift: number, out: THREE.Vector3, roll: THREE.Quaternion): THREE.Vector3 {
    const bind = this.bind!;
    const foot = this.feet[side];
    const pivot = this.legPivot.copy(foot.current);
    const lever = this.legLever;
    const flatAnkle = out.copy(foot.current);
    flatAnkle.y += ankleLift;
    if (signedAngle > 0) {
      lever.set(-Math.sin(foot.currentYaw), 0, -Math.cos(foot.currentYaw)).multiplyScalar(bind.legs[side].toeForward);
      lever.y += this.ballHeight() - bind.dims.ankleHeight;
      pivot.copy(lever.applyQuaternion(this.rollTilt.setFromUnitVectors(UP, foot.currentNormal))).add(flatAnkle);
    }
    lever.subVectors(flatAnkle, pivot);
    roll.setFromAxisAngle(this.rollAxis.set(Math.cos(foot.currentYaw), 0, -Math.sin(foot.currentYaw)), -signedAngle);
    return out.copy(lever).applyQuaternion(roll).add(pivot);
  }

  // The ball joint's rest height above the sole, under the ankle's.
  private ballHeight(): number {
    const dims = this.bind!.dims;
    return clamp(dims.toeHeight, 0, 0.9 * dims.ankleHeight);
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
