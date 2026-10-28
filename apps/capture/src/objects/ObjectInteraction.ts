import * as THREE from 'three';

import type { AvatarRig } from '../avatar/AvatarRig';
import type { HandPoseSource, VrHandSide } from '../types/contracts';
import type { ObjectPhysics } from '../physics/ObjectPhysics';
import type { XrTracking } from '../xr/XrTracking';
import type { DesktopCarryPose } from './DesktopCarryPose';
import { DesktopReach, REACH_PALM_M, REACH_STEP_AHEAD_M, REACH_TARGET_FRACTION } from './DesktopReach';
import type { GrabIntent, ObjectGrabInput } from './ObjectGrabInput';
import type { ObjectTray } from './ObjectTray';
import type { SceneObject, SceneObjectRegistry } from './SceneObjectRegistry';

const SIDES = ['left', 'right'] as const;
// A grab needs the avatar's palm this close to the object's bounds.
const VR_REACH_M = 0.1;
// Desktop: an object at or above the shoulder, its bounds within this fraction of the arm's reach of the shoulder joint.
const DESKTOP_REACH_FRACTION = 1.15;
// An object below the shoulder, its bounds within one arm's reach of the shoulder, measured across the floor; and no nearer than this to the feet.
const DESKTOP_LOW_FEET_M = 0.15;
// A squat set-down takes the hand to the floor at this pace (within these bounds), and aims this far past the release gap.
const LOWER_MAX_SEC = 0.5;
const LOWER_MIN_SEC = 0.3;
// After the hand has been sent, the squat gets this long to catch up before the prop is let go where it is.
const LOWER_SETTLE_SEC = 0.4;
const LOWER_HAND_MPS = 2.2;
const LOWER_OVERSHOOT_M = 0.01;
// A reach for a low prop may start this far beyond the arm's reach across the floor: the avatar steps in first.
const DESKTOP_STEP_ALLOWANCE_M = 0.25;
// A reach steps in first only for a grasp point below this fraction of the avatar's height (hip height and under): a chest-high prop is bent for in place.
const REACH_STEP_BELOW_HEIGHT_FRACTION = 0.5;
// Tracking loss: the object freezes, then is released where it is.
const LOST_RELEASE_SEC = 0.5;
const TRACKED_SOURCES: ReadonlySet<HandPoseSource> = new Set(['xr-hand', 'controller', 'mock']);
const TURN_RAD_PER_SEC = Math.PI / 2;
// Where a prepared object first appears: in front of the avatar's chest.
const PLACE_FORWARD_M = 0.45;
const PLACE_BELOW_EYES_M = 0.45;
// A desktop release slower than this (fitted from the prop's own poses) sets the
// prop down; a faster one throws.
const SET_DOWN_MAX_MPS = 0.3;
// A set-down lowers the carrying hand, and the prop rigidly with it, over this
// long, then lets go this far above the surface.
const SET_DOWN_SEC = 0.3;
const SET_DOWN_RELEASE_GAP_M = 0.02;
const SET_DOWN_SEARCH_M = 3;

export interface ObjectStep {
  vrActive: boolean;
  deltaSec: number;
  /** A take is recording: only then does a tray pick summon (PRD-045). */
  recording: boolean;
  /** The take's clock, for the summon log. */
  timeSec: number;
  /** The body's facing (the camera's look yaw). */
  bodyYaw: number;
  /** The hand that summons from an open tray in a headset (the dominant one). */
  summoner?: VrHandSide;
  desktop: {
    /** `G` was pressed this step. */
    toggle: boolean;
    /** −1..1 from Q/E and Z/X. */
    turnYaw: number;
    turnPitch: number;
    /** The desktop point action owns the right arm while held. */
    pointHeld: boolean;
    /** 1–5 pressed this step while T holds the tray open, else null. */
    summonSlot: number | null;
    /** The avatar is walking: it cancels a reach or a set-down. */
    walking: boolean;
    /** A mouse or touch press that landed on a reachable prop this step, and whether that pointer lifted. */
    grab: { press: SceneObject | null; release: boolean };
  };
}

export interface ObjectSnapshot {
  id: string;
  name: string;
  origin: SceneObject['origin'];
  layer: SceneObject['layer'];
  placed: boolean;
  heldBy: VrHandSide | null;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  /** The prop body: kinematic while held or hovering, dynamic once released, asleep at rest. */
  body: 'none' | 'kinematic' | 'dynamic' | 'asleep';
  linvel: [number, number, number];
  angvel: [number, number, number];
  /** World-space bounds of the model. */
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
}

interface Hold {
  object: SceneObject;
  side: VrHandSide;
  desktop: boolean;
  /** Object pose in the hand anchor's frame. */
  offset: THREE.Matrix4;
  lostSec: number;
  /** Grabbed by a mouse or touch press: lifting it releases. */
  pointer: boolean;
  /** Taken by a flat-screen reach: the next press lets it go, like `G`. A tray summon is not. */
  reached: boolean;
  /**
   * Being lowered onto the surface under it before it is let go. The object stays held meanwhile.
   * `squat`: nothing is within the arm's standing reach below, so the hand goes down to the floor (`handFrom` to `handTo`, world points)
   * and the body squats only as far as the arm needs.
   */
  settle: { startSec: number; lowerM: number; squat: boolean; handFrom?: THREE.Vector3; handTo?: THREE.Vector3; sec?: number } | null;
}

/**
 * Grab, carry and release. The object follows the avatar's hand bone (what
 * the recipient sees), with the bone's scale removed so height fit never
 * rescales the object; it is never parented to the bone. Runs after the arms
 * have their final pose for the step, and is the only writer of object
 * transforms.
 */
export class ObjectInteraction {
  private hold: Hold | null = null;
  private readonly reach = new DesktopReach();
  /** The step in a reach asked for this frame; the movement system takes it, as a displacement that is not input. */
  private readonly pendingStep = { x: 0, z: 0 };
  private readonly stepDir = new THREE.Vector3();
  private readonly toeOffset = { x: 0, z: 0 };
  /** Where the hand is in a squat set-down this frame, and whether a stand-up after a cancelled one still heads for it. */
  private readonly lowerPoint = new THREE.Vector3();
  private liftFromLower = false;
  private lastBodyYaw = 0;
  private physics: ObjectPhysics | null = null;
  /** Accumulated step time, which stamps the poses the release velocity is fitted from. */
  private clock = 0;
  private readonly wasPressed: Record<VrHandSide, boolean> = { left: false, right: false };
  private readonly box = new THREE.Box3();
  private readonly anchor = new THREE.Matrix4();
  private readonly world = new THREE.Matrix4();
  private readonly tmpM = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly pos2 = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly quat2 = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly unit = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly axis = new THREE.Vector3();

  constructor(
    private readonly deps: {
      registry: SceneObjectRegistry;
      avatar: AvatarRig;
      tracking: XrTracking;
      grabInput: ObjectGrabInput;
      carry: DesktopCarryPose;
      tray: ObjectTray;
      embodyOffset: number;
    }
  ) {}

  /** The body's reach demand, 0 to 1: the crouch and squat a flat-screen pickup or low set-down asks of the avatar. */
  reachDemand(): number {
    return this.reach.demand;
  }

  /** Extra forward lean (0 to 1) a set-down needs when the full squat still leaves the hand short of the floor. */
  reachDeep(): number {
    return this.reach.deepExtra;
  }

  /** True while the avatar steps in for a reach: its ground speed is the reach's own and doesn't count as walking. */
  isStepping(): boolean {
    return this.reach.isStepping();
  }

  /** A reach in progress, or the body still bent from one: the follow camera holds its height. */
  isReachActive(): boolean {
    const phase = this.reach.phase;
    return phase === 'step' || phase === 'reach' || phase === 'lift' || phase === 'lower' || this.reach.demand > 0;
  }

  /** The step in a reach asked for this frame, once (a displacement for the character motor); null when none. */
  takeReachStep(): { x: number; z: number } | null {
    const { x, z } = this.pendingStep;
    if (x === 0 && z === 0) return null;
    this.pendingStep.x = 0;
    this.pendingStep.z = 0;
    return { x, z };
  }

  /** The flat-screen reach: its phase, the body's demand, and the avatar's palm's distance to the first prop's bounds (null if either is missing). */
  reachSnapshot(): { phase: string; demand: number; palmToPropM: number | null; settling: boolean; pointer: boolean } {
    const object = this.deps.registry.all()[0];
    const palm = this.deps.avatar.avatar ? this.palmWorld('right', this.pos2) : undefined;
    return { phase: this.reach.phase, demand: this.reach.demand, palmToPropM: object && palm ? this.distanceToObject(object, palm) : null, settling: Boolean(this.hold?.settle), pointer: Boolean(this.hold?.pointer) };
  }

  setPhysics(physics: ObjectPhysics | null): void {
    this.physics = physics;
  }

  /** Steps the prop world after the hold update and writes free props' poses back. */
  stepPhysics(deltaSec: number): void {
    this.physics?.step(this.deps.registry.eventObjects(), deltaSec, (object, world) => this.writeWorld(object, world));
  }

  update(step: ObjectStep): void {
    const { registry, carry } = this.deps;
    if (!this.deps.avatar.avatar) return;
    this.clock += step.deltaSec;
    for (const object of registry.eventObjects()) if (!object.placed) this.place(object, step.bodyYaw);
    if (this.hold && !registry.all().includes(this.hold.object)) this.release(false);

    if (step.vrActive) {
      carry.idle();
      this.reach.reset();
      if (this.hold?.desktop) this.release(false);
      this.updateVr(step);
    } else {
      this.deps.grabInput.reset();
      this.wasPressed.left = this.wasPressed.right = false;
      if (this.hold && !this.hold.desktop) this.release(false);
      this.updateDesktop(step);
    }
  }

  /**
   * The nearest reachable event prop the ray hits, for a mouse or touch press;
   * null when the nearest hit is out of reach. A press while a prop is being
   * reached for or carried from a reach is for that prop, wherever the ray falls
   * (it cancels the reach, or lets go like `G`). While a prop is being set down,
   * `anywhere` (a mouse press, whose ray is the view's centre) takes it back.
   */
  pick(ray: THREE.Raycaster, anywhere: boolean): SceneObject | null {
    const { registry, carry } = this.deps;
    if (this.hold?.settle && anywhere) return this.hold.object;
    // A second press (mouse or touch) during a reach cancels it, wherever it falls.
    if (this.reach.isReaching()) return this.reach.object;
    // The next press lets a prop held from a reach go, like G.
    if (this.hold && !this.hold.settle) return this.hold.reached ? this.hold.object : null;
    let best: SceneObject | null = null;
    let bestDistance = Infinity;
    for (const object of registry.eventObjects()) {
      if (!object.placed) continue;
      object.model.updateWorldMatrix(true, true);
      const hit = ray.intersectObject(object.model, true)[0];
      if (hit && hit.distance < bestDistance) {
        best = object;
        bestDistance = hit.distance;
      }
    }
    return best && this.desktopReachable(best, carry) ? best : null;
  }

  isHeld(object: SceneObject): VrHandSide | null {
    return this.hold?.object === object ? this.hold.side : null;
  }

  /** Whether `side` holds an object (one hold at a time: the first hand wins). */
  isHolding(side: VrHandSide): boolean {
    return this.hold?.side === side;
  }

  /** The avatar's palm (between the wrist and middle knuckle) in world space. */
  palmPosition(side: VrHandSide, out: THREE.Vector3): THREE.Vector3 | undefined {
    return this.palmWorld(side, out);
  }

  snapshot(): ObjectSnapshot[] {
    return this.deps.registry.all().map((object) => {
      object.wrapper.updateWorldMatrix(true, false);
      object.wrapper.matrixWorld.decompose(this.pos, this.quat, this.scale);
      this.box.setFromObject(object.model);
      const body = this.physics?.bodyState(object) ?? { state: 'none' as const, linvel: [0, 0, 0] as [number, number, number], angvel: [0, 0, 0] as [number, number, number] };
      return {
        id: object.id,
        name: object.name,
        origin: object.origin,
        layer: object.layer,
        placed: object.placed,
        heldBy: object.heldBy,
        position: [this.pos.x, this.pos.y, this.pos.z],
        quaternion: [this.quat.x, this.quat.y, this.quat.z, this.quat.w],
        body: body.state,
        linvel: body.linvel,
        angvel: body.angvel,
        boundsMin: [this.box.min.x, this.box.min.y, this.box.min.z],
        boundsMax: [this.box.max.x, this.box.max.y, this.box.max.z]
      };
    });
  }

  /** The avatar hand bones' world poses, scale removed: what a held object follows (checks compare against it). */
  handSnapshot(): Record<VrHandSide, { position: [number, number, number]; quaternion: [number, number, number, number] } | null> {
    const read = (side: VrHandSide) => {
      if (!this.readAnchor(side)) return null;
      this.anchor.decompose(this.pos, this.quat, this.scale);
      return { position: [this.pos.x, this.pos.y, this.pos.z] as [number, number, number], quaternion: [this.quat.x, this.quat.y, this.quat.z, this.quat.w] as [number, number, number, number] };
    };
    return { left: read('left'), right: read('right') };
  }

  private updateVr(step: ObjectStep): void {
    const { grabInput, tracking, registry } = this.deps;
    grabInput.update();
    for (const side of SIDES) {
      const intent: Readonly<GrabIntent> = grabInput.get(side);
      const rising = intent.pressed && !this.wasPressed[side];
      this.wasPressed[side] = intent.pressed;
      if (this.hold?.side === side && (intent.switched || !intent.pressed)) {
        this.release(!intent.switched);
        continue;
      }
      // A switch is not a fresh press: the new source has to open and close again.
      if (intent.switched) continue;
      // First hand wins: the other hand's grab is ignored until release.
      if (!rising || this.hold || !this.readAnchor(side)) continue;
      const palm = this.palmWorld(side, this.pos2);
      if (!palm) continue;
      // An open tray's miniature wins over an object in reach (PRD-045).
      const item = side === (step.summoner ?? 'right') && step.recording ? this.deps.tray.nearestItem(palm, VR_REACH_M) : null;
      if (item) {
        const summoned = this.deps.tray.summon(item, step.timeSec);
        this.writeWorld(summoned, this.deps.tray.miniaturePose(item, this.world));
        summoned.placed = true;
        this.grab(summoned, side, false);
        continue;
      }
      const target = registry.eventObjects().find((object) => this.distanceToObject(object, palm) <= VR_REACH_M);
      if (target) this.grab(target, side, false);
    }

    const hold = this.hold;
    if (!hold) return;
    if (!TRACKED_SOURCES.has(tracking.getHandPoseSource(hold.side)) || grabInput.get(hold.side).source === 'none') {
      // The hand falls back to a rest pose: freeze rather than swing with it.
      hold.lostSec += step.deltaSec;
      if (hold.lostSec >= LOST_RELEASE_SEC) this.release(false);
      return;
    }
    hold.lostSec = 0;
    if (this.readAnchor(hold.side)) {
      this.writeWorld(hold.object, this.world.multiplyMatrices(this.anchor, hold.offset));
      this.physics?.sample(hold.object, this.clock);
    }
  }

  private updateDesktop(step: ObjectStep): void {
    const { carry, registry, tray } = this.deps;
    const reach = this.reach;
    this.lastBodyYaw = step.bodyYaw;
    const slot = step.desktop.summonSlot;
    const item = slot !== null && step.recording && !this.hold && !reach.isReaching() ? tray.getItems().find((candidate) => candidate.slot === slot) : undefined;
    if (item && tray.isOpen() && this.readAnchor('right')) {
      // Appears in the right hand and rises with it as the carry pose blends in.
      const summoned = tray.summon(item, step.timeSec);
      this.writeWorld(summoned, tray.miniaturePose(item, this.world));
      this.writeWorld(summoned, this.inHandPose(summoned, step.bodyYaw, this.world));
      summoned.placed = true;
      this.grab(summoned, 'right', false);
      this.hold!.desktop = true;
    } else if (step.desktop.toggle) {
      if (reach.isReaching()) {
        // G again while reaching: stand back up, nothing grabbed.
        this.cancelReach();
      } else if (this.hold?.settle) {
        // G again while setting down: let go now, where it is.
        this.release(false);
      } else if (this.hold) {
        if (!reach.isLifting()) this.releaseDesktop();
      } else if (reach.phase === 'idle') {
        const target = this.nearestReachable();
        if (target) this.beginReach(target, false);
      }
    }
    const { press, release } = step.desktop.grab;
    if (press && registry.all().includes(press)) {
      if (reach.isReaching()) this.cancelReach();
      else if (this.hold?.settle) this.cancelSettle(true);
      else if (this.hold?.reached && !reach.isLifting()) this.releaseDesktop();
      else if (!this.hold && reach.phase === 'idle') this.beginReach(press, true);
    }
    if (release) {
      // A pointer lifted during the reach or the lift doesn't cancel it: the prop stays held until the next press or G.
      if (reach.isReaching() || reach.isLifting()) {
        reach.pointerDown = false;
        if (this.hold) this.hold.pointer = false;
      } else if (this.hold?.pointer && !this.hold.settle) this.releaseDesktop();
    }
    if (reach.isReaching() && !this.stillReaching(step)) this.cancelReach();
    if (reach.isStepping()) this.stepIn(step);
    if (this.hold?.settle && step.desktop.walking) this.cancelSettle(false);

    const hold = this.hold;
    const settle = hold?.settle ?? null;
    let lowerM = 0;
    if (settle) {
      if (settle.squat) {
        // The hand goes down to the floor over the stance, as the pickup came from there; the body squats only as far as the arm needs.
        const t = Math.min(1, (this.clock - settle.startSec) / settle.sec!);
        this.lowerPoint.lerpVectors(settle.handFrom!, settle.handTo!, t * t * (3 - 2 * t));
        const shoulder = this.deps.avatar.getBoneWorldPosition('rightUpperArm', this.pos2);
        const reachM = carry.getReach();
        reach.stepLower(step.deltaSec, !shoulder || !reachM || shoulder.distanceTo(this.lowerPoint) > reachM * REACH_TARGET_FRACTION);
      } else {
        const t = Math.min(1, (this.clock - settle.startSec) / SET_DOWN_SEC);
        lowerM = t * t * (3 - 2 * t) * settle.lowerM;
      }
    } else if (reach.isLifting()) reach.stepLift(step.deltaSec);
    else reach.relax(step.deltaSec);
    let worldBlend = reach.worldBlend();
    let worldPoint = this.liftFromLower ? this.lowerPoint : reach.grasp;
    if (settle?.squat) {
      worldBlend = 1;
      worldPoint = this.lowerPoint;
    }
    carry.update({
      carrying: (Boolean(hold) || reach.phase === 'reach') && !step.desktop.pointHeld,
      bodyYaw: step.bodyYaw,
      deltaSec: step.deltaSec,
      lowerM,
      ...(worldBlend > 0 ? { worldTarget: { point: worldPoint, blend: worldBlend } } : {})
    });
    if (!this.readAnchor('right')) return;

    // The hand has its arm pose for the step: take the prop once the palm is on it. It stays where it was until then.
    if (reach.phase === 'reach' && reach.object) {
      const palm = this.palmWorld('right', this.pos2);
      if (palm && this.distanceToObject(reach.object, palm) <= REACH_PALM_M) {
        const object = reach.object;
        this.grab(object, 'right', true);
        this.hold!.pointer = reach.pointerDown;
        this.hold!.reached = true;
        reach.beginLift(true);
      }
    }
    const held = this.hold;
    if (!held) return;
    this.world.multiplyMatrices(this.anchor, held.offset);

    const { turnYaw, turnPitch } = step.desktop;
    if (turnYaw !== 0 || turnPitch !== 0) {
      // Turn about the object's own center: world up for yaw, the body's right for pitch.
      this.world.decompose(this.pos, this.quat, this.scale);
      this.quat2.setFromAxisAngle(this.up, turnYaw * TURN_RAD_PER_SEC * step.deltaSec);
      this.quat.premultiply(this.quat2);
      this.axis.set(Math.cos(step.bodyYaw), 0, -Math.sin(step.bodyYaw));
      this.quat2.setFromAxisAngle(this.axis, turnPitch * TURN_RAD_PER_SEC * step.deltaSec);
      this.quat.premultiply(this.quat2).normalize();
      this.world.compose(this.pos, this.quat, this.unit);
      held.offset.copy(this.anchor).invert().multiply(this.world);
    }
    this.writeWorld(held.object, this.world);
    this.physics?.sample(held.object, this.clock);
    // The prop moved only with the hand. Let go once it hangs just above what is under it, or the hand can go no lower.
    const hanging = (this.physics?.gapBelow(held.object, SET_DOWN_SEARCH_M) ?? Infinity) <= SET_DOWN_RELEASE_GAP_M;
    const settled = held.settle && this.clock - held.settle.startSec >= (held.settle.squat ? held.settle.sec! + LOWER_SETTLE_SEC : SET_DOWN_SEC);
    if (held.settle && (settled || hanging)) {
      this.release(false);
    }
  }

  /** Starts a reach for `object`: the body bends toward it, and it is taken once the palm is on it. */
  private beginReach(object: SceneObject, pointerDown: boolean): void {
    this.box.setFromObject(object.model);
    this.reach.grasp.set((this.box.min.x + this.box.max.x) / 2, this.box.max.y, (this.box.min.z + this.box.max.z) / 2);
    // A prop low enough to be squatted for, and out of the arm's standing reach, is stepped in to first, so the squat is a drop and not a dive.
    const { avatar, carry } = this.deps;
    const shoulder = avatar.getBoneWorldPosition('rightUpperArm', this.pos2);
    const reachM = carry.getReach();
    let stepM = 0;
    const low = this.reach.grasp.y < avatar.avatarRoot.position.y + avatar.avatarHeight * REACH_STEP_BELOW_HEIGHT_FRACTION;
    if (low && shoulder && reachM && shoulder.distanceTo(this.reach.grasp) > reachM * REACH_TARGET_FRACTION) stepM = this.stepRemaining(true);
    this.liftFromLower = false;
    this.reach.begin(object, pointerDown, stepM);
  }

  /**
   * How far the avatar must still step toward the grasp point to stand `REACH_STEP_AHEAD_M` from it, measured from the toes; sets `stepDir`.
   * `fresh`: read the toes from the pose (standing); otherwise the stance moves with the root, since the walk swings the toes about it.
   */
  private stepRemaining(fresh: boolean): number {
    const { avatar } = this.deps;
    const root = avatar.avatarRoot.position;
    if (fresh) {
      const left = avatar.getBoneWorldPosition('leftToes', this.pos) ?? avatar.getBoneWorldPosition('leftFoot', this.pos);
      if (!left) return 0;
      const right = avatar.getBoneWorldPosition('rightToes', this.pos2) ?? avatar.getBoneWorldPosition('rightFoot', this.pos2);
      this.toeOffset.x = (right ? (left.x + right.x) / 2 : left.x) - root.x;
      this.toeOffset.z = (right ? (left.z + right.z) / 2 : left.z) - root.z;
    }
    const dx = this.reach.grasp.x - (root.x + this.toeOffset.x);
    const dz = this.reach.grasp.z - (root.z + this.toeOffset.z);
    const distance = Math.hypot(dx, dz);
    if (distance < 1e-6) return 0;
    this.stepDir.set(dx / distance, 0, dz / distance);
    return Math.max(0, distance - REACH_STEP_AHEAD_M);
  }

  /** One frame of the step in: asks the movement system for this frame's displacement toward the prop. */
  private stepIn(step: ObjectStep): void {
    const moveM = this.reach.stepTowards(step.deltaSec, this.stepRemaining(false));
    this.pendingStep.x = this.stepDir.x * moveM;
    this.pendingStep.z = this.stepDir.z * moveM;
  }

  /** Stands back up with nothing grabbed. */
  private cancelReach(): void {
    this.pendingStep.x = 0;
    this.pendingStep.z = 0;
    this.reach.stop();
  }

  /** Whether a reach goes on: the prop is still there and reachable, nothing walks or points, and it has not timed out or moved. */
  private stillReaching(step: ObjectStep): boolean {
    const { registry, carry, avatar } = this.deps;
    const object = this.reach.object;
    if (!object || !registry.all().includes(object) || step.desktop.walking || step.desktop.pointHeld) return false;
    if (!this.desktopReachable(object, carry)) return false;
    const shoulder = avatar.getBoneWorldPosition('rightUpperArm', this.pos2);
    const reachM = carry.getReach();
    if (!shoulder || !reachM) return false;
    object.wrapper.updateWorldMatrix(true, false);
    object.wrapper.matrixWorld.decompose(this.pos, this.quat, this.scale);
    return this.reach.stepReach(step.deltaSec, this.pos, shoulder.distanceTo(this.reach.grasp), reachM) === 'reaching';
  }

  /** The reachable prop nearest the avatar's shoulder (what `G` takes without aiming). */
  private nearestReachable(): SceneObject | null {
    const { registry, carry, avatar } = this.deps;
    const shoulder = avatar.getBoneWorldPosition('rightUpperArm', this.pos2);
    let best: SceneObject | null = null;
    let bestDistance = Infinity;
    for (const object of registry.eventObjects()) {
      if (!object.placed || !this.desktopReachable(object, carry)) continue;
      const distance = shoulder ? this.distanceToObject(object, shoulder) : 0;
      if (distance < bestDistance) {
        best = object;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** A deliberate desktop let-go: a moving prop is thrown, a still one is set down on what is under it. */
  private releaseDesktop(): void {
    const hold = this.hold;
    if (!hold) return;
    if (!this.physics || this.physics.releaseSpeed(hold.object) > SET_DOWN_MAX_MPS) {
      this.release(true);
      return;
    }
    // The hand goes down by the prop's gap to the surface, less the release gap, if the arm reaches that far standing.
    const gap = this.physics.gapBelow(hold.object, SET_DOWN_SEARCH_M);
    const needed = gap === null ? 0 : Math.max(0, gap - SET_DOWN_RELEASE_GAP_M);
    if (needed <= this.deps.carry.maxLowerM()) {
      hold.settle = { startSec: this.clock, lowerM: needed, squat: false };
    } else if (this.readAnchor(hold.side)) {
      // Nothing within the arm's standing reach below: the hand goes down to the floor over the pickup's stance, squatting only as far as it must.
      const handFrom = new THREE.Vector3().setFromMatrixPosition(this.anchor);
      this.stepRemaining(true);
      const root = this.deps.avatar.avatarRoot.position;
      this.box.setFromObject(hold.object.model);
      const handTo = new THREE.Vector3(
        root.x + this.toeOffset.x - Math.sin(this.lastBodyYaw) * REACH_STEP_AHEAD_M + handFrom.x - (this.box.min.x + this.box.max.x) / 2,
        handFrom.y - needed - LOWER_OVERSHOOT_M,
        root.z + this.toeOffset.z - Math.cos(this.lastBodyYaw) * REACH_STEP_AHEAD_M + handFrom.z - (this.box.min.z + this.box.max.z) / 2
      );
      hold.settle = { startSec: this.clock, lowerM: 0, squat: true, handFrom, handTo, sec: THREE.MathUtils.clamp(handFrom.distanceTo(handTo) / LOWER_HAND_MPS, LOWER_MIN_SEC, LOWER_MAX_SEC) };
      this.lowerPoint.copy(handFrom);
      this.liftFromLower = false;
      this.reach.beginLower();
    }
  }

  /** A new press, or walking, during a set-down: the prop stays in the hand, where the lowering has put it. */
  private cancelSettle(pointer: boolean): void {
    const hold = this.hold;
    if (!hold?.settle || !this.readAnchor(hold.side)) return;
    hold.object.wrapper.updateWorldMatrix(true, false);
    hold.offset.copy(this.anchor).invert().multiply(hold.object.wrapper.matrixWorld);
    // A squat stands back up first, the hand easing back to the carry pose as the body rises.
    if (hold.settle.squat) {
      this.liftFromLower = true;
      this.reach.beginLift(true);
    }
    hold.settle = null;
    hold.pointer = pointer;
    this.physics?.hold(hold.object);
  }

  private grab(object: SceneObject, side: VrHandSide, desktop: boolean): void {
    object.wrapper.updateWorldMatrix(true, false);
    this.world.copy(object.wrapper.matrixWorld);
    const offset = this.anchor.clone().invert().multiply(this.world);
    this.hold = { object, side, desktop, offset, lostSec: 0, pointer: false, reached: false, settle: null };
    object.heldBy = side;
    this.physics?.hold(object);
  }

  /** A deliberate let-go throws with the fitted velocity; every other release drops with none. */
  private release(throwIt: boolean): void {
    if (!this.hold) return;
    this.physics?.release(this.hold.object, throwIt);
    this.hold.object.heldBy = null;
    this.hold = null;
    // A reach that was only for this prop ends with it; a body already standing up goes on standing.
    this.reach.stop();
  }

  /** The avatar hand bone's world pose with its scale removed, into `anchor`. */
  private readAnchor(side: VrHandSide): boolean {
    const hand = this.deps.avatar.bone(`${side}Hand`);
    if (!hand) return false;
    hand.updateWorldMatrix(true, false);
    hand.matrixWorld.decompose(this.pos, this.quat, this.scale);
    this.anchor.compose(this.pos, this.quat, this.unit);
    return true;
  }

  /** Between the wrist and the middle knuckle. */
  private palmWorld(side: VrHandSide, out: THREE.Vector3): THREE.Vector3 | undefined {
    const { avatar } = this.deps;
    const wrist = avatar.getBoneWorldPosition(`${side}Hand`, out);
    const knuckle = avatar.getBoneWorldPosition(`${side}MiddleProximal`, this.pos);
    if (!wrist) return undefined;
    return knuckle ? out.lerp(knuckle, 0.5) : out;
  }

  private distanceToObject(object: SceneObject, point: THREE.Vector3): number {
    this.box.setFromObject(object.model);
    return this.box.distanceToPoint(point);
  }

  /**
   * Within the avatar's reach on a flat screen: its bounds within the arm's reach (with margin) of the shoulder joint;
   * or, for a prop below the shoulder, its bounds within one arm's reach of the shoulder across the
   * floor, at any height down to the floor, and not under the feet. Low props are reached by bending and squatting.
   */
  private desktopReachable(object: SceneObject, carry: DesktopCarryPose): boolean {
    const { avatar } = this.deps;
    const shoulder = avatar.getBoneWorldPosition('rightUpperArm', this.pos2);
    const reach = carry.getReach();
    if (!shoulder || !reach) return false;
    this.box.setFromObject(object.model);
    if (this.box.distanceToPoint(shoulder) <= reach * DESKTOP_REACH_FRACTION) return true;
    if (this.box.max.y >= shoulder.y) return false;
    const across = Math.hypot(Math.max(this.box.min.x - shoulder.x, 0, shoulder.x - this.box.max.x), Math.max(this.box.min.z - shoulder.z, 0, shoulder.z - this.box.max.z));
    if (across > reach + DESKTOP_STEP_ALLOWANCE_M) return false;
    const root = avatar.avatarRoot.position;
    const fromFeet = Math.hypot(Math.max(this.box.min.x - root.x, 0, root.x - this.box.max.x), Math.max(this.box.min.z - root.z, 0, root.z - this.box.max.z));
    return fromFeet >= DESKTOP_LOW_FEET_M;
  }

  /** Desktop: the object just in front of the palm, keeping its own rotation. */
  private inHandPose(object: SceneObject, bodyYaw: number, out: THREE.Matrix4): THREE.Matrix4 {
    const palm = this.palmWorld('right', this.pos2) ?? this.pos2.setFromMatrixPosition(this.anchor);
    this.box.setFromObject(object.model);
    const radius = this.box.getSize(this.pos).length() / 2;
    object.wrapper.updateWorldMatrix(true, false);
    object.wrapper.matrixWorld.decompose(this.pos, this.quat2, this.scale);
    palm.x += -Math.sin(bodyYaw) * radius * 0.6;
    palm.z += -Math.cos(bodyYaw) * radius * 0.6;
    return out.compose(palm, this.quat2, this.unit);
  }

  private place(object: SceneObject, bodyYaw: number): void {
    const { avatar, embodyOffset } = this.deps;
    const eye = avatar.getEyeAnchorWorldPosition(this.pos2, embodyOffset);
    eye.x += -Math.sin(bodyYaw) * PLACE_FORWARD_M;
    eye.z += -Math.cos(bodyYaw) * PLACE_FORWARD_M;
    eye.y -= PLACE_BELOW_EYES_M;
    this.quat.setFromAxisAngle(this.up, bodyYaw);
    this.writeWorld(object, this.world.compose(eye, this.quat, this.unit));
    object.placed = true;
  }

  private writeWorld(object: SceneObject, world: THREE.Matrix4): void {
    const wrapper = object.wrapper;
    const parent = wrapper.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      this.tmpM.copy(parent.matrixWorld).invert().multiply(world);
    } else {
      this.tmpM.copy(world);
    }
    this.tmpM.decompose(wrapper.position, wrapper.quaternion, wrapper.scale);
    wrapper.updateMatrixWorld(true);
  }
}
