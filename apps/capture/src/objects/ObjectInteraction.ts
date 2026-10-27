import * as THREE from 'three';

import type { AvatarRig } from '../avatar/AvatarRig';
import type { HandPoseSource, VrHandSide } from '../types/contracts';
import type { ObjectPhysics } from '../physics/ObjectPhysics';
import type { XrTracking } from '../xr/XrTracking';
import type { DesktopCarryPose } from './DesktopCarryPose';
import { DesktopReach, REACH_PALM_M } from './DesktopReach';
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
    /** The avatar is walking: it cancels a reach or a low set-down. */
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
  /**
   * Being lowered onto the surface under it before it is let go. The object stays held meanwhile.
   * `squat`: nothing is within the arm's standing reach below, so the body squats (the reach demand) instead of only the arm lowering;
   * `fullSec` is when the squat bottomed out.
   */
  settle: { startSec: number; lowerM: number; squat: boolean; fullSec: number | null } | null;
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
   * null while something is held, or when the nearest hit is out of reach.
   * While a prop is being set down, `anywhere` (a mouse press, whose ray is the
   * view's centre) takes it back wherever the ray falls.
   */
  pick(ray: THREE.Raycaster, anywhere: boolean): SceneObject | null {
    const { registry, carry } = this.deps;
    if (this.hold?.settle && anywhere) return this.hold.object;
    // A second press during a reach cancels it, wherever it falls.
    if (this.reach.isReaching() && anywhere) return this.reach.object;
    if (this.reach.isReaching()) return null;
    if (this.hold && !this.hold.settle) return null;
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
    if (this.hold?.settle?.squat && step.desktop.walking) this.cancelSettle(false);

    const hold = this.hold;
    const settle = hold?.settle ?? null;
    let lowerM = 0;
    if (settle) {
      if (settle.squat) {
        // Squat further until the prop is just above the surface; at the bottom the arm lowers the rest of the way.
        if (reach.stepLower(step.deltaSec) && settle.fullSec === null) {
          settle.fullSec = this.clock;
          settle.lowerM = carry.maxLowerM();
        }
        const ease = settle.fullSec === null ? 0 : Math.min(1, (this.clock - settle.fullSec) / SET_DOWN_SEC);
        lowerM = ease * ease * (3 - 2 * ease) * settle.lowerM;
      } else {
        const t = Math.min(1, (this.clock - settle.startSec) / SET_DOWN_SEC);
        lowerM = t * t * (3 - 2 * t) * settle.lowerM;
      }
    } else if (reach.isLifting()) reach.stepLift(step.deltaSec);
    else reach.relax(step.deltaSec);
    const worldBlend = reach.worldBlend();
    carry.update({
      carrying: (Boolean(hold) || reach.isReaching()) && !step.desktop.pointHeld,
      bodyYaw: step.bodyYaw,
      deltaSec: step.deltaSec,
      lowerM,
      ...(worldBlend > 0 ? { worldTarget: { point: reach.grasp, blend: worldBlend } } : {})
    });
    if (!this.readAnchor('right')) return;

    // The hand has its arm pose for the step: take the prop once the palm is on it. It stays where it was until then.
    if (reach.isReaching() && reach.object) {
      const palm = this.palmWorld('right', this.pos2);
      if (palm && this.distanceToObject(reach.object, palm) <= REACH_PALM_M) {
        const object = reach.object;
        this.grab(object, 'right', true);
        this.hold!.pointer = reach.pointerDown;
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
    const settled = held.settle && (held.settle.squat ? held.settle.fullSec !== null && this.clock - held.settle.fullSec >= SET_DOWN_SEC : this.clock - held.settle.startSec >= SET_DOWN_SEC);
    if (held.settle && (settled || hanging)) this.release(false);
  }

  /** Starts a reach for `object`: the body bends toward it, and it is taken once the palm is on it. */
  private beginReach(object: SceneObject, pointerDown: boolean): void {
    this.box.setFromObject(object.model);
    this.reach.grasp.set((this.box.min.x + this.box.max.x) / 2, this.box.max.y, (this.box.min.z + this.box.max.z) / 2);
    this.reach.begin(object, pointerDown);
  }

  /** Stands back up with nothing grabbed. */
  private cancelReach(): void {
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
      hold.settle = { startSec: this.clock, lowerM: needed, squat: false, fullSec: null };
    } else {
      // Nothing within the arm's standing reach below: squat until the prop is just above the surface.
      hold.settle = { startSec: this.clock, lowerM: 0, squat: true, fullSec: null };
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
    if (hold.settle.squat) this.reach.beginLift(false);
    hold.settle = null;
    hold.pointer = pointer;
    this.physics?.hold(hold.object);
  }

  private grab(object: SceneObject, side: VrHandSide, desktop: boolean): void {
    object.wrapper.updateWorldMatrix(true, false);
    this.world.copy(object.wrapper.matrixWorld);
    const offset = this.anchor.clone().invert().multiply(this.world);
    this.hold = { object, side, desktop, offset, lostSec: 0, pointer: false, settle: null };
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
    if (across > reach) return false;
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
