/**
 * Solves a beat sheet on its avatars, frame by frame: each performer is
 * reset to bind, placed, posed by its directions (closed forms of time, so a
 * revised beat changes only its span), and given the life that always runs
 * underneath (breath, sway, blinks, saccades, finger drift). Each frame is
 * recorded as local transforms and morph weights, ready for the writer.
 */
import * as THREE from 'three';
import type { FaceChannel } from '@holoim/avatar-face';
import type { VrmHumanoidBone } from '@holoim/meaning';

import { LivenessFace } from '../../../src/face/LivenessFace.ts';
import type { FaceGaze, FaceWeights } from '../../../src/face/faceTypes.ts';
import { resetPose, type LoadedAvatar } from './avatar.ts';
import { EXPRESSIONS, envelope, holdingsOf, pointObjects, resolveTiming, validateSheet, type BeatSheet, type Direction, type Holding, type ObjectSpec, type PerformerSpec, type Place, type Point, type Resolved, type Side } from './beats.ts';
import { FINGERS, HAND_SHAPES, blendPose, shapePose, type FingerName, type HandPose } from './hands.ts';
import { armRestOffset, bodyUp, hangArm, moveBoneWorld, orientHand, plantFeet, restElbowHint, rotateBoneWorld, solveArm, toWorld, turnBody, TURN_SHARE } from './pose.ts';
import { buildProp, propWorld, type LoadedSource, type Prop } from './props.ts';
import { isPlace, measureBody, resolvePlace, type Body, type PlaceFrame } from './stage.ts';

const SIDES = ['left', 'right'] as const;
const DEG = Math.PI / 180;
const STANCE_DROP = 0.02;
const WEIGHT_SHIFT = 0.06;
const STEP_LIFT = 0.06;
const ROOT_LAG = 0.18;
const FINGER_STAGGER = 0.03;
const FINGER_ORDER: Readonly<Record<FingerName, number>> = { index: 0, middle: 1, ring: 2, little: 3, thumb: 1.5 };

// Life every performer has underneath its directions. Sized so a held pose
// still moves at feed-card size, where a standing performer is about 190 CSS
// px tall on a phone (about 9 mm per CSS px, measured by `review.ts`): head
// and hands travel more than a pixel a second. Half these read as frozen to
// fresh readers.
/** Hips sway, metres: side to side and front to back. */
const SWAY = { x: 0.022, z: 0.012 } as const;
/** Breath, degrees of pitch per spine bone at full inhale. */
const BREATH_DEG = [['spine', 1.5], ['chest', 2.5], ['upperChest', 1.6]] as const;
const SHOULDER_LIFT_DEG = 2.5;
/** The hanging hands rise and fall with the breath, metres. */
const ARM_BREATH = 0.012;
/** The head's slow drift, degrees of yaw (pitch is 0.6 of it). */
const HEAD_DRIFT_DEG = 3.5;

// Leaning into a reach: the palm can go this far from the shoulder before the
// body leans (a share of the arm, plus the palm's offset from the wrist).
const COMFORT_REACH = 0.94;
const PALM_OFFSET = 0.07;
/** The most the hips move toward a reach, and the most the spine leans. */
const LEAN_HIPS = 0.04;
const LEAN_MAX_DEG = 28;
const LEAN_SHARE: ReadonlyArray<readonly [VrmHumanoidBone, number]> = [['spine', 0.35], ['chest', 0.4], ['upperChest', 0.25]];

// Held objects: the fingers close over this long before a take's hand arrives, and open over this long after a put's lands.
const GRIP_CLOSE = 0.2;
const GRIP_OPEN = 0.25;
/** A put's object settles from where the hand let it go to upright on its place over this long. */
const PUT_SETTLE = 0.2;

export interface PerformerTrack {
  readonly spec: PerformerSpec;
  readonly avatar: LoadedAvatar;
  /** Per animated object: local rotation per frame (x, y, z, w). */
  readonly rotations: Map<THREE.Object3D, Float32Array>;
  /** Per animated object: local position per frame. */
  readonly translations: Map<THREE.Object3D, Float32Array>;
  /** Per morphing mesh object (the glTF node's object): influences per frame, `targets` wide. */
  readonly weights: Map<THREE.Object3D, { targets: number; values: Float32Array; meshes: THREE.Mesh[] }>;
  /** The performer root (stage placement) per frame. */
  readonly root: { position: Float32Array; rotation: Float32Array };
  /** Palm-to-target distance at the middle of each reach's hold, by beat id; `outOfReach`, how far the goal stayed beyond the arm after leaning, at most, over the reach. */
  readonly reaches: { beat: string; side: Side; targetDistance: number; stopShort: number; outOfReach: number }[];
}

/** An object's world pose per frame, and who held it when. */
export interface PropTrack {
  readonly prop: Prop;
  readonly position: Float32Array;
  readonly rotation: Float32Array;
  readonly holdings: readonly Holding[];
}

/** How close each grip, put and aim came to what the sheet asked: metres and degrees. */
export interface ObjectReport {
  readonly grips: { beat: string; object: string; side: Side; distance: number; angle: number }[];
  readonly puts: { beat: string; object: string; side: Side; distance: number; tilt: number }[];
  readonly aims: { beat: string; object: string; side: Side; residual: number }[];
}

export interface SolvedTake {
  readonly sheet: BeatSheet;
  readonly fps: number;
  readonly times: Float32Array;
  readonly tracks: PerformerTrack[];
  readonly props: PropTrack[];
  readonly objects: ObjectReport;
}

interface Cast {
  readonly spec: PerformerSpec;
  readonly a: LoadedAvatar;
  readonly live: LivenessFace;
  readonly seed: number;
  readonly dirs: Resolved[];
  /** Turn degrees per `toward` turn, fixed when the turn begins. */
  readonly turnDeg: Map<Resolved, number>;
  /** Step offsets in stage space, fixed when the step begins. */
  readonly stepWorld: Map<Resolved, THREE.Vector3>;
  /** Persistent directions are fixed in start order as the solve reaches them: the next one to fix, and the facing so far. */
  fixed: { next: number; yaw: number };
  readonly ankles0: Record<Side, THREE.Vector3>;
  readonly feetMid0: THREE.Vector3;
  /** World positions of humanoid bones after the latest solve, for other performers to look and reach at. */
  readonly seen: Map<VrmHumanoidBone, THREE.Vector3>;
  /** The solve before that, and the take times of both, so a performer solved later in the frame is seen where it will be now. */
  readonly seenBefore: Map<VrmHumanoidBone, THREE.Vector3>;
  seenAt: { t: number; before: number };
  /** Per reach: the most its palm fell short of its goal after leaning (metres). */
  readonly shortfall: Map<Resolved, number>;
  readonly morphing: { node: THREE.Object3D; meshes: THREE.Mesh[] }[];
}

const yawQuat = (deg: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), deg * DEG);
/** Degrees about +Y that a rotation turns +Z to. */
const yawOf = (q: THREE.Quaternion): number => { const z = new THREE.Vector3(0, 0, 1).applyQuaternion(q); return Math.atan2(z.x, z.z) / DEG; };

export function solveTake(sheet: BeatSheet, avatars: Map<string, LoadedAvatar>, sources: ReadonlyMap<string, LoadedSource> = new Map()): SolvedTake {
  const problems = validateSheet(sheet);
  if (problems.length) throw new Error(`beat sheet: ${problems.join('; ')}`);
  stage.marks.clear();
  stage.fixed = new WeakMap();
  stage.props.clear();
  stage.bodies.clear();
  stage.runs.clear();
  stage.goals.clear();
  stage.swivels.clear();
  stage.report = { grips: [], puts: [], aims: [] };
  stage.first = sheet.performers[0]!.id;
  for (const [k, v] of Object.entries(sheet.marks ?? {})) stage.marks.set(k, v);
  const fps = sheet.fps ?? 30;
  const flat = sheet.style === 'flat';
  const life = sheet.life !== false && !flat;
  const frames = Math.round(sheet.duration * fps) + 1;
  const times = new Float32Array(frames).map((_, i) => i / fps);

  const cast: Cast[] = sheet.performers.map((spec, index) => {
    const a = avatars.get(spec.id)!;
    resetPose(a);
    a.frame.position.set(spec.at[0], 0, spec.at[1]);
    a.frame.quaternion.copy(yawQuat(spec.facing));
    a.frame.updateMatrixWorld(true);
    const dirs = sheet.beats.filter((b) => b.performer === spec.id).flatMap((b) => b.directions.map((d) => {
      const r = resolveTiming(b, d);
      return flat ? { ...r, start: r.at, anticipation: 0 } : r;
    })).sort((x, y) => x.start - y.start);
    const ankles0 = { left: toWorld(a, a.legs.left.foot.rootPosition), right: toWorld(a, a.legs.right.foot.rootPosition) };
    const morphing: Cast['morphing'] = [];
    const seenNodes = new Set<THREE.Object3D>();
    a.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.morphTargetInfluences?.length) return;
      const node = a.nodeIndex.has(m) ? m : m.parent!;
      if (seenNodes.has(node)) { morphing.find((x) => x.node === node)!.meshes.push(m); return; }
      seenNodes.add(node);
      morphing.push({ node, meshes: [m] });
    });
    return {
      spec, a, live: new LivenessFace(spec.seed ?? 0x5eed + index * 7919), seed: spec.seed ?? index + 1, dirs,
      turnDeg: new Map(), stepWorld: new Map(), fixed: { next: 0, yaw: spec.facing }, ankles0,
      feetMid0: ankles0.left.clone().add(ankles0.right).multiplyScalar(0.5),
      seen: new Map(), seenBefore: new Map(), seenAt: { t: -Infinity, before: -Infinity }, shortfall: new Map(), morphing
    };
  });
  // Measures and landmarks from each performer's rest pose, then the set, placed on the first frame.
  for (const c of cast) {
    solveFrame(cast, { ...c, dirs: [] }, 0, 1 / fps, false, false);
    stage.bodies.set(c.spec.id, measureBody(c.a));
  }
  for (const c of cast) see(c, -Infinity);
  const { holdings } = holdingsOf(sheet);
  for (const h of holdings) stage.runs.set(h, {});
  placeObjects(cast, sheet, sources, holdings);
  for (const k of stage.marks.keys()) pointOf(cast, cast[0]!.spec, k);

  const tracks: PerformerTrack[] = cast.map((c) => {
    const rotations = new Map<THREE.Object3D, Float32Array>();
    const translations = new Map<THREE.Object3D, Float32Array>();
    for (const o of c.a.rest.keys()) { rotations.set(o, new Float32Array(frames * 4)); translations.set(o, new Float32Array(frames * 3)); }
    const weights = new Map(c.morphing.map((m) => [m.node, { targets: m.meshes[0]!.morphTargetInfluences!.length, values: new Float32Array(frames * m.meshes[0]!.morphTargetInfluences!.length), meshes: m.meshes }]));
    return { spec: c.spec, avatar: c.a, rotations, translations, weights, root: { position: new Float32Array(frames * 3), rotation: new Float32Array(frames * 4) }, reaches: [] };
  });
  const props: PropTrack[] = [...stage.props.values()].map((st) => ({ prop: st.prop, position: new Float32Array(frames * 3), rotation: new Float32Array(frames * 4), holdings: st.holdings }));

  // Reaches are measured at the middle of their hold.
  const reachChecks = new Map<number, { c: number; r: Resolved }[]>();
  cast.forEach((c, ci) => c.dirs.forEach((r) => {
    if (r.direction.kind !== 'reach') return;
    // A reach still on its way at the end of the take is measured on the last frame.
    const f = Math.min(frames - 1, Math.round((r.at + r.attack + r.hold / 2) * fps));
    reachChecks.set(f, [...(reachChecks.get(f) ?? []), { c: ci, r }]);
  }));
  const aimChecks = new Map<number, { c: number; r: Resolved }[]>();
  cast.forEach((c, ci) => c.dirs.forEach((r) => {
    if (r.direction.kind !== 'aim') return;
    const f = Math.min(frames - 1, Math.round((r.at + r.attack + r.hold / 2) * fps));
    aimChecks.set(f, [...(aimChecks.get(f) ?? []), { c: ci, r }]);
  }));

  for (let f = 0; f < frames; f += 1) {
    const t = times[f]!;
    solving.t = t;
    cast.forEach((c, ci) => {
      fixPersistent(cast, c, t);
      solveFrame(cast, c, t, 1 / fps, life, flat);
      const tr = tracks[ci]!;
      for (const [o, arr] of tr.rotations) o.quaternion.toArray(arr, f * 4);
      for (const [o, arr] of tr.translations) o.position.toArray(arr, f * 3);
      for (const [, w] of tr.weights) w.values.set(w.meshes[0]!.morphTargetInfluences!, f * w.targets);
      c.a.frame.position.toArray(tr.root.position, f * 3);
      c.a.frame.quaternion.toArray(tr.root.rotation, f * 4);
      see(c, t);
    });
    // Measured as the file plays: every performer at this frame. (A performer
    // solved earlier in the cast aims at the others' previous frame.)
    for (const { c, r } of reachChecks.get(f) ?? []) {
      const d = r.direction as Extract<Direction, { kind: 'reach' }>;
      const target = pointOf(cast, cast[c]!.spec, d.at);
      const palm = cast[c]!.a.hands[d.side]?.palmCenter(new THREE.Vector3()) ?? cast[c]!.a.arms[d.side].hand.getWorldPosition(new THREE.Vector3());
      tracks[c]!.reaches.push({ beat: r.beat.id, side: d.side, targetDistance: Math.round(palm.distanceTo(target) * 10000) / 10000, stopShort: d.stopShort, outOfReach: Math.round((cast[c]!.shortfall.get(r) ?? 0) * 10000) / 10000 });
    }
    settleReleased(t);
    for (const { c, r } of aimChecks.get(f) ?? []) {
      const d = r.direction as Extract<Direction, { kind: 'aim' }>;
      const st = heldIn(cast[c]!.spec.id, d.side, t);
      if (!st?.prop.tool) continue;
      const tip = propWorld(st.prop, st.prop.tool.tip);
      const axis = st.prop.tool.axis.clone().applyQuaternion(st.prop.quaternion);
      const want = pointOf(cast, cast[c]!.spec, d.at).sub(tip).normalize();
      stage.report.aims.push({ beat: r.beat.id, object: st.prop.id, side: d.side, residual: round(axis.angleTo(want) / DEG, 10) });
    }
    props.forEach((pt) => { pt.prop.position.toArray(pt.position, f * 3); pt.prop.quaternion.toArray(pt.rotation, f * 4); });
  }
  return { sheet, fps, times, tracks, props, objects: stage.report };
}

const round = (v: number, k: number): number => Math.round(v * k) / k;

/** Signed degrees in [-180, 180). */
const wrapDeg = (deg: number): number => ((((deg + 180) % 360) + 360) % 360) - 180;

/**
 * Fixes each persistent direction (and each `toward` turn) once, in start
 * order, when the solve reaches its start: from where the performer stands
 * then and where its target is then, so a turn toward a performer who has
 * moved aims at where they are.
 */
function fixPersistent(cast: Cast[], c: Cast, t: number): void {
  while (c.fixed.next < c.dirs.length && c.dirs[c.fixed.next]!.start <= t) {
    const r = c.dirs[c.fixed.next]!;
    c.fixed.next += 1;
    const d = r.direction;
    if (d.kind === 'turn') {
      let deg = d.degrees ?? 0;
      if (d.toward !== undefined) {
        const from = rootPositionAt(c, r.start);
        const to = pointOf(cast, c.spec, d.toward);
        deg = wrapDeg(Math.atan2(to.x - from.x, to.z - from.z) / DEG - c.fixed.yaw);
      }
      c.turnDeg.set(r, deg);
      if (d.body === 'whole') c.fixed.yaw += deg;
    } else if (d.kind === 'step') {
      c.stepWorld.set(r, new THREE.Vector3(d.by[0], 0, d.by[1]).applyQuaternion(yawQuat(c.fixed.yaw)));
    }
  }
}

function see(c: Cast, t: number): void {
  c.a.frame.updateMatrixWorld(true);
  for (const [name, b] of c.a.bind) {
    const now = c.seen.get(name);
    if (now) c.seenBefore.set(name, (c.seenBefore.get(name) ?? new THREE.Vector3()).copy(now));
    c.seen.set(name, b.bone.getWorldPosition(now ?? new THREE.Vector3()));
  }
  c.seenAt = { t, before: c.seenAt.t };
}

interface PropState {
  readonly prop: Prop;
  readonly holdings: Holding[];
  /** After a put lets go: from where the hand left it to upright on its place. */
  release?: { t0: number; fromP: THREE.Vector3; fromQ: THREE.Quaternion; toP: THREE.Vector3; toQ: THREE.Quaternion };
}

// The sheet being solved, set at the start of `solveTake`: its marks, objects,
// performer measures, places fixed when first evaluated, per-holding grip
// offsets, per-direction goals fixed at the direction's start, and the report.
// And the take time being solved.
const stage = {
  first: '',
  marks: new Map<string, readonly [number, number, number] | Place>(),
  fixed: new WeakMap<object, THREE.Vector3>(),
  props: new Map<string, PropState>(),
  bodies: new Map<string, Body>(),
  runs: new Map<Holding, { offset?: THREE.Matrix4; released?: boolean }>(),
  goals: new Map<Direction, { point: THREE.Vector3; axis?: THREE.Vector3; upright?: THREE.Quaternion }>(),
  report: { grips: [], puts: [], aims: [] } as ObjectReport,
  swivels: new Map<Direction, number>()
};
const solving = { t: 0 };

function pointOf(cast: Cast[], self: PerformerSpec, p: Point): THREE.Vector3 {
  if (typeof p !== 'string') return isPlace(p) ? placeOf(cast, p) : new THREE.Vector3(p[0], p[1], p[2]);
  const dot = p.indexOf('.');
  if (dot < 0) {
    const m = stage.marks.get(p);
    if (!m) throw new Error(`no mark ${p}`);
    // A mark that is a place is fixed on the first frame (when it is first evaluated, at setup).
    return pointOf(cast, self, m);
  }
  const who = p.slice(0, dot);
  const bone = p.slice(dot + 1);
  const object = stage.props.get(who);
  if (object) return propWorld(object.prop, object.prop.anchors.get(bone)!);
  const other = cast.find((c) => c.spec.id === who);
  const at = other?.seen.get(bone as VrmHumanoidBone);
  if (!other || !at) throw new Error(`${self.id}: cannot find ${p}`);
  // A performer not solved yet this frame is where its last move carries it now, not where it was.
  const { t, before } = other.seenAt;
  const was = other.seenBefore.get(bone as VrmHumanoidBone);
  if (was && Number.isFinite(before) && t < solving.t && t > before) return at.clone().lerp(was, -(solving.t - t) / (t - before));
  return at.clone();
}

/** A place, fixed the first time it is evaluated: from its performer as they stand then, or its object as it rests. */
function placeOf(cast: Cast[], p: Place): THREE.Vector3 {
  const hit = stage.fixed.get(p);
  if (hit) return hit.clone();
  const of = p.of ?? stage.first;
  const performer = cast.find((c) => c.spec.id === of);
  let frame: PlaceFrame;
  if (performer) frame = { origin: performer.a.frame.position.clone().setY(0), yaw: yawOf(performer.a.frame.quaternion) };
  else {
    const o = stage.props.get(of)!.prop;
    frame = { origin: o.position.clone(), yaw: yawOf(o.quaternion) };
  }
  const out = resolvePlace(p, frame, stage.bodies, performer ? of : stage.first);
  stage.fixed.set(p, out);
  return out.clone();
}

/** The performer a point is measured from, when it names one. */
function measuredFrom(sheet: BeatSheet, p: Point | undefined): string | undefined {
  if (p === undefined || Array.isArray(p)) return undefined;
  const ids = new Set(sheet.performers.map((x) => x.id));
  if (isPlace(p)) return p.of !== undefined && ids.has(p.of) ? p.of : undefined;
  const head = (p as string).split('.')[0]!;
  return ids.has(head) ? head : undefined;
}

/** Builds every object and sets it down where the sheet says, supports before what sits on them; one held from the first frame is seated in the hand later. */
function placeObjects(cast: Cast[], sheet: BeatSheet, sources: ReadonlyMap<string, LoadedSource>, holdings: readonly Holding[]): void {
  const specs = sheet.objects ?? {};
  const ids = new Set(Object.keys(specs));
  const order: string[] = [];
  const visit = (id: string): void => {
    if (order.includes(id)) return;
    const o = specs[id]!;
    for (const d of [...(o.on !== undefined ? [o.on] : []), ...pointObjects(o.at, ids), ...(typeof o.facing === 'number' ? [] : pointObjects(o.facing, ids))]) visit(d);
    order.push(id);
  };
  for (const id of ids) visit(id);
  const self = cast[0]!.spec;
  for (const id of order) {
    const spec: ObjectSpec = specs[id]!;
    const performer = measuredFrom(sheet, spec.at) ?? stage.first;
    const prop = buildProp(id, spec, stage.bodies, performer, sources);
    stage.props.set(id, { prop, holdings: holdings.filter((h) => h.object === id) });
    if (spec.at === undefined && spec.on === undefined) continue;
    let defaultYaw = 0;
    if (spec.on !== undefined) {
      const support = stage.props.get(spec.on)!.prop;
      const top = propWorld(support, support.anchors.get('top')!);
      if (spec.at !== undefined) { const p = pointOf(cast, self, spec.at); prop.position.set(p.x, top.y, p.z); } else prop.position.copy(top);
      defaultYaw = yawOf(support.quaternion);
    } else prop.position.copy(pointOf(cast, self, spec.at!));
    if (isPlace(spec.at)) {
      const of = spec.at.of ?? stage.first;
      const c = cast.find((x) => x.spec.id === of);
      defaultYaw = c ? c.spec.facing : yawOf(stage.props.get(of)!.prop.quaternion);
    }
    let yaw = defaultYaw;
    if (typeof spec.facing === 'number') yaw = spec.facing;
    else if (spec.facing !== undefined) {
      const to = pointOf(cast, self, spec.facing).sub(prop.position);
      yaw = Math.atan2(to.x, to.z) / DEG;
    }
    prop.quaternion.copy(yawQuat(yaw));
  }
}

/** The object in a performer's hand at `t`, if any. */
function heldIn(performer: string, side: Side, t: number): PropState | undefined {
  for (const st of stage.props.values()) {
    if (st.holdings.some((h) => h.performer === performer && h.side === side && h.from <= t && t <= h.to)) return st;
  }
  return undefined;
}

/** How closed a hand is on an object (0..1) at `t`, with the object: closing before a take arrives, open again after a put lands. */
function gripOf(performer: string, side: Side, t: number): { weight: number; prop: Prop } | undefined {
  let best: { weight: number; prop: Prop } | undefined;
  for (const st of stage.props.values()) {
    for (const h of st.holdings) {
      if (h.performer !== performer || h.side !== side) continue;
      const closing = h.take ? smooth(clamp01((t - (h.from - GRIP_CLOSE)) / GRIP_CLOSE)) : 1;
      const opening = h.put ? 1 - smooth(clamp01((t - h.to) / GRIP_OPEN)) : 1;
      const weight = Math.min(closing, opening);
      if (weight > 0 && (!best || weight > best.weight)) best = { weight, prop: st.prop };
    }
  }
  return best;
}

/** Where a take's hand goes (the grip, where the object rests when the take begins) and the grip's axis there. */
function takeGoal(r: Resolved): { point: THREE.Vector3; axis?: THREE.Vector3 } {
  let g = stage.goals.get(r.direction);
  if (!g) {
    const d = r.direction as Extract<Direction, { kind: 'take' }>;
    const prop = stage.props.get(d.object)!.prop;
    g = { point: propWorld(prop, prop.grip!.center), axis: prop.grip!.axis.clone().applyQuaternion(prop.quaternion) };
    stage.goals.set(r.direction, g);
  }
  return g;
}

/** Where a put sets its object's bottom down, and the upright turn it lands in, fixed when the put begins. */
function putGoal(cast: Cast[], c: Cast, r: Resolved): { point: THREE.Vector3; upright?: THREE.Quaternion } {
  let g = stage.goals.get(r.direction);
  if (!g) {
    const d = r.direction as Extract<Direction, { kind: 'put' }>;
    const prop = stage.props.get(d.object)!.prop;
    let point: THREE.Vector3;
    if (d.on !== undefined) {
      const support = stage.props.get(d.on)!.prop;
      point = propWorld(support, support.anchors.get('top')!);
    } else point = pointOf(cast, c.spec, d.at!);
    g = { point, upright: yawQuat(yawOf(prop.quaternion)) };
    stage.goals.set(r.direction, g);
  }
  return g;
}

/**
 * Turns an object about one of its own axes (through `pivot`, both in its
 * frame) until its up is as near the world's up as that axis allows: how a
 * held object hangs from a handle, which turns in the fist.
 */
function hangAbout(q: THREE.Quaternion, axisLocal: THREE.Vector3): THREE.Quaternion {
  const axis = axisLocal.clone().applyQuaternion(q);
  const u = new THREE.Vector3(0, 1, 0).applyQuaternion(q).projectOnPlane(axis);
  const w = new THREE.Vector3(0, 1, 0).projectOnPlane(axis);
  // A handle near vertical (a pen held upright) has no way to hang.
  if (u.lengthSq() < 0.04 || w.lengthSq() < 0.04) return q.clone();
  u.normalize(); w.normalize();
  const angle = Math.atan2(new THREE.Vector3().crossVectors(u, w).dot(axis), u.dot(w));
  return new THREE.Quaternion().setFromAxisAngle(axis, angle).multiply(q);
}

/** Where a held object is for a hand pose: rigid in the fist, except that it hangs about its grip's axis. */
function poseInHand(prop: Prop, handPosition: THREE.Vector3, handQuaternion: THREE.Quaternion, offset: THREE.Matrix4): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  const m = new THREE.Matrix4().compose(handPosition, handQuaternion, new THREE.Vector3(1, 1, 1)).multiply(offset);
  const rigidP = new THREE.Vector3();
  const rigidQ = new THREE.Quaternion();
  m.decompose(rigidP, rigidQ, new THREE.Vector3());
  const grip = prop.grip!;
  const pivot = grip.center.clone().applyQuaternion(rigidQ).add(rigidP);
  const quaternion = hangAbout(rigidQ, grip.axis);
  return { position: pivot.sub(grip.center.clone().applyQuaternion(quaternion)), quaternion };
}

/** Where a held object is while that hand holds it. */
function heldPose(c: Cast, side: Side, prop: Prop, offset: THREE.Matrix4): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  const hand = c.a.arms[side].hand;
  return poseInHand(prop, hand.getWorldPosition(new THREE.Vector3()), hand.getWorldQuaternion(new THREE.Quaternion()), offset);
}

/**
 * Moves every object this performer holds to its hand, after its arms are
 * solved: at a take's arrival the offset is fixed where the object rests
 * (capture's rule); a hold from the first frame seats the object in the fist,
 * as upright as the grip allows; at a put's arrival the object is let go.
 */
function moveHeld(cast: Cast[], c: Cast, t: number): void {
  c.a.frame.updateMatrixWorld(true);
  for (const st of stage.props.values()) {
    for (const h of st.holdings) {
      if (h.performer !== c.spec.id || t < h.from - 1e-6) continue;
      const run = stage.runs.get(h)!;
      if (run.released) continue;
      const hand = c.a.arms[h.side].hand;
      const rig = c.a.hands[h.side];
      const grip = st.prop.grip!;
      if (!run.offset) {
        if (!h.take) seat(c, h.side, st.prop);
        else if (rig) {
          const fist = rig.fistPoint(grip.radius, new THREE.Vector3());
          const across = new THREE.Vector3(1, 0, 0).applyQuaternion(rig.palmFrame(new THREE.Quaternion()));
          const axis = grip.axis.clone().applyQuaternion(st.prop.quaternion);
          stage.report.grips.push({ beat: h.take.beat.id, object: st.prop.id, side: h.side, distance: round(fist.distanceTo(propWorld(st.prop, grip.center)), 10000), angle: round(Math.acos(Math.min(1, Math.abs(across.dot(axis)))) / DEG, 10) });
        }
        run.offset = hand.matrixWorld.clone().invert().multiply(new THREE.Matrix4().compose(st.prop.position, st.prop.quaternion, new THREE.Vector3(1, 1, 1)));
      }
      const pose = heldPose(c, h.side, st.prop, run.offset);
      st.prop.position.copy(pose.position);
      st.prop.quaternion.copy(pose.quaternion);
      if (h.put && t >= h.to - 1e-6) {
        run.released = true;
        const goal = putGoal(cast, c, h.put);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(st.prop.quaternion);
        stage.report.puts.push({ beat: h.put.beat.id, object: st.prop.id, side: h.side, distance: round(st.prop.position.distanceTo(goal.point), 10000), tilt: round(up.angleTo(new THREE.Vector3(0, 1, 0)) / DEG, 10) });
        st.release = { t0: t, fromP: st.prop.position.clone(), fromQ: st.prop.quaternion.clone(), toP: goal.point.clone(), toQ: yawQuat(yawOf(st.prop.quaternion)) };
      }
    }
  }
}

/** Seats an object held from the first frame: its grip axis across the palm, turned about it to stand as upright as it can (front forward), the grip in the fist. */
function seat(c: Cast, side: Side, prop: Prop): void {
  const rig = c.a.hands[side];
  const grip = prop.grip!;
  const palm = rig ? rig.palmFrame(new THREE.Quaternion()) : c.a.arms[side].hand.getWorldQuaternion(new THREE.Quaternion());
  const across = new THREE.Vector3(1, 0, 0).applyQuaternion(palm);
  const up = new THREE.Vector3(0, 1, 0);
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(c.a.frame.quaternion);
  let best: { q: THREE.Quaternion; score: number } | undefined;
  for (const sign of [1, -1]) {
    // The grip across the palm, turned about it to hang as upright as it can.
    const q = hangAbout(new THREE.Quaternion().setFromUnitVectors(grip.axis.clone().multiplyScalar(sign), across), grip.axis);
    const score = new THREE.Vector3(0, 1, 0).applyQuaternion(q).dot(up) + 0.5 * new THREE.Vector3(0, 0, 1).applyQuaternion(q).dot(forward);
    if (!best || score > best.score) best = { q, score };
  }
  const fist = rig ? rig.fistPoint(grip.radius, new THREE.Vector3()) : c.a.arms[side].hand.getWorldPosition(new THREE.Vector3());
  prop.quaternion.copy(best!.q);
  prop.position.copy(fist).sub(grip.center.clone().applyQuaternion(best!.q));
}

/** An object let go settles upright on its place. */
function settleReleased(t: number): void {
  for (const st of stage.props.values()) {
    const r = st.release;
    if (!r) continue;
    const u = smooth(clamp01((t - r.t0) / PUT_SETTLE));
    st.prop.position.lerpVectors(r.fromP, r.toP, u);
    st.prop.quaternion.slerpQuaternions(r.fromQ, r.toQ, u);
    if (u >= 1) delete st.release;
  }
}

function rootPositionAt(c: Cast, t: number): THREE.Vector3 {
  const out = new THREE.Vector3(c.spec.at[0], 0, c.spec.at[1]);
  for (const r of c.dirs) {
    const d = r.direction;
    if (d.kind !== 'step' || r.start >= t) continue;
    const by = c.stepWorld.get(r);
    if (by) out.addScaledVector(by, stepShare(r, t));
  }
  return out;
}

/** The root carries half a step while the lead foot travels, and the rest as the other foot follows. */
function stepShare(r: Resolved, t: number): number {
  const d = r.direction as Extract<Direction, { kind: 'step' }>;
  const lead = clamp01((t - r.at) / r.attack);
  const follow = d.follow ? clamp01((t - r.at - r.attack) / r.settle) : 0;
  return smooth(lead) * 0.5 + smooth(follow) * 0.5;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smooth = (u: number): number => u * u * (3 - 2 * u);
const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;

function env(r: Resolved, t: number, flat: boolean): number {
  if (!flat) return envelope(t, r);
  // Flat: straight lines between keys, no anticipation or overshoot.
  const arrive = r.at + r.attack;
  if (t <= r.at) return 0;
  if (t < arrive) return (t - r.at) / r.attack;
  if (t < arrive + r.hold || r.persistent) return 1;
  return Math.max(0, 1 - (t - arrive - r.hold) / r.settle);
}

/**
 * Degrees a hand's turn is off, as the hand is now: a take's grip axis
 * across the fist, a put's object from upright, an aim's tool from its target.
 */
function turnError(cast: Cast[], c: Cast, s: Side, r: Resolved): number {
  const d = r.direction;
  if (d.kind === 'aim') return aimError(cast, c, s, r);
  if (d.kind === 'take') {
    const rig = c.a.hands[s];
    if (!rig) return 0;
    const across = new THREE.Vector3(1, 0, 0).applyQuaternion(rig.palmFrame(new THREE.Quaternion()));
    return Math.acos(Math.min(1, Math.abs(across.dot(takeGoal(r).axis!)))) / DEG;
  }
  if (d.kind === 'put') {
    const offset = holdingRun(r)?.offset;
    if (!offset) return 0;
    const o = heldPose(c, s, stage.props.get(d.object)!.prop, offset);
    return new THREE.Vector3(0, 1, 0).applyQuaternion(o.quaternion).angleTo(new THREE.Vector3(0, 1, 0)) / DEG;
  }
  return 0;
}

/** Degrees between what a hand holds is pointing and its aim's target, as the hand is now. */
function aimError(cast: Cast[], c: Cast, s: Side, r: Resolved): number {
  const d = r.direction as Extract<Direction, { kind: 'aim' }>;
  const st = heldIn(c.spec.id, s, solving.t);
  const run = st && [...stage.runs].find(([h]) => st.holdings.includes(h) && h.side === s && h.from <= solving.t && solving.t <= h.to)?.[1];
  if (!st?.prop.tool || !run?.offset) return 0;
  const o = heldPose(c, s, st.prop, run.offset);
  const tip = st.prop.tool.tip.clone().applyQuaternion(o.quaternion).add(o.position);
  const axis = st.prop.tool.axis.clone().applyQuaternion(o.quaternion);
  return axis.angleTo(pointOf(cast, c.spec, d.at).sub(tip)) / DEG;
}

/** The holding a take or put direction opens or closes. */
function holdingRun(r: Resolved): { offset?: THREE.Matrix4; released?: boolean } | undefined {
  for (const [h, run] of stage.runs) if (h.take?.direction === r.direction || h.put?.direction === r.direction) return run;
  return undefined;
}

/**
 * Turns a hand, after its arm is solved: a take's grip axis across the palm
 * (whichever way round is nearer), a put's object upright on its place, an
 * aim's tool axis at its target (the tip moves as the hand turns, so a few
 * passes). Each by its envelope, within the wrist's limits.
 */
function turnHand(cast: Cast[], c: Cast, s: Side, turns: readonly { r: Resolved; e: number }[]): void {
  const a = c.a;
  const hand = a.arms[s].hand;
  const rig = a.hands[s];
  for (const { r, e } of turns) {
    const d = r.direction;
    a.frame.updateMatrixWorld(true);
    const Hc = hand.getWorldQuaternion(new THREE.Quaternion());
    let wanted: THREE.Quaternion | undefined;
    if (d.kind === 'take' && rig) {
      const across = new THREE.Vector3(1, 0, 0).applyQuaternion(rig.palmFrame(new THREE.Quaternion()));
      const g = takeGoal(r).axis!.clone();
      if (g.dot(across) < 0) g.negate();
      wanted = new THREE.Quaternion().setFromUnitVectors(across, g).multiply(Hc);
    } else if (d.kind === 'put') {
      const offset = holdingRun(r)?.offset;
      if (!offset) continue;
      const offQ = new THREE.Quaternion();
      offset.decompose(new THREE.Vector3(), offQ, new THREE.Vector3());
      wanted = putGoal(cast, c, r).upright!.clone().multiply(offQ.invert());
    } else if (d.kind === 'aim') {
      const st = heldIn(c.spec.id, s, solving.t);
      const run = st && [...stage.runs].find(([h]) => st.holdings.includes(h) && h.side === s && h.from <= solving.t && solving.t <= h.to)?.[1];
      if (!st?.prop.tool || !run?.offset) continue;
      const target = pointOf(cast, c.spec, d.at);
      const Hbase = Hc.clone();
      let Hcur = Hc.clone();
      const hp = hand.getWorldPosition(new THREE.Vector3());
      for (let i = 0; i < 3; i += 1) {
        const o = poseInHand(st.prop, hp, Hcur, run.offset);
        const tip = st.prop.tool.tip.clone().applyQuaternion(o.quaternion).add(o.position);
        const axis = st.prop.tool.axis.clone().applyQuaternion(o.quaternion);
        const want = target.clone().sub(tip).normalize();
        Hcur = new THREE.Quaternion().setFromUnitVectors(axis, want).multiply(Hcur);
      }
      orientHand(a, s, Hbase.slerp(Hcur, clamp01(e)));
      continue;
    }
    if (wanted) orientHand(a, s, Hc.clone().slerp(wanted, clamp01(e)));
  }
  a.frame.updateMatrixWorld(true);
}

function solveFrame(cast: Cast[], c: Cast, t: number, dt: number, life: boolean, flat: boolean): void {
  const a = c.a;
  resetPose(a);
  const phase = c.seed * 1.618;

  // 1. Root: stage position and yaw; the root lags whole turns (the upper body leads).
  let rootYaw = c.spec.facing;
  let leadYaw = c.spec.facing;
  for (const r of c.dirs) {
    if (r.direction.kind !== 'turn') continue;
    const turnDeg = c.turnDeg.get(r) ?? 0;
    if (r.direction.body === 'whole') {
      rootYaw += turnDeg * env(r, t - (flat ? 0 : ROOT_LAG), flat);
      leadYaw += turnDeg * env(r, t, flat);
    } else leadYaw += turnDeg * env(r, t, flat);
  }
  const root = rootPositionAt(c, t);
  a.frame.position.copy(root);
  a.frame.quaternion.copy(yawQuat(rootYaw));
  a.frame.updateMatrixWorld(true);
  const twist = (leadYaw - rootYaw) * DEG;

  // 2. Feet in stage space: steps move them (lead foot arcs), whole turns pivot them about their midpoint.
  const feet = { left: c.ankles0.left.clone(), right: c.ankles0.right.clone() };
  for (const r of c.dirs) {
    const d = r.direction;
    const by = d.kind === 'step' ? c.stepWorld.get(r) : undefined;
    if (!by || d.kind !== 'step') continue;
    const lead = clamp01((t - r.at) / r.attack);
    feet[d.foot].addScaledVector(by, smooth(lead));
    if (lead > 0 && lead < 1) feet[d.foot].y += STEP_LIFT * Math.sin(Math.PI * lead);
    if (d.follow) {
      const other: Side = d.foot === 'left' ? 'right' : 'left';
      const u = clamp01((t - r.at - r.attack) / r.settle);
      feet[other].addScaledVector(by, smooth(u));
      if (u > 0 && u < 1) feet[other].y += STEP_LIFT * 0.6 * Math.sin(Math.PI * u);
    }
  }
  const pivot = root.clone().add(c.feetMid0).sub(new THREE.Vector3(c.spec.at[0], 0, c.spec.at[1]));
  const feetYaw = (rootYaw - c.spec.facing) * DEG;
  for (const s of SIDES) feet[s].sub(pivot).applyAxisAngle(new THREE.Vector3(0, 1, 0), feetYaw).add(pivot);

  // 3. Hips: soft knees, weight shifts, and (alive) a slow postural sway and breath.
  const legLength = a.legs.left.thighLength + a.legs.left.shinLength;
  const hipsLocal = new THREE.Vector3(0, -STANCE_DROP * legLength, 0);
  let pelvisRoll = 0;
  for (const r of c.dirs) {
    const d = r.direction;
    if (d.kind !== 'weight') continue;
    const w = env(r, t, flat) * (d.amount ?? 1);
    const dir = { left: [1, 0], right: [-1, 0], forward: [0, 1], back: [0, -1] }[d.toward];
    hipsLocal.x += dir[0]! * WEIGHT_SHIFT * w;
    hipsLocal.z += dir[1]! * WEIGHT_SHIFT * 0.6 * w;
    pelvisRoll += dir[0]! * 4 * DEG * w;
    hipsLocal.y -= 0.008 * Math.abs(w);
  }
  // A step carries the hips toward the lead foot and down a little while a foot is off the floor.
  for (const r of c.dirs) {
    if (r.direction.kind !== 'step') continue;
    const lead = clamp01((t - r.at) / r.attack);
    hipsLocal.y -= 0.012 * Math.sin(Math.PI * lead);
  }
  const breathT = (2 * Math.PI * t) / (3.8 + (c.seed % 5) * 0.15) + phase;
  if (life) {
    // Postural sway: a slow drift of the weight between the feet, large enough to see at card size.
    hipsLocal.x += SWAY.x * (Math.sin((2 * Math.PI * t) / 7.3 + phase) + 0.35 * Math.sin((2 * Math.PI * t) / 3.1 + phase * 3));
    hipsLocal.z += SWAY.z * Math.sin((2 * Math.PI * t) / 9.1 + phase * 2);
  }
  const hips = a.humanoid.bone('hips')!;
  const bodyQ = a.body.getWorldQuaternion(new THREE.Quaternion());
  // A reach whose goal is beyond the arm (the other performer moved away) is met by leaning toward it.
  const lean = flat ? undefined : leanFor(cast, c, t, hipsLocal);
  if (lean) hipsLocal.addScaledVector(lean.dir.clone().applyQuaternion(bodyQ.clone().invert()), lean.hipShift);
  moveBoneWorld(hips, hipsLocal.clone().applyQuaternion(bodyQ));
  if (pelvisRoll) rotateBoneWorld(hips, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1).applyQuaternion(bodyQ), -pelvisRoll));
  // The chest counters the pelvis so the head stays over the feet.
  if (pelvisRoll) {
    const chest = a.humanoid.bone('chest') ?? a.humanoid.bone('spine')!;
    rotateBoneWorld(chest, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1).applyQuaternion(bodyQ), pelvisRoll * 1.1));
  }

  // 4. Twist: the upper body leads a whole turn and makes an upper turn.
  if (Math.abs(twist) > 1e-5) turnBody(a, twist);
  if (life) {
    // Breath: chest and spine rise and fall; the shoulders lift with the inhale.
    const inhale = Math.sin(breathT);
    const right = new THREE.Vector3(-1, 0, 0).applyQuaternion(bodyQ);
    for (const [name, deg] of BREATH_DEG) {
      const b = a.humanoid.bone(name);
      if (b) rotateBoneWorld(b, new THREE.Quaternion().setFromAxisAngle(right, -deg * DEG * inhale));
    }
    for (const s of SIDES) {
      const b = a.humanoid.bone(`${s}Shoulder`);
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(bodyQ);
      if (b) rotateBoneWorld(b, new THREE.Quaternion().setFromAxisAngle(fwd, (s === 'left' ? -1 : 1) * SHOULDER_LIFT_DEG * DEG * (inhale + 1) / 2));
    }
  }
  if (lean && lean.theta > 0) {
    // Lean from the waist toward the goal, the head kept level enough to hold its look.
    const axis = new THREE.Vector3().crossVectors(bodyUp(a), lean.dir).normalize();
    let carry = 0;
    for (const [name, k] of LEAN_SHARE) {
      const b = a.humanoid.bone(name);
      if (!b) { carry += k; continue; }
      rotateBoneWorld(b, new THREE.Quaternion().setFromAxisAngle(axis, lean.theta * (k + carry)));
      carry = 0;
    }
    const head = a.humanoid.bone('neck') ?? a.humanoid.bone('head')!;
    rotateBoneWorld(head, new THREE.Quaternion().setFromAxisAngle(axis, -0.5 * lean.theta));
  }
  a.frame.updateMatrixWorld(true);

  // 5. Legs: planted feet, each foot in the lagging yaw of the root.
  plantFeet(a, feet);

  // 6. Head: looks (the head takes its share; the eyes take the rest and lead).
  const headTarget = lookTarget(cast, c, t, flat, 'head');
  if (headTarget) {
    const { point, weight, share } = headTarget;
    const head = a.humanoid.bone('head')!;
    const neck = a.humanoid.bone('neck');
    const from = head.getWorldPosition(new THREE.Vector3());
    const local = point.clone().sub(from).applyQuaternion(bodyQ.clone().invert());
    // Relative to where the twisted upper body already faces.
    const faced = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), twist);
    const yaw = THREE.MathUtils.clamp(Math.atan2(local.x, local.z) - Math.atan2(faced.x, faced.z), -70 * DEG, 70 * DEG) * share * weight;
    const pitch = THREE.MathUtils.clamp(Math.atan2(local.y, Math.hypot(local.x, local.z)), -35 * DEG, 35 * DEG) * share * weight;
    const up = bodyUp(a);
    const parts: [THREE.Object3D | undefined, number][] = [[neck, 0.4], [head, neck ? 0.6 : 1]];
    for (const [bone, k] of parts) {
      if (!bone) continue;
      rotateBoneWorld(bone, new THREE.Quaternion().setFromAxisAngle(up, yaw * k));
      // Pitch about the performer's left axis as the head now faces (+X of the body, turned by twist and yaw).
      const side = new THREE.Vector3(1, 0, 0).applyQuaternion(bodyQ).applyAxisAngle(up, twist + yaw);
      rotateBoneWorld(bone, new THREE.Quaternion().setFromAxisAngle(side, -pitch * k));
    }
  }
  if (life) {
    // The head is never quite still: a slow drift, less while it holds a look.
    const head = a.humanoid.bone('head')!;
    const k = headTarget ? 1 - 0.6 * clamp01(headTarget.weight) : 1;
    const up = bodyUp(a);
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()));
    const yaw = HEAD_DRIFT_DEG * DEG * k * (Math.sin((2 * Math.PI * t) / 6.7 + phase * 1.3) + 0.4 * Math.sin((2 * Math.PI * t) / 2.9 + phase));
    const pitch = HEAD_DRIFT_DEG * 0.6 * DEG * k * Math.sin((2 * Math.PI * t) / 8.3 + phase * 0.7);
    rotateBoneWorld(head, new THREE.Quaternion().setFromAxisAngle(up, yaw));
    rotateBoneWorld(head, new THREE.Quaternion().setFromAxisAngle(side, pitch));
  }
  a.frame.updateMatrixWorld(true);

  // 7. Arms: hanging (following the torso; out from the thigh round a held object), or reaching
  //    with the palm to a point short of a target, the fist to a grip, or a held object to its place;
  //    then the hand turned to the grip, the place, or to aim what it holds.
  const torsoYaw = twist * TURN_SHARE.slice(0, 4).reduce((s, [, w]) => s + w, 0);
  for (const s of SIDES) {
    // The wrist's rest offset from the shoulder, turned with the torso and the body.
    const local = armRestOffset(a, s);
    const held = gripOf(c.spec.id, s, t);
    if (held) local.x += (s === 'left' ? 1 : -1) * held.prop.halfWidth * held.weight;
    local.applyAxisAngle(new THREE.Vector3(0, 1, 0), torsoYaw);
    const rest = toWorld(a, local).sub(toWorld(a, new THREE.Vector3()));
    if (life) rest.addScaledVector(bodyUp(a), ARM_BREATH * Math.sin(breathT));
    let w = 0;
    let goal: THREE.Vector3 | undefined;
    let palm: THREE.Vector3 | undefined;
    let effector: (out: THREE.Vector3) => THREE.Vector3 = (out) => (a.hands[s] ? a.hands[s]!.palmCenter(out) : a.arms[s].hand.getWorldPosition(out));
    const turns: { r: Resolved; e: number }[] = [];
    for (const r of c.dirs) {
      const d = r.direction;
      if ((d.kind !== 'reach' && d.kind !== 'take' && d.kind !== 'put' && d.kind !== 'aim') || d.side !== s) continue;
      const e = env(r, t, flat);
      if (e === 0) continue;
      if (d.kind === 'aim') { turns.push({ r, e }); continue; }
      const shoulder = a.arms[s].upperArm.getWorldPosition(new THREE.Vector3());
      let g: THREE.Vector3;
      let target: THREE.Vector3;
      let palmKind = d.kind === 'put' ? 'in' : d.palm ?? (d.kind === 'take' ? 'in' : 'toward');
      if (d.kind === 'reach') {
        target = pointOf(cast, c.spec, d.at);
        g = target.clone().addScaledVector(target.clone().sub(shoulder).normalize(), -d.stopShort);
        effector = (out) => (a.hands[s] ? a.hands[s]!.palmCenter(out) : a.arms[s].hand.getWorldPosition(out));
      } else if (d.kind === 'take') {
        target = takeGoal(r).point;
        g = target.clone();
        const radius = stage.props.get(d.object)!.prop.grip!.radius;
        effector = (out) => (a.hands[s] ? a.hands[s]!.fistPoint(radius, out) : a.arms[s].hand.getWorldPosition(out));
        turns.push({ r, e });
      } else {
        target = putGoal(cast, c, r).point;
        g = target.clone();
        const run = holdingRun(r);
        if (run?.offset) {
          const offset = run.offset;
          const held = stage.props.get(d.object)!.prop;
          effector = (out) => out.copy(heldPose(c, s, held, offset).position);
          turns.push({ r, e });
        }
        palmKind = 'in';
      }
      goal = goal ? goal.lerp(g, clamp01(e)) : g;
      w = goal === g ? e : Math.max(w, e);
      const up = bodyUp(a);
      const towards = target.clone().sub(shoulder).normalize();
      const p = palmKind === 'up' ? up : palmKind === 'down' ? up.clone().negate() : palmKind === 'in' ? new THREE.Vector3(s === 'left' ? -1 : 1, 0, 0).applyQuaternion(bodyQ) : towards;
      palm = palm ? palm.lerp(p, clamp01(e)).normalize() : p.clone();
    }
    hangArm(a, s, rest);
    a.frame.updateMatrixWorld(true);
    const hand = a.hands[s];
    if (goal && w !== 0) {
      const restAt = effector(new THREE.Vector3());
      const restNormal = hand ? hand.palmNormal(new THREE.Vector3()) : bodyUp(a).negate();
      const point = restAt.clone().lerp(goal, w);
      // A little outward and forward on the way, so the hand clears the thigh.
      const arc = Math.sin(Math.PI * clamp01(w));
      if (!flat) point.addScaledVector(new THREE.Vector3(s === 'left' ? 1 : -1, 0, 0.6).applyQuaternion(bodyQ), 0.04 * arc);
      const toward = restNormal.clone().lerp(palm!, clamp01(w)).normalize();
      const wrist = a.arms[s].hand.getWorldPosition(new THREE.Vector3()).add(point.clone().sub(restAt));
      // The elbow turns from hanging (back) to the rig's reaching bend (out) as the arm lifts.
      const elbowHint = restElbowHint(a, s).lerp(a.arms[s].elbowHintLocal, clamp01(w)).normalize();
      const at = new THREE.Vector3();
      // The elbow swung about the shoulder-to-hand line (the upper arm's rotation), in the avatar's frame.
      const solveWith = (swivel: number, withTurns: readonly { r: Resolved; e: number }[]): void => {
        const shoulder = a.arms[s].upperArm.getWorldPosition(new THREE.Vector3());
        const line = point.clone().sub(shoulder).normalize().applyQuaternion(a.frame.getWorldQuaternion(new THREE.Quaternion()).invert());
        const hint = elbowHint.clone().applyAxisAngle(line, swivel * DEG);
        const wr = wrist.clone();
        for (let i = 0; i < 8; i += 1) {
          solveArm(a, s, wr, { palmToward: toward, wristBend: flat ? 0 : 0.35 * clamp01(w), elbowHint: hint });
          a.frame.updateMatrixWorld(true);
          turnHand(cast, c, s, withTurns);
          effector(at);
          const err = point.clone().sub(at);
          if (err.length() < 5e-4) break;
          wr.add(err);
        }
      };
      // A turn the wrist cannot make alone (an aim, a grip axis, an object set upright)
      // swings the elbow too, as a pour does: the swing is chosen once per direction,
      // at its full turn, and eased in with it.
      let swivel = 0;
      const lead = turns.find((x) => x.r.direction.kind === 'aim') ?? turns[0];
      if (lead) {
        let chosen = stage.swivels.get(lead.r.direction);
        if (chosen === undefined) {
          const full = turns.map((x) => (x === lead ? { r: x.r, e: 1 } : x));
          let best = { swivel: 0, error: Infinity };
          for (const candidate of [0, 15, -15, 30, -30, 45, -45, 60, -60, 75, -75, 90, -90]) {
            solveWith(candidate, full);
            const error = turnError(cast, c, s, lead.r);
            if (error < best.error - 0.5) best = { swivel: candidate, error };
          }
          chosen = best.swivel;
          stage.swivels.set(lead.r.direction, chosen);
        }
        swivel = chosen * clamp01(lead.e);
      }
      solveWith(swivel, turns);
    } else if (turns.length) turnHand(cast, c, s, turns);
  }

  // A flat take stops here: bind fingers, a still face, eyes fixed in the head (held objects still follow the hands).
  if (flat) { moveHeld(cast, c, t); return; }

  // 8. Hands: relaxed, opened by a reach, shaped by hand directions (fingers arrive one after another).
  for (const s of SIDES) {
    const hand = a.hands[s];
    if (!hand) continue;
    const reachW = Math.max(0, ...c.dirs.filter((r) => (r.direction.kind === 'reach' || r.direction.kind === 'take' || r.direction.kind === 'put') && r.direction.side === s).map((r) => env(r, t, false)));
    let pose: HandPose = blendPose(HAND_SHAPES.relaxed, HAND_SHAPES.reach, clamp01(reachW) * 0.8);
    // Closed round what it holds: tighter round a thin handle, looser round a thick one.
    const held = gripOf(c.spec.id, s, t);
    if (held) {
      const k = Math.min(1.3, Math.max(0.6, 1 + (0.015 - held.prop.grip!.radius) * 12));
      const grip = { curl: Object.fromEntries(FINGERS.map((f) => [f, Math.min(1, HAND_SHAPES.grip.curl[f] * k)])) as Record<FingerName, number>, spread: HAND_SHAPES.grip.spread };
      pose = blendPose(pose, grip, held.weight);
    }
    for (const r of c.dirs) {
      const d = r.direction;
      if (d.kind !== 'hand' || (d.side !== s && d.side !== 'both')) continue;
      const target = shapePose(d.shape, d.strength ?? 1);
      const curl = { ...pose.curl } as Record<FingerName, number>;
      for (const finger of FINGERS) {
        const e = env(r, t - FINGER_ORDER[finger] * FINGER_STAGGER, false);
        curl[finger] = lerp(curl[finger], target.curl[finger], e);
      }
      pose = { curl, spread: lerp(pose.spread, target.spread, env(r, t, false)) };
    }
    if (life) {
      const curl = { ...pose.curl } as Record<FingerName, number>;
      const still = 1 - 0.7 * (held?.weight ?? 0);
      FINGERS.forEach((finger, i) => { curl[finger] += still * 0.025 * Math.sin((2 * Math.PI * t) / (2.7 + i * 0.37) + phase + i * 1.3) + still * 0.012 * Math.sin((2 * Math.PI * t) / 1.1 + i); });
      pose = { curl, spread: pose.spread };
    }
    hand.apply(pose);
  }
  a.frame.updateMatrixWorld(true);
  moveHeld(cast, c, t);

  // 9. Face: expressions summed, then blinks (always, and on a big look shift), then gaze.
  const weights: FaceWeights = {};
  for (const r of c.dirs) {
    const d = r.direction;
    if (d.kind !== 'expression') continue;
    const e = Math.max(0, env(r, t, flat)) * (d.strength ?? 1);
    const shape = typeof d.shape === 'string' ? EXPRESSIONS[d.shape] : d.shape;
    for (const [k, v] of Object.entries(shape) as [FaceChannel, number][]) weights[k] = Math.min(1, (weights[k] ?? 0) + v * e);
  }
  const liveSample = life ? c.live.sample(t, dt, 0) : undefined;
  if (liveSample) {
    let blink = liveSample.weights.eyeBlinkLeft ?? 0;
    for (const r of c.dirs) if (r.direction.kind === 'look' && (r.direction.head ?? 0.6) > 0.3) blink = Math.max(blink, blinkAt(t - r.at + 0.02));
    weights.eyeBlinkLeft = Math.max(weights.eyeBlinkLeft ?? 0, blink);
    weights.eyeBlinkRight = Math.max(weights.eyeBlinkRight ?? 0, blink);
  }
  const neutral: FaceGaze = { left: { yaw: 0, pitch: 0 }, right: { yaw: 0, pitch: 0 } };
  let gaze: FaceGaze = neutral;
  const eyeTarget = lookTarget(cast, c, t, flat, 'eyes');
  if (eyeTarget) {
    const g = a.face.gazeTowardPoint(eyeTarget.point);
    if (g) gaze = mixGaze(neutral, g, eyeTarget.weight);
  }
  if (liveSample) {
    // Saccades shrink to fixational jitter while the eyes hold a target.
    const k = eyeTarget ? 1 - 0.7 * clamp01(eyeTarget.weight) : 1;
    gaze = { left: { yaw: gaze.left.yaw + liveSample.gaze.left.yaw * k, pitch: gaze.left.pitch + liveSample.gaze.left.pitch * k }, right: { yaw: gaze.right.yaw + liveSample.gaze.right.yaw * k, pitch: gaze.right.pitch + liveSample.gaze.right.pitch * k } };
  }
  a.face.apply(weights, gaze);
  a.frame.updateMatrixWorld(true);
}

/**
 * How far to lean so each active reach's goal comes within the arm: from the
 * shoulder as it stands this frame (before leaning), the shortfall beyond a
 * comfortable reach, met first by the hips (up to `LEAN_HIPS`) and then by
 * the spine (up to `LEAN_MAX_DEG`). What is still left is recorded per reach,
 * so the build can say the performers are too far apart.
 */
function leanFor(cast: Cast[], c: Cast, t: number, hipsLocal: THREE.Vector3): { dir: THREE.Vector3; hipShift: number; theta: number } | undefined {
  const a = c.a;
  let best: { dir: THREE.Vector3; need: number; r: Resolved; e: number } | undefined;
  for (const r of c.dirs) {
    const d = r.direction;
    if (d.kind !== 'reach' && d.kind !== 'take' && d.kind !== 'put') continue;
    const e = clamp01(envelope(t, r));
    if (e === 0) continue;
    const shoulder = toWorld(a, a.bind.get(`${d.side}UpperArm`)!.rootPosition.clone().add(hipsLocal));
    let goal: THREE.Vector3;
    if (d.kind === 'reach') {
      const target = pointOf(cast, c.spec, d.at);
      goal = target.clone().addScaledVector(target.clone().sub(shoulder).normalize(), -d.stopShort);
    } else if (d.kind === 'take') goal = takeGoal(r).point.clone();
    else goal = putGoal(cast, c, r).point.clone().add(new THREE.Vector3(0, stage.props.get(d.object)!.prop.grip!.center.y, 0));
    const arm = a.arms[d.side];
    const over = goal.distanceTo(shoulder) - (COMFORT_REACH * (arm.upperLength + arm.lowerLength) + PALM_OFFSET);
    if (over <= 0) { if (e > 0.9 && !c.shortfall.has(r)) c.shortfall.set(r, 0); continue; }
    const dir = goal.clone().sub(shoulder).setY(0);
    if (dir.lengthSq() < 1e-8) continue;
    dir.normalize();
    if (!best || over * e > best.need) best = { dir, need: over * e, r, e };
  }
  if (!best) return undefined;
  const torso = a.bind.get('leftUpperArm')!.rootPosition.y - a.bind.get('hips')!.rootPosition.y;
  const hipShift = Math.min(LEAN_HIPS, best.need * 0.35);
  const rest = best.need - hipShift;
  const theta = Math.asin(Math.min(Math.sin(LEAN_MAX_DEG * DEG), rest / torso));
  if (best.e > 0.9) c.shortfall.set(best.r, Math.max(c.shortfall.get(best.r) ?? 0, rest - torso * Math.sin(theta)));
  return { dir: best.dir, hipShift, theta };
}

function lookTarget(cast: Cast[], c: Cast, t: number, flat: boolean, by: 'head' | 'eyes'): { point: THREE.Vector3; weight: number; share: number } | undefined {
  let point: THREE.Vector3 | undefined;
  let weight = 0;
  let share = 0.6;
  for (const r of c.dirs) {
    const d = r.direction;
    if (d.kind !== 'look') continue;
    // The eyes lead the head by a few frames and arrive faster.
    const e = by === 'eyes'
      ? env({ ...r, start: r.start - 0.06, at: r.at - 0.06, attack: Math.min(r.attack, 0.12), hold: r.hold + r.attack - Math.min(r.attack, 0.12) + 0.06 }, t, flat)
      : env(r, t, flat);
    if (e === 0) continue;
    const p = pointOf(cast, c.spec, d.at);
    point = point ? point.lerp(p, clamp01(e)) : p;
    weight = point === p ? e : Math.max(weight, e);
    share = d.head ?? 0.6;
  }
  return point ? { point, weight, share } : undefined;
}

function mixGaze(a: FaceGaze, b: FaceGaze, f: number): FaceGaze {
  return {
    left: { yaw: lerp(a.left.yaw, b.left.yaw, f), pitch: lerp(a.left.pitch, b.left.pitch, f) },
    right: { yaw: lerp(a.right.yaw, b.right.yaw, f), pitch: lerp(a.right.pitch, b.right.pitch, f) }
  };
}

function blinkAt(u: number): number {
  if (u < 0) return 0;
  if (u < 0.07) return u / 0.07;
  if (u < 0.11) return 1;
  return u < 0.23 ? 1 - (u - 0.11) / 0.12 : 0;
}
