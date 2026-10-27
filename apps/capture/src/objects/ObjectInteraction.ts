import * as THREE from 'three';

import type { AvatarRig } from '../avatar/AvatarRig';
import type { HandPoseSource, VrHandSide } from '../types/contracts';
import type { ObjectPhysics } from '../physics/ObjectPhysics';
import type { XrTracking } from '../xr/XrTracking';
import type { DesktopCarryPose } from './DesktopCarryPose';
import type { GrabIntent, ObjectGrabInput } from './ObjectGrabInput';
import type { ObjectTray } from './ObjectTray';
import type { SceneObject, SceneObjectRegistry } from './SceneObjectRegistry';

const SIDES = ['left', 'right'] as const;
// A grab needs the avatar's palm this close to the object's bounds.
const VR_REACH_M = 0.1;
// Desktop: the object's bounds within this fraction of the arm's reach of the shoulder joint.
const DESKTOP_REACH_FRACTION = 1.15;
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
  /** Desktop: the object's pose when picked up, which it glides from into the hand. */
  pickup: THREE.Matrix4 | null;
  lostSec: number;
  /** Grabbed by a mouse or touch press: lifting it releases. */
  pointer: boolean;
  /** Being lowered onto the surface under it before it is let go. The object stays held meanwhile. */
  settle: { startSec: number; lowerM: number } | null;
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
    const slot = step.desktop.summonSlot;
    const item = slot !== null && step.recording && !this.hold ? tray.getItems().find((candidate) => candidate.slot === slot) : undefined;
    if (item && tray.isOpen() && this.readAnchor('right')) {
      // Appears in the right hand and rises with it as the carry pose blends in.
      const summoned = tray.summon(item, step.timeSec);
      this.writeWorld(summoned, tray.miniaturePose(item, this.world));
      this.writeWorld(summoned, this.inHandPose(summoned, step.bodyYaw, this.world));
      summoned.placed = true;
      this.grab(summoned, 'right', false);
      this.hold!.desktop = true;
    } else if (step.desktop.toggle) {
      if (this.hold?.settle) {
        // G again while setting down: let go now, where it is.
        this.release(false);
      } else if (this.hold) {
        this.releaseDesktop();
      } else {
        const target = registry.eventObjects().find((object) => this.desktopReachable(object, carry));
        if (target && this.readAnchor('right')) this.grab(target, 'right', true);
      }
    }
    const { press, release } = step.desktop.grab;
    if (press && registry.all().includes(press) && (!this.hold || this.hold.settle) && this.readAnchor('right')) {
      if (this.hold) this.cancelSettle();
      else {
        this.grab(press, 'right', true);
        this.hold!.pointer = true;
      }
    }
    if (release && this.hold?.pointer && !this.hold.settle) this.releaseDesktop();
    const hold = this.hold;
    const settle = hold?.settle ?? null;
    const settleT = settle ? Math.min(1, (this.clock - settle.startSec) / SET_DOWN_SEC) : 0;
    const settleEase = settleT * settleT * (3 - 2 * settleT);
    carry.update({
      carrying: Boolean(hold) && !step.desktop.pointHeld,
      bodyYaw: step.bodyYaw,
      deltaSec: step.deltaSec,
      lowerM: settle ? settleEase * settle.lowerM : 0
    });
    if (!hold || !this.readAnchor('right')) return;

    if (hold.pickup) {
      // Glide from where it was picked up into the hand as the arm comes up.
      const t = carry.getWeight();
      this.inHandPose(hold.object, step.bodyYaw, this.tmpM);
      hold.pickup.decompose(this.pos, this.quat, this.scale);
      this.tmpM.decompose(this.pos2, this.quat2, this.scale);
      this.pos.lerp(this.pos2, t);
      this.quat.slerp(this.quat2, t);
      this.world.compose(this.pos, this.quat, this.unit);
      hold.offset.copy(this.anchor).invert().multiply(this.world);
      if (t >= 1) hold.pickup = null;
    }
    this.world.multiplyMatrices(this.anchor, hold.offset);

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
      hold.offset.copy(this.anchor).invert().multiply(this.world);
    }
    this.writeWorld(hold.object, this.world);
    this.physics?.sample(hold.object, this.clock);
    // The prop moved only with the hand. Let go once it hangs just above what is under it, or the hand can go no lower.
    if (settle && (settleT >= 1 || (this.physics?.gapBelow(hold.object, SET_DOWN_SEARCH_M) ?? Infinity) <= SET_DOWN_RELEASE_GAP_M)) this.release(false);
  }

  /** A deliberate desktop let-go: a moving prop is thrown, a still one is set down on what is under it. */
  private releaseDesktop(): void {
    const hold = this.hold;
    if (!hold) return;
    if (!this.physics || this.physics.releaseSpeed(hold.object) > SET_DOWN_MAX_MPS) {
      this.release(true);
      return;
    }
    // The hand goes down by the prop's gap to the surface, less the release gap, as far as the arm reaches.
    const gap = this.physics.gapBelow(hold.object, SET_DOWN_SEARCH_M);
    const lowerM = gap === null ? 0 : Math.min(Math.max(0, gap - SET_DOWN_RELEASE_GAP_M), this.deps.carry.maxLowerM());
    hold.settle = { startSec: this.clock, lowerM };
  }

  /** A new press during a set-down: the prop stays in the hand, where the ease has put it. */
  private cancelSettle(): void {
    const hold = this.hold;
    if (!hold?.settle || !this.readAnchor(hold.side)) return;
    hold.object.wrapper.updateWorldMatrix(true, false);
    hold.offset.copy(this.anchor).invert().multiply(hold.object.wrapper.matrixWorld);
    hold.pickup = null;
    hold.settle = null;
    hold.pointer = true;
    this.physics?.hold(hold.object);
  }

  private grab(object: SceneObject, side: VrHandSide, desktop: boolean): void {
    object.wrapper.updateWorldMatrix(true, false);
    this.world.copy(object.wrapper.matrixWorld);
    const offset = this.anchor.clone().invert().multiply(this.world);
    this.hold = { object, side, desktop, offset, pickup: desktop ? this.world.clone() : null, lostSec: 0, pointer: false, settle: null };
    object.heldBy = side;
    this.physics?.hold(object);
  }

  /** A deliberate let-go throws with the fitted velocity; every other release drops with none. */
  private release(throwIt: boolean): void {
    if (!this.hold) return;
    this.physics?.release(this.hold.object, throwIt);
    this.hold.object.heldBy = null;
    this.hold = null;
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

  private desktopReachable(object: SceneObject, carry: DesktopCarryPose): boolean {
    const shoulder = this.deps.avatar.getBoneWorldPosition('rightUpperArm', this.pos2);
    const reach = carry.getReach();
    return Boolean(shoulder && reach && this.distanceToObject(object, shoulder) <= reach * DESKTOP_REACH_FRACTION);
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
