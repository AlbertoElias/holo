import * as THREE from 'three';
import type { AvatarRig } from '../avatar/AvatarRig';
import { inStance, type GaitLeg, type GaitState } from './LocomotionAnimator';

/**
 * How a foot is placed on the animation path:
 * - `free`: where the (direction-remapped) clip puts it, easing out of a release;
 * - `pinned`: held at a world point (a stance of the walk, or standing);
 * - `step`: a settling step from where it stood to where the pose wants it.
 */
type FootMode = 'free' | 'pinned' | 'step';
type Leg = {
  side: GaitLeg;
  upper: THREE.Bone; lower: THREE.Bone; foot: THREE.Bone; toe: THREE.Object3D | undefined;
  upInFoot: THREE.Vector3;
  /** Rest ankle height above the sole plane, as a share of the avatar's height. */
  ankleRatio: number;
  /** Rest toe height above the sole plane, as a share of the avatar's height. */
  toeRatio: number;
  correction: number; planted: boolean; plantCorrection: number;
  heldTarget: THREE.Vector3; heldQuat: THREE.Quaternion; release: number; releaseSec: number;
  /** Where the foot was put last frame and how fast it was moving, so a step out of a stride carries its speed. */
  last: THREE.Vector3 | undefined; velocity: THREE.Vector3; stepVelocity: THREE.Vector3; lastQuat: THREE.Quaternion | undefined;
  /** Set down before the clip's footfall; held until that stance ends. */
  early: boolean;
  /** 0 to 1: how far this leg's reach is softened. */
  soft: number;
  mode: FootMode; anchor: THREE.Vector3; stepFrom: THREE.Vector3; step: number; wasStance: boolean;
};
type LegSample = {
  side: string;
  foot: { x: number; y: number; z: number };
  groundY: number | null;
  correction: number;
  upper: number[];
  lower: number[];
  mode: FootMode;
};

/** A released plant eases the foot back to the animation over this long. */
const PLANT_RELEASE_SEC = 0.15;
/** A foot leaving its stance at the start of a walk eases into the stride over this long. */
const GAIT_RELEASE_SEC = 0.25;
/** Time constant for a planted foot settling onto the floor. */
const PIN_SETTLE_SEC = 0.06;
/** Mid-swing clearance added to the walk's swing foot, as a share of the avatar's height. */
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
/**
 * A pinned foot lets go once it lies this far past the straight leg's reach (share of the leg's length):
 * a walk lands on a nearly straight leg, and the IK holds the rest by drawing the foot in, a slide kept under 3 cm.
 */
const OVERSTRETCH = 1.03;

const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * Post-animation, leg-only terrain adaptation and foot planting; the one
 * writer of the legs on the animation path. No calibration or root ownership.
 * With the walk's measured footfalls (`GaitState`), a foot is pinned to the
 * ground for its stance and the clip's stride is turned toward the direction
 * of travel, so strafing and backing up plant their feet like walking does.
 */
export class TerrainLegSolver {
  private avatar: THREE.Object3D | undefined;
  private legs: Leg[] = [];
  private readonly originals = new Map<THREE.Bone, THREE.Quaternion>();
  private readonly ray = new THREE.Raycaster();
  private readonly down = new THREE.Vector3(0, -1, 0);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly normalMatrix = new THREE.Matrix3();
  private samples: LegSample[] = [];
  private readonly lastRoot = new THREE.Vector3();
  private hasLastRoot = false;
  private readonly travel = new THREE.Vector3(0, 0, 1);

  restore(): void {
    for (const [bone, quaternion] of this.originals) bone.quaternion.copy(quaternion);
    this.originals.clear();
  }

  getSnapshot(): readonly LegSample[] { return this.samples; }

  attach(rig: AvatarRig): void {
    rig.avatarRoot.updateWorldMatrix(true, true);
    this.avatar = rig.avatar;
    this.legs = [];
    this.hasLastRoot = false;
    const baseY = rig.avatarRoot.getWorldPosition(new THREE.Vector3()).y + rig.avatarMinLocalY;
    for (const side of ['left', 'right'] as const) {
      const upper = rig.bone(`${side}UpperLeg`), lower = rig.bone(`${side}LowerLeg`), foot = rig.bone(`${side}Foot`);
      if (!upper || !lower || !foot) continue;
      const ankleRatio = Math.max(0.02, (foot.getWorldPosition(new THREE.Vector3()).y - baseY) / Math.max(rig.avatarHeight, 1e-3));
      const toe = rig.bone(`${side}Toes`);
      const toeRatio = toe ? Math.max(0, (toe.getWorldPosition(new THREE.Vector3()).y - baseY) / Math.max(rig.avatarHeight, 1e-3)) : 0;
      this.legs.push({
        side, upper, lower, foot, toe, ankleRatio, toeRatio,
        upInFoot: this.up.clone().applyQuaternion(foot.getWorldQuaternion(new THREE.Quaternion()).invert()),
        correction: 0, planted: false, plantCorrection: 0, heldTarget: new THREE.Vector3(), heldQuat: new THREE.Quaternion(), release: 0, releaseSec: PLANT_RELEASE_SEC,
        last: undefined, velocity: new THREE.Vector3(), stepVelocity: new THREE.Vector3(), lastQuat: undefined, early: false, soft: 0,
        mode: 'free', anchor: new THREE.Vector3(), stepFrom: new THREE.Vector3(), step: 0, wasStance: false
      });
    }
  }

  /**
   * `plant`: a reach is driving the pose; each foot stays where it stood when the reach began.
   * `gait`: the walk's footfalls; without it the feet follow the animation (no planting).
   */
  update(rig: AvatarRig, grounded: boolean, deltaSec: number, plant = false, bent = false, gait?: GaitState): void {
    if (this.avatar !== rig.avatar) this.attach(rig);
    this.samples = [];
    if (!rig.worldModel || !rig.avatar) return;
    rig.avatarRoot.updateWorldMatrix(true, true);
    const height = rig.avatarHeight;
    const root = rig.avatarRoot.getWorldPosition(new THREE.Vector3());
    const facing = rig.facingWorld(new THREE.Vector3());
    const forward = new THREE.Vector3(facing.x, 0, facing.z);
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, 1);
    forward.normalize();
    const walking = gait?.walking ?? false;
    // A teleport (respawn, a world swap, leaving XR) drops every plant: a pinned foot would sweep from the old spot.
    if (this.updateTravel(root, forward, deltaSec, walking, height)) for (const leg of this.legs) this.resetLeg(leg);
    // Sample only around the support plane, never from the top of the room.
    const baseY = root.y + rig.avatarMinLocalY;
    const center = this.surface(rig.worldModel, root.x, baseY, root.z, height);
    for (const [index, leg] of this.legs.entries()) {
      const animated = leg.foot.getWorldPosition(new THREE.Vector3());
      const animatedQuat = leg.foot.getWorldQuaternion(new THREE.Quaternion());
      // Strafing or backing up plays the forward walk with its stride turned toward travel.
      const foot = walking && !plant ? this.remap(animated, root, forward, gait?.stride ?? 1) : animated.clone();
      const surface = grounded ? this.surface(rig.worldModel, foot.x, baseY, foot.z, height) : undefined;
      if (surface && center) {
        for (const bone of [leg.upper, leg.lower, leg.foot]) this.originals.set(bone, bone.quaternion.clone());
        const sole = height * leg.ankleRatio;
        // Preserve the authored swing arc, shifting it by local terrain elevation.
        let target: THREE.Vector3;
        if (plant) {
          // Planted at the start of the reach, at the height the foot stood at then.
          if (!leg.planted) {
            leg.planted = true;
            leg.plantCorrection = leg.correction;
          }
          const stand = rig.plantFeet[index === 0 ? 'left' : 'right'];
          target = new THREE.Vector3(stand.x, stand.y + leg.plantCorrection, stand.z);
          leg.correction = target.y - foot.y;
          leg.heldTarget.copy(target);
          leg.heldQuat.copy(rig.plantFootQuats[index === 0 ? 'left' : 'right']);
          leg.release = 1;
          leg.releaseSec = PLANT_RELEASE_SEC;
          leg.mode = 'free';
        } else {
          leg.planted = false;
          const desired = THREE.MathUtils.clamp(Math.max(surface.point.y - center.point.y, surface.point.y + sole - foot.y), -height * 0.18, height * 0.22);
          leg.correction = THREE.MathUtils.lerp(leg.correction, desired, 1 - Math.exp(-18 * Math.max(0, deltaSec)));
          const posed = foot.clone();
          // A grounded foot never sinks below its resting height, however the crouch or the clip bends the leg.
          posed.y = Math.max(posed.y + leg.correction, surface.point.y + sole);
          // A pinned foot stands on the floor under its anchor, not under where the pose has the foot.
          const floorAt = (x: number, z: number) => (this.surface(rig.worldModel!, x, baseY, z, height)?.point.y ?? surface.point.y) + sole;
          target = gait ? this.place(leg, posed, gait, deltaSec, height, surface.point.y + sole, floorAt) : posed;
          // Letting go of a plant eases the foot from where it was held to where the pose has it, not a snap.
          if (leg.release > 0) {
            leg.release = Math.max(0, leg.release - deltaSec / leg.releaseSec);
            target.lerp(leg.heldTarget, smooth(leg.release));
            target.y = Math.max(target.y, surface.point.y + sole);
          }
        }
        if (leg.last && deltaSec > 0) leg.velocity.copy(target).sub(leg.last).divideScalar(deltaSec);
        else leg.velocity.set(0, 0, 0);
        leg.last = target.clone();
        // Knees always bend forward, the way the body faces.
        // A walking or stepping leg eases into full extension; a leg standing planted keeps its full length, so it never lifts off its footprint.
        leg.soft = THREE.MathUtils.clamp(leg.soft + (gait && (walking || leg.mode !== 'pinned') ? 1 : -1) * deltaSec / SOFT_REACH_FADE_SEC, 0, 1);
        this.solve(leg, target, facing, gait ? true : plant || bent, leg.soft);
        if (plant) {
          // A planted foot keeps its orientation: at a deep squat the shin folds so far that tilting it toward the floor would spin it.
          const planted = rig.plantFootQuats[index === 0 ? 'left' : 'right'];
          const parentRotation = leg.foot.parent!.getWorldQuaternion(new THREE.Quaternion());
          leg.foot.quaternion.copy(parentRotation.invert().multiply(planted)).normalize();
          leg.foot.updateWorldMatrix(false, true);
        } else {
          // The clip's foot orientation, rotated toward the support normal while near contact.
          const contact = 1 - THREE.MathUtils.smoothstep(target.y - surface.point.y - sole, height * 0.025, height * 0.15);
          const worldRotation = gait ? animatedQuat : leg.foot.getWorldQuaternion(new THREE.Quaternion());
          const footUp = leg.upInFoot.clone().applyQuaternion(worldRotation);
          const tilt = new THREE.Quaternion().setFromUnitVectors(footUp, surface.normal);
          tilt.slerp(new THREE.Quaternion(), 1 - contact);
          const parentRotation = leg.foot.parent!.getWorldQuaternion(new THREE.Quaternion());
          const free = tilt.multiply(worldRotation);
          if (leg.release > 0) free.slerp(leg.heldQuat, smooth(leg.release));
          // A walking foot turns no faster than it can: the clip's crossfades swing it within a frame or two.
          if (gait && leg.lastQuat) free.copy(leg.lastQuat.clone().slerp(free, 1 - Math.exp(-deltaSec / FOOT_TURN_SEC)));
          leg.foot.quaternion.copy(parentRotation.invert().multiply(free)).normalize();
          leg.foot.updateWorldMatrix(false, true);
          this.liftToe(leg, surface.point.y + height * leg.toeRatio);
          leg.lastQuat = leg.foot.getWorldQuaternion(new THREE.Quaternion());
        }
      } else {
        // No inferred contact during flight or over a ledge.
        leg.correction = 0;
        leg.planted = false;
        leg.release = 0;
        leg.mode = 'free';
        leg.wasStance = false;
        leg.last = undefined;
        leg.lastQuat = undefined;
      }
      const resolved = leg.foot.getWorldPosition(new THREE.Vector3());
      this.samples.push({ side: leg.side, foot: { x: resolved.x, y: resolved.y, z: resolved.z }, groundY: surface?.point.y ?? null, correction: leg.correction, upper: leg.upper.quaternion.toArray(), lower: leg.lower.quaternion.toArray(), mode: leg.mode });
    }
  }

  /** The direction of travel, eased, from the root's own motion; facing while not walking. */
  /** Returns true when the root jumped (a teleport), not walked. */
  private updateTravel(root: THREE.Vector3, forward: THREE.Vector3, deltaSec: number, walking: boolean, height: number): boolean {
    const moved = new THREE.Vector3(root.x - this.lastRoot.x, 0, root.z - this.lastRoot.z);
    const jumped = !this.hasLastRoot || moved.length() > height * 0.5;
    this.lastRoot.copy(root);
    this.hasLastRoot = true;
    const direction = !jumped && deltaSec > 0 && moved.length() / deltaSec > 0.02 ? moved.normalize() : forward.clone();
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
    leg.mode = 'free';
    leg.planted = false;
    leg.release = 0;
    leg.wasStance = false;
    leg.early = false;
    leg.step = 0;
    leg.last = undefined;
    leg.lastQuat = undefined;
    leg.velocity.set(0, 0, 0);
    leg.stepVelocity.set(0, 0, 0);
  }

  /** The clip's foot with its fore-aft offset from the root laid along the direction of travel. */
  private remap(animated: THREE.Vector3, root: THREE.Vector3, forward: THREE.Vector3, stride: number): THREE.Vector3 {
    const across = new THREE.Vector3(forward.z, 0, -forward.x);
    const offset = new THREE.Vector3(animated.x - root.x, 0, animated.z - root.z);
    const along = offset.dot(forward) * stride;
    const side = offset.dot(across);
    return new THREE.Vector3(root.x, animated.y, root.z).addScaledVector(across, side).addScaledVector(this.travel, along);
  }

  /** One leg's foot state: pinned through each stance of the walk and while standing, a settling step otherwise. */
  private place(
    leg: Leg, posed: THREE.Vector3, gait: GaitState, deltaSec: number, height: number, floorY: number,
    floorAt: (x: number, z: number) => number
  ): THREE.Vector3 {
    const stance = gait.walking ? inStance(gait.gait, leg.side, gait.phase) : true;
    const landing = stance && !leg.wasStance;
    leg.wasStance = stance;
    if (landing) leg.early = false;
    const swingU = (() => {
      if (!gait.walking || stance) return 0;
      const { land, lift } = gait.gait.stance[leg.side];
      const swing = (((land - lift) % 1) + 1) % 1;
      return swing > 0 ? THREE.MathUtils.clamp(((((gait.phase - lift) % 1) + 1) % 1) / swing, 0, 1) : 0;
    })();
    const hip = leg.upper.getWorldPosition(new THREE.Vector3());
    const reach = (leg.upper.getWorldPosition(new THREE.Vector3()).distanceTo(leg.lower.getWorldPosition(new THREE.Vector3())) +
      leg.lower.getWorldPosition(new THREE.Vector3()).distanceTo(leg.foot.getWorldPosition(new THREE.Vector3()))) * OVERSTRETCH;
    // One ray per anchor spot a frame, however often the checks below ask.
    let cached: { x: number; z: number; y: number } | undefined;
    const anchorFloor = () => {
      if (!cached || cached.x !== leg.anchor.x || cached.z !== leg.anchor.z) cached = { x: leg.anchor.x, z: leg.anchor.z, y: floorAt(leg.anchor.x, leg.anchor.z) };
      return cached.y;
    };
    const pinnedAt = () => new THREE.Vector3(leg.anchor.x, Math.max(anchorFloor(), leg.anchor.y), leg.anchor.z);
    const letGo = (from: THREE.Vector3) => {
      leg.mode = 'free';
      leg.heldTarget.copy(from);
      leg.heldQuat.copy(leg.lastQuat ?? leg.foot.getWorldQuaternion(new THREE.Quaternion()));
      leg.release = 1;
      leg.releaseSec = GAIT_RELEASE_SEC;
      leg.early = false;
    };
    const blended = () => leg.release > 0 ? posed.clone().lerp(leg.heldTarget, smooth(Math.max(0, leg.release - deltaSec / leg.releaseSec))) : posed.clone();
    const tolerance = height * STEP_TOLERANCE_RATIO;
    const flatDistance = (a: THREE.Vector3, b: THREE.Vector3) => Math.hypot(a.x - b.x, a.z - b.z);
    const otherStepping = this.legs.some((other) => other !== leg && other.mode === 'step');

    if (gait.walking) {
      if (leg.mode === 'step') {
        letGo(this.stepPosition(leg, posed, height));
      } else if (leg.mode === 'pinned' && ((!stance && !leg.early) || pinnedAt().distanceTo(hip) > reach)) {
        letGo(pinnedAt());
      } else if (leg.mode === 'free' && !stance && swingU > EARLY_SET_DOWN_SWING && leg.last && leg.last.y < floorY + height * EARLY_SET_DOWN_HEIGHT_RATIO && this.reverses(leg, posed, deltaSec)) {
        // Late in the swing the clip draws the foot back before its footfall; set it down where it turned instead.
        leg.anchor.copy(leg.last);
        leg.mode = 'pinned';
        leg.early = true;
        leg.release = 0;
      } else if (leg.mode === 'free' && landing) {
        // Set down where the foot already is, so the landing never jumps.
        const at = leg.last ?? blended();
        leg.anchor.set(at.x, at.y, at.z);
        leg.mode = 'pinned';
        leg.release = 0;
      }
    } else if (leg.mode === 'free') {
      // Where the foot is: the pose may have moved under it as the walk ended (its stride turned and lengthened).
      const at = leg.last ?? blended();
      const moving = Math.hypot(leg.velocity.x, leg.velocity.z) > SET_DOWN_SPEED;
      // A foot in mid-stride when the walk ends steps on to its place, never stops dead in the air.
      if (moving || (flatDistance(at, posed) > tolerance && !otherStepping)) this.beginStep(leg, at, moving ? leg.velocity : undefined);
      else {
        leg.anchor.set(at.x, at.y, at.z);
        leg.mode = 'pinned';
      }
    } else if (leg.mode === 'pinned' && ((flatDistance(leg.anchor, posed) > tolerance && !otherStepping) || pinnedAt().distanceTo(hip) > reach)) {
      // A foot the leg can no longer reach steps at once, even while the other is stepping: held, it would lift off its print.
      this.beginStep(leg, pinnedAt());
    }

    // A planted foot settles onto the floor rather than keeping the height the clip landed it at.
    if (leg.mode === 'pinned') {
      const ground = anchorFloor();
      leg.anchor.y = ground + (leg.anchor.y - ground) * Math.exp(-deltaSec / PIN_SETTLE_SEC);
      return pinnedAt();
    }
    if (leg.mode === 'step') {
      leg.step = Math.min(1, leg.step + deltaSec / STEP_SEC);
      const at = this.stepPosition(leg, posed, height);
      if (leg.step >= 1) {
        leg.anchor.set(posed.x, posed.y, posed.z);
        leg.mode = 'pinned';
      }
      return at;
    }
    const out = posed.clone();
    // The shipped walk shuffles; lift the swing foot clear of the floor along an arc over its swing.
    if (gait.walking && !stance) out.y += Math.sin(Math.PI * swingU) * height * SWING_LIFT_RATIO;
    // Late in the swing the clip draws the foot back before its footfall; a foot never travels back against
    // the walk, so it holds its reach and only comes down (pinning it there would stop it dead mid-air).
    if (gait.walking && !stance && swingU > EARLY_SET_DOWN_SWING && leg.last) {
      const back = (out.x - leg.last.x) * this.travel.x + (out.z - leg.last.z) * this.travel.z;
      if (back < 0) out.addScaledVector(this.travel, -back);
    }
    return out;
  }

  /** Whether the foot, carried on to where the pose has it now, would turn back against how it was moving. */
  private reverses(leg: Leg, posed: THREE.Vector3, deltaSec: number): boolean {
    if (!leg.last || deltaSec <= 0) return false;
    const next = posed.clone();
    if (leg.release > 0) next.lerp(leg.heldTarget, smooth(Math.max(0, leg.release - deltaSec / leg.releaseSec)));
    const vx = (next.x - leg.last.x) / deltaSec, vz = (next.z - leg.last.z) / deltaSec;
    return vx * leg.velocity.x + vz * leg.velocity.z < 0;
  }

  /** A toe the clip or the crouch tips below the floor is pitched up about the ankle until it rests at its standing height. */
  private liftToe(leg: Leg, floorY: number): void {
    if (!leg.toe) return;
    const ankle = leg.foot.getWorldPosition(new THREE.Vector3());
    const toe = leg.toe.getWorldPosition(new THREE.Vector3());
    if (toe.y >= floorY) return;
    const arm = toe.clone().sub(ankle);
    const length = arm.length();
    const flat = Math.hypot(arm.x, arm.z);
    if (length < 1e-5 || flat < 1e-5) return;
    // The toe's height below the ankle it may have, kept on its circle about the ankle.
    const drop = THREE.MathUtils.clamp(floorY - ankle.y, -length, length);
    const lifted = new THREE.Vector3(arm.x / flat, 0, arm.z / flat).multiplyScalar(Math.sqrt(Math.max(0, length * length - drop * drop))).setY(drop);
    const turn = new THREE.Quaternion().setFromUnitVectors(arm.normalize(), lifted.normalize());
    const world = turn.multiply(leg.foot.getWorldQuaternion(new THREE.Quaternion()));
    leg.foot.quaternion.copy(leg.foot.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(world)).normalize();
    leg.foot.updateWorldMatrix(false, true);
  }

  private beginStep(leg: Leg, from: THREE.Vector3, velocity?: THREE.Vector3): void {
    leg.mode = 'step';
    leg.step = 0;
    leg.stepFrom.copy(from);
    leg.stepVelocity.copy(velocity ?? new THREE.Vector3());
    leg.release = 0;
  }

  /**
   * Along the step from where the foot stood to where the pose wants it, lifted mid-way: a cubic that
   * leaves at the foot's own speed (zero from standing) and arrives at rest.
   */
  private stepPosition(leg: Leg, posed: THREE.Vector3, height: number): THREE.Vector3 {
    const u = leg.step;
    const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u, h01 = -2 * u ** 3 + 3 * u ** 2;
    const at = leg.stepFrom.clone().multiplyScalar(h00).addScaledVector(leg.stepVelocity, h10 * STEP_SEC).addScaledVector(posed, h01);
    const lift = leg.stepVelocity.lengthSq() > 0 ? 0 : Math.sin(Math.PI * u) * height * STEP_LIFT_RATIO;
    at.y = Math.max(at.y, Math.min(leg.stepFrom.y, posed.y)) + lift;
    return at;
  }

  private surface(world: THREE.Object3D, x: number, y: number, z: number, height: number) {
    this.ray.set(new THREE.Vector3(x, y + height * 0.28, z), this.down);
    this.ray.near = 0;
    this.ray.far = height * 0.55;
    for (const hit of this.ray.intersectObject(world, true)) {
      if (!hit.face) continue;
      this.normalMatrix.getNormalMatrix(hit.object.matrixWorld);
      const normal = hit.face.normal.clone().applyNormalMatrix(this.normalMatrix);
      if (normal.y >= Math.cos(THREE.MathUtils.degToRad(40))) return { point: hit.point, normal };
    }
    return undefined;
  }

  private solve(leg: Leg, target: THREE.Vector3, facing: THREE.Vector3, kneesForward: boolean, soft = 0): void {
    const hip = leg.upper.getWorldPosition(new THREE.Vector3());
    const knee = leg.lower.getWorldPosition(new THREE.Vector3());
    const ankle = leg.foot.getWorldPosition(new THREE.Vector3());
    const a = hip.distanceTo(knee), b = knee.distanceTo(ankle);
    if (a < 1e-5 || b < 1e-5) return;
    const axis = target.clone().sub(hip);
    // Soft reach: near full extension the knee's offset changes as the square root of the slack, so a leg
    // straightening and bending again snaps the knee. Ease the last few centimetres of reach instead.
    const softness = (a + b) * SOFT_REACH_RATIO * soft;
    const start = a + b - softness;
    const wanted = axis.length();
    const eased = softness > 0 && wanted > start ? start + softness * (1 - Math.exp(-(wanted - start) / softness)) : wanted;
    const distance = THREE.MathUtils.clamp(eased, Math.abs(a - b) + 1e-5, a + b - 1e-5);
    if (axis.lengthSq() < 1e-10) return;
    axis.normalize();
    const pole = knee.clone().sub(hip).addScaledVector(axis, -knee.clone().sub(hip).dot(axis));
    // A knee bends forward. A deep squat folds the leg so far that the folded knee lies on the axis or behind it; keep the bend plane forward then, never flip the knee backward.
    const forward = facing.clone().addScaledVector(axis, -facing.dot(axis));
    if (forward.lengthSq() > 1e-6 && (kneesForward || pole.lengthSq() < a * a * 0.001 || pole.dot(forward) < 0)) pole.copy(forward);
    if (pole.lengthSq() < 1e-10) return;
    pole.normalize();
    const along = (a * a + distance * distance - b * b) / (2 * distance);
    const bend = Math.sqrt(Math.max(0, a * a - along * along));
    const kneeTarget = hip.clone().addScaledVector(axis, along).addScaledVector(pole, bend);
    this.aim(leg.upper, knee.clone().sub(hip), kneeTarget.clone().sub(hip));
    const newKnee = leg.lower.getWorldPosition(new THREE.Vector3());
    const newAnkle = leg.foot.getWorldPosition(new THREE.Vector3());
    const reachableTarget = hip.clone().addScaledVector(axis, distance);
    this.aim(leg.lower, newAnkle.sub(newKnee), reachableTarget.sub(newKnee));
  }

  private aim(bone: THREE.Bone, from: THREE.Vector3, to: THREE.Vector3): void {
    if (from.lengthSq() < 1e-10 || to.lengthSq() < 1e-10) return;
    const world = bone.getWorldQuaternion(new THREE.Quaternion());
    const parent = bone.parent!.getWorldQuaternion(new THREE.Quaternion());
    const delta = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
    bone.quaternion.copy(parent.invert().multiply(delta).multiply(world)).normalize();
    bone.updateWorldMatrix(false, true);
  }
}
