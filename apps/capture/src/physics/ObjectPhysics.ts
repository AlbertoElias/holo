import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

import type { SceneObject } from '../objects/SceneObjectRegistry';
import { isThreeMesh } from '../shared/threeTypeGuards';
import type { VrHandSide } from '../types/contracts';
import { type AvatarBones, AvatarColliders, PROP_BIT, groups } from './AvatarColliders';

// A convex hull is built from at most this many of the model's vertices.
const MAX_HULL_POINTS = 128;
// A resize rebuilds the collider once the size has moved this far (as a ratio) from the collider's.
const RESHAPE_RATIO = 0.01;
// One density for every prop (kg/m³): mass follows the hull's volume.
const DENSITY = 500;
// Max-combined with the scene (Rapier's default 0.5), so a dropped prop grips
// instead of skating; a low bounce and rolling damping let it tip, then stop.
const FRICTION = 0.8;
const RESTITUTION = 0.12;
const LINEAR_DAMPING = 0.15;
const ANGULAR_DAMPING = 1.5;
// The physics step is substepped to at most this long, and at most this many times a frame.
const MAX_SUBSTEP_SEC = 1 / 60;
const MAX_SUBSTEPS = 6;
// Release velocity is fitted over this window of the object's own poses, from at least 3 samples.
const FIT_WINDOW_SEC = 0.1;
const MIN_FIT_SAMPLES = 3;
const MAX_HISTORY = 12;
const MAX_LINEAR_MPS = 12;
// Keeps the turn between 60 Hz keys under 180°, so replay interpolation can't spin the wrong way.
const MAX_ANGULAR_RADPS = 20;
// A prop this far past the scene's footprint, or this far below its lowest surface, goes back to its placement pose.
const BOUNDS_MARGIN_M = 0.5;
const BELOW_FLOOR_M = 1;
const ABOVE_CEILING_M = 100;
const STEP_TIME_SAMPLES = 600;
// A hovering prop is knocked down only by a part moving faster than this: a hand slowly closing on it grabs it instead.
const KNOCK_MPS = 0.5;
// A released prop passes through the arm that held it this long, then until clear: a hand that stops after a throw doesn't catch what it threw.
const ARM_GRACE_SEC = 0.25;
// A flat-screen put-down also passes through the legs this long (the squat's knees rise past it).
const LEG_GRACE_SEC = 1;

// A prop lifted out of a surface it was grown into lands this far above it.
const LIFT_CLEARANCE_M = 0.002;

const DOWN = { x: 0, y: -1, z: 0 };
// Queries that see the scene and props but never the avatar.
const NO_AVATAR = groups(PROP_BIT, PROP_BIT);

interface PoseSample {
  t: number;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

interface PropBody {
  body: RAPIER.RigidBody;
  /** The pose `place()` (or a summon) gave it: where an out-of-bounds prop returns. */
  home: { position: THREE.Vector3; quaternion: THREE.Quaternion };
  /** Kinematic (held, or hovering where it was placed) until its first release. */
  dynamic: boolean;
  held: boolean;
  /** Avatar parts this prop passes through until it is clear of them (all of them while it is a reach's target). */
  excluded: number;
  /** Groups last given to the collider, and which collider: one rebuilt (a resize) gets them again. */
  groups: number;
  groupsCollider: number;
  /** Parts excluded for `graceSec` more, overlapping or not. */
  graceBits: number;
  graceSec: number;
  /** Gliding to the hand: collides with nothing. */
  ghosted: boolean;
  /** A kinematic prop's pose after the last step and its target for this one, interpolated per substep. */
  from: { position: THREE.Vector3; quaternion: THREE.Quaternion };
  to: { position: THREE.Vector3; quaternion: THREE.Quaternion };
  /** The wrapper already has the pose the body fell asleep with. */
  sleepWritten: boolean;
  history: PoseSample[];
  /** The collider's points at size 1, in the wrapper's frame, and whether they are a hull's (else a box's corners). */
  shape: { points: Float32Array; hull: boolean };
  /** The size the collider was built at. */
  size: number;
}

export interface ObjectPhysicsStats {
  bodies: number;
  /** Median wall time of one frame's `world.step` calls, over the last frames that stepped a body. */
  stepMedianMs: number | null;
  stepSamples: number;
  resets: number;
  /** Avatar parts with a collider. */
  avatarParts: number;
  /** Hovering props the avatar has knocked down. */
  knockdowns: number;
}

/**
 * The props' own physics world: a copy of the scene's collision mesh and a
 * ground backstop, one body per event object, and the avatar as kinematic
 * parts that push props and are never pushed. It is separate from the
 * character motor's world so props never block the capsule or its raycasts,
 * and so it steps after the hold update (the motor steps before the arms are
 * final). A prop is kinematic while held and dynamic once released; the
 * object system writes the result back to the wrapper.
 */
export class ObjectPhysics {
  private readonly world: RAPIER.World;
  private readonly props = new Map<SceneObject, PropBody>();
  private readonly bounds = new THREE.Box3();
  private readonly stepTimes: number[] = [];
  private resets = 0;
  private knockdowns = 0;
  private avatar: AvatarColliders | null = null;
  private reachTarget: SceneObject | null = null;

  private readonly m = new THREE.Matrix4();
  private readonly rigidInverse = new THREE.Matrix4();
  private readonly p = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly unit = new THREE.Vector3(1, 1, 1);
  private readonly s = new THREE.Vector3();

  /** `RAPIER.init()` has run: the character motor awaits it before it exposes the scene's mesh. */
  constructor(trimesh: { vertices: Float32Array; indices: Uint32Array }, gravity: number) {
    this.world = new RAPIER.World({ x: 0, y: gravity, z: 0 });
    this.world.createCollider(RAPIER.ColliderDesc.trimesh(trimesh.vertices, trimesh.indices));
    this.bounds.makeEmpty();
    for (let i = 0; i < trimesh.vertices.length; i += 3) this.bounds.expandByPoint(this.p.set(trimesh.vertices[i] ?? 0, trimesh.vertices[i + 1] ?? 0, trimesh.vertices[i + 2] ?? 0));
    if (this.bounds.isEmpty()) return;
    // A backstop at the scene's lowest surface, so a prop that leaves the mesh doesn't fall forever before the bounds check returns it.
    const { min, max } = this.bounds;
    const halfX = (max.x - min.x) / 2 + 50;
    const halfZ = (max.z - min.z) / 2 + 50;
    const slab = RAPIER.ColliderDesc.cuboid(halfX, 0.5, halfZ).setTranslation((min.x + max.x) / 2, min.y - 0.5, (min.z + max.z) / 2);
    this.world.createCollider(slab);
  }

  /** The avatar's bones, once it is loaded: its parts join the world. */
  setAvatar(bones: AvatarBones): void {
    if (!this.avatar) this.avatar = new AvatarColliders(this.world, bones);
  }

  /** A flat-screen reach's target passes through the whole avatar until it is grabbed, or clear of it once the reach ends. */
  setReachTarget(object: SceneObject | null): void {
    if (object === this.reachTarget) return;
    const previous = this.reachTarget ? this.props.get(this.reachTarget) : undefined;
    // Clear of the parts it is not inside after the next step, when this frame's avatar pose is known.
    if (previous && this.avatar) previous.excluded = this.avatar.allBits;
    this.reachTarget = object;
  }

  /** Whether `object` has a body. */
  has(object: SceneObject): boolean {
    return this.props.has(object);
  }

  isDynamic(object: SceneObject): boolean {
    return this.props.get(object)?.dynamic ?? false;
  }

  /** Gives `object` a kinematic body at its current pose, which is also where it returns to when it leaves the bounds. */
  ensure(object: SceneObject): PropBody {
    const existing = this.props.get(object);
    if (existing) return existing;
    object.wrapper.updateWorldMatrix(true, true);
    this.rigidPose(object, this.p, this.q);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(this.p.x, this.p.y, this.p.z)
        .setRotation(this.q)
        .setCcdEnabled(true)
        .setCanSleep(true)
        .setLinearDamping(LINEAR_DAMPING)
        .setAngularDamping(ANGULAR_DAMPING)
    );
    // Placed where it is, it passes through whatever of the avatar it was placed in until clear (narrowed after the first step).
    const prop: PropBody = { body, home: { position: this.p.clone(), quaternion: this.q.clone() }, dynamic: false, held: false, excluded: 0xfffe, groups: 0, groupsCollider: -1, graceBits: 0, graceSec: 0, ghosted: false, from: { position: this.p.clone(), quaternion: this.q.clone() }, to: { position: this.p.clone(), quaternion: this.q.clone() }, sleepWritten: false, history: [], shape: this.shapeFor(object), size: object.size };
    this.attachCollider(prop);
    this.props.set(object, prop);
    return prop;
  }

  /**
   * The collider follows the object's size: rebuilt from the size-1 points once
   * the size has moved past the rebuild ratio, or always with `exact` (a
   * gesture's end). Density stays, so mass follows the volume.
   */
  resize(object: SceneObject, exact = false): void {
    const prop = this.props.get(object);
    if (!prop || prop.size === object.size) return;
    if (!exact && Math.abs(object.size / prop.size - 1) < RESHAPE_RATIO) return;
    prop.size = object.size;
    const desc = this.shapeAt(prop);
    const collider = prop.body.collider(0);
    collider.setShape(desc.shape);
    collider.setTranslationWrtParent(desc.translation);
    // Density is per collider: setting it again makes the body's mass follow the new volume.
    collider.setDensity(DENSITY);
  }

  /** Poses so far no longer count toward a release's velocity: what moved the prop was not the hand's swing. */
  forget(object: SceneObject): void {
    const prop = this.props.get(object);
    if (prop) prop.history.length = 0;
  }

  /** A prop gliding to the hand passes through other props instead of batting them. */
  ghost(object: SceneObject, on: boolean): void {
    const prop = this.props.get(object);
    if (!prop) return;
    prop.ghosted = on;
    // The next step gives the collider its groups.
    prop.groupsCollider = -1;
  }

  /** The body's mass (kg), for checks. */
  mass(object: SceneObject): number {
    return this.props.get(object)?.body.mass() ?? 0;
  }

  /**
   * How far (m) the object, at its wrapper's current pose, can move along the
   * unit `direction` before its collider meets the scene or another prop, up to
   * `maxM`. Its own body is ignored.
   */
  clearance(object: SceneObject, direction: THREE.Vector3, maxM: number): number {
    const prop = this.props.get(object);
    if (!prop || !(maxM > 0)) return Math.max(0, maxM);
    this.rigidPose(object, this.p, this.q);
    const hit = this.world.castShape(this.p, this.q, direction, prop.body.collider(0).shape, 0, maxM, true, undefined, NO_AVATAR, undefined, prop.body);
    return hit ? hit.time_of_impact : maxM;
  }

  /** The object is grabbed (or caught mid-air): kinematic at once, with no velocity. */
  hold(object: SceneObject): void {
    const prop = this.ensure(object);
    prop.history.length = 0;
    prop.dynamic = false;
    prop.held = true;
    prop.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    prop.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    prop.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    this.rigidPose(object, this.p, this.q);
    prop.body.setTranslation(this.p, true);
    prop.body.setRotation(this.q, true);
    prop.from.position.copy(this.p);
    prop.from.quaternion.copy(this.q);
  }

  /** A pose of the held object at `timeSec`, for the release fit. */
  sample(object: SceneObject, timeSec: number): void {
    const prop = this.props.get(object);
    if (!prop) return;
    this.rigidPose(object, this.p, this.q);
    prop.history.push({ t: timeSec, position: this.p.clone(), quaternion: this.q.clone() });
    if (prop.history.length > MAX_HISTORY) prop.history.shift();
  }

  /**
   * The object is let go: dynamic, with the fitted velocity when `throwIt`,
   * else at rest. It passes through the arm that held it for a moment, and
   * through every part until the next step, after which it collides with all
   * those it is clear of (the avatar's pose for this frame is not known yet). A flat-screen put-down (`desktop`, not a throw) also passes through
   * the legs for a moment. Its collider takes its final size first, and a
   * prop grown into a surface while held is lifted out onto it.
   */
  release(object: SceneObject, throwIt: boolean, side?: VrHandSide, desktop = false): void {
    const prop = this.props.get(object);
    if (!prop) return;
    this.resize(object, true);
    prop.held = false;
    if (this.avatar) {
      const arm = side ? this.avatar.armBits(side) : 0;
      const putDown = desktop && !throwIt;
      prop.excluded = this.avatar.allBits;
      prop.graceBits = arm | (putDown ? this.avatar.legBits : 0);
      prop.graceSec = putDown ? LEG_GRACE_SEC : ARM_GRACE_SEC;
    }
    this.rigidPose(object, this.p, this.q);
    this.p.y += this.liftOut(prop, this.p, this.q);
    prop.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    prop.body.setTranslation(this.p, true);
    prop.body.setRotation(this.q, true);
    const fit = throwIt ? this.fitVelocity(prop.history) : null;
    prop.body.setLinvel(fit?.linear ?? { x: 0, y: 0, z: 0 }, true);
    prop.body.setAngvel(fit?.angular ?? { x: 0, y: 0, z: 0 }, true);
    prop.history.length = 0;
    prop.dynamic = true;
    prop.sleepWritten = false;
  }

  /** The fitted speed (m/s) a release now would throw with; 0 when too few poses are known. */
  releaseSpeed(object: SceneObject): number {
    const prop = this.props.get(object);
    return prop ? (this.fitVelocity(prop.history)?.linear.length() ?? 0) : 0;
  }

  /**
   * How far the prop, at its wrapper's current pose, can fall straight down
   * before its collider touches the scene, the ground or another prop; null
   * when nothing is within `maxM`. Its own body is ignored.
   */
  gapBelow(object: SceneObject, maxM: number): number | null {
    const prop = this.props.get(object);
    if (!prop) return null;
    this.rigidPose(object, this.p, this.q);
    const hit = this.world.castShape(this.p, this.q, DOWN, prop.body.collider(0).shape, 0, maxM, true, undefined, NO_AVATAR, undefined, prop.body);
    return hit ? hit.time_of_impact : null;
  }

  remove(object: SceneObject): void {
    const prop = this.props.get(object);
    if (!prop) return;
    this.world.removeRigidBody(prop.body);
    this.props.delete(object);
  }

  /**
   * One frame. Held and hovering props follow their wrapper; free props are
   * simulated and written back through `write`. Every placed event object
   * gets a body first.
   */
  step(objects: readonly SceneObject[], deltaSec: number, write: (object: SceneObject, world: THREE.Matrix4) => void): void {
    for (const object of objects) if (object.placed) this.ensure(object);
    if (this.props.size === 0 || !(deltaSec > 0)) return;

    const avatar = this.avatar;
    const simulatedSec = Math.min(deltaSec, MAX_SUBSTEPS * MAX_SUBSTEP_SEC);
    // A hitch frame simulates less time than it took, so the avatar's motion is judged over the simulated time.
    const jumped = avatar?.sync(simulatedSec) ?? 0;
    for (const [object, prop] of this.props) {
      // A part that jumped in passes through whatever it landed in, rather than launching it.
      if (jumped) prop.excluded |= this.overlappedParts(prop, jumped);
      if (prop.graceSec > 0) {
        prop.graceSec -= deltaSec;
        if (prop.graceSec <= 0) prop.excluded |= prop.graceBits;
      }
      const ignored = this.reachTarget === object ? 0xfffe : prop.excluded | (prop.graceSec > 0 ? prop.graceBits : 0);
      const next = prop.ghosted ? 0 : groups(PROP_BIT, PROP_BIT | (~ignored & 0xfffe));
      const collider = prop.body.collider(0);
      if (next !== prop.groups || collider.handle !== prop.groupsCollider) {
        collider.setCollisionGroups(next);
        prop.groups = next;
        prop.groupsCollider = collider.handle;
      }
      if (prop.dynamic) continue;
      object.wrapper.updateWorldMatrix(true, true);
      this.rigidPose(object, prop.to.position, prop.to.quaternion);
    }
    const substeps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(deltaSec / MAX_SUBSTEP_SEC - 1e-6)));
    this.world.timestep = simulatedSec / substeps;
    const started = performance.now();
    for (let i = 0; i < substeps; i += 1) {
      // Kinematic bodies cover their frame's motion evenly across the substeps, so a swing hits at its own speed.
      const fraction = (i + 1) / substeps;
      avatar?.substep(fraction);
      for (const prop of this.props.values()) {
        if (prop.dynamic) continue;
        prop.body.setNextKinematicTranslation(this.p.lerpVectors(prop.from.position, prop.to.position, fraction));
        prop.body.setNextKinematicRotation(this.q.slerpQuaternions(prop.from.quaternion, prop.to.quaternion, fraction));
      }
      this.world.step();
    }
    this.stepTimes.push(performance.now() - started);
    if (this.stepTimes.length > STEP_TIME_SAMPLES) this.stepTimes.shift();
    avatar?.settle();
    const moving = avatar?.movingBits(KNOCK_MPS) ?? 0;

    for (const [object, prop] of this.props) {
      if (!prop.dynamic) {
        prop.from.position.copy(prop.to.position);
        prop.from.quaternion.copy(prop.to.quaternion);
      }
      if (!avatar || this.reachTarget === object) continue;
      // Parts it has come clear of collide again.
      if (prop.excluded) prop.excluded = this.overlappedParts(prop, prop.excluded);
      const touching = moving & ~prop.excluded & ~(prop.graceSec > 0 ? prop.graceBits : 0);
      if (!touching) continue;
      if (prop.dynamic && prop.body.isSleeping() && this.overlappedParts(prop, touching)) prop.body.wakeUp();
      if (!prop.dynamic && !prop.held && this.overlappedParts(prop, touching)) {
        // The avatar walked or swung into a hovering prop: it falls, and the next step pushes it.
        prop.dynamic = true;
        prop.sleepWritten = false;
        prop.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
        prop.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        prop.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        this.knockdowns += 1;
      }
    }

    for (const [object, prop] of this.props) {
      if (!prop.dynamic) continue;
      this.clampSpeed(prop.body);
      if (this.outOfBounds(prop.body.translation())) {
        this.sendHome(prop);
        this.resets += 1;
      } else if (prop.body.isSleeping()) {
        // Written once more on the step it falls asleep, so the wrapper holds the final pose.
        if (prop.sleepWritten) continue;
        prop.sleepWritten = true;
      } else {
        prop.sleepWritten = false;
      }
      const t = prop.body.translation();
      const r = prop.body.rotation();
      write(object, this.m.compose(this.p.set(t.x, t.y, t.z), this.q.set(r.x, r.y, r.z, r.w), this.unit));
    }
  }

  stats(): ObjectPhysicsStats {
    const sorted = [...this.stepTimes].sort((a, b) => a - b);
    return {
      bodies: this.props.size,
      stepMedianMs: sorted[Math.floor(sorted.length / 2)] ?? null,
      stepSamples: sorted.length,
      resets: this.resets,
      avatarParts: this.avatar ? popcount(this.avatar.liveBits) : 0,
      knockdowns: this.knockdowns
    };
  }

  /** A free body's velocity and sleep state, for checks. */
  bodyState(object: SceneObject): { state: 'none' | 'kinematic' | 'dynamic' | 'asleep'; linvel: [number, number, number]; angvel: [number, number, number] } {
    const prop = this.props.get(object);
    if (!prop) return { state: 'none', linvel: [0, 0, 0], angvel: [0, 0, 0] };
    const l = prop.body.linvel();
    const a = prop.body.angvel();
    const state = !prop.dynamic ? 'kinematic' : prop.body.isSleeping() ? 'asleep' : 'dynamic';
    return { state, linvel: [l.x, l.y, l.z], angvel: [a.x, a.y, a.z] };
  }

  /**
   * How far up the prop at `position` must go for its collider to clear what
   * it overlaps, landing on top of it; 0 when it overlaps nothing, or when
   * there is no room above.
   */
  private liftOut(prop: PropBody, position: THREE.Vector3, quaternion: THREE.Quaternion): number {
    const shape = prop.body.collider(0).shape;
    if (!this.world.intersectionWithShape(position, quaternion, shape, undefined, NO_AVATAR, undefined, prop.body)) return 0;
    let reach = 0;
    const { points } = prop.shape;
    for (let i = 0; i < points.length; i += 3) reach = Math.max(reach, Math.hypot(points[i] ?? 0, points[i + 1] ?? 0, points[i + 2] ?? 0));
    const above = 2 * reach * prop.size + LIFT_CLEARANCE_M;
    const from = { x: position.x, y: position.y + above, z: position.z };
    if (this.world.intersectionWithShape(from, quaternion, shape, undefined, NO_AVATAR, undefined, prop.body)) return 0;
    const hit = this.world.castShape(from, quaternion, DOWN, shape, 0, above, true, undefined, NO_AVATAR, undefined, prop.body);
    return hit ? Math.max(0, above - hit.time_of_impact) + LIFT_CLEARANCE_M : 0;
  }

  /** The prop returns to its placement pose, at rest and hovering as it first appeared. */
  private sendHome(prop: PropBody): void {
    prop.dynamic = false;
    prop.held = false;
    prop.history.length = 0;
    prop.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    prop.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    prop.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    prop.body.setTranslation(prop.home.position, true);
    prop.body.setRotation(prop.home.quaternion, true);
    prop.body.setNextKinematicTranslation(prop.home.position);
    prop.body.setNextKinematicRotation(prop.home.quaternion);
    prop.from.position.copy(prop.home.position);
    prop.from.quaternion.copy(prop.home.quaternion);
    prop.to.position.copy(prop.home.position);
    prop.to.quaternion.copy(prop.home.quaternion);
    // Back where it was placed, it passes through the avatar until clear, as when first placed.
    prop.excluded = this.avatar?.allBits ?? 0xfffe;
    prop.graceBits = 0;
    prop.graceSec = 0;
    prop.sleepWritten = false;
  }

  /** A kick, bat or foot pressing a prop into the floor never sends it faster than a throw can, or spins it past what replay interpolates. */
  private clampSpeed(body: RAPIER.RigidBody): void {
    const l = body.linvel();
    const linear = Math.hypot(l.x, l.y, l.z);
    if (linear > MAX_LINEAR_MPS) body.setLinvel({ x: (l.x * MAX_LINEAR_MPS) / linear, y: (l.y * MAX_LINEAR_MPS) / linear, z: (l.z * MAX_LINEAR_MPS) / linear }, true);
    const a = body.angvel();
    const angular = Math.hypot(a.x, a.y, a.z);
    if (angular > MAX_ANGULAR_RADPS) body.setAngvel({ x: (a.x * MAX_ANGULAR_RADPS) / angular, y: (a.y * MAX_ANGULAR_RADPS) / angular, z: (a.z * MAX_ANGULAR_RADPS) / angular }, true);
  }

  /** Which of `bits`' avatar parts the prop's collider, where it was after the last step, overlaps at the parts' pose for the coming one. */
  private overlappedParts(prop: PropBody, bits: number): number {
    if (!bits || !this.avatar) return 0;
    const collider = prop.body.collider(0);
    return this.avatar.overlaps(collider.shape, collider.translation(), collider.rotation(), bits);
  }

  private outOfBounds(t: { x: number; y: number; z: number }): boolean {
    if (this.bounds.isEmpty()) return false;
    const { min, max } = this.bounds;
    return (
      !Number.isFinite(t.x + t.y + t.z) ||
      t.y < min.y - BELOW_FLOOR_M ||
      t.y > max.y + ABOVE_CEILING_M ||
      t.x < min.x - BOUNDS_MARGIN_M ||
      t.x > max.x + BOUNDS_MARGIN_M ||
      t.z < min.z - BOUNDS_MARGIN_M ||
      t.z > max.z + BOUNDS_MARGIN_M
    );
  }

  /** The wrapper's world position and rotation, scale removed. */
  private rigidPose(object: SceneObject, position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    object.wrapper.updateWorldMatrix(true, false);
    object.wrapper.matrixWorld.decompose(position, quaternion, this.s);
  }

  /** The prop's collider at its current size. */
  private attachCollider(prop: PropBody): void {
    this.world.createCollider(this.shapeAt(prop).setDensity(DENSITY).setFriction(FRICTION).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Max).setRestitution(RESTITUTION), prop.body);
  }

  /** The prop's collider description at its current size. */
  private shapeAt(prop: PropBody): RAPIER.ColliderDesc {
    const { points, hull } = prop.shape;
    const scaled = points.map((value) => value * prop.size);
    const desc = hull ? RAPIER.ColliderDesc.convexHull(scaled) : null;
    if (desc) return desc;
    const box = new THREE.Box3().setFromArray(scaled);
    const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5).max(new THREE.Vector3(0.005, 0.005, 0.005));
    const center = box.getCenter(new THREE.Vector3());
    return RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setTranslation(center.x, center.y, center.z);
  }

  /**
   * The points of a convex hull of the model's vertices (the extreme ones in a
   * fan of directions when there are more than the cap), in the wrapper's frame
   * with the object's size divided out, so the body's origin is the wrapper's. A box of the model's
   * bounds when the hull can't be built.
   */
  private shapeFor(object: SceneObject): { points: Float32Array; hull: boolean } {
    object.model.updateWorldMatrix(true, true);
    object.wrapper.updateWorldMatrix(true, false);
    object.wrapper.matrixWorld.decompose(this.p, this.q, this.s);
    this.rigidInverse.compose(this.p, this.q, this.unit).invert();
    const points: number[] = [];
    const v = new THREE.Vector3();
    object.model.traverse((node) => {
      if (!isThreeMesh(node)) return;
      const position = node.geometry.getAttribute('position');
      if (!position) return;
      this.m.multiplyMatrices(this.rigidInverse, node.matrixWorld);
      for (let i = 0; i < position.count; i += 1) {
        v.fromBufferAttribute(position, i).applyMatrix4(this.m).divideScalar(object.size);
        points.push(v.x, v.y, v.z);
      }
    });
    if (points.length < 12) return { points: boxCorners(new THREE.Box3(new THREE.Vector3(-0.1, -0.1, -0.1), new THREE.Vector3(0.1, 0.1, 0.1))), hull: false };
    const capped = new Float32Array(cap(points, MAX_HULL_POINTS));
    if (RAPIER.ColliderDesc.convexHull(capped)) return { points: capped, hull: true };
    return { points: boxCorners(new THREE.Box3().setFromArray(points)), hull: false };
  }

  /**
   * Linear and angular velocity of the object's own poses over the last
   * ~100 ms, a least-squares slope weighted toward the newest samples. It
   * covers whatever moved the object: the hand's swing (ω×r from the
   * offset), the pickup glide and the turn keys. Needs 3 samples.
   */
  private fitVelocity(history: readonly PoseSample[]): { linear: THREE.Vector3; angular: THREE.Vector3 } | null {
    const last = history.at(-1);
    if (!last || history.length < MIN_FIT_SAMPLES) return null;
    let first = history.length - 1;
    while (first > 0 && last.t - (history[first - 1]?.t ?? Infinity) <= FIT_WINDOW_SEC + 1e-6) first -= 1;
    const window = history.slice(Math.min(first, history.length - MIN_FIT_SAMPLES));
    const t0 = window[0]?.t ?? last.t;
    const span = last.t - t0;
    if (!(span > 1e-4)) return null;

    const ref = (window[0]?.quaternion ?? last.quaternion).clone().invert();
    const times = window.map((sample) => sample.t - t0);
    const weights = times.map((t) => 0.25 + (0.75 * t) / span);
    const sw = weights.reduce((sum, w) => sum + w, 0);
    const tMean = weights.reduce((sum, w, i) => sum + w * (times[i] ?? 0), 0) / sw;
    const denom = weights.reduce((sum, w, i) => sum + w * ((times[i] ?? 0) - tMean) ** 2, 0);
    if (!(denom > 1e-12)) return null;

    const slope = (values: readonly THREE.Vector3[]): THREE.Vector3 => {
      const mean = new THREE.Vector3();
      for (const [i, value] of values.entries()) mean.addScaledVector(value, (weights[i] ?? 0) / sw);
      const out = new THREE.Vector3();
      for (const [i, value] of values.entries()) out.addScaledVector(this.p.copy(value).sub(mean), ((weights[i] ?? 0) * ((times[i] ?? 0) - tMean)) / denom);
      return out;
    };
    const linear = slope(window.map((sample) => sample.position));
    const angular = slope(window.map((sample) => rotationVector(sample.quaternion.clone().multiply(ref))));
    if (linear.length() > MAX_LINEAR_MPS) linear.setLength(MAX_LINEAR_MPS);
    if (angular.length() > MAX_ANGULAR_RADPS) angular.setLength(MAX_ANGULAR_RADPS);
    return { linear, angular };
  }
}

/** Axis × angle of a quaternion's shortest rotation. */
function rotationVector(q: THREE.Quaternion): THREE.Vector3 {
  const sign = q.w < 0 ? -1 : 1;
  const x = q.x * sign;
  const y = q.y * sign;
  const z = q.z * sign;
  const sin = Math.hypot(x, y, z);
  if (sin < 1e-9) return new THREE.Vector3(0, 0, 0);
  const angle = 2 * Math.atan2(sin, q.w * sign);
  return new THREE.Vector3(x, y, z).multiplyScalar(angle / sin);
}

/** At most `limit` points: the extreme point along each of a fan of directions, plus the axis extremes. */
function cap(points: readonly number[], limit: number): number[] {
  const count = points.length / 3;
  if (count <= limit) return [...points];
  const picked = new Set<number>();
  const directions: Array<[number, number, number]> = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
  ];
  const golden = Math.PI * (3 - Math.sqrt(5));
  const fan = limit - directions.length;
  for (let i = 0; i < fan; i += 1) {
    const y = 1 - (2 * (i + 0.5)) / fan;
    const r = Math.sqrt(1 - y * y);
    directions.push([Math.cos(golden * i) * r, y, Math.sin(golden * i) * r]);
  }
  for (const [dx, dy, dz] of directions) {
    let best = 0;
    let bestDot = -Infinity;
    for (let i = 0; i < count; i += 1) {
      const dot = (points[i * 3] ?? 0) * dx + (points[i * 3 + 1] ?? 0) * dy + (points[i * 3 + 2] ?? 0) * dz;
      if (dot > bestDot) {
        bestDot = dot;
        best = i;
      }
    }
    picked.add(best);
  }
  const out: number[] = [];
  for (const i of picked) out.push(points[i * 3] ?? 0, points[i * 3 + 1] ?? 0, points[i * 3 + 2] ?? 0);
  return out;
}

function popcount(bits: number): number {
  let count = 0;
  for (let b = bits; b; b &= b - 1) count += 1;
  return count;
}

/** The eight corners of `box`, flat xyz. */
function boxCorners(box: THREE.Box3): Float32Array {
  const out: number[] = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) out.push(x, y, z);
  return new Float32Array(out);
}
