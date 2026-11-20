/**
 * Solves a beat sheet on its avatars, frame by frame: each performer is
 * reset to bind, placed, posed by its directions (closed forms of time, so a
 * revised beat changes only its span), and given the life that always runs
 * underneath (weight shifts, glances, sighs and hand fidgets as events, over
 * breath, a little sway, blinks, saccades and finger drift). Each frame is
 * recorded as local transforms and morph weights, ready for the writer.
 */
import * as THREE from 'three';
import { gazeFromArkit, MAX_PITCH, MAX_YAW, type FaceChannel } from '@holoim/avatar-face';
import type { VrmHumanoidBone } from '@holoim/meaning';

import { LivenessFace } from '../../../src/face/LivenessFace.ts';
import type { JointName, MotionFrame, Vec3 } from '../../lib/motion-quality.ts';
import type { FaceGaze, FaceWeights } from '../../../src/face/faceTypes.ts';
import { resetPose, type LoadedAvatar } from './avatar.ts';
import { FACE_MIXES, GESTURES, cueTime, STATE_FACES, envelope, gestureCycle, holdingsOf, pointObjects, resolveTiming, validateSheet, type BeatSheet, type Direction, type Holding, type ObjectSpec, type PerformerSpec, type Place, type Point, type Resolved, type Side } from './beats.ts';
import { FINGERS, HAND_SHAPES, blendPose, shapePose, type FingerName, type HandPose } from './hands.ts';
import { armRestOffset, bodyUp, hangArm, moveBoneWorld, orientHand, plantFeet, restElbowHint, rotateBoneWorld, solveArm, toWorld, turnBody, TURN_SHARE } from './pose.ts';
import { speakingAt, visemesAt, type LineLips } from './lips.ts';
import { busy, faceAt, fidgetAt, GLANCE_BLINK_DEG, glanceAt, glanceChest, LIFE_FIDGET, LIFE_SIGH, LIFE_WEIGHT, lifeSchedule, MASK_PAD, MASKED_BY, postureAt, sighAt, weightAt, attendArmsAt, attendGate, attendNodAt, attendSchedule, ATTEND_ARMS, type AttendSchedule, type LifeSchedule } from './life.ts';
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

// Continuous life under the events of `life.ts` (weight shifts, glances,
// sighs, fidgets), which carry what a viewer sees. Sway and drift are kept to
// a standing person's postural noise: as the only life, at 22 mm and 3.5°,
// two fresh readers and the owner still called a held ending frozen.
/** Hips sway, metres: side to side and front to back. */
const SWAY = { x: 0.006, z: 0.004 } as const;
/** Breath, degrees of pitch per spine bone at full inhale. */
const BREATH_DEG = [['spine', 1.5], ['chest', 2.5], ['upperChest', 1.6]] as const;
const SHOULDER_LIFT_DEG = 2.5;
/** The hanging hands rise and fall with the breath, metres. */
const ARM_BREATH = 0.012;
/** The head's slow drift, degrees of yaw (pitch is 0.6 of it). */
const HEAD_DRIFT_DEG = 1.5;

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
/** Gestures (`beats.ts` GESTURES): degrees and metres at strength 1. */
const NOD_DEG = 26;
const SHAKE = { yawDeg: 40, dipDeg: 6, fade: 0.25 } as const;
const SHRUG = { shoulderDeg: 14, headRollDeg: 5 } as const;
const WAVE_SWING = 0.055;
const RUB_ROLL_DEG = 15;
/** Where a gesture's hand goes, from its shoulder per arm length (out, up, forward in the body frame). */
const GESTURE_HAND = { shrug: [0.38, -0.72, 0.38], wave: [0.38, 0.12, 0.25], rub: [0.22, -0.3, 0.62] } as const;
/** Hand to chest: the palm this far in front of the chest bone (metres), toward the other side. */
const CHEST_HAND = { forward: 0.13, across: 0.04, down: 0.02 } as const;
/** States: head pitch down and roll, spine lean forward and shoulders up (degrees); how much of the head turns to an `at`. */
const STATE_POSE = {
  noticing: { pitch: -4, roll: 0, spine: -2.5, shoulders: 3, head: 0.7 },
  concerned: { pitch: 14, roll: 8, spine: 7, shoulders: 6, head: 0.5 }
} as const;
/** A bend at amount 1: degrees forward at the waist (spread up the spine), and the hips back and down (m) to keep the weight over the feet. */
export const BEND = { deg: 45, hipsBack: 0.07, drop: 0.035 } as const;
/** A crouch at amount 1: the hips down and back (m) over the planted feet, and the spine leans forward (degrees) to keep the weight over the feet. */
export const CROUCH = { drop: 0.3, hipsBack: 0.1, deg: 22 } as const;
/** A shrug's face: brows up, the lower lip pushed up. */
const SHRUG_FACE: Partial<Record<FaceChannel, number>> = { browInnerUp: 0.4, browOuterUpLeft: 0.45, browOuterUpRight: 0.45, mouthShrugLower: 0.5, mouthPressLeft: 0.2, mouthPressRight: 0.2 };
const RUB_HAND = { low: { thumb: 0.5, index: 0.45, middle: 0.66 }, high: { thumb: 0.75, index: 0.62, middle: 0.5 }, ring: 0.7, little: 0.74, spread: 0.05 } as const;
const CHEST_PALM: HandPose = { curl: { thumb: 0.15, index: 0.1, middle: 0.12, ring: 0.16, little: 0.2 }, spread: 0.2 };
const CLASP_HAND: HandPose = { curl: { thumb: 0.3, index: 0.35, middle: 0.4, ring: 0.45, little: 0.5 }, spread: 0.08 };

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
  /** World joint positions per frame, as `scripts/lib/motion-quality.ts` measures a body. */
  readonly motion: MotionFrame[];
  /** The performer's life events (`life.ts`); undefined when the take has no life. */
  readonly life?: LifeSchedule;
  /** Attending life (`life.ts`), drawn when the take has life; plays only while facing someone. */
  readonly attend?: AttendSchedule;
}

/** The motion-quality joints, by the humanoid bone each is read from (as capture's body samples). */
const MOTION_JOINTS: ReadonlyArray<readonly [JointName, VrmHumanoidBone]> = [
  ['head', 'head'], ['neck', 'neck'], ['chest', 'upperChest'], ['hips', 'hips'],
  ['leftShoulder', 'leftUpperArm'], ['rightShoulder', 'rightUpperArm'], ['leftElbow', 'leftLowerArm'], ['rightElbow', 'rightLowerArm'],
  ['leftWrist', 'leftHand'], ['rightWrist', 'rightHand'], ['leftHip', 'leftUpperLeg'], ['rightHip', 'rightUpperLeg'],
  ['leftKnee', 'leftLowerLeg'], ['rightKnee', 'rightLowerLeg'], ['leftAnkle', 'leftFoot'], ['rightAnkle', 'rightFoot'],
  ['leftToe', 'leftToes'], ['rightToe', 'rightToes']
];

function motionFrame(a: LoadedAvatar, t: number): MotionFrame {
  const joints: MotionFrame['joints'] = {};
  const v = new THREE.Vector3();
  for (const [name, bone] of MOTION_JOINTS) {
    const b = a.humanoid.bone(bone) ?? (name === 'chest' ? a.humanoid.bone('chest') : undefined);
    if (b) joints[name] = b.getWorldPosition(v).toArray() as Vec3;
  }
  return { timeSec: t, joints };
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
  readonly events: LifeSchedule;
  readonly attend: AttendSchedule | undefined;
  readonly dirs: Resolved[];
  /** Other performers' reaches to this performer's left or right arm or hand, which hold that hand's life still. */
  readonly touched: Record<Side, Resolved[]>;
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
  /** The performer's spoken lines (`lips.ts`), in take time. */
  readonly speech: readonly Speech[];
}

/** A spoken line's lips, starting at take time `at`. */
export interface Speech { readonly at: number; readonly lips: LineLips }

const yawQuat = (deg: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), deg * DEG);
/** Degrees about +Y that a rotation turns +Z to. */
const yawOf = (q: THREE.Quaternion): number => { const z = new THREE.Vector3(0, 0, 1).applyQuaternion(q); return Math.atan2(z.x, z.z) / DEG; };

export function solveTake(sheet: BeatSheet, avatars: Map<string, LoadedAvatar>, sources: ReadonlyMap<string, LoadedSource> = new Map(), speech: ReadonlyMap<string, readonly Speech[]> = new Map()): SolvedTake {
  const problems = validateSheet(sheet);
  if (problems.length) throw new Error(`beat sheet: ${problems.join('; ')}`);
  stage.marks.clear();
  stage.fixed = new WeakMap();
  stage.props.clear();
  stage.bodies.clear();
  stage.runs.clear();
  stage.fallen.clear();
  stage.restBones.clear();
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
    const dirs = sheet.beats.filter((b) => b.performer === spec.id).flatMap((b) => b.directions.map((d0) => {
      // A hand gesture is the right hand's unless it names one (so it masks only that hand's life).
      const d: Direction = d0.kind === 'gesture' && GESTURES[d0.name].hand && !d0.side ? { ...d0, side: 'right' } : d0;
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
      spec, a, live: new LivenessFace(spec.seed ?? 0x5eed + index * 7919), seed: spec.seed ?? index + 1,
      events: lifeSchedule(spec.seed ?? index + 1, sheet.duration + 1),
      attend: life && spec.attend !== false ? attendSchedule(spec.seed ?? index + 1, sheet.duration + 1) : undefined, dirs, touched: { left: [], right: [] },
      turnDeg: new Map(), stepWorld: new Map(), fixed: { next: 0, yaw: spec.facing }, ankles0,
      feetMid0: ankles0.left.clone().add(ankles0.right).multiplyScalar(0.5),
      seen: new Map(), seenBefore: new Map(), seenAt: { t: -Infinity, before: -Infinity }, shortfall: new Map(), morphing, speech: speech.get(spec.id) ?? []
    };
  });
  // A hand someone reaches to keeps still while they do (its fidget would move what they touch).
  for (const c of cast) for (const r of c.dirs) {
    const d = r.direction;
    if (d.kind !== 'reach' || typeof d.at !== 'string') continue;
    const m = /^([^.]+)\.(left|right)(Shoulder|UpperArm|LowerArm|Hand|\w*(Proximal|Intermediate|Distal|Metacarpal))$/.exec(d.at);
    const other = m && cast.find((o) => o.spec.id === m[1]);
    if (other && other !== c) other.touched[m[2] as Side].push(r);
  }
  // Measures and landmarks from each performer's rest pose, then the set, placed on the first frame.
  for (const c of cast) {
    solveFrame(cast, { ...c, dirs: [] }, 0, 1 / fps, false, false);
    stage.bodies.set(c.spec.id, measureBody(c.a));
    const bones = new Map<string, THREE.Matrix4>();
    for (const o of Object.values(sheet.objects ?? {})) {
      if (!o.wear || (o.wear.performer ?? stage.first) !== c.spec.id) continue;
      const bone = c.a.bind.get(o.wear.on as VrmHumanoidBone)?.bone;
      if (bone) bones.set(o.wear.on, new THREE.Matrix4().compose(bone.getWorldPosition(new THREE.Vector3()), bone.getWorldQuaternion(new THREE.Quaternion()), new THREE.Vector3(1, 1, 1)));
    }
    stage.restBones.set(c.spec.id, bones);
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
    return { spec: c.spec, avatar: c.a, rotations, translations, weights, root: { position: new Float32Array(frames * 3), rotation: new Float32Array(frames * 4) }, reaches: [], motion: [], ...(life ? { life: c.events } : {}), ...(c.attend ? { attend: c.attend } : {}) };
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
      tr.motion.push(motionFrame(c.a, t));
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
    for (const w of sheet.world ?? []) {
      if (w.kind !== 'fall' || stage.fallen.has(w)) continue;
      const when = cueTime(sheet, w.when)!;
      const st = stage.props.get(w.object)!;
      if (t >= when - 1e-6) { stage.fallen.add(w); delete st.release; startFall(st, new THREE.Vector3(...(w.push ?? [0, 0, 0])), w.push === undefined); }
    }
    stepFalls(t, 1 / fps);
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
  /** Falling (dropped or knocked): velocity and spin, until it rests; then settling onto its side. */
  fall?: { v: THREE.Vector3; w: THREE.Vector3; bounces: number; settle?: { t0: number; fromQ: THREE.Quaternion; toQ: THREE.Quaternion; surface: number; slide: THREE.Vector3 } };
  /** Where a held object was on the frame before, to give a drop the hand's speed. */
  last?: { t: number; p: THREE.Vector3 };
  /** A worn object's fixed place in its bone's frame. */
  worn?: THREE.Matrix4;
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
  /** The world fall lines already started. */
  fallen: new Set<object>(),
  /** Each performer's bone world matrices in the rest pose, for worn objects. */
  restBones: new Map<string, Map<string, THREE.Matrix4>>(),
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
    for (const d of [...(o.on !== undefined ? [o.on] : []), ...pointObjects(o.at, ids, sheet.marks), ...(typeof o.facing === 'number' ? [] : pointObjects(o.facing, ids, sheet.marks))]) visit(d);
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
    // Turned as what it is placed from faces: a mark stands for its own point.
    const at = typeof spec.at === 'string' && stage.marks.has(spec.at) ? stage.marks.get(spec.at) : spec.at;
    if (isPlace(at)) {
      const of = at.of ?? stage.first;
      const c = cast.find((x) => x.spec.id === of);
      defaultYaw = c ? c.spec.facing : yawOf(stage.props.get(of)!.prop.quaternion);
    } else if (spec.on === undefined) {
      const from = measuredFrom(sheet, at);
      const c = from !== undefined ? cast.find((x) => x.spec.id === from) : undefined;
      if (c) defaultYaw = c.spec.facing;
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
      const opening = h.put || h.drop ? 1 - smooth(clamp01((t - h.to) / GRIP_OPEN)) : 1;
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
        // At unit scale, as `poseInHand` applies it: a rig scaled to centimetres would scale the offset.
        const handAt = new THREE.Matrix4().compose(hand.getWorldPosition(new THREE.Vector3()), hand.getWorldQuaternion(new THREE.Quaternion()), new THREE.Vector3(1, 1, 1));
        run.offset = handAt.invert().multiply(new THREE.Matrix4().compose(st.prop.position, st.prop.quaternion, new THREE.Vector3(1, 1, 1)));
      }
      const pose = heldPose(c, h.side, st.prop, run.offset);
      if (h.drop && t >= h.to - 1e-6) {
        run.released = true;
        const v = st.last && t > st.last.t ? pose.position.clone().sub(st.last.p).divideScalar(t - st.last.t) : new THREE.Vector3();
        startFall(st, v);
        continue;
      }
      st.last = { t, p: pose.position.clone() };
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

const GRAVITY = 9.81;
const FALL_SETTLE = 0.35;

/** Starts a fall with a velocity; the spin tips it the way it travels, plus a little of its own. */
function startFall(st: PropState, v: THREE.Vector3, tumble = false): void {
  const speed = Math.hypot(v.x, v.z);
  const across = new THREE.Vector3(0, 1, 0).cross(new THREE.Vector3(v.x, 0, v.z));
  // A gentle drop (under 0.3 m/s across) falls without a spin; a fall with no push tumbles a little.
  const w = speed >= 0.3 ? across.normalize().multiplyScalar(-Math.min(9, 3 + 6 * speed)) : tumble ? new THREE.Vector3(2.5, 0, 1.5) : new THREE.Vector3();
  st.fall = { v: v.clone(), w, bounces: 0 };
}

/** The lowest point of an object at a turn, below its origin (metres, negative below). */
function lowest(prop: Prop, q: THREE.Quaternion): number {
  let min = Infinity;
  const b = prop.bounds;
  for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) min = Math.min(min, new THREE.Vector3(x, y, z).applyQuaternion(q).y);
  return min;
}

/** The highest surface under a point that is not above `below`: another object's top, else the floor. */
function surfaceUnder(self: PropState, p: THREE.Vector3, below: number): number {
  let best = 0;
  for (const st of stage.props.values()) {
    if (st === self || st.fall || st.prop.spec.wear || st.holdings.some((h) => h.from <= solving.t && solving.t < h.to)) continue;
    const box = st.prop.bounds.clone().applyMatrix4(new THREE.Matrix4().compose(st.prop.position, st.prop.quaternion, new THREE.Vector3(1, 1, 1)));
    if (p.x >= box.min.x && p.x <= box.max.x && p.z >= box.min.z && p.z <= box.max.z && box.max.y <= below + 0.02) best = Math.max(best, box.max.y);
  }
  return best;
}

/** Every falling object one frame on: gravity, a bounce or two, then it tips onto its nearest face and rests. */
function stepFalls(t: number, dt: number): void {
  for (const st of stage.props.values()) {
    const f = st.fall;
    if (!f) continue;
    // Taken while it falls or rests: the hand has it now.
    if (st.holdings.some((h) => h.from <= t + 1e-6 && t < h.to)) { delete st.fall; continue; }
    const prop = st.prop;
    if (f.settle) {
      const u = smooth(clamp01((t - f.settle.t0) / FALL_SETTLE));
      prop.quaternion.slerpQuaternions(f.settle.fromQ, f.settle.toQ, u);
      prop.position.addScaledVector(f.settle.slide, dt * (1 - u));
      // Slid off its surface (past a table edge): it falls again from here.
      const surface = surfaceUnder(st, prop.position, prop.position.y + lowest(prop, prop.quaternion) + 0.001);
      if (surface < f.settle.surface - 0.02) { f.v.set(f.settle.slide.x * (1 - u), 0, f.settle.slide.z * (1 - u)); delete f.settle; continue; }
      prop.position.y = f.settle.surface - lowest(prop, prop.quaternion);
      // At rest: no longer falling, so a hand can take it and other objects can stand on it.
      if (u >= 1) delete st.fall;
      continue;
    }
    const n = 4;
    for (let k = 0; k < n; k += 1) {
      const h = dt / n;
      f.v.y -= GRAVITY * h;
      prop.position.addScaledVector(f.v, h);
      const spin = f.w.length() * h;
      if (spin > 0) prop.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(f.w.clone().normalize(), spin));
      const bottom = prop.position.y + lowest(prop, prop.quaternion);
      const surface = surfaceUnder(st, prop.position, bottom - f.v.y * h + 0.001);
      if (bottom > surface) continue;
      prop.position.y += surface - bottom;
      // Still going up (a knock tips it about its edge first): keep it on the surface, with a little friction.
      if (f.v.y > 0) { f.v.x *= 0.97; f.v.z *= 0.97; continue; }
      if (f.v.y < -0.8 && f.bounces < 2) {
        f.v.set(f.v.x * 0.5, -f.v.y * 0.25, f.v.z * 0.5);
        f.w.multiplyScalar(0.4);
        f.bounces += 1;
        continue;
      }
      // Rest on the face nearest to down once its spin has carried on a little (a knocked glass goes over).
      const ahead = prop.quaternion.clone();
      if (f.w.lengthSq() > 0) ahead.premultiply(new THREE.Quaternion().setFromAxisAngle(f.w.clone().normalize(), Math.min(Math.PI / 2, f.w.length() * 0.25)));
      let toQ = prop.quaternion.clone();
      let bestAngle = Infinity;
      const down = new THREE.Vector3(0, -1, 0);
      for (const a of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
        const now = new THREE.Vector3(...a).applyQuaternion(ahead);
        const angle = now.angleTo(down);
        if (angle < bestAngle) { bestAngle = angle; toQ = new THREE.Quaternion().setFromUnitVectors(now, down).multiply(ahead); }
      }
      f.settle = { t0: t, fromQ: prop.quaternion.clone(), toQ, surface, slide: new THREE.Vector3(f.v.x, 0, f.v.z) };
      break;
    }
  }
}

/** Worn objects ride their bone: placed on the first frame from the performer's facing, then fixed in the bone's frame. */
function moveWorn(c: Cast): void {
  for (const st of stage.props.values()) {
    const wear = st.prop.spec.wear;
    if (!wear || (wear.performer ?? stage.first) !== c.spec.id) continue;
    const bone = c.a.bind.get(wear.on as VrmHumanoidBone)?.bone;
    if (!bone) throw new Error(`${st.prop.id}: ${c.spec.id} has no bone ${wear.on}`);
    bone.updateWorldMatrix(true, false);
    const boneM = new THREE.Matrix4().compose(bone.getWorldPosition(new THREE.Vector3()), bone.getWorldQuaternion(new THREE.Quaternion()), new THREE.Vector3(1, 1, 1));
    if (!st.worn) {
      const rest = stage.restBones.get(c.spec.id)?.get(wear.on);
      if (rest) boneM.copy(rest);
      const facing = yawQuat(c.spec.facing);
      const at = new THREE.Vector3(-(wear.at?.[0] ?? 0), wear.at?.[1] ?? 0, wear.at?.[2] ?? 0).applyQuaternion(facing);
      const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(wear.turn ?? [0, 0, 0]).map((d) => d * DEG) as [number, number, number], 'XYZ'));
      const want = new THREE.Matrix4().compose(new THREE.Vector3().setFromMatrixPosition(boneM).add(at), facing.clone().multiply(turn), new THREE.Vector3(1, 1, 1));
      st.worn = boneM.clone().invert().multiply(want);
      if (rest) boneM.compose(bone.getWorldPosition(new THREE.Vector3()), bone.getWorldQuaternion(new THREE.Quaternion()), new THREE.Vector3(1, 1, 1));
    }
    const m = boneM.multiply(st.worn);
    m.decompose(st.prop.position, st.prop.quaternion, new THREE.Vector3());
  }
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
  // Attending life plays as much as the upper body faces another performer.
  const attendK = life && !flat && c.attend ? attendFacing(cast, c, leadYaw) : 0;

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
  let lifeRoll = 0;
  let postureLean = 0;
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
  let bend = 0;
  for (const r of c.dirs) {
    const d = r.direction;
    if (d.kind !== 'bend') continue;
    bend += env(r, t, flat) * (d.amount ?? 0.7);
  }
  hipsLocal.z -= BEND.hipsBack * bend;
  hipsLocal.y -= BEND.drop * bend;
  let crouch = 0;
  for (const r of c.dirs) {
    const d = r.direction;
    if (d.kind !== 'crouch') continue;
    crouch += env(r, t, flat) * (d.amount ?? 0.7);
  }
  crouch = Math.min(crouch, 1);
  hipsLocal.z -= CROUCH.hipsBack * crouch;
  hipsLocal.y -= CROUCH.drop * crouch;
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
    // Weight on one leg, changing legs now and then: the hips go toward the standing foot
    // (wherever a step left it), the pelvis rolls so the free hip drops, and the free knee bends.
    const w = weightAt(c.events, t) * (1 - busy(c.dirs, t, MASKED_BY.weight));
    if (w !== 0) {
      const stand = w > 0 ? feet.left : feet.right;
      const toward = stand.clone().sub(feet.left.clone().add(feet.right).multiplyScalar(0.5)).applyQuaternion(a.body.getWorldQuaternion(new THREE.Quaternion()).invert());
      toward.y = 0;
      if (toward.lengthSq() < 1e-6) toward.set(w > 0 ? 1 : -1, 0, 0);
      hipsLocal.addScaledVector(toward.normalize(), LIFE_WEIGHT.shift * Math.abs(w));
      hipsLocal.y -= LIFE_WEIGHT.drop * Math.abs(w);
      lifeRoll = -LIFE_WEIGHT.rollDeg * DEG * w;
    }
    // The posture resettles with each change of legs: the hips sit forward or back and the spine
    // leans a little, which is what a weight shift shows from the side.
    // Not while another performer reaches to this one (their hand would chase a moving arm).
    const pk = 1 - busy(c.dirs, t, MASKED_BY.weight);
    const touched = [...c.touched.left, ...c.touched.right];
    const posture = postureAt(c.events, t, (from, to) => touched.some((r) => from < r.end + MASK_PAD && to > r.start - MASK_PAD));
    hipsLocal.z += posture.hips * pk;
    postureLean = posture.lean * DEG * pk;
  }
  const hips = a.humanoid.bone('hips')!;
  const bodyQ = a.body.getWorldQuaternion(new THREE.Quaternion());
  // A reach whose goal is beyond the arm (the other performer moved away) is met by leaning toward it.
  const lean = flat ? undefined : leanFor(cast, c, t, hipsLocal);
  if (lean) hipsLocal.addScaledVector(lean.dir.clone().applyQuaternion(bodyQ.clone().invert()), lean.hipShift);
  moveBoneWorld(hips, hipsLocal.clone().applyQuaternion(bodyQ));
  if (pelvisRoll || lifeRoll) rotateBoneWorld(hips, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1).applyQuaternion(bodyQ), -(pelvisRoll + lifeRoll)));
  // The chest counters the pelvis so the head stays over the feet; under life's weight shift
  // only partly, so the shoulder line tilts against the hips.
  if (pelvisRoll || lifeRoll) {
    const chest = a.humanoid.bone('chest') ?? a.humanoid.bone('spine')!;
    rotateBoneWorld(chest, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1).applyQuaternion(bodyQ), pelvisRoll * 1.1 + lifeRoll * LIFE_WEIGHT.chestCounter));
  }

  // 4. Twist: the upper body leads a whole turn and makes an upper turn.
  if (Math.abs(twist) > 1e-5) turnBody(a, twist);
  let sigh = 0;
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
    // A sigh now and then: the shoulders rise and the chest lifts, then the breath goes out and
    // the body settles a little below its rest before coming back; less while a reach leans.
    sigh = sighAt(c.events, t) * (lean ? 1 - clamp01(lean.theta / (8 * DEG)) : 1);
    if (sigh !== 0) {
      const chest = a.humanoid.bone('upperChest') ?? a.humanoid.bone('chest');
      if (chest) rotateBoneWorld(chest, new THREE.Quaternion().setFromAxisAngle(right, -LIFE_SIGH.chestDeg * DEG * sigh));
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(bodyQ);
      for (const s of SIDES) {
        const b = a.humanoid.bone(`${s}Shoulder`);
        if (b) rotateBoneWorld(b, new THREE.Quaternion().setFromAxisAngle(fwd, (s === 'left' ? -1 : 1) * LIFE_SIGH.shoulderDeg * DEG * sigh));
      }
    }
  }
  {
    // A shrug lifts the shoulders; a state settles the body into its attitude (the head drops with a forward lean).
    let shoulders = 0;
    let spine = 0;
    for (const r of c.dirs) {
      const d = r.direction;
      if (d.kind === 'gesture' && d.name === 'shrug') shoulders += SHRUG.shoulderDeg * env(r, t, flat) * (d.strength ?? 1);
      else if (d.kind === 'state') {
        const e = env(r, t, flat) * (d.strength ?? 1);
        shoulders += STATE_POSE[d.name].shoulders * e;
        spine += STATE_POSE[d.name].spine * e;
      }
    }
    spine += BEND.deg * bend + CROUCH.deg * crouch;
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(bodyQ);
    if (shoulders !== 0) for (const s of SIDES) {
      const b = a.humanoid.bone(`${s}Shoulder`);
      if (b) rotateBoneWorld(b, new THREE.Quaternion().setFromAxisAngle(fwd, (s === 'left' ? -1 : 1) * shoulders * DEG));
    }
    if (spine !== 0) {
      const axis = new THREE.Vector3().crossVectors(bodyUp(a), fwd).normalize();
      let carry = 0;
      for (const [name, k] of LEAN_SHARE) {
        const b = a.humanoid.bone(name);
        if (!b) { carry += k; continue; }
        rotateBoneWorld(b, new THREE.Quaternion().setFromAxisAngle(axis, spine * DEG * (k + carry)));
        carry = 0;
      }
    }
  }
  if (postureLean !== 0) {
    // The posture's lean, spread up the spine; the neck takes most of it back so the gaze stays level.
    const axis = new THREE.Vector3().crossVectors(bodyUp(a), new THREE.Vector3(0, 0, 1).applyQuaternion(bodyQ)).normalize();
    let carry = 0;
    for (const [name, k] of LEAN_SHARE) {
      const b = a.humanoid.bone(name);
      if (!b) { carry += k; continue; }
      rotateBoneWorld(b, new THREE.Quaternion().setFromAxisAngle(axis, postureLean * (k + carry)));
      carry = 0;
    }
    const neck = a.humanoid.bone('neck') ?? a.humanoid.bone('head')!;
    rotateBoneWorld(neck, new THREE.Quaternion().setFromAxisAngle(axis, -0.6 * postureLean));
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

  // 5. Legs: planted feet, each foot in the lagging yaw of the root. The two-bone solve misses
  //    the ankle by a few millimetres when the pelvis rolls, so aim past the miss and solve again.
  plantFeet(a, feet);
  const aim = { left: feet.left.clone(), right: feet.right.clone() };
  for (let i = 0; i < 2; i++) {
    let miss = 0;
    for (const s of SIDES) {
      const off = feet[s].clone().sub(a.legs[s].foot.bone.getWorldPosition(new THREE.Vector3()));
      miss = Math.max(miss, off.length());
      aim[s].add(off);
    }
    if (miss < 2e-4) break;
    plantFeet(a, aim);
  }

  // 6. Head: a large glance turns the upper chest first (not on someone another performer
  //    reaches to); then looks (the head takes its share; the eyes take the rest and lead).
  const glance = life ? glanceAt(c.events, t) : undefined;
  const glanceK = glance ? 1 - busy(c.dirs, t, MASKED_BY.glance) : 0;
  let chestYaw = 0;
  if (glance && glanceK > 0) {
    const touchedK = 1 - Math.max(busy(c.touched.left, t, { reach: 1 }), busy(c.touched.right, t, { reach: 1 }));
    chestYaw = glanceChest(glance.head.yaw) * DEG * glanceK * touchedK;
    const chest = a.humanoid.bone('upperChest') ?? a.humanoid.bone('chest');
    if (chest && chestYaw !== 0) {
      rotateBoneWorld(chest, new THREE.Quaternion().setFromAxisAngle(bodyUp(a), chestYaw));
      a.frame.updateMatrixWorld(true);
    }
  }
  const headTarget = lookTarget(cast, c, t, flat, 'head');
  if (headTarget) {
    const { point, weight, share } = headTarget;
    const head = a.humanoid.bone('head')!;
    const neck = a.humanoid.bone('neck');
    const from = head.getWorldPosition(new THREE.Vector3());
    const local = point.clone().sub(from).applyQuaternion(bodyQ.clone().invert());
    // Relative to where the twisted upper body already faces.
    const faced = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), twist + chestYaw);
    const yaw = THREE.MathUtils.clamp(Math.atan2(local.x, local.z) - Math.atan2(faced.x, faced.z), -70 * DEG, 70 * DEG) * share * weight;
    const pitch = THREE.MathUtils.clamp(Math.atan2(local.y, Math.hypot(local.x, local.z)), -35 * DEG, 35 * DEG) * share * weight;
    const up = bodyUp(a);
    const parts: [THREE.Object3D | undefined, number][] = [[neck, 0.4], [head, neck ? 0.6 : 1]];
    for (const [bone, k] of parts) {
      if (!bone) continue;
      rotateBoneWorld(bone, new THREE.Quaternion().setFromAxisAngle(up, yaw * k));
      // Pitch about the performer's left axis as the head now faces (+X of the body, turned by twist and yaw).
      const side = new THREE.Vector3(1, 0, 0).applyQuaternion(bodyQ).applyAxisAngle(up, twist + chestYaw + yaw);
      rotateBoneWorld(bone, new THREE.Quaternion().setFromAxisAngle(side, -pitch * k));
    }
  }
  if (glance && glanceK > 0) {
    // A glance: the head and neck take the rest of their share, about the body's up and then its side as the head now faces.
    const up = bodyUp(a);
    const yaw = glance.head.yaw * DEG * glanceK - chestYaw;
    const pitch = glance.head.pitch * DEG * glanceK;
    const neck = a.humanoid.bone('neck');
    const head = a.humanoid.bone('head')!;
    for (const [bone, k] of [[neck, 0.4], [head, neck ? 0.6 : 1]] as const) {
      if (!bone) continue;
      rotateBoneWorld(bone, new THREE.Quaternion().setFromAxisAngle(up, yaw * k));
      const side = new THREE.Vector3(1, 0, 0).applyQuaternion(bodyQ).applyAxisAngle(up, twist + chestYaw + yaw);
      rotateBoneWorld(bone, new THREE.Quaternion().setFromAxisAngle(side, -pitch * k));
    }
  }
  {
    // Gestures, states and attending nods in the head, on top of any look, about the head as it now faces.
    let pitch = 0;
    let yaw = 0;
    let roll = 0;
    for (const r of c.dirs) {
      const d = r.direction;
      if (d.kind === 'state') {
        const e = env(r, t, flat) * (d.strength ?? 1);
        pitch += STATE_POSE[d.name].pitch * e;
        roll += STATE_POSE[d.name].roll * e;
        continue;
      }
      if (d.kind !== 'gesture') continue;
      const e = env(r, t, flat);
      if (e === 0) continue;
      const k = d.strength ?? 1;
      if (d.name === 'nod' || d.name === 'head-shake') {
        const cyc = gestureCycle(d, r.attack)!;
        const tau = t - r.at - cyc.from;
        const on = tau > 0 && tau < Math.min(cyc.count * cyc.cycle, r.attack + r.hold - cyc.from); // a shorter authored hold ends the repeats with it
        const wave = (2 * Math.PI * tau) / cyc.cycle;
        if (d.name === 'nod') pitch += NOD_DEG * k * (0.3 * e + (on ? 0.7 * (0.5 - 0.5 * Math.cos(wave)) * (tau < cyc.cycle ? 1 : 0.7) : 0));
        else {
          pitch += SHAKE.dipDeg * k * e;
          if (on) yaw += SHAKE.yawDeg * k * Math.sin(wave) * (1 - SHAKE.fade * tau / (cyc.count * cyc.cycle)) * clamp01(e);
        }
      } else if (d.name === 'shrug') roll += SHRUG.headRollDeg * k * e;
    }
    if (attendK > 0) pitch += attendNodAt(c.attend!, t) * attendK * (1 - busy(c.dirs, t, MASKED_BY.nod));
    if (pitch !== 0 || yaw !== 0 || roll !== 0) {
      const head = a.humanoid.bone('head')!;
      const neck = a.humanoid.bone('neck');
      const q = head.getWorldQuaternion(new THREE.Quaternion());
      const up = bodyUp(a);
      const side = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      const ahead = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      for (const [bone, k] of [[neck, 0.4], [head, neck ? 0.6 : 1]] as const) {
        if (!bone) continue;
        if (yaw) rotateBoneWorld(bone, new THREE.Quaternion().setFromAxisAngle(up, yaw * DEG * k));
        if (pitch) rotateBoneWorld(bone, new THREE.Quaternion().setFromAxisAngle(side, pitch * DEG * k));
        if (roll) rotateBoneWorld(bone, new THREE.Quaternion().setFromAxisAngle(ahead, roll * DEG * k));
      }
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
    // As a sigh goes out, the head dips with the body.
    if (sigh < 0) rotateBoneWorld(head, new THREE.Quaternion().setFromAxisAngle(side, LIFE_SIGH.headDipDeg * DEG * (-sigh / LIFE_SIGH.slump)));
  }
  a.frame.updateMatrixWorld(true);

  // 7. Arms: hanging (following the torso; out from the thigh round a held object), or reaching
  //    with the palm to a point short of a target, the fist to a grip, or a held object to its place;
  //    then the hand turned to the grip, the place, or to aim what it holds.
  const torsoYaw = twist * TURN_SHARE.slice(0, 4).reduce((s, [, w]) => s + w, 0);
  const torsoQ = bodyQ.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), torsoYaw));
  const bodyVec = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z).applyQuaternion(torsoQ);
  // Attending: now and then the hands come loosely together in front (both or neither).
  let clasp = 0;
  let claspOver: Side = 'right';
  if (attendK > 0) {
    const arms = attendArmsAt(c.attend!, t);
    if (arms.k > 0) {
      const free = Math.min(...SIDES.map((s) => (1 - busy(c.dirs, t, MASKED_BY.arms, s)) * (1 - busy(c.touched[s], t, { reach: 1 })) * (1 - (gripOf(c.spec.id, s, t)?.weight ?? 0))));
      clasp = arms.k * attendK * free;
      claspOver = arms.over;
    }
  }
  for (const s of SIDES) {
    // The wrist's rest offset from the shoulder, turned with the torso and the body.
    const local = armRestOffset(a, s);
    const held = gripOf(c.spec.id, s, t);
    if (held) local.x += (s === 'left' ? 1 : -1) * held.prop.halfWidth * held.weight;
    local.applyAxisAngle(new THREE.Vector3(0, 1, 0), torsoYaw);
    const rest = toWorld(a, local).sub(toWorld(a, new THREE.Vector3()));
    // A hanging hand that fidgets lifts a little (the elbow bends) while its fingers move.
    const fidget = life ? handFree(c, s, t, held?.weight ?? 0) * (1 - clasp) * fidgetAt(c.events, s, t) : 0;
    if (life) rest.addScaledVector(bodyUp(a), ARM_BREATH * Math.sin(breathT) + LIFE_FIDGET.lift * fidget);
    let w = 0;
    let goal: THREE.Vector3 | undefined;
    let palm: THREE.Vector3 | undefined;
    // How far the elbow takes the rig's reaching bend (out): less for a hand kept near the body.
    let elbowOut = 1;
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
    // Gestures (and attending's hands together), blended in the same way.
    const add = (g: THREE.Vector3, e: number, p: THREE.Vector3, elbow: number): void => {
      goal = goal ? goal.lerp(g, clamp01(e)) : g;
      w = goal === g ? e : Math.max(w, e);
      palm = palm ? palm.lerp(p, clamp01(e)).normalize() : p.clone();
      elbowOut = Math.min(elbowOut, lerp(1, elbow, clamp01(e)));
    };
    const out = s === 'left' ? 1 : -1;
    const L = a.arms[s].upperLength + a.arms[s].lowerLength;
    const inward = new THREE.Vector3(-out, 0, 0).applyQuaternion(bodyQ);
    for (const r of c.dirs) {
      const d = r.direction;
      if (d.kind !== 'gesture' || !(d.name === 'shrug' ? !held : GESTURES[d.name].hand && d.side === s)) continue;
      const e = env(r, t, flat);
      if (e === 0) continue;
      const k = d.strength ?? 1;
      const shoulder = a.arms[s].upperArm.getWorldPosition(new THREE.Vector3());
      if (d.name === 'shrug') {
        const [x, y, z] = GESTURE_HAND.shrug;
        add(shoulder.add(bodyVec(out * x * L, y * L, z * L)), e * Math.min(1, k), bodyUp(a), 0.3);
      } else if (d.name === 'wave') {
        const [x, y, z] = GESTURE_HAND.wave;
        const cyc = gestureCycle(d, r.attack)!;
        const tau = t - r.at - cyc.from;
        const swing = tau > 0 && tau < Math.min(cyc.count * cyc.cycle, r.attack + r.hold - cyc.from) ? Math.sin((2 * Math.PI * tau) / cyc.cycle) * WAVE_SWING * k : 0;
        const toward = d.at !== undefined ? pointOf(cast, c.spec, d.at).sub(shoulder).normalize() : bodyVec(0, 0, 1);
        add(shoulder.clone().add(bodyVec(out * (x * L + swing), y * L, z * L)), e, toward, 1);
      } else if (d.name === 'rub') {
        const [x, y, z] = GESTURE_HAND.rub;
        add(shoulder.add(bodyVec(out * x * L, y * L, z * L)), e, bodyUp(a).lerp(inward, 0.15).normalize(), 0.1);
      } else if (d.name === 'hand-to-chest') {
        const chest = (a.humanoid.bone('upperChest') ?? a.humanoid.bone('chest') ?? a.humanoid.bone('spine')!).getWorldPosition(new THREE.Vector3());
        add(chest.add(bodyVec(-out * CHEST_HAND.across, -CHEST_HAND.down, CHEST_HAND.forward)), e, bodyVec(0, 0, -1), 0.4);
      }
    }
    if (clasp > 0) {
      const hips = a.humanoid.bone('hips')!.getWorldPosition(new THREE.Vector3());
      const over = s === claspOver ? 0.02 : 0;
      add(hips.add(bodyVec(out * ATTEND_ARMS.apart * L / 2, ATTEND_ARMS.height * L, ATTEND_ARMS.forward * L + over)), clasp, inward, 0.25);
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
      const elbowHint = restElbowHint(a, s).lerp(a.arms[s].elbowHintLocal, clamp01(w) * elbowOut).normalize();
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
  if (flat) { moveHeld(cast, c, t); moveWorn(c); return; }

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
    // Gestures shape the hand: open for a shrug or a wave, flat on the chest, fingertips rubbing (the wrist rolling a little with them).
    let rubRoll = 0;
    for (const r of c.dirs) {
      const d = r.direction;
      if (d.kind !== 'gesture' || !(d.name === 'shrug' ? !held : GESTURES[d.name].hand && d.side === s)) continue;
      const e = clamp01(env(r, t, false));
      if (e === 0) continue;
      let target: HandPose = HAND_SHAPES.open;
      if (d.name === 'hand-to-chest') target = CHEST_PALM;
      else if (d.name === 'rub') {
        const cyc = gestureCycle(d, r.attack)!;
        const tau = t - r.at - cyc.from;
        const on = tau > 0 && tau < Math.min(cyc.count * cyc.cycle, r.attack + r.hold - cyc.from); // a shorter authored hold ends the repeats with it
        const u = on ? 0.5 - 0.5 * Math.cos((2 * Math.PI * tau) / cyc.cycle) : 0;
        const { low, high } = RUB_HAND;
        target = { curl: { thumb: lerp(low.thumb, high.thumb, u), index: lerp(low.index, high.index, u), middle: lerp(low.middle, high.middle, u), ring: RUB_HAND.ring, little: RUB_HAND.little }, spread: RUB_HAND.spread };
        if (on) rubRoll += Math.sin((2 * Math.PI * tau) / cyc.cycle) * RUB_ROLL_DEG * e * (d.strength ?? 1);
      }
      pose = blendPose(pose, target, e);
    }
    if (clasp > 0) pose = blendPose(pose, CLASP_HAND, clasp);
    if (rubRoll !== 0) {
      const forearm = a.arms[s].hand.getWorldPosition(new THREE.Vector3()).sub(a.arms[s].foreArm.getWorldPosition(new THREE.Vector3())).normalize();
      rotateBoneWorld(a.arms[s].hand, new THREE.Quaternion().setFromAxisAngle(forearm, rubRoll * DEG));
    }
    if (life) {
      const curl = { ...pose.curl } as Record<FingerName, number>;
      const still = 1 - 0.7 * (held?.weight ?? 0);
      // A hanging hand fidgets now and then: the fingers curl a little more one after another, and the forearm rolls.
      const free = handFree(c, s, t, held?.weight ?? 0) * (1 - clasp);
      FINGERS.forEach((finger, i) => {
        curl[finger] += still * 0.025 * Math.sin((2 * Math.PI * t) / (2.7 + i * 0.37) + phase + i * 1.3) + still * 0.012 * Math.sin((2 * Math.PI * t) / 1.1 + i);
        if (free > 0) curl[finger] += free * LIFE_FIDGET.curl * fidgetAt(c.events, s, t, FINGER_ORDER[finger] * LIFE_FIDGET.stagger);
      });
      pose = { curl, spread: pose.spread };
      const roll = free * fidgetAt(c.events, s, t);
      if (roll > 0) {
        const forearm = a.arms[s].hand.getWorldPosition(new THREE.Vector3()).sub(a.arms[s].foreArm.getWorldPosition(new THREE.Vector3())).normalize();
        rotateBoneWorld(a.arms[s].hand, new THREE.Quaternion().setFromAxisAngle(forearm, (s === 'left' ? 1 : -1) * LIFE_FIDGET.rollDeg * DEG * roll));
      }
    }
    hand.apply(pose);
  }
  a.frame.updateMatrixWorld(true);
  moveHeld(cast, c, t);
  moveWorn(c);

  // 9. Face: expressions summed, life's face under them, then blinks (always, and on a big look shift), then gaze.
  const weights: FaceWeights = {};
  for (const r of c.dirs) {
    const d = r.direction;
    if (d.kind !== 'expression') continue;
    const e = Math.max(0, env(r, t, flat)) * (d.strength ?? 1);
    const shape: Partial<Record<FaceChannel, number>> = typeof d.shape === 'string' ? FACE_MIXES[d.shape] : d.shape;
    for (const [k, v] of Object.entries(shape) as [FaceChannel, number][]) weights[k] = Math.min(1, (weights[k] ?? 0) + v * e);
  }
  // A state's face, and a shrug's.
  for (const r of c.dirs) {
    const d = r.direction;
    const shape = d.kind === 'state' ? STATE_FACES[d.name] : d.kind === 'gesture' && d.name === 'shrug' ? SHRUG_FACE : undefined;
    if (!shape || (d.kind !== 'state' && d.kind !== 'gesture')) continue;
    const e = Math.max(0, env(r, t, flat)) * (d.strength ?? 1);
    for (const [k, v] of Object.entries(shape) as [FaceChannel, number][]) weights[k] = Math.min(1, (weights[k] ?? 0) + v * e);
  }
  // A spoken line: its visemes over everything, and life's face gives way while it plays.
  let speaking = 0;
  for (const sp of c.speech) {
    const lt = t - sp.at;
    speaking = Math.max(speaking, speakingAt(sp.lips, lt));
    for (const [ch, v] of Object.entries(visemesAt(sp.lips, lt)) as [FaceChannel, number][]) weights[ch] = Math.min(1, Math.max(weights[ch] ?? 0, v));
  }
  if (life) {
    // Life's face (a sigh's mouth and brows, the mouth settling under a weight shift, a brow flash as a glance comes back), under any directed expression.
    const k = (1 - busy(c.dirs, t, MASKED_BY.face)) * (1 - speaking);
    if (k > 0) for (const [ch, v] of Object.entries(faceAt(c.events, t, glanceK)) as [FaceChannel, number][]) weights[ch] = Math.min(1, (weights[ch] ?? 0) + v * k);
  }
  const liveSample = life ? c.live.sample(t, dt, 0) : undefined;
  if (liveSample) {
    let blink = liveSample.weights.eyeBlinkLeft ?? 0;
    for (const r of c.dirs) if (r.direction.kind === 'look' && (r.direction.head ?? 0.6) > 0.3) blink = Math.max(blink, blinkAt(t - r.at + 0.02));
    // A glance that turns the head far brings a blink with it.
    if (glance?.onset !== undefined && glance.size * glanceK > GLANCE_BLINK_DEG) blink = Math.max(blink, blinkAt(t - glance.onset - 0.02));
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
  if (glance && glanceK > 0) {
    // The eyes lead a glance: where they look, from the body's facing, weighted in only while a glance is under way.
    const e = glance.eyes;
    const on = clamp01(Math.max(Math.abs(e.yaw), Math.abs(e.pitch)) / 3) * glanceK;
    if (on > 0) {
      const up = bodyUp(a);
      const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(bodyQ).applyAxisAngle(up, twist + e.yaw * DEG);
      const side = new THREE.Vector3().crossVectors(up, dir).normalize();
      dir.applyAxisAngle(side, -e.pitch * DEG);
      const from = a.humanoid.bone('head')!.getWorldPosition(new THREE.Vector3());
      const g = a.face.gazeTowardPoint(from.addScaledVector(dir, 3));
      if (g) gaze = mixGaze(gaze, g, on);
    }
  }
  if (liveSample) {
    // Saccades shrink to fixational jitter while the eyes hold a target or lead a glance.
    const glancing = glance && glanceK > 0 ? clamp01(Math.max(Math.abs(glance.eyes.yaw), Math.abs(glance.eyes.pitch)) / 3) * glanceK : 0;
    const k = (eyeTarget ? 1 - 0.7 * clamp01(eyeTarget.weight) : 1) * (1 - 0.7 * glancing);
    gaze = { left: { yaw: gaze.left.yaw + liveSample.gaze.left.yaw * k, pitch: gaze.left.pitch + liveSample.gaze.left.pitch * k }, right: { yaw: gaze.right.yaw + liveSample.gaze.right.yaw * k, pitch: gaze.right.pitch + liveSample.gaze.right.pitch * k } };
  }
  // An expression's eyeLook channels (looking down) turn the eyes on top of the gaze, since FaceRig.apply leaves them out of the morphs;
  // a look target the eyes hold wins over them, and the sum stays within the eyes' range (eye bones are not clamped).
  const looked = gazeFromArkit(weights);
  const free = eyeTarget ? 1 - clamp01(eyeTarget.weight) : 1;
  const turn = (g: { yaw: number; pitch: number }, l: { yaw: number; pitch: number }) => ({
    yaw: Math.max(-MAX_YAW, Math.min(MAX_YAW, g.yaw + l.yaw * free)),
    pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, g.pitch + l.pitch * free))
  });
  gaze = { left: turn(gaze.left, looked.left), right: turn(gaze.right, looked.right) };
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
  // A rub looks at its hand, a state or a wave with an `at` at that; a directed look, blended after, wins.
  const implied = (d: Direction): { p: THREE.Vector3; share: number } | undefined => {
    if (d.kind === 'gesture' && d.name === 'rub') { const p = c.seen.get(`${d.side ?? 'right'}Hand`); return p ? { p: p.clone(), share: 0.8 } : undefined; }
    if (d.kind === 'gesture' && d.name === 'wave' && d.at !== undefined) return { p: pointOf(cast, c.spec, d.at), share: 0.6 };
    if (d.kind === 'state' && d.at !== undefined) return { p: pointOf(cast, c.spec, d.at), share: STATE_POSE[d.name].head };
    return undefined;
  };
  const ordered = [...c.dirs.filter((r) => r.direction.kind !== 'look'), ...c.dirs.filter((r) => r.direction.kind === 'look')];
  for (const r of ordered) {
    const d = r.direction;
    const im = d.kind === 'look' ? undefined : implied(d);
    if (d.kind !== 'look' && !im) continue;
    // The eyes lead the head by a few frames and arrive faster.
    const e = by === 'eyes'
      ? env({ ...r, start: r.start - 0.06, at: r.at - 0.06, attack: Math.min(r.attack, 0.12), hold: r.hold + r.attack - Math.min(r.attack, 0.12) + 0.06 }, t, flat)
      : env(r, t, flat);
    if (e === 0) continue;
    const p = im ? im.p : pointOf(cast, c.spec, (d as Extract<Direction, { kind: 'look' }>).at);
    point = point ? point.lerp(p, clamp01(e)) : p;
    weight = point === p ? e : Math.max(weight, e);
    share = im ? im.share : (d as Extract<Direction, { kind: 'look' }>).head ?? 0.6;
  }
  return point ? { point, weight, share } : undefined;
}

/** How much attending life plays: the strongest `attendGate` over the other performers' heads off the upper body's facing, as last solved. */
function attendFacing(cast: Cast[], c: Cast, yaw: number): number {
  const me = c.seen.get('head') ?? c.a.frame.position;
  let k = 0;
  for (const o of cast) {
    if (o === c) continue;
    const h = o.seen.get('head') ?? new THREE.Vector3(o.spec.at[0], 0, o.spec.at[1]);
    const dx = h.x - me.x;
    const dz = h.z - me.z;
    if (dx * dx + dz * dz < 1e-6) continue;
    k = Math.max(k, attendGate(wrapDeg(Math.atan2(dx, dz) / DEG - yaw)));
  }
  return k;
}

function mixGaze(a: FaceGaze, b: FaceGaze, f: number): FaceGaze {
  return {
    left: { yaw: lerp(a.left.yaw, b.left.yaw, f), pitch: lerp(a.left.pitch, b.left.pitch, f) },
    right: { yaw: lerp(a.right.yaw, b.right.yaw, f), pitch: lerp(a.right.pitch, b.right.pitch, f) }
  };
}

/** How free a hand is for life's fidgets, 0 to 1: not directed, not holding, not being reached to. */
function handFree(c: Cast, s: Side, t: number, holding: number): number {
  return (1 - busy(c.dirs, t, MASKED_BY.hand, s)) * (1 - busy(c.touched[s], t, { reach: 1 })) * (1 - holding);
}

function blinkAt(u: number): number {
  if (u < 0) return 0;
  if (u < 0.07) return u / 0.07;
  if (u < 0.11) return 1;
  return u < 0.23 ? 1 - (u - 0.11) / 0.12 : 0;
}
