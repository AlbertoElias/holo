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
import { EXPRESSIONS, envelope, resolveTiming, validateSheet, type BeatSheet, type Direction, type PerformerSpec, type Point, type Resolved, type Side } from './beats.ts';
import { FINGERS, HAND_SHAPES, blendPose, shapePose, type FingerName, type HandPose } from './hands.ts';
import { armRestTarget, bodyUp, moveBoneWorld, plantFeet, rotateBoneWorld, solveArm, toWorld, turnBody, TURN_SHARE, yawAboutHips } from './pose.ts';

const SIDES = ['left', 'right'] as const;
const DEG = Math.PI / 180;
const STANCE_DROP = 0.02;
const WEIGHT_SHIFT = 0.06;
const STEP_LIFT = 0.06;
const ROOT_LAG = 0.18;
const FINGER_STAGGER = 0.03;
const FINGER_ORDER: Readonly<Record<FingerName, number>> = { index: 0, middle: 1, ring: 2, little: 3, thumb: 1.5 };

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
  /** Palm-to-target distance at the middle of each reach's hold, by beat id. */
  readonly reaches: { beat: string; side: Side; targetDistance: number; stopShort: number }[];
}

export interface SolvedTake {
  readonly sheet: BeatSheet;
  readonly fps: number;
  readonly times: Float32Array;
  readonly tracks: PerformerTrack[];
}

interface Cast {
  readonly spec: PerformerSpec;
  readonly a: LoadedAvatar;
  readonly live: LivenessFace;
  readonly seed: number;
  readonly dirs: Resolved[];
  /** Turn degrees per `toward` turn, fixed at setup. */
  readonly turnDeg: Map<Resolved, number>;
  /** Step offsets in stage space, fixed at setup. */
  readonly stepWorld: Map<Resolved, THREE.Vector3>;
  readonly ankles0: Record<Side, THREE.Vector3>;
  readonly feetMid0: THREE.Vector3;
  /** World positions of humanoid bones after the latest solve, for other performers to look and reach at. */
  readonly seen: Map<VrmHumanoidBone, THREE.Vector3>;
  readonly morphing: { node: THREE.Object3D; meshes: THREE.Mesh[] }[];
}

const yawQuat = (deg: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), deg * DEG);

export function solveTake(sheet: BeatSheet, avatars: Map<string, LoadedAvatar>): SolvedTake {
  const problems = validateSheet(sheet);
  if (problems.length) throw new Error(`beat sheet: ${problems.join('; ')}`);
  markTable.clear();
  for (const [k, v] of Object.entries(sheet.marks ?? {})) markTable.set(k, new THREE.Vector3(v[0], v[1], v[2]));
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
      turnDeg: new Map(), stepWorld: new Map(), ankles0,
      feetMid0: ankles0.left.clone().add(ankles0.right).multiplyScalar(0.5),
      seen: new Map(), morphing
    };
  });
  for (const c of cast) see(c);

  // Persistent directions, fixed once from where the performer is when each begins.
  for (const c of cast) {
    let yaw = c.spec.facing;
    for (const r of c.dirs) {
      const d = r.direction;
      if (d.kind === 'turn' && d.body === 'whole') {
        let deg = d.degrees ?? 0;
        if (d.toward !== undefined) {
          const from = rootPositionAt(c, r.start);
          const to = pointOf(cast, c.spec, d.toward);
          const want = Math.atan2(to.x - from.x, to.z - from.z) / DEG;
          deg = ((want - yaw + 540) % 360) - 180;
        }
        c.turnDeg.set(r, deg);
        yaw += deg;
      } else if (d.kind === 'turn' && d.toward !== undefined) {
        const from = rootPositionAt(c, r.start);
        const to = pointOf(cast, c.spec, d.toward);
        c.turnDeg.set(r, ((Math.atan2(to.x - from.x, to.z - from.z) / DEG - yaw + 540) % 360) - 180);
      } else if (d.kind === 'step') {
        c.stepWorld.set(r, new THREE.Vector3(d.by[0], 0, d.by[1]).applyQuaternion(yawQuat(yaw)));
      }
    }
  }

  const tracks: PerformerTrack[] = cast.map((c) => {
    const rotations = new Map<THREE.Object3D, Float32Array>();
    const translations = new Map<THREE.Object3D, Float32Array>();
    for (const o of c.a.rest.keys()) { rotations.set(o, new Float32Array(frames * 4)); translations.set(o, new Float32Array(frames * 3)); }
    const weights = new Map(c.morphing.map((m) => [m.node, { targets: m.meshes[0]!.morphTargetInfluences!.length, values: new Float32Array(frames * m.meshes[0]!.morphTargetInfluences!.length), meshes: m.meshes }]));
    return { spec: c.spec, avatar: c.a, rotations, translations, weights, root: { position: new Float32Array(frames * 3), rotation: new Float32Array(frames * 4) }, reaches: [] };
  });

  // Reaches are measured at the middle of their hold.
  const reachChecks = new Map<number, { c: number; r: Resolved }[]>();
  cast.forEach((c, ci) => c.dirs.forEach((r) => {
    if (r.direction.kind !== 'reach') return;
    const f = Math.round((r.at + r.attack + r.hold / 2) * fps);
    if (f < frames) reachChecks.set(f, [...(reachChecks.get(f) ?? []), { c: ci, r }]);
  }));

  for (let f = 0; f < frames; f += 1) {
    const t = times[f]!;
    cast.forEach((c, ci) => {
      solveFrame(cast, c, t, 1 / fps, life, flat);
      const tr = tracks[ci]!;
      for (const [o, arr] of tr.rotations) o.quaternion.toArray(arr, f * 4);
      for (const [o, arr] of tr.translations) o.position.toArray(arr, f * 3);
      for (const [, w] of tr.weights) w.values.set(w.meshes[0]!.morphTargetInfluences!, f * w.targets);
      c.a.frame.position.toArray(tr.root.position, f * 3);
      c.a.frame.quaternion.toArray(tr.root.rotation, f * 4);
      see(c);
    });
    for (const { c, r } of reachChecks.get(f) ?? []) {
      const d = r.direction as Extract<Direction, { kind: 'reach' }>;
      const target = pointOf(cast, cast[c]!.spec, d.at);
      const palm = cast[c]!.a.hands[d.side]?.palmCenter(new THREE.Vector3()) ?? cast[c]!.a.arms[d.side].hand.getWorldPosition(new THREE.Vector3());
      tracks[c]!.reaches.push({ beat: r.beat.id, side: d.side, targetDistance: Math.round(palm.distanceTo(target) * 10000) / 10000, stopShort: d.stopShort });
    }
  }
  return { sheet, fps, times, tracks };
}

function see(c: Cast): void {
  c.a.frame.updateMatrixWorld(true);
  for (const [name, b] of c.a.bind) c.seen.set(name, b.bone.getWorldPosition(c.seen.get(name) ?? new THREE.Vector3()));
}

// Marks of the sheet being solved, set at the start of `solveTake`.
const markTable = new Map<string, THREE.Vector3>();

function pointOf(cast: Cast[], self: PerformerSpec, p: Point): THREE.Vector3 {
  if (typeof p !== 'string') return new THREE.Vector3(p[0], p[1], p[2]);
  const [who, bone] = p.split('.');
  if (bone === undefined) {
    const m = markTable.get(p);
    if (!m) throw new Error(`no mark ${p}`);
    return m.clone();
  }
  const at = cast.find((c) => c.spec.id === who)?.seen.get(bone as VrmHumanoidBone);
  if (!at) throw new Error(`${self.id}: cannot find ${p}`);
  return at.clone();
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

function solveFrame(cast: Cast[], c: Cast, t: number, dt: number, life: boolean, flat: boolean): void {
  const a = c.a;
  resetPose(a);
  const phase = c.seed * 1.618;

  // 1. Root: stage position and yaw; the root lags whole turns (the upper body leads).
  let rootYaw = c.spec.facing;
  let leadYaw = c.spec.facing;
  for (const r of c.dirs) {
    if (r.direction.kind !== 'turn') continue;
    const deg = r.direction.degrees ?? c.turnDeg.get(r) ?? 0;
    const turnDeg = c.turnDeg.get(r) ?? deg;
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
    if (d.kind !== 'step') continue;
    const by = c.stepWorld.get(r)!;
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
  const pivot = rootPositionAt(c, t).add(c.feetMid0).sub(new THREE.Vector3(c.spec.at[0], 0, c.spec.at[1]));
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
    hipsLocal.x += 0.004 * Math.sin((2 * Math.PI * t) / 7.3 + phase);
    hipsLocal.z += 0.003 * Math.sin((2 * Math.PI * t) / 9.1 + phase * 2);
  }
  const hips = a.humanoid.bone('hips')!;
  const bodyQ = a.body.getWorldQuaternion(new THREE.Quaternion());
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
    for (const [name, deg] of [['spine', 0.5], ['chest', 0.9], ['upperChest', 0.6]] as const) {
      const b = a.humanoid.bone(name);
      if (b) rotateBoneWorld(b, new THREE.Quaternion().setFromAxisAngle(right, -deg * DEG * inhale));
    }
    for (const s of SIDES) {
      const b = a.humanoid.bone(`${s}Shoulder`);
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(bodyQ);
      if (b) rotateBoneWorld(b, new THREE.Quaternion().setFromAxisAngle(fwd, (s === 'left' ? -1 : 1) * 0.8 * DEG * (inhale + 1) / 2));
    }
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
  a.frame.updateMatrixWorld(true);

  // 7. Arms: hanging (following the torso), or reaching with the palm to a point short of a target.
  const torsoYaw = twist * TURN_SHARE.slice(0, 4).reduce((s, [, w]) => s + w, 0);
  for (const s of SIDES) {
    const rest = toWorld(a, yawAboutHips(a, armRestTarget(a, s), torsoYaw).add(hipsLocal));
    if (life) rest.addScaledVector(bodyUp(a), 0.004 * Math.sin(breathT));
    const reaches = c.dirs.filter((r) => r.direction.kind === 'reach' && r.direction.side === s);
    let w = 0;
    let goal: THREE.Vector3 | undefined;
    let palm: THREE.Vector3 | undefined;
    for (const r of reaches) {
      const e = env(r, t, flat);
      if (e === 0) continue;
      const d = r.direction as Extract<Direction, { kind: 'reach' }>;
      const target = pointOf(cast, c.spec, d.at);
      const shoulder = a.arms[s].upperArm.getWorldPosition(new THREE.Vector3());
      const g = target.clone().addScaledVector(target.clone().sub(shoulder).normalize(), -d.stopShort);
      goal = goal ? goal.lerp(g, clamp01(e)) : g;
      w = goal === g ? e : Math.max(w, e);
      const up = bodyUp(a);
      const towards = target.clone().sub(shoulder).normalize();
      const p = d.palm === 'up' ? up : d.palm === 'down' ? up.clone().negate() : d.palm === 'in' ? new THREE.Vector3(s === 'left' ? -1 : 1, 0, 0).applyQuaternion(bodyQ) : towards;
      palm = palm ? palm.lerp(p, clamp01(e)).normalize() : p.clone();
    }
    solveArm(a, s, rest);
    a.frame.updateMatrixWorld(true);
    const hand = a.hands[s];
    if (goal && w !== 0) {
      const restPalm = hand ? hand.palmCenter(new THREE.Vector3()) : a.arms[s].hand.getWorldPosition(new THREE.Vector3());
      const restNormal = hand ? hand.palmNormal(new THREE.Vector3()) : bodyUp(a).negate();
      const point = restPalm.clone().lerp(goal, w);
      // A little outward and forward on the way, so the hand clears the thigh.
      const arc = Math.sin(Math.PI * clamp01(w));
      if (!flat) point.addScaledVector(new THREE.Vector3(s === 'left' ? 1 : -1, 0, 0.6).applyQuaternion(bodyQ), 0.04 * arc);
      const toward = restNormal.clone().lerp(palm!, clamp01(w)).normalize();
      const wrist = point.clone();
      const at = new THREE.Vector3();
      for (let i = 0; i < 6; i += 1) {
        solveArm(a, s, wrist, { palmToward: toward, wristBend: flat ? 0 : 0.35 * clamp01(w) });
        a.frame.updateMatrixWorld(true);
        if (hand) hand.palmCenter(at); else a.arms[s].hand.getWorldPosition(at);
        const err = point.clone().sub(at);
        if (err.length() < 5e-4) break;
        wrist.add(err);
      }
    }
  }

  // A flat take stops here: bind fingers, a still face, eyes fixed in the head.
  if (flat) return;

  // 8. Hands: relaxed, opened by a reach, shaped by hand directions (fingers arrive one after another).
  for (const s of SIDES) {
    const hand = a.hands[s];
    if (!hand) continue;
    const reachW = Math.max(0, ...c.dirs.filter((r) => r.direction.kind === 'reach' && r.direction.side === s).map((r) => env(r, t, false)));
    let pose: HandPose = blendPose(HAND_SHAPES.relaxed, HAND_SHAPES.reach, clamp01(reachW) * 0.8);
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
      FINGERS.forEach((finger, i) => { curl[finger] += 0.025 * Math.sin((2 * Math.PI * t) / (2.7 + i * 0.37) + phase + i * 1.3) + 0.012 * Math.sin((2 * Math.PI * t) / 1.1 + i); });
      pose = { curl, spread: pose.spread };
    }
    hand.apply(pose);
  }
  a.frame.updateMatrixWorld(true);

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
