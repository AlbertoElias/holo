import * as THREE from 'three';
import type { AvatarRig } from '../avatar/AvatarRig';
import { inStance, type GaitLeg, type GaitState } from './LocomotionAnimator';
import { TerrainHeightIndex, WALKABLE_NORMAL_Y } from './TerrainHeightIndex';

/**
 * How a foot is placed on the animation path:
 * - `free`: where the (direction-remapped) clip puts it, easing out of a release;
 * - `pinned`: held at a world point (a stance of the walk, or standing);
 * - `step`: a settling step from where it stood to where the pose wants it.
 */
type FootMode = 'free' | 'pinned' | 'step';
/** A ground sample: its height and its face's normal. */
type Ground = { y: number; normal: THREE.Vector3 };
type Leg = {
  side: GaitLeg;
  upper: THREE.Bone; lower: THREE.Bone; foot: THREE.Bone; toe: THREE.Object3D | undefined;
  bones: readonly [THREE.Bone, THREE.Bone, THREE.Bone];
  upInFoot: THREE.Vector3;
  /** Rest ankle height above the sole plane, as a share of the avatar's height. */
  ankleRatio: number;
  /** Rest toe height above the sole plane, as a share of the avatar's height. */
  toeRatio: number;
  correction: number; planted: boolean; plantCorrection: number;
  heldTarget: THREE.Vector3; heldQuat: THREE.Quaternion; release: number; releaseSec: number;
  /** The last grounded frame's leg rotations (upper, lower, foot), which fade out over LIFT_OFF_SEC in the air. */
  airQuats: [THREE.Quaternion, THREE.Quaternion, THREE.Quaternion]; airFade: number;
  /** The leg rotations before this frame's solve (restore puts them back). */
  savedQuats: [THREE.Quaternion, THREE.Quaternion, THREE.Quaternion]; saved: boolean;
  /** Where the foot was put last frame and how fast it was moving, so a step out of a stride carries its speed. */
  last: THREE.Vector3; hasLast: boolean; velocity: THREE.Vector3; stepVelocity: THREE.Vector3;
  lastQuat: THREE.Quaternion; hasLastQuat: boolean;
  /** Set down before the clip's footfall; held until that stance ends. */
  early: boolean;
  /** 0 to 1: how far this leg's reach is softened. */
  soft: number;
  mode: FootMode; anchor: THREE.Vector3; stepFrom: THREE.Vector3; step: number; wasStance: boolean;
  /** This frame: the clip's foot, where the pose puts it (remapped), the solver's target, and the ground under it. */
  animated: THREE.Vector3; animatedQuat: THREE.Quaternion; posed: THREE.Vector3; target: THREE.Vector3;
  ground: Ground; onGround: boolean;
  /** Ground under the target's heel and toe (the support plane the foot tilts to). */
  heel: Ground; toeGround: Ground;
  sample: LegSample;
};
type LegSample = {
  side: string;
  foot: { x: number; y: number; z: number };
  groundY: number | null;
  correction: number;
  upper: number[];
  lower: number[];
  mode: FootMode;
  /** The angle between a grounded foot's sole and the ground under its heel and toe (deg); null in the air. */
  groundTiltDeg: number | null;
  /** That ground's slope (deg). */
  groundSlopeDeg: number | null;
};

/** A released plant eases the foot back to the animation over this long. */
const PLANT_RELEASE_SEC = 0.15;
/** A foot leaving its stance at the start of a walk eases into the stride over this long. */
const GAIT_RELEASE_SEC = 0.25;
/** Time constant for a planted foot settling onto the floor. */
const PIN_SETTLE_SEC = 0.06;
/** Leaving the ground, the feet ease from where the ground had them to the pose's over this long (s), not in one frame. */
const LIFT_OFF_SEC = 0.1;
/** The least mid-swing clearance of the walk's swing foot, as a share of the avatar's height: a clip whose swing already clears the floor by it gets nothing added. */
const SWING_LIFT_RATIO = 0.03;
/** Share of the leg's length over which a walking leg eases into full extension. */
const SOFT_REACH_RATIO = 0.03;
const SOFT_REACH_FADE_SEC = 0.15;
/** Time constant of a walking foot's turn toward the clip's orientation. */
const FOOT_TURN_SEC = 0.05;
/** Share of the swing after which a foot turning back is set down early. */
const EARLY_SET_DOWN_SWING = 0.6;
/** Only a foot already this close to the floor (share of height) is set down early. */
const EARLY_SET_DOWN_HEIGHT_RATIO = 0.006;
/** A foot slower than this (m/s) when the walk ends is set down where it is; a faster one steps out of its stride. */
const SET_DOWN_SPEED = 0.3;
/** A settling step (after a stop, or turning on the spot) takes this long and lifts the foot this high (share of height). */
const STEP_SEC = 0.32;
const STEP_LIFT_RATIO = 0.035;
/** A standing foot further than this (share of height) from where the pose wants it steps there. */
const STEP_TOLERANCE_RATIO = 0.05;
/** Share of the step tolerance an unreachable foot must be from the pose's foot to step there. */
const UNREACHABLE_STEP_SHARE = 0.25;
/**
 * A pinned foot lets go once it lies this far past the straight leg's reach (share of the leg's length):
 * a walk lands on a nearly straight leg, and the IK holds the rest by drawing the foot in, a slide kept under 3 cm.
 */
const OVERSTRETCH = 1.03;
/** A toe whose floor stands above the ankle by more than this share of the foot's length faces a wall. */
const WALL_TOE_SHARE = 0.7;
/** The gap a foot drawn back from a rock face keeps from it, as a share of the height. */
const WALL_CLEARANCE_RATIO = 0.005;
/** A foot tilts toward its ground's slope by at most this much: on a steeper face it stands as on this slope. */
const MAX_FOOT_TILT_DEG = 40;
const MAX_FOOT_TILT_COS = Math.cos(THREE.MathUtils.degToRad(MAX_FOOT_TILT_DEG));
const MAX_FOOT_TILT_SIN = Math.sin(THREE.MathUtils.degToRad(MAX_FOOT_TILT_DEG));
const MAX_FOOT_TILT_TAN = Math.tan(THREE.MathUtils.degToRad(MAX_FOOT_TILT_DEG));
/**
 * A standing or planted foot the straight leg cannot reach (the lower foot across a slope, a stance on a dip) lowers
 * the pelvis, to this share of the leg's reach and by at most PELVIS_DROP_MAX_RATIO of the height, eased.
 */
const PELVIS_REACH_SHARE = 0.995;
const PELVIS_DROP_MAX_RATIO = 0.12;
const PELVIS_DROP_SEC = 0.08;
// Standing, the hips come back up slower than they go down: a settle step that brings the feet together lets them
// rise smoothly, not snap up in a tenth of a second (walking, they follow each stance at PELVIS_DROP_SEC).
const PELVIS_RISE_SEC = 0.3;

const smooth = (t: number) => t * t * (3 - 2 * t);
const flatDistance = (a: THREE.Vector3, b: THREE.Vector3) => Math.hypot(a.x - b.x, a.z - b.z);
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Post-animation, leg-only terrain adaptation and foot planting; the one
 * writer of the legs (and the pelvis drop) on the animation path. No
 * calibration or root ownership. With the walk's measured footfalls
 * (`GaitState`), a foot is pinned to the ground for its stance and the
 * clips' stride is turned from their own travel to the body's, so a blend
 * that does not match the travel still plants its feet. It allocates nothing
 * per frame.
 */
export class TerrainLegSolver {
  private avatar: THREE.Object3D | undefined;
  private legs: Leg[] = [];
  private hips: THREE.Bone | undefined;
  private readonly hipsSaved = new THREE.Vector3();
  private hipsWasSaved = false;
  private pelvisDrop = 0;
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly identity = new THREE.Quaternion();
  private samples: LegSample[] = [];
  private sampleCount = 0;
  private readonly lastRoot = new THREE.Vector3();
  private hasLastRoot = false;
  private readonly travel = new THREE.Vector3(0, 0, 1);
  private readonly center: Ground = { y: 0, normal: new THREE.Vector3() };
  private readonly probe: Ground = { y: 0, normal: new THREE.Vector3() };
  // This frame's floor lookup (floorAt): the model, the probe base and the fallback height.
  private model: THREE.Object3D | undefined;
  private baseY = 0;
  private heightNow = 1;
  // The anchor floor cache of one `place` call.
  private anchorX = NaN;
  private anchorZ = NaN;
  private anchorFloor = 0;
  private anchorFallback = 0;
  private anchorSole = 0;
  // Scratch, never kept across calls.
  private readonly root = new THREE.Vector3();
  private readonly facing = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly va = new THREE.Vector3();
  private readonly vb = new THREE.Vector3();
  private readonly vc = new THREE.Vector3();
  private readonly vd = new THREE.Vector3();
  private readonly ve = new THREE.Vector3();
  private readonly vf = new THREE.Vector3();
  private readonly vg = new THREE.Vector3();
  private readonly qa = new THREE.Quaternion();
  private readonly qb = new THREE.Quaternion();
  private readonly qc = new THREE.Quaternion();
  private readonly qd = new THREE.Quaternion();

  restore(): void {
    for (const leg of this.legs) {
      if (!leg.saved) continue;
      for (let i = 0; i < 3; i++) leg.bones[i]!.quaternion.copy(leg.savedQuats[i]!);
      leg.saved = false;
    }
    if (this.hipsWasSaved && this.hips) this.hips.position.copy(this.hipsSaved);
    this.hipsWasSaved = false;
  }

  getSnapshot(): readonly LegSample[] { return this.samples.slice(0, this.sampleCount); }

  /** How far the pelvis is lowered this frame (m), for the slope checks. */
  getPelvisDrop(): number { return this.pelvisDrop; }

  attach(rig: AvatarRig): void {
    rig.avatarRoot.updateWorldMatrix(true, true);
    this.avatar = rig.avatar;
    this.legs = [];
    this.samples = [];
    this.hasLastRoot = false;
    this.hips = rig.bone('hips');
    this.hipsWasSaved = false;
    this.pelvisDrop = 0;
    const baseY = rig.avatarRoot.getWorldPosition(new THREE.Vector3()).y + rig.avatarMinLocalY;
    for (const side of ['left', 'right'] as const) {
      const upper = rig.bone(`${side}UpperLeg`), lower = rig.bone(`${side}LowerLeg`), foot = rig.bone(`${side}Foot`);
      if (!upper || !lower || !foot) continue;
      const ankleRatio = Math.max(0.02, (foot.getWorldPosition(new THREE.Vector3()).y - baseY) / Math.max(rig.avatarHeight, 1e-3));
      const toe = rig.bone(`${side}Toes`);
      const toeRatio = toe ? Math.max(0, (toe.getWorldPosition(new THREE.Vector3()).y - baseY) / Math.max(rig.avatarHeight, 1e-3)) : 0;
      const sample: LegSample = { side, foot: { x: 0, y: 0, z: 0 }, groundY: null, correction: 0, upper: [0, 0, 0, 1], lower: [0, 0, 0, 1], mode: 'free', groundTiltDeg: null, groundSlopeDeg: null };
      this.samples.push(sample);
      this.legs.push({
        side, upper, lower, foot, toe, bones: [upper, lower, foot], ankleRatio, toeRatio,
        upInFoot: this.up.clone().applyQuaternion(foot.getWorldQuaternion(new THREE.Quaternion()).invert()),
        correction: 0, planted: false, plantCorrection: 0, heldTarget: new THREE.Vector3(), heldQuat: new THREE.Quaternion(), release: 0, releaseSec: PLANT_RELEASE_SEC,
        airQuats: [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()], airFade: 0,
        savedQuats: [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()], saved: false,
        last: new THREE.Vector3(), hasLast: false, velocity: new THREE.Vector3(), stepVelocity: new THREE.Vector3(),
        lastQuat: new THREE.Quaternion(), hasLastQuat: false, early: false, soft: 0,
        mode: 'free', anchor: new THREE.Vector3(), stepFrom: new THREE.Vector3(), step: 0, wasStance: false,
        animated: new THREE.Vector3(), animatedQuat: new THREE.Quaternion(), posed: new THREE.Vector3(), target: new THREE.Vector3(),
        ground: { y: 0, normal: new THREE.Vector3() }, onGround: false,
        heel: { y: 0, normal: new THREE.Vector3() }, toeGround: { y: 0, normal: new THREE.Vector3() },
        sample
      });
    }
  }

  /**
   * `plant`: a reach is driving the pose; each foot stays where it stood when the reach began.
   * `gait`: the walk's footfalls; without it the feet follow the animation (no planting).
   */
  update(rig: AvatarRig, grounded: boolean, deltaSec: number, plant = false, bent = false, gait?: GaitState): void {
    if (this.avatar !== rig.avatar) this.attach(rig);
    this.sampleCount = 0;
    if (!rig.worldModel || !rig.avatar) return;
    const model = rig.worldModel;
    rig.avatarRoot.updateWorldMatrix(true, true);
    const height = rig.avatarHeight;
    const root = rig.avatarRoot.getWorldPosition(this.root);
    const facing = this.facing.set(0, 0, 1).applyQuaternion(rig.avatar.getWorldQuaternion(this.qa));
    const forward = this.forward.set(facing.x, 0, facing.z);
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, 1);
    forward.normalize();
    const walking = gait?.walking ?? false;
    // A teleport (respawn, a world swap, leaving XR) drops every plant: a pinned foot would sweep from the old spot.
    if (this.updateTravel(root, forward, deltaSec, walking, height)) for (const leg of this.legs) this.resetLeg(leg);
    // Sample only around the support plane, never from the top of the room.
    const baseY = root.y + rig.avatarMinLocalY;
    this.model = model;
    this.baseY = baseY;
    this.heightNow = height;
    const hasCenter = this.surface(this.center, model, root.x, baseY, root.z, height);

    // Pass 1: each leg's target, from the clip, the ground and the plant.
    for (let index = 0; index < this.legs.length; index++) {
      const leg = this.legs[index]!;
      leg.foot.getWorldPosition(leg.animated);
      leg.foot.getWorldQuaternion(leg.animatedQuat);
      // The clips' stride turned from their own travel toward the body's.
      const foot = walking && !plant ? this.remap(leg.posed, leg.animated, root, forward, gait!) : leg.posed.copy(leg.animated);
      leg.onGround = grounded && hasCenter && this.surface(leg.ground, model, foot.x, baseY, foot.z, height);
      if (!leg.onGround) continue;
      for (let i = 0; i < 3; i++) leg.savedQuats[i]!.copy(leg.bones[i]!.quaternion);
      leg.saved = true;
      const sole = height * leg.ankleRatio;
      const target = leg.target;
      if (plant) {
        // Planted at the start of the reach, at the height the foot stood at then.
        if (!leg.planted) {
          leg.planted = true;
          leg.plantCorrection = leg.correction;
        }
        const stand = rig.plantFeet[index === 0 ? 'left' : 'right'];
        target.set(stand.x, stand.y + leg.plantCorrection, stand.z);
        leg.correction = target.y - foot.y;
        leg.heldTarget.copy(target);
        leg.heldQuat.copy(rig.plantFootQuats[index === 0 ? 'left' : 'right']);
        leg.release = 1;
        leg.releaseSec = PLANT_RELEASE_SEC;
        leg.mode = 'free';
      } else {
        leg.planted = false;
        const groundY = leg.ground.y;
        const desired = THREE.MathUtils.clamp(Math.max(groundY - this.center.y, groundY + sole - foot.y), -height * 0.18, height * 0.22);
        leg.correction = THREE.MathUtils.lerp(leg.correction, desired, 1 - Math.exp(-18 * Math.max(0, deltaSec)));
        // A grounded foot never sinks below its resting height, however the crouch or the clip bends the leg.
        foot.y = Math.max(foot.y + leg.correction, groundY + sole);
        if (gait) this.place(leg, foot, gait, deltaSec, height, groundY + sole, sole);
        else target.copy(foot);
        // Letting go of a plant eases the foot from where it was held to where the pose has it, not a snap.
        if (leg.release > 0) {
          leg.release = Math.max(0, leg.release - deltaSec / leg.releaseSec);
          target.lerp(leg.heldTarget, smooth(leg.release));
          target.y = Math.max(target.y, groundY + sole);
        }
      }
    }

    // The pelvis drops (one writer, before either leg is solved) so a standing foot it cannot reach still stands.
    this.dropPelvis(plant, walking, height, deltaSec);

    // Pass 2: solve each leg onto its target and lay the foot on its ground.
    for (const leg of this.legs) {
      if (leg.onGround) this.solveGrounded(leg, rig, gait, deltaSec, plant, bent, grounded, height, model, baseY);
      else this.leaveGround(leg, deltaSec);
      if (leg.onGround) {
        for (let i = 0; i < 3; i++) leg.airQuats[i]!.copy(leg.bones[i]!.quaternion);
        leg.airFade = 1;
      } else {
        leg.sample.groundTiltDeg = null;
        leg.sample.groundSlopeDeg = null;
      }
      const resolved = leg.foot.getWorldPosition(this.va);
      const s = leg.sample;
      s.foot.x = resolved.x; s.foot.y = resolved.y; s.foot.z = resolved.z;
      s.groundY = leg.onGround ? leg.ground.y : null;
      s.correction = leg.correction;
      leg.upper.quaternion.toArray(s.upper);
      leg.lower.quaternion.toArray(s.lower);
      s.mode = leg.mode;
      this.samples[this.sampleCount++] = s;
    }
  }

  private solveGrounded(
    leg: Leg, rig: AvatarRig, gait: GaitState | undefined, deltaSec: number, plant: boolean, bent: boolean,
    grounded: boolean, height: number, model: THREE.Object3D, baseY: number
  ): void {
    const target = leg.target;
    const walking = gait?.walking ?? false;
    const sole = height * leg.ankleRatio;
    if (leg.hasLast && deltaSec > 0) leg.velocity.copy(target).sub(leg.last).divideScalar(deltaSec);
    else leg.velocity.set(0, 0, 0);
    leg.last.copy(target);
    leg.hasLast = true;
    // Knees always bend forward, the way the body faces.
    // A walking or stepping leg eases into full extension; a leg standing planted keeps its full length, so it never lifts off its footprint.
    leg.soft = THREE.MathUtils.clamp(leg.soft + (gait && (walking || leg.mode !== 'pinned') ? 1 : -1) * deltaSec / SOFT_REACH_FADE_SEC, 0, 1);
    this.solve(leg, target, this.facing, gait ? true : plant || bent, leg.soft);
    const parentRotation = leg.foot.parent!.getWorldQuaternion(this.qa);
    if (plant) {
      // A planted foot keeps its orientation: at a deep squat the shin folds so far that tilting it toward the floor would spin it.
      const planted = rig.plantFootQuats[leg.side];
      leg.foot.quaternion.copy(parentRotation.invert().multiply(planted)).normalize();
      leg.foot.updateWorldMatrix(false, true);
      this.recordTilt(leg, model, baseY, height);
      return;
    }
    // The clip's foot orientation, tilted to the ground under the heel and the toe while near contact.
    const contact = 1 - THREE.MathUtils.smoothstep(target.y - leg.ground.y - sole, height * 0.025, height * 0.15);
    const worldRotation = gait ? leg.animatedQuat : leg.foot.getWorldQuaternion(this.qb);
    const footUp = this.vb.copy(leg.upInFoot).applyQuaternion(worldRotation);
    const support = this.supportNormal(this.vc, leg, model, baseY, height);
    if (support.y < MAX_FOOT_TILT_COS) {
      const across = Math.hypot(support.x, support.z);
      support.set(support.x / across * MAX_FOOT_TILT_SIN, MAX_FOOT_TILT_COS, support.z / across * MAX_FOOT_TILT_SIN);
    }
    const free = this.qc.setFromUnitVectors(footUp, support);
    free.slerp(this.identity, 1 - contact);
    free.multiply(worldRotation);
    if (leg.release > 0) free.slerp(leg.heldQuat, smooth(leg.release));
    // A walking foot turns no faster than it can: the clip's crossfades swing it within a frame or two.
    if (gait && leg.hasLastQuat) free.copy(this.qd.copy(leg.lastQuat).slerp(free, 1 - Math.exp(-deltaSec / FOOT_TURN_SEC)));
    leg.foot.quaternion.copy(parentRotation.invert().multiply(free)).normalize();
    leg.foot.updateWorldMatrix(false, true);
    // A toe that would stand in a rock face draws the foot back off it (a planted foot keeps the new spot).
    if (grounded && this.wallSetBack(this.vd, leg, model, baseY, height)) {
      target.add(this.vd);
      if (leg.mode === 'pinned') leg.anchor.add(this.vd);
      this.solve(leg, target, this.facing, true, leg.soft);
      leg.foot.quaternion.copy(leg.foot.parent!.getWorldQuaternion(this.qa).invert().multiply(free)).normalize();
      leg.foot.updateWorldMatrix(false, true);
    }
    this.liftToe(leg, model, baseY, height, leg.ground.y);
    leg.foot.getWorldQuaternion(leg.lastQuat);
    leg.hasLastQuat = true;
    this.recordTilt(leg, model, baseY, height);
  }

  /** No inferred contact during flight or over a ledge: the last grounded correction fades out, so the stance foot
   * leaves the floor with the body rather than dropping to the pose (through the floor) in one frame. */
  private leaveGround(leg: Leg, deltaSec: number): void {
    leg.airFade = Math.max(0, leg.airFade - Math.max(0, deltaSec) / LIFT_OFF_SEC);
    if (leg.airFade > 0) {
      const share = smooth(leg.airFade);
      for (let i = 0; i < 3; i++) leg.bones[i]!.quaternion.slerp(leg.airQuats[i]!, share);
      leg.upper.updateWorldMatrix(false, true);
    }
    leg.correction = 0;
    leg.planted = false;
    leg.release = 0;
    leg.mode = 'free';
    leg.wasStance = false;
    leg.hasLast = false;
    leg.hasLastQuat = false;
  }

  /**
   * The ground plane under the foot, from the floor under its heel (the target) and under its toe: its pitch along
   * the foot from the two heights, its roll from the heel's face. A toe floor a wall's height above the heel is left
   * to wallSetBack and liftToe; the heel's face alone sets the plane then.
   */
  private supportNormal(out: THREE.Vector3, leg: Leg, model: THREE.Object3D, baseY: number, height: number): THREE.Vector3 {
    const target = leg.target;
    const heel = this.surface(leg.heel, model, target.x, baseY, target.z, height) ? leg.heel : leg.ground;
    out.copy(heel.normal);
    if (!leg.toe) return out;
    const toe = leg.toe.getWorldPosition(this.ve);
    const ankle = leg.foot.getWorldPosition(this.vf);
    const fx = toe.x - ankle.x, fz = toe.z - ankle.z;
    const flat = Math.hypot(fx, fz);
    if (flat < 1e-4) return out;
    const fdx = fx / flat, fdz = fz / flat;
    if (!this.surface(leg.toeGround, model, target.x + fx, baseY, target.z + fz, height)) return out;
    const rise = leg.toeGround.y - heel.y;
    if (rise > toe.distanceTo(ankle) * WALL_TOE_SHARE) return out;
    const n = heel.normal;
    // Slopes along the foot (from the two heights) and across it (from the heel's face): the plane y = g_f·f + g_s·s.
    const gf = rise / flat;
    const sx = fdz, sz = -fdx;
    const gs = n.y > 1e-3 ? -(n.x * sx + n.z * sz) / n.y : 0;
    return out.set(-gf * fdx - gs * sx, 1, -gf * fdz - gs * sz).normalize();
  }

  /** The foot's sole against the ground plane under it, for the slope checks. */
  private recordTilt(leg: Leg, model: THREE.Object3D, baseY: number, height: number): void {
    const support = this.supportNormal(this.vg, leg, model, baseY, height);
    const footUp = this.vb.copy(leg.upInFoot).applyQuaternion(leg.foot.getWorldQuaternion(this.qb));
    leg.sample.groundTiltDeg = Math.acos(THREE.MathUtils.clamp(footUp.dot(support), -1, 1)) * RAD_TO_DEG;
    leg.sample.groundSlopeDeg = Math.acos(THREE.MathUtils.clamp(support.y, -1, 1)) * RAD_TO_DEG;
  }

  /**
   * Lowers the hips until each standing or planted foot is within the straight leg's reach, beyond what the clip's own
   * pose asks of that leg (a stride's trailing leg stays as long as the clip has it). Eased; none during a reach plant.
   */
  private dropPelvis(plant: boolean, walking: boolean, height: number, deltaSec: number): void {
    const hips = this.hips;
    let wanted = 0;
    if (hips?.parent && !plant) {
      for (const leg of this.legs) {
        if (!leg.onGround || (walking && leg.mode !== 'pinned')) continue;
        const hip = leg.upper.getWorldPosition(this.va);
        const knee = leg.lower.getWorldPosition(this.vb);
        const ankle = leg.foot.getWorldPosition(this.vc);
        const reach = Math.max(PELVIS_REACH_SHARE * (hip.distanceTo(knee) + knee.distanceTo(ankle)), hip.distanceTo(leg.animated));
        const dx = hip.x - leg.target.x, dy = hip.y - leg.target.y, dz = hip.z - leg.target.z;
        const across = dx * dx + dz * dz;
        const drop = across < reach * reach ? dy - Math.sqrt(reach * reach - across) : Infinity;
        if (drop > wanted) wanted = drop;
      }
    }
    // A settle step lifts a foot off its ground for a moment: the hips hold their drop over it rather than rise and
    // come down again when it lands (the step that moves the feet together lets them up once it is down).
    let stepping = false;
    for (const leg of this.legs) if (leg.mode === 'step') stepping = true;
    if (!walking && stepping) wanted = Math.max(wanted, this.pelvisDrop);
    wanted = Math.min(wanted, height * PELVIS_DROP_MAX_RATIO);
    const ease = wanted > this.pelvisDrop || walking ? PELVIS_DROP_SEC : PELVIS_RISE_SEC;
    this.pelvisDrop += (wanted - this.pelvisDrop) * (1 - Math.exp(-Math.max(0, deltaSec) / ease));
    if (!hips?.parent || this.pelvisDrop < 1e-5) return;
    this.hipsSaved.copy(hips.position);
    this.hipsWasSaved = true;
    // World down in the hips' parent frame.
    const parentScale = Math.abs(hips.parent.getWorldScale(this.va).y) || 1;
    const down = this.vb.set(0, -1, 0).applyQuaternion(hips.parent.getWorldQuaternion(this.qa).invert());
    hips.position.addScaledVector(down, this.pelvisDrop / parentScale);
    hips.updateWorldMatrix(false, true);
  }

  /** The direction of travel, eased, from the root's own motion; facing while not walking. */
  /** Returns true when the root jumped (a teleport), not walked. */
  private updateTravel(root: THREE.Vector3, forward: THREE.Vector3, deltaSec: number, walking: boolean, height: number): boolean {
    const moved = this.va.set(root.x - this.lastRoot.x, 0, root.z - this.lastRoot.z);
    const distance = moved.length();
    const jumped = !this.hasLastRoot || distance > height * 0.5;
    this.lastRoot.copy(root);
    this.hasLastRoot = true;
    const direction = !jumped && deltaSec > 0 && distance / deltaSec > 0.02 ? moved.divideScalar(distance) : moved.copy(forward);
    if (!walking) {
      this.travel.copy(direction);
      return jumped;
    }
    // A reversal (walking off backward from a stand facing forward) is taken at once: easing through it would
    // pass the stride through sideways and sweep the feet across each other.
    if (this.travel.dot(direction) < 0) this.travel.copy(direction);
    this.travel.lerp(direction, 1 - Math.exp(-20 * Math.max(0, deltaSec)));
    if (this.travel.lengthSq() < 1e-6) this.travel.copy(direction);
    this.travel.normalize();
    return jumped;
  }

  private resetLeg(leg: Leg): void {
    leg.airFade = 0;
    leg.mode = 'free';
    leg.planted = false;
    leg.release = 0;
    leg.wasStance = false;
    leg.early = false;
    leg.step = 0;
    leg.hasLast = false;
    leg.hasLastQuat = false;
    leg.velocity.set(0, 0, 0);
    leg.stepVelocity.set(0, 0, 0);
  }

  /**
   * The clip's foot with its offset from the root turned from the blended clips' own travel to the body's: the
   * share along the clips' travel (times the stride) is laid along travel, the share across it across travel. A
   * travel more than a right angle from the clips' (the forward walk backing up, without a backward clip) keeps the
   * offset across the body, or the feet would swap sides.
   */
  private remap(out: THREE.Vector3, animated: THREE.Vector3, root: THREE.Vector3, forward: THREE.Vector3, gait: GaitState): THREE.Vector3 {
    // The clips' travel in the world: body forward and left (forward.z, -forward.x) by the gait's share of each.
    const cx = forward.x * gait.clipForward + forward.z * gait.clipLeft;
    const cz = forward.z * gait.clipForward - forward.x * gait.clipLeft;
    const length = Math.hypot(cx, cz) || 1;
    const ux = cx / length, uz = cz / length;
    const ox = animated.x - root.x, oz = animated.z - root.z;
    const along = (ox * ux + oz * uz) * gait.stride;
    const side = ox * uz - oz * ux;
    const t = this.travel;
    // Across: the travel's left when it is within a right angle of the clips' travel, else the clips' own.
    const aligned = t.x * ux + t.z * uz >= 0;
    const ax = aligned ? t.z : uz, az = aligned ? -t.x : -ux;
    return out.set(root.x + ax * side + t.x * along, animated.y, root.z + az * side + t.z * along);
  }

  /** The floor height under (x, z) for a planted foot: its own ground, else `fallback`, plus the sole. */
  private floorAt(x: number, z: number, fallback: number, sole: number): number {
    return (this.model && this.surface(this.probe, this.model, x, this.baseY, z, this.heightNow) ? this.probe.y : fallback) + sole;
  }

  /** The floor under the leg's anchor, sampled once per anchor spot in a `place` call. */
  private floorUnderAnchor(leg: Leg): number {
    if (this.anchorX !== leg.anchor.x || this.anchorZ !== leg.anchor.z) {
      this.anchorX = leg.anchor.x;
      this.anchorZ = leg.anchor.z;
      this.anchorFloor = this.floorAt(this.anchorX, this.anchorZ, this.anchorFallback, this.anchorSole);
    }
    return this.anchorFloor;
  }

  /** Where the pose has the foot (into `into`), eased from a release still under way. */
  private blended(into: THREE.Vector3, leg: Leg, posed: THREE.Vector3, deltaSec: number): THREE.Vector3 {
    into.copy(posed);
    if (leg.release > 0) into.lerp(leg.heldTarget, smooth(Math.max(0, leg.release - deltaSec / leg.releaseSec)));
    return into;
  }

  private stanceOf(leg: Leg, gait: GaitState): boolean {
    return gait.walking ? inStance(gait.gait, leg.side, gait.phase) : true;
  }

  private swingShare(leg: Leg, gait: GaitState, stance: boolean): number {
    if (!gait.walking || stance) return 0;
    const { land, lift } = gait.gait.stance[leg.side];
    const swing = (((land - lift) % 1) + 1) % 1;
    return swing > 0 ? THREE.MathUtils.clamp(((((gait.phase - lift) % 1) + 1) % 1) / swing, 0, 1) : 0;
  }

  /** The pinned foot's point: its anchor, never below the floor there. `floor`: that floor's height. */
  private pinnedAt(out: THREE.Vector3, leg: Leg, floor: number): THREE.Vector3 {
    return out.set(leg.anchor.x, Math.max(floor, leg.anchor.y), leg.anchor.z);
  }

  private letGo(leg: Leg, from: THREE.Vector3): void {
    leg.mode = 'free';
    leg.heldTarget.copy(from);
    if (leg.hasLastQuat) leg.heldQuat.copy(leg.lastQuat);
    else leg.foot.getWorldQuaternion(leg.heldQuat);
    leg.release = 1;
    leg.releaseSec = GAIT_RELEASE_SEC;
    leg.early = false;
  }

  /** One leg's foot state, into `leg.target`: pinned through each stance of the walk and while standing, a settling step otherwise. */
  private place(leg: Leg, posed: THREE.Vector3, gait: GaitState, deltaSec: number, height: number, floorY: number, sole: number): void {
    const out = leg.target;
    const stance = this.stanceOf(leg, gait);
    const landing = stance && !leg.wasStance;
    leg.wasStance = stance;
    if (landing) leg.early = false;
    const swingU = this.swingShare(leg, gait, stance);
    const hip = leg.upper.getWorldPosition(this.va);
    const knee = leg.lower.getWorldPosition(this.vb);
    const reach = (hip.distanceTo(knee) + knee.distanceTo(leg.foot.getWorldPosition(this.vc))) * OVERSTRETCH;
    // The hips stand where the pelvis drop will put them (last frame's, eased): measured from the clip's hips, a foot
    // the drop already reaches reads as out of reach and steps onto the same spot again and again.
    hip.y -= this.pelvisDrop;
    const fallback = floorY - sole;
    // One ray per anchor spot a frame, however often the checks below ask.
    this.anchorX = NaN;
    this.anchorFallback = fallback;
    this.anchorSole = sole;
    const pinned = this.vd;
    const tolerance = height * STEP_TOLERANCE_RATIO;
    let otherStepping = false;
    for (const other of this.legs) if (other !== leg && other.mode === 'step') otherStepping = true;

    if (gait.walking) {
      if (leg.mode === 'step') {
        this.letGo(leg, this.stepPosition(this.ve, leg, posed, height));
      } else if (leg.mode === 'pinned' && ((!stance && !leg.early) || this.pinnedAt(pinned, leg, this.floorUnderAnchor(leg)).distanceTo(hip) > reach)) {
        this.letGo(leg, this.pinnedAt(pinned, leg, this.floorUnderAnchor(leg)));
      } else if (leg.mode === 'free' && !stance && swingU > EARLY_SET_DOWN_SWING && leg.hasLast && leg.last.y < floorY + height * EARLY_SET_DOWN_HEIGHT_RATIO && this.reverses(leg, posed, deltaSec)) {
        // Late in the swing the clip draws the foot back before its footfall; set it down where it turned instead.
        leg.anchor.copy(leg.last);
        leg.mode = 'pinned';
        leg.early = true;
        leg.release = 0;
      } else if (leg.mode === 'free' && landing) {
        // Set down where the foot already is, so the landing never jumps.
        leg.anchor.copy(leg.hasLast ? leg.last : this.blended(this.ve, leg, posed, deltaSec));
        leg.mode = 'pinned';
        leg.release = 0;
      }
    } else if (leg.mode === 'free') {
      // Where the foot is: the pose may have moved under it as the walk ended (its stride turned and lengthened).
      const at = leg.hasLast ? leg.last : this.blended(this.ve, leg, posed, deltaSec);
      const moving = Math.hypot(leg.velocity.x, leg.velocity.z) > SET_DOWN_SPEED;
      // A foot in mid-stride when the walk ends steps on to its place, never stops dead in the air.
      if (moving || (flatDistance(at, posed) > tolerance && !otherStepping)) this.beginStep(leg, at, moving ? leg.velocity : undefined);
      else {
        leg.anchor.copy(at);
        leg.mode = 'pinned';
      }
    } else if (leg.mode === 'pinned' && ((flatDistance(leg.anchor, posed) > tolerance && !otherStepping) || (this.pinnedAt(pinned, leg, this.floorUnderAnchor(leg)).distanceTo(hip) > reach && flatDistance(leg.anchor, posed) > tolerance * UNREACHABLE_STEP_SHARE))) {
      // A foot the leg can no longer reach steps at once, even while the other is stepping: held, it would lift off its print.
      // Only a step that goes somewhere: one onto the same spot (floor out of the leg's reach there) would land
      // unreachable again and step forever, twitching the leg.
      this.beginStep(leg, this.pinnedAt(pinned, leg, this.floorUnderAnchor(leg)));
    }

    // A planted foot settles onto the floor rather than keeping the height the clip landed it at.
    if (leg.mode === 'pinned') {
      const ground = this.floorUnderAnchor(leg);
      leg.anchor.y = ground + (leg.anchor.y - ground) * Math.exp(-deltaSec / PIN_SETTLE_SEC);
      this.pinnedAt(out, leg, ground);
      return;
    }
    if (leg.mode === 'step') {
      leg.step = Math.min(1, leg.step + deltaSec / STEP_SEC);
      this.stepPosition(out, leg, posed, height);
      if (leg.step >= 1) {
        leg.anchor.copy(posed);
        leg.mode = 'pinned';
      }
      return;
    }
    out.copy(posed);
    // A swing foot clears the floor along an arc over its swing; a clip whose swing already lifts it that high gets nothing added.
    if (gait.walking && !stance) out.y = Math.max(out.y, floorY + Math.sin(Math.PI * swingU) * height * SWING_LIFT_RATIO);
    // Late in the swing the clip draws the foot back before its footfall; a foot never travels back against
    // the walk, so it holds its reach and only comes down (pinning it there would stop it dead mid-air).
    if (gait.walking && !stance && swingU > EARLY_SET_DOWN_SWING && leg.hasLast) {
      const back = (out.x - leg.last.x) * this.travel.x + (out.z - leg.last.z) * this.travel.z;
      if (back < 0) out.addScaledVector(this.travel, -back);
    }
  }

  /** Whether the foot, carried on to where the pose has it now, would turn back against how it was moving. */
  private reverses(leg: Leg, posed: THREE.Vector3, deltaSec: number): boolean {
    if (!leg.hasLast || deltaSec <= 0) return false;
    const next = this.vf.copy(posed);
    if (leg.release > 0) next.lerp(leg.heldTarget, smooth(Math.max(0, leg.release - deltaSec / leg.releaseSec)));
    const vx = (next.x - leg.last.x) / deltaSec, vz = (next.z - leg.last.z) / deltaSec;
    return vx * leg.velocity.x + vz * leg.velocity.z < 0;
  }

  /**
   * A toe the clip, the crouch or a rising slope tips below the floor is pitched up about the ankle until it
   * rests at its standing height. The floor is sampled under the toe itself: on an uphill slope the ground
   * there is higher than under the ankle.
   */
  private liftToe(leg: Leg, model: THREE.Object3D, baseY: number, height: number, ankleGroundY: number): void {
    if (!leg.toe) return;
    const ankle = leg.foot.getWorldPosition(this.va);
    const toe = leg.toe.getWorldPosition(this.vb);
    // Any upward face counts under the toe, in the same window as the ankle's probe (from about a quarter of
    // the height above the base): a rock edge too steep to stand on still stops it, and so does a ledge the
    // body is stepping down from.
    const groundY = this.surface(this.probe, model, toe.x, Math.max(baseY, toe.y + height * 0.05 - height * 0.28), toe.z, height, 0) ? this.probe.y : ankleGroundY;
    const arm = this.vc.copy(toe).sub(ankle);
    const length = arm.length();
    const flat = Math.hypot(arm.x, arm.z);
    if (length < 1e-5 || flat < 1e-5) return;
    // Down a slope the toe stands on its own ground; over a drop steeper than a foot can tilt to (a ledge the body is
    // stepping down from) it holds at the ankle's ground, level, rather than point down over the edge.
    const ledge = ankleGroundY - groundY > flat * MAX_FOOT_TILT_TAN;
    const floorY = (ledge ? ankleGroundY : groundY) + height * leg.toeRatio;
    if (toe.y >= floorY) return;
    // The toe's height below the ankle it may have, kept on its circle about the ankle.
    const drop = THREE.MathUtils.clamp(floorY - ankle.y, -length, length);
    const lifted = this.vd.set(arm.x / flat, 0, arm.z / flat).multiplyScalar(Math.sqrt(Math.max(0, length * length - drop * drop))).setY(drop);
    const turn = this.qb.setFromUnitVectors(arm.normalize(), lifted.normalize());
    const world = turn.multiply(leg.foot.getWorldQuaternion(this.qd));
    leg.foot.quaternion.copy(leg.foot.parent!.getWorldQuaternion(this.qa).invert().multiply(world)).normalize();
    leg.foot.updateWorldMatrix(false, true);
  }

  /**
   * How far to draw the foot back (into `out`) so its toe stays out of a rock face: where the floor along the foot
   * rises above the ankle by more than the toe could pitch up over, the toe would stand inside the rock. False when clear.
   */
  private wallSetBack(out: THREE.Vector3, leg: Leg, model: THREE.Object3D, baseY: number, height: number): boolean {
    if (!leg.toe) return false;
    const ankle = leg.foot.getWorldPosition(this.va);
    const toe = leg.toe.getWorldPosition(this.vb);
    const along = out.set(toe.x - ankle.x, 0, toe.z - ankle.z);
    const reach = along.length();
    if (reach < 1e-5) return false;
    along.divideScalar(reach);
    const rise = ankle.distanceTo(toe) * WALL_TOE_SHARE;
    // Looks for rock from just over the ankle to half a body above it: a face taller than the probe window is still a face.
    const start = Math.max(baseY, ankle.y) + height * 0.3;
    const ax = ankle.x, ay = ankle.y, az = ankle.z;
    if (!this.walled(model, ax, ay, az, along, reach, 1, start, height, leg.toeRatio, rise)) return false;
    // Where along the foot the face stands, to a sixteenth of the foot.
    let clear = 0, wall = 1;
    for (let i = 0; i < 4; i++) {
      const mid = (clear + wall) / 2;
      if (this.walled(model, ax, ay, az, along, reach, mid, start, height, leg.toeRatio, rise)) wall = mid; else clear = mid;
    }
    along.multiplyScalar(-(reach * (1 - clear) + height * WALL_CLEARANCE_RATIO));
    return true;
  }

  /** Whether the floor `share` along the foot stands above the ankle by more than the toe could pitch up over. */
  private walled(
    model: THREE.Object3D, ax: number, ay: number, az: number, along: THREE.Vector3, reach: number, share: number,
    start: number, height: number, toeRatio: number, rise: number
  ): boolean {
    return this.surface(this.probe, model, ax + along.x * reach * share, start, az + along.z * reach * share, height, 0) && this.probe.y + height * toeRatio - ay > rise;
  }

  private beginStep(leg: Leg, from: THREE.Vector3, velocity?: THREE.Vector3): void {
    leg.mode = 'step';
    leg.step = 0;
    leg.stepFrom.copy(from);
    if (velocity) leg.stepVelocity.copy(velocity);
    else leg.stepVelocity.set(0, 0, 0);
    leg.release = 0;
  }

  /**
   * Along the step (into `out`) from where the foot stood to where the pose wants it, lifted mid-way: a cubic that
   * leaves at the foot's own speed (zero from standing) and arrives at rest.
   */
  private stepPosition(out: THREE.Vector3, leg: Leg, posed: THREE.Vector3, height: number): THREE.Vector3 {
    const u = leg.step;
    const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u, h01 = -2 * u ** 3 + 3 * u ** 2;
    out.copy(leg.stepFrom).multiplyScalar(h00).addScaledVector(leg.stepVelocity, h10 * STEP_SEC).addScaledVector(posed, h01);
    const lift = leg.stepVelocity.lengthSq() > 0 ? 0 : Math.sin(Math.PI * u) * height * STEP_LIFT_RATIO;
    out.y = Math.max(out.y, Math.min(leg.stepFrom.y, posed.y)) + lift;
    return out;
  }

  /**
   * The ground at (x, z) near `y` into `out`, on faces whose normal's y is at least `minNormalY` (by default what the
   * character walks on). False where there is none.
   */
  private surface(out: Ground, world: THREE.Object3D, x: number, y: number, z: number, height: number, minNormalY = WALKABLE_NORMAL_Y): boolean {
    // A probe from just above the hips' reach down past the foot (the leg's span), as a downward ray would.
    const top = y + height * 0.28;
    const ground = TerrainHeightIndex.of(world).heightAt(x, z, top, top - height * 0.55, minNormalY - 1e-6, out.normal);
    if (ground === undefined) return false;
    out.y = ground;
    return true;
  }

  private solve(leg: Leg, target: THREE.Vector3, facing: THREE.Vector3, kneesForward: boolean, soft = 0): void {
    const hip = leg.upper.getWorldPosition(this.va);
    const knee = leg.lower.getWorldPosition(this.vb);
    const ankle = leg.foot.getWorldPosition(this.vc);
    const a = hip.distanceTo(knee), b = knee.distanceTo(ankle);
    if (a < 1e-5 || b < 1e-5) return;
    const axis = this.vd.copy(target).sub(hip);
    // Soft reach: near full extension the knee's offset changes as the square root of the slack, so a leg
    // straightening and bending again snaps the knee. Ease the last few centimetres of reach instead.
    const softness = (a + b) * SOFT_REACH_RATIO * soft;
    const start = a + b - softness;
    const wanted = axis.length();
    const eased = softness > 0 && wanted > start ? start + softness * (1 - Math.exp(-(wanted - start) / softness)) : wanted;
    const distance = THREE.MathUtils.clamp(eased, Math.abs(a - b) + 1e-5, a + b - 1e-5);
    if (axis.lengthSq() < 1e-10) return;
    axis.normalize();
    const kneeOut = this.ve.copy(knee).sub(hip);
    const pole = this.vf.copy(kneeOut).addScaledVector(axis, -kneeOut.dot(axis));
    // A knee bends forward. A deep squat folds the leg so far that the folded knee lies on the axis or behind it; keep the bend plane forward then, never flip the knee backward.
    const forward = this.vg.copy(facing).addScaledVector(axis, -facing.dot(axis));
    if (forward.lengthSq() > 1e-6 && (kneesForward || pole.lengthSq() < a * a * 0.001 || pole.dot(forward) < 0)) pole.copy(forward);
    if (pole.lengthSq() < 1e-10) return;
    pole.normalize();
    const along = (a * a + distance * distance - b * b) / (2 * distance);
    const bend = Math.sqrt(Math.max(0, a * a - along * along));
    // Knee target, relative to the hip.
    const kneeTarget = this.vg.copy(axis).multiplyScalar(along).addScaledVector(pole, bend);
    this.aim(leg.upper, kneeOut, kneeTarget);
    const newKnee = leg.lower.getWorldPosition(this.vb);
    const newAnkle = leg.foot.getWorldPosition(this.vc).sub(newKnee);
    // The reachable target, relative to the new knee.
    const reachable = this.ve.copy(hip).addScaledVector(axis, distance).sub(newKnee);
    this.aim(leg.lower, newAnkle, reachable);
  }

  /** Turns `bone` so its world direction `from` points along `to` (both are normalized in place). */
  private aim(bone: THREE.Bone, from: THREE.Vector3, to: THREE.Vector3): void {
    if (from.lengthSq() < 1e-10 || to.lengthSq() < 1e-10) return;
    const world = bone.getWorldQuaternion(this.qa);
    const parent = bone.parent!.getWorldQuaternion(this.qb);
    const delta = this.qd.setFromUnitVectors(from.normalize(), to.normalize());
    bone.quaternion.copy(parent.invert().multiply(delta).multiply(world)).normalize();
    bone.updateWorldMatrix(false, true);
  }
}
