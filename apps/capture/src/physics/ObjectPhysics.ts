import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

import type { SceneObject } from '../objects/SceneObjectRegistry';
import { isThreeMesh } from '../shared/threeTypeGuards';

// A convex hull is built from at most this many of the model's vertices.
const MAX_HULL_POINTS = 128;
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

const DOWN = { x: 0, y: -1, z: 0 };

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
  /** The wrapper already has the pose the body fell asleep with. */
  sleepWritten: boolean;
  history: PoseSample[];
}

export interface ObjectPhysicsStats {
  bodies: number;
  /** Median wall time of one frame's `world.step` calls, over the last frames that stepped a body. */
  stepMedianMs: number | null;
  stepSamples: number;
  resets: number;
}

/**
 * The props' own physics world: a copy of the scene's collision mesh and a
 * ground backstop, one body per event object, and no avatar. It is separate
 * from the character motor's world so props never block the capsule or its
 * raycasts, and so it steps after the hold update (the motor steps before the
 * arms are final). A prop is kinematic while held and dynamic once released;
 * the object system writes the result back to the wrapper.
 */
export class ObjectPhysics {
  private readonly world: RAPIER.World;
  private readonly props = new Map<SceneObject, PropBody>();
  private readonly bounds = new THREE.Box3();
  private readonly stepTimes: number[] = [];
  private resets = 0;

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
    this.world.createCollider(this.colliderFor(object).setDensity(DENSITY).setFriction(FRICTION).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Max).setRestitution(RESTITUTION), body);
    const prop: PropBody = { body, home: { position: this.p.clone(), quaternion: this.q.clone() }, dynamic: false, sleepWritten: false, history: [] };
    this.props.set(object, prop);
    return prop;
  }

  /** The object is grabbed (or caught mid-air): kinematic at once, with no velocity. */
  hold(object: SceneObject): void {
    const prop = this.ensure(object);
    prop.history.length = 0;
    prop.dynamic = false;
    prop.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    prop.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    prop.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    this.rigidPose(object, this.p, this.q);
    prop.body.setTranslation(this.p, true);
    prop.body.setRotation(this.q, true);
  }

  /** A pose of the held object at `timeSec`, for the release fit. */
  sample(object: SceneObject, timeSec: number): void {
    const prop = this.props.get(object);
    if (!prop) return;
    this.rigidPose(object, this.p, this.q);
    prop.history.push({ t: timeSec, position: this.p.clone(), quaternion: this.q.clone() });
    if (prop.history.length > MAX_HISTORY) prop.history.shift();
  }

  /** The object is let go: dynamic, with the fitted velocity when `throwIt`, else at rest. */
  release(object: SceneObject, throwIt: boolean): void {
    const prop = this.props.get(object);
    if (!prop) return;
    this.rigidPose(object, this.p, this.q);
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
    const hit = this.world.castShape(this.p, this.q, DOWN, prop.body.collider(0).shape, 0, maxM, true, undefined, undefined, undefined, prop.body);
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

    for (const [object, prop] of this.props) {
      if (prop.dynamic) continue;
      object.wrapper.updateWorldMatrix(true, true);
      this.rigidPose(object, this.p, this.q);
      prop.body.setNextKinematicTranslation(this.p);
      prop.body.setNextKinematicRotation(this.q);
    }
    const substeps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(deltaSec / MAX_SUBSTEP_SEC - 1e-6)));
    this.world.timestep = Math.min(deltaSec, MAX_SUBSTEPS * MAX_SUBSTEP_SEC) / substeps;
    const started = performance.now();
    for (let i = 0; i < substeps; i += 1) this.world.step();
    this.stepTimes.push(performance.now() - started);
    if (this.stepTimes.length > STEP_TIME_SAMPLES) this.stepTimes.shift();

    for (const [object, prop] of this.props) {
      if (!prop.dynamic) continue;
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
      resets: this.resets
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

  /** The prop returns to its placement pose, at rest and hovering as it first appeared. */
  private sendHome(prop: PropBody): void {
    prop.dynamic = false;
    prop.history.length = 0;
    prop.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    prop.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    prop.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    prop.body.setTranslation(prop.home.position, true);
    prop.body.setRotation(prop.home.quaternion, true);
    prop.body.setNextKinematicTranslation(prop.home.position);
    prop.body.setNextKinematicRotation(prop.home.quaternion);
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

  /**
   * A convex hull of the model's vertices (the extreme ones in a fan of
   * directions when there are more than the cap), in the wrapper's frame so
   * the body's origin is the wrapper's. A box of the model's bounds when the
   * hull can't be built.
   */
  private colliderFor(object: SceneObject): RAPIER.ColliderDesc {
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
        v.fromBufferAttribute(position, i).applyMatrix4(this.m);
        points.push(v.x, v.y, v.z);
      }
    });
    if (points.length < 12) return RAPIER.ColliderDesc.cuboid(0.1, 0.1, 0.1);
    const capped = cap(points, MAX_HULL_POINTS);
    const hull = RAPIER.ColliderDesc.convexHull(new Float32Array(capped));
    if (hull) return hull;
    const box = new THREE.Box3();
    for (let i = 0; i < points.length; i += 3) box.expandByPoint(v.set(points[i] ?? 0, points[i + 1] ?? 0, points[i + 2] ?? 0));
    const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5).max(new THREE.Vector3(0.005, 0.005, 0.005));
    const center = box.getCenter(new THREE.Vector3());
    return RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setTranslation(center.x, center.y, center.z);
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
