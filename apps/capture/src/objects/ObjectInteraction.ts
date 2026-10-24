import * as THREE from 'three';

import type { AvatarRig } from '../avatar/AvatarRig';
import type { HandPoseSource, VrHandSide } from '../types/contracts';
import type { XrTracking } from '../xr/XrTracking';
import type { DesktopCarryPose } from './DesktopCarryPose';
import type { GrabIntent, ObjectGrabInput } from './ObjectGrabInput';
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

export interface ObjectStep {
  vrActive: boolean;
  deltaSec: number;
  /** The body's facing (the camera's look yaw). */
  bodyYaw: number;
  desktop: {
    /** `G` was pressed this step. */
    toggle: boolean;
    /** −1..1 from Q/E and Z/X. */
    turnYaw: number;
    turnPitch: number;
    /** The desktop point action owns the right arm while held. */
    pointHeld: boolean;
  };
}

export interface ObjectSnapshot {
  id: string;
  name: string;
  placed: boolean;
  heldBy: VrHandSide | null;
  position: [number, number, number];
  quaternion: [number, number, number, number];
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
      embodyOffset: number;
    }
  ) {}

  update(step: ObjectStep): void {
    const { registry, carry } = this.deps;
    if (!this.deps.avatar.avatar) return;
    for (const object of registry.all()) if (!object.placed) this.place(object, step.bodyYaw);
    if (this.hold && !registry.all().includes(this.hold.object)) this.release();

    if (step.vrActive) {
      carry.idle();
      if (this.hold?.desktop) this.release();
      this.updateVr(step);
    } else {
      this.deps.grabInput.reset();
      this.wasPressed.left = this.wasPressed.right = false;
      if (this.hold && !this.hold.desktop) this.release();
      this.updateDesktop(step);
    }
  }

  isHeld(object: SceneObject): VrHandSide | null {
    return this.hold?.object === object ? this.hold.side : null;
  }

  snapshot(): ObjectSnapshot[] {
    return this.deps.registry.all().map((object) => {
      object.wrapper.updateWorldMatrix(true, false);
      object.wrapper.matrixWorld.decompose(this.pos, this.quat, this.scale);
      this.box.setFromObject(object.model);
      return {
        id: object.id,
        name: object.name,
        placed: object.placed,
        heldBy: object.heldBy,
        position: [this.pos.x, this.pos.y, this.pos.z],
        quaternion: [this.quat.x, this.quat.y, this.quat.z, this.quat.w],
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
      if (this.hold?.side === side && !intent.pressed) {
        this.release();
        continue;
      }
      // First hand wins: the other hand's grab is ignored until release.
      if (!rising || this.hold || !this.readAnchor(side)) continue;
      const palm = this.palmWorld(side, this.pos2);
      const target = palm && registry.eventObjects().find((object) => this.distanceToObject(object, palm) <= VR_REACH_M);
      if (target) this.grab(target, side, false);
    }

    const hold = this.hold;
    if (!hold) return;
    if (!TRACKED_SOURCES.has(tracking.getHandPoseSource(hold.side)) || grabInput.get(hold.side).source === 'none') {
      // The hand falls back to a rest pose: freeze rather than swing with it.
      hold.lostSec += step.deltaSec;
      if (hold.lostSec >= LOST_RELEASE_SEC) this.release();
      return;
    }
    hold.lostSec = 0;
    if (this.readAnchor(hold.side)) this.writeWorld(hold.object, this.world.multiplyMatrices(this.anchor, hold.offset));
  }

  private updateDesktop(step: ObjectStep): void {
    const { carry, registry } = this.deps;
    if (step.desktop.toggle) {
      if (this.hold) {
        this.release();
      } else {
        const target = registry.eventObjects().find((object) => this.desktopReachable(object, carry));
        if (target && this.readAnchor('right')) this.grab(target, 'right', true);
      }
    }
    const hold = this.hold;
    carry.update({ carrying: Boolean(hold) && !step.desktop.pointHeld, bodyYaw: step.bodyYaw, deltaSec: step.deltaSec });
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
  }

  private grab(object: SceneObject, side: VrHandSide, desktop: boolean): void {
    object.wrapper.updateWorldMatrix(true, false);
    this.world.copy(object.wrapper.matrixWorld);
    const offset = this.anchor.clone().invert().multiply(this.world);
    this.hold = { object, side, desktop, offset, pickup: desktop ? this.world.clone() : null, lostSec: 0 };
    object.heldBy = side;
  }

  private release(): void {
    if (!this.hold) return;
    this.hold.object.heldBy = null;
    this.hold = null;
  }

  /** The avatar hand bone's world pose with its scale removed, into `anchor`. */
  private readAnchor(side: VrHandSide): boolean {
    const hand = this.deps.avatar.avatar?.getObjectByName(side === 'left' ? 'LeftHand' : 'RightHand');
    if (!hand) return false;
    hand.updateWorldMatrix(true, false);
    hand.matrixWorld.decompose(this.pos, this.quat, this.scale);
    this.anchor.compose(this.pos, this.quat, this.unit);
    return true;
  }

  /** Between the wrist and the middle knuckle. */
  private palmWorld(side: VrHandSide, out: THREE.Vector3): THREE.Vector3 | undefined {
    const prefix = side === 'left' ? 'Left' : 'Right';
    const { avatar } = this.deps;
    const wrist = avatar.getBoneWorldPosition(`${prefix}Hand`, out);
    const knuckle = avatar.getBoneWorldPosition(`${prefix}HandMiddle1`, this.pos);
    if (!wrist) return undefined;
    return knuckle ? out.lerp(knuckle, 0.5) : out;
  }

  private distanceToObject(object: SceneObject, point: THREE.Vector3): number {
    this.box.setFromObject(object.model);
    return this.box.distanceToPoint(point);
  }

  private desktopReachable(object: SceneObject, carry: DesktopCarryPose): boolean {
    const shoulder = this.deps.avatar.getBoneWorldPosition('RightArm', this.pos2);
    const reach = carry.getReach();
    return Boolean(shoulder && reach && this.distanceToObject(object, shoulder) <= reach * DESKTOP_REACH_FRACTION);
  }

  /** Desktop: the object just in front of the palm, keeping its own rotation. */
  private inHandPose(object: SceneObject, bodyYaw: number, out: THREE.Matrix4): void {
    const palm = this.palmWorld('right', this.pos2) ?? this.pos2.setFromMatrixPosition(this.anchor);
    this.box.setFromObject(object.model);
    const radius = this.box.getSize(this.pos).length() / 2;
    object.wrapper.updateWorldMatrix(true, false);
    object.wrapper.matrixWorld.decompose(this.pos, this.quat2, this.scale);
    palm.x += -Math.sin(bodyYaw) * radius * 0.6;
    palm.z += -Math.cos(bodyYaw) * radius * 0.6;
    out.compose(palm, this.quat2, this.unit);
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
