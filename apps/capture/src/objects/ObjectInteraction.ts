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
export const VR_REACH_M = 0.1;
// Desktop: an object at or above the shoulder, its bounds within this fraction of the arm's reach of the shoulder joint.
const DESKTOP_REACH_FRACTION = 1.15;
// An object below the shoulder, its bounds within one arm's reach of the shoulder, measured across the floor; and no nearer than this to the feet.
const DESKTOP_LOW_FEET_M = 0.1;
// A prop whose lowest point is further below the feet's ground than this is down a drop, not a squat away.
const REACH_BELOW_FEET_M = 0.3;
// The step in stays on ground that is there and within this height of the ground under the avatar's root; it looks this far ahead, sampling this often.
const STEP_GROUND_TOLERANCE_M = 0.15;
const STEP_LOOKAHEAD_M = 0.12;
const STEP_PROBE_SPACING_M = 0.05;
// The height above the feet of the ray that checks the way to the prop for a low wall.
const REACH_KNEE_RAY_M = 0.25;
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
// A held prop's size, against the model as loaded: clamped, and caught at 1 while within the detent.
export const MIN_SIZE = 0.25;
export const MAX_SIZE = 4;
const SIZE_DETENT = 0.06;
// A held prop can be pushed out this far beyond the hand; a headset's stick pushes it at this pace.
export const MAX_PUSH_M = 4;
const VR_PUSH_MPS = 2;
// Pushed out further than this, a still desktop release lowers the prop itself onto the surface below.
const PUSHED_M = 0.05;
// A prop out of reach but within this far, in sight, is fetched: it glides into the hand over this long.
export const FETCH_MAX_M = 8;
const FETCH_SEC = 0.3;

export interface ObjectStep {
  vrActive: boolean;
  deltaSec: number;
  /** The take's clock, for the summon log. */
  timeSec: number;
  /** The body's facing (the camera's look yaw). */
  bodyYaw: number;
  /** The view's forward (world, unit): a flat screen pushes a held prop along it. */
  viewDirection?: THREE.Vector3;
  /** −1..1: the right stick's push (forward) or pull on a prop held in a headset. */
  vrPush?: number;
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
    /** Resizing the held prop this step: a size factor (wheel, `-`/`=`, a pinch) and `0`'s reset to 1. */
    resize?: { factor: number; reset: boolean };
    /** Metres to push the held prop out (negative: pull it in) this step: Shift+wheel or a two-finger pan. */
    push?: number;
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
  /** Uniform size against the model as loaded. */
  size: number;
  /** How far a held prop is pushed out beyond the hand (m); 0 when not held. */
  pushM: number;
  /** The prop body's mass (kg); 0 without one. */
  mass: number;
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
  /** Taken by a flat-screen reach: the next press lets it go, like `G`. */
  reached: boolean;
  /** Summoned from the tray on a flat screen: the next press (a touch on it, a click) lets it go, too. */
  summoned?: boolean;
  /**
   * Being lowered onto the surface under it before it is let go. The object stays held meanwhile.
   * `squat`: nothing is within the arm's standing reach below, so the hand goes down to the floor (`handFrom` to `handTo`, world points)
   * and the body squats only as far as the arm needs.
   */
  settle: { startSec: number; lowerM: number; squat: boolean; handFrom?: THREE.Vector3; handTo?: THREE.Vector3; sec?: number; remote?: { dropFrom: number } } | null;
  /** How far the prop is asked to be pushed out beyond the hand, along the view (flat screen) or the eye's line through the hand (headset). */
  pushM: number;
  /** How far it is pushed out this frame: `pushM`, or less where the scene or another prop is in the way. */
  pushedM: number;
  /** How far a remote set-down has lowered the pushed-out prop. */
  dropM: number;
  /** Fetched from a distance: the world pose it glides from, and when it started. */
  glide: { from: THREE.Matrix4; startSec: number } | null;
  /** The size asked for, before the detent at 1 and the clamp: resizes accumulate on it. */
  rawSize: number;
  /** A headset's other hand also holds the prop and stretches it: its side, the hands' distance and the raw size when it closed. */
  stretch: { side: VrHandSide; startM: number; startRaw: number } | null;
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
  /** One for ground heights (its range is the world's), one for lines between two points. */
  private readonly probe = new THREE.Raycaster();
  private readonly blockProbe = new THREE.Raycaster();
  private readonly originalSides = new WeakMap<THREE.Material, THREE.Side>();
  private readonly probeFrom = new THREE.Vector3();
  private readonly probeTo = new THREE.Vector3();
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
  private readonly otherPalm = new THREE.Vector3();
  private readonly eyePos = new THREE.Vector3();
  private readonly lineDir = new THREE.Vector3();
  private readonly fetchRay = new THREE.Raycaster();

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
    this.physics?.setReachTarget(this.reach.isReaching() ? this.reach.object : null);
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
      this.clearStep();
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
  pick(ray: THREE.Raycaster, anywhere: boolean, far = false): SceneObject | null {
    const { carry } = this.deps;
    if (this.hold?.settle && anywhere) return this.hold.object;
    // A second press (mouse or touch) during a reach cancels it, wherever it falls.
    if (this.reach.isReaching()) return this.reach.object;
    // The next press lets a prop held from a reach or a flat-screen summon go, like G.
    if (this.hold && !this.hold.settle) return this.hold.reached || this.hold.summoned ? this.hold.object : null;
    const hit = this.nearestProp(ray);
    if (!hit) return null;
    if (this.desktopReachable(hit.object, carry)) return hit.object;
    // `far` (a mouse press, or a touch that lifted as a tap): a prop out of reach but in sight is fetched.
    return far && hit.distance <= FETCH_MAX_M && !this.sceneBlocks(ray.ray.origin, hit.point) ? hit.object : null;
  }

  /** The nearest placed event prop `ray` meets, and where. */
  private nearestProp(ray: THREE.Raycaster): { object: SceneObject; distance: number; point: THREE.Vector3 } | null {
    let best: { object: SceneObject; distance: number; point: THREE.Vector3 } | null = null;
    for (const object of this.deps.registry.eventObjects()) {
      if (!object.placed) continue;
      object.model.updateWorldMatrix(true, true);
      const hit = ray.intersectObject(object.model, true)[0];
      if (hit && hit.distance < (best?.distance ?? Infinity)) best = { object, distance: hit.distance, point: hit.point };
    }
    return best;
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
        size: object.size,
        pushM: this.hold?.object === object ? this.hold.pushedM : 0,
        mass: this.physics?.mass(object) ?? 0,
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
      // The other hand lets go of a stretch: the prop stays in the first hand at its new size.
      if (this.hold?.stretch?.side === side && (intent.switched || !intent.pressed)) {
        this.hold.stretch = null;
        continue;
      }
      // The other hand closing on the held prop stretches it, ahead of an open tray's miniature.
      if (rising && !intent.switched && this.hold && this.hold.side !== side && !this.hold.stretch) {
        const palm = this.palmWorld(side, this.pos2);
        const other = this.palmWorld(this.hold.side, this.otherPalm);
        if (palm && other && this.distanceToObject(this.hold.object, palm) <= VR_REACH_M) {
          this.hold.stretch = { side, startM: Math.max(palm.distanceTo(other), 0.01), startRaw: this.hold.rawSize };
          continue;
        }
      }
      // A switch is not a fresh press: the new source has to open and close again.
      if (intent.switched) continue;
      // First hand wins: the other hand's grab is ignored until release.
      if (!rising || this.hold || !this.readAnchor(side)) continue;
      const palm = this.palmWorld(side, this.pos2);
      if (!palm) continue;
      // An open tray's miniature wins over an object in reach (PRD-045).
      const item = side === (step.summoner ?? 'right') ? this.deps.tray.nearestItem(palm, VR_REACH_M) : null;
      if (item) {
        const summoned = this.deps.tray.summon(item, step.timeSec);
        this.writeWorld(summoned, this.deps.tray.miniaturePose(item, this.world));
        summoned.placed = true;
        this.grab(summoned, side, false);
        continue;
      }
      const target = registry.eventObjects().find((object) => this.distanceToObject(object, palm) <= VR_REACH_M);
      if (target) this.grab(target, side, false);
      else {
        // Nothing in reach: the prop the hand's ray points at, in sight, is fetched.
        const far = this.rayTarget(side);
        if (far) this.fetch(far, side, false);
      }
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
    const stretch = hold.stretch;
    if (stretch) {
      const palm = TRACKED_SOURCES.has(tracking.getHandPoseSource(stretch.side)) ? this.palmWorld(stretch.side, this.pos2) : undefined;
      const other = this.palmWorld(hold.side, this.otherPalm);
      // The stretching hand losing tracking ends the stretch where it is.
      if (!palm || !other) hold.stretch = null;
      else this.resizeTo(hold, (stretch.startRaw * palm.distanceTo(other)) / stretch.startM);
    }
    if (this.readAnchor(hold.side)) {
      this.world.multiplyMatrices(this.anchor, hold.offset);
      if (step.vrPush) this.pushBy(hold, step.vrPush * VR_PUSH_MPS * step.deltaSec);
      this.finishPose(hold, this.eyeLine(hold.side, step.viewDirection));
      this.writeWorld(hold.object, this.world);
      this.physics?.sample(hold.object, this.clock);
    }
  }

  private updateDesktop(step: ObjectStep): void {
    const { carry, registry, tray } = this.deps;
    const reach = this.reach;
    this.lastBodyYaw = step.bodyYaw;
    const slot = step.desktop.summonSlot;
    const item = slot !== null && !this.hold && !reach.isReaching() ? tray.getItems().find((candidate) => candidate.slot === slot) : undefined;
    if (item && tray.isOpen() && this.readAnchor('right')) {
      // Appears in the right hand and rises with it as the carry pose blends in.
      const summoned = tray.summon(item, step.timeSec);
      this.writeWorld(summoned, tray.miniaturePose(item, this.world));
      this.writeWorld(summoned, this.inHandPose(summoned, step.bodyYaw, this.world));
      summoned.placed = true;
      this.grab(summoned, 'right', false);
      this.hold!.desktop = true;
      this.hold!.summoned = true;
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
      else if ((this.hold?.reached || this.hold?.summoned) && !reach.isLifting()) this.releaseDesktop();
      else if (!this.hold && reach.phase === 'idle') {
        // Picked out of reach (a mouse press, or a touch tap): fetched into the hand, where it stays until the next press.
        if (this.desktopReachable(press, carry)) this.beginReach(press, true);
        else if (this.readAnchor('right')) this.fetch(press, 'right', true, step.bodyYaw);
      }
    }
    if (release) {
      // A pointer lifted during the reach or the lift doesn't cancel it: the prop stays held until the next press or G.
      if (reach.isReaching() || reach.isLifting()) {
        reach.pointerDown = false;
        if (this.hold) this.hold.pointer = false;
      } else if (this.hold?.pointer && !this.hold.settle) this.releaseDesktop();
    }
    if (reach.isReaching() && !this.stillReaching(step)) this.cancelReach();
    if (reach.isStepping()) {
      this.stepIn(step);
      // The step ended (arrived, stalled at a wall, or stopped at a ledge): the prop must still be reachable across open space.
      if (!reach.isStepping()) {
        this.clearStep();
        if (this.reachBlocked()) this.cancelReach();
      }
    } else this.clearStep();
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
        // A pushed-out prop is lowered by itself; the hand stays where it is.
        if (settle.remote) hold!.dropM = settle.remote.dropFrom + t * t * (3 - 2 * t) * settle.lowerM;
        else lowerM = t * t * (3 - 2 * t) * settle.lowerM;
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
    const resize = step.desktop.resize;
    if (resize && (resize.reset || resize.factor !== 1)) this.resizeTo(held, resize.reset ? 1 : held.rawSize * resize.factor);
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
    const push = step.desktop.push ?? 0;
    if (push !== 0 && !held.settle) this.pushBy(held, push);
    this.finishPose(held, step.viewDirection ?? this.axis.set(-Math.sin(step.bodyYaw), 0, -Math.cos(step.bodyYaw)));
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
    if (this.reachBlocked()) return;
    if (stepM > 0) stepM = this.supportedStepM(stepM);
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
    let moveM = this.reach.stepTowards(step.deltaSec, this.stepRemaining(false));
    if (moveM > 0) {
      // Ground ends ahead (a ledge, a gap): the step stops where the support does.
      const allowed = this.supportedStepM(moveM);
      if (allowed < moveM) {
        moveM = allowed;
        this.reach.blockStep();
      }
    }
    this.pendingStep.x = this.stepDir.x * moveM;
    this.pendingStep.z = this.stepDir.z * moveM;
  }

  private clearStep(): void {
    this.pendingStep.x = 0;
    this.pendingStep.z = 0;
  }

  /** Stands back up with nothing grabbed. */
  private cancelReach(): void {
    this.clearStep();
    this.reach.stop();
  }

  /** The ground height under a point, or undefined where the scene has none. */
  private groundAt(x: number, z: number): number | undefined {
    return this.deps.avatar.sampleTerrainYAt(x, z, this.probe);
  }

  /**
   * How far along `stepDir` (from the root) the avatar can step, up to `wantM`, with ground under it the whole way:
   * present, and within `STEP_GROUND_TOLERANCE_M` of the ground under the root. Looks `STEP_LOOKAHEAD_M` ahead of each position.
   */
  private supportedStepM(wantM: number): number {
    const root = this.deps.avatar.avatarRoot.position;
    const here = this.groundAt(root.x, root.z);
    if (here === undefined) return 0;
    const reachEnd = wantM + STEP_LOOKAHEAD_M;
    let good = 0;
    for (let d = STEP_PROBE_SPACING_M; ; d += STEP_PROBE_SPACING_M) {
      const probe = Math.min(d, reachEnd);
      const y = this.groundAt(root.x + this.stepDir.x * probe, root.z + this.stepDir.z * probe);
      if (y === undefined || Math.abs(y - here) > STEP_GROUND_TOLERANCE_M) return Math.max(0, Math.min(wantM, good - STEP_LOOKAHEAD_M));
      good = probe;
      if (probe >= reachEnd) return wantM;
    }
  }

  /** Whether scene geometry (a wall, a thin one included) lies between two points. Back faces count: a wall blocks from both sides. */
  private sceneBlocks(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const world = this.deps.avatar.worldModel;
    if (!world) return false;
    const length = from.distanceTo(to);
    if (length < 1e-4) return false;
    this.blockProbe.set(from, this.probeTo.copy(to).sub(from).normalize());
    this.blockProbe.near = 0;
    this.blockProbe.far = length - 0.02;
    // A wall blocks from both sides, so rays see back faces: every material is DoubleSide for the cast and put back from its snapshot (taken once, so a material two meshes share is not recorded as already changed).
    const materials = new Set<THREE.Material>();
    world.traverse((child) => {
      const material = (child as THREE.Mesh).material;
      for (const m of Array.isArray(material) ? material : material ? [material] : []) materials.add(m);
    });
    for (const m of materials) {
      if (!this.originalSides.has(m)) this.originalSides.set(m, m.side);
      m.side = THREE.DoubleSide;
    }
    const hit = this.blockProbe.intersectObject(world, true).length > 0;
    for (const m of materials) m.side = this.originalSides.get(m) ?? m.side;
    return hit;
  }

  /** Whether the way from the avatar to the prop's grasp point is open: the arm's line from the shoulder, and a knee-high line along the floor the step would walk. */
  private reachBlocked(): boolean {
    const { avatar } = this.deps;
    const root = avatar.avatarRoot.position;
    const shoulder = avatar.getBoneWorldPosition('rightUpperArm', this.pos2);
    if (shoulder && this.sceneBlocks(shoulder, this.reach.grasp)) return true;
    this.probeFrom.set(root.x, root.y + REACH_KNEE_RAY_M, root.z);
    this.pos.set(this.reach.grasp.x, root.y + REACH_KNEE_RAY_M, this.reach.grasp.z);
    return this.sceneBlocks(this.probeFrom, this.pos);
  }

  /** Whether a reach goes on: the prop is still there and reachable, nothing walks or points, and it has not timed out or moved. */
  private stillReaching(step: ObjectStep): boolean {
    const { registry, carry, avatar } = this.deps;
    const object = this.reach.object;
    if (!object || !registry.all().includes(object) || step.desktop.walking || step.desktop.pointHeld) return false;
    if (!this.desktopReachable(object, carry)) return false;
    // The shoulder moves through the squat: the way to the prop must stay open every frame, not only at the start.
    if (this.reachBlocked()) return false;
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
    if (hold.pushedM > PUSHED_M || needed <= this.deps.carry.maxLowerM()) {
      hold.settle = { startSec: this.clock, lowerM: needed, squat: false, ...(hold.pushedM > PUSHED_M ? { remote: { dropFrom: hold.dropM } } : {}) };
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
    // A pushed-out prop stays out where the lowering put it.
    if (hold.settle.remote) {
      hold.settle = null;
      hold.pointer = pointer;
      this.physics?.hold(hold.object);
      return;
    }
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
    this.hold = { object, side, desktop, offset, lostSec: 0, pointer: false, reached: false, settle: null, rawSize: object.size, stretch: null, pushM: 0, pushedM: 0, dropM: 0, glide: null };
    object.heldBy = side;
    this.physics?.hold(object);
  }

  /**
   * A prop out of reach comes to the hand: held at once, gliding from where it
   * was into the hand over a moment, passing through other props meanwhile.
   * On a flat screen it lands in front of the palm (`bodyYaw`), in a headset at it.
   */
  private fetch(object: SceneObject, side: VrHandSide, desktop: boolean, bodyYaw = 0): void {
    if (!this.readAnchor(side)) return;
    object.wrapper.updateWorldMatrix(true, false);
    const from = object.wrapper.matrixWorld.clone();
    let target: THREE.Matrix4;
    if (desktop) target = this.inHandPose(object, bodyYaw, new THREE.Matrix4());
    else {
      const palm = this.palmWorld(side, this.pos2) ?? this.pos2.setFromMatrixPosition(this.anchor);
      this.box.setFromObject(object.model);
      const radius = this.box.getSize(this.pos).length() / 2;
      from.decompose(this.pos, this.quat, this.scale);
      // Just off the palm, on the side it came from.
      const toward = this.pos.sub(palm).normalize();
      target = new THREE.Matrix4().compose(palm.clone().addScaledVector(toward, radius * 0.6), this.quat, this.unit);
    }
    this.grab(object, side, desktop);
    const hold = this.hold!;
    hold.offset.copy(this.anchor).invert().multiply(target);
    hold.glide = { from, startSec: this.clock };
    hold.reached = desktop;
    this.physics?.ghost(object, true);
  }

  /** The placed event prop the headset hand's pointing ray meets, within fetch range and in sight. */
  private rayTarget(side: VrHandSide): SceneObject | null {
    const ray = this.deps.tracking.getChromeInput(side).targetRay;
    if (!ray) return null;
    ray.updateWorldMatrix(true, false);
    ray.matrixWorld.decompose(this.pos, this.quat, this.scale);
    this.fetchRay.set(this.pos, this.axis.set(0, 0, -1).applyQuaternion(this.quat));
    this.fetchRay.near = 0;
    this.fetchRay.far = FETCH_MAX_M;
    const hit = this.nearestProp(this.fetchRay);
    return hit && !this.sceneBlocks(this.fetchRay.ray.origin, hit.point) ? hit.object : null;
  }

  /** Pushes the held prop out (or pulls it in) by `deltaM`; what moved it is not the hand, so it never counts toward a throw. */
  private pushBy(hold: Hold, deltaM: number): void {
    // From where it is: a push held against a wall builds up no distance to jump out by, nor a pull any to wind back first.
    hold.pushM = THREE.MathUtils.clamp(Math.min(hold.pushM, hold.pushedM) + deltaM, 0, MAX_PUSH_M);
    this.physics?.forget(hold.object);
  }

  /**
   * From the in-hand pose in `world`: pushed out along `direction`, no further
   * than the scene or another prop allows this frame (the asked distance is
   * kept for when the way clears), lowered by a remote set-down, and blended
   * from where a fetch started while it glides.
   */
  private finishPose(hold: Hold, direction: THREE.Vector3): void {
    hold.pushedM = hold.pushM;
    if (hold.pushM > 0 || hold.dropM > 0) {
      if (hold.pushM > 0 && this.physics) {
        this.writeWorld(hold.object, this.world);
        hold.pushedM = Math.min(hold.pushM, this.physics.clearance(hold.object, direction, hold.pushM));
      }
      this.world.elements[12] += direction.x * hold.pushedM;
      this.world.elements[13] += direction.y * hold.pushedM - hold.dropM;
      this.world.elements[14] += direction.z * hold.pushedM;
    }
    const glide = hold.glide;
    if (!glide) return;
    // The glide is not the hand's swing: a release during it drops the prop rather than throwing it.
    this.physics?.forget(hold.object);
    const t = Math.min(1, (this.clock - glide.startSec) / FETCH_SEC);
    if (t >= 1) {
      hold.glide = null;
      this.physics?.ghost(hold.object, false);
      return;
    }
    const k = t * t * (3 - 2 * t);
    this.world.decompose(this.pos, this.quat, this.scale);
    glide.from.decompose(this.pos2, this.quat2, this.scale);
    this.world.compose(this.pos2.lerp(this.pos, k), this.quat2.slerp(this.quat, k), this.unit);
  }

  /**
   * A headset's push line: where the holding controller points (the stick that
   * pushes is on a controller); else from the eye through the hand, or the
   * view's forward when the hand is at the eye.
   */
  private eyeLine(side: VrHandSide, fallback: THREE.Vector3 | undefined): THREE.Vector3 {
    const ray = this.deps.tracking.getChromeInput(side).targetRay;
    if (ray) {
      ray.updateWorldMatrix(true, false);
      ray.matrixWorld.decompose(this.eyePos, this.quat2, this.scale);
      return this.lineDir.set(0, 0, -1).applyQuaternion(this.quat2);
    }
    const eye = this.deps.avatar.getEyeAnchorWorldPosition(this.eyePos, this.deps.embodyOffset);
    this.lineDir.setFromMatrixPosition(this.anchor).sub(eye);
    if (this.lineDir.length() >= 0.1) return this.lineDir.normalize();
    return this.lineDir.copy(fallback ?? this.axis.set(0, 0, -1));
  }

  /** A deliberate let-go throws with the fitted velocity; every other release drops with none. */
  private release(throwIt: boolean): void {
    if (!this.hold) return;
    if (this.hold.glide) this.physics?.ghost(this.hold.object, false);
    this.physics?.release(this.hold.object, throwIt, this.hold.side, this.hold.desktop);
    this.hold.object.heldBy = null;
    this.hold = null;
    // A reach that was only for this prop ends with it; a body already standing up goes on standing.
    this.reach.stop();
  }

  /**
   * The held prop takes the size asked for: clamped, and exactly 1 within the
   * detent. It grows about its center, and its collider follows.
   */
  private resizeTo(hold: Hold, raw: number): void {
    hold.rawSize = THREE.MathUtils.clamp(raw, MIN_SIZE, MAX_SIZE);
    const size = Math.abs(hold.rawSize - 1) <= SIZE_DETENT ? 1 : hold.rawSize;
    const object = hold.object;
    if (size === object.size) return;
    object.size = size;
    object.sizer.scale.setScalar(size);
    object.wrapper.updateMatrixWorld(true);
    this.physics?.resize(object);
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
    if (this.box.min.y < avatar.avatarRoot.position.y - REACH_BELOW_FEET_M) return false;
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
