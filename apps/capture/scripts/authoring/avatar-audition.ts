/**
 * The audition: can this avatar act? It adds only what capture's binding
 * reports cannot say (they say whether bones, face channels and fingers
 * bind): how far each face channel moves the mesh, whether a fist and a
 * point close and open the hand, how far a reach lands from fixed targets,
 * and whether one turn drives parts through each other.
 *
 *   node --conditions=development --import tsx scripts/authoring/avatar-audition.ts <avatar.glb> [--json out.json]
 */
import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { FACE_CHANNELS, type FaceChannel } from '@holoim/avatar-face';
import type { VrmHumanoidBone } from '@holoim/meaning';

import { loadAvatar, resetPose, type LoadedAvatar, type Side } from './lib/avatar.ts';
import { FINGERS, shapePose, type FingerName } from './lib/hands.ts';
import { armRestOffset, bindAnkles, bodyUp, hangArm, moveBoneWorld, plantFeet, solveArm, toWorld, turnBody, TURN_SHARE } from './lib/pose.ts';
import { meshesOf, skin, type SkinnedSurface } from './lib/skin.ts';

/** Provisional bars, set on the stock avatar; a failing item names itself. */
export const BARS = {
  /** A face channel that moves the mesh less than this cannot be read. */
  faceMm: 1,
  /** Channels a performance cannot do without. */
  keyChannels: ['eyeBlinkLeft', 'eyeBlinkRight', 'jawOpen', 'mouthSmileLeft', 'mouthSmileRight', 'browInnerUp', 'mouthFrownLeft', 'mouthFrownRight', 'mouthPressLeft', 'mouthPressRight'] as FaceChannel[],
  /** Fist: every fingertip within this share of hand length of the palm. */
  fistReach: 0.45,
  /** Point: the index fingertip at least this far out, the others within `fistReach`. */
  pointReach: 0.6,
  /** A reachable target is missed by at most this much at the wrist. */
  reachMm: 10,
  /** A turn may add at most this share of a part's vertices passing deeper than `depthMm` into another. */
  turnShare: 0.005,
  depthMm: 5
} as const;

const NEUTRAL = { left: { yaw: 0, pitch: 0 }, right: { yaw: 0, pitch: 0 } };
const TURN_DEG = 75;

/** Targets for the right hand in units of standing height, body frame (+X the performer's left); the left hand mirrors them. */
const REACH_TARGETS: ReadonlyArray<{ name: string; at: readonly [number, number, number] }> = [
  { name: 'chest, forward', at: [-0.08, 0.72, 0.24] },
  { name: 'shoulder, forward', at: [-0.12, 0.82, 0.26] },
  { name: 'out to the side', at: [-0.34, 0.8, 0.04] },
  { name: 'overhead', at: [-0.1, 1.04, 0.06] },
  { name: 'across the body', at: [0.08, 0.66, 0.2] },
  { name: 'low, forward', at: [-0.1, 0.56, 0.16] },
  { name: 'out of reach', at: [-0.12, 0.8, 0.9] }
];

type Part = 'torso' | 'head' | 'armL' | 'armR' | 'legL' | 'legR';
const PAIRS: ReadonlyArray<readonly [Part, Part]> = [['armL', 'torso'], ['armR', 'torso'], ['armL', 'legL'], ['armR', 'legR'], ['legL', 'legR'], ['head', 'torso']];

export interface AuditionReport {
  readonly file: string;
  readonly height: number;
  readonly face: {
    readonly channels: { channel: FaceChannel; mm: number }[];
    readonly gaze: { by: string; mm: number };
    readonly still: FaceChannel[];
  };
  readonly hands: Record<Side, null | {
    readonly lengthMm: number;
    readonly fist: Record<FingerName, number | null>;
    readonly point: Record<FingerName, number | null>;
  }>;
  readonly reach: { side: Side; target: string; reachable: boolean; errorMm: number }[];
  readonly turn: { degrees: number; ankleSlipMm: number; pairs: { pair: string; vertices: number; stance: number; turn: number; maxDepthMm: number }[] };
  readonly fails: string[];
}

const mm = (m: number): number => Math.round(m * 10000) / 10;

function faceAudition(a: LoadedAvatar): AuditionReport['face'] {
  const meshes = meshesOf(a.scene).filter((m) => m.morphTargetInfluences?.length);
  const eyeMeshes = meshesOf(a.scene).filter((m) => /eye/i.test(m.name));
  const measure = (list: THREE.Mesh[], base: SkinnedSurface[]): number => {
    let max = 0;
    list.forEach((mesh, k) => {
      const now = skin(mesh).positions;
      const was = base[k]!.positions;
      for (let i = 0; i < now.length; i += 3) max = Math.max(max, Math.hypot(now[i]! - was[i]!, now[i + 1]! - was[i + 1]!, now[i + 2]! - was[i + 2]!));
    });
    return max;
  };
  resetPose(a);
  a.face.apply({}, NEUTRAL);
  a.frame.updateMatrixWorld(true);
  const base = meshes.map((m) => skin(m));
  const eyeBase = eyeMeshes.map((m) => skin(m));
  const channels = FACE_CHANNELS.filter((c) => !c.startsWith('eyeLook')).map((channel) => {
    a.face.apply({ [channel]: 1 }, NEUTRAL);
    return { channel, mm: mm(measure(meshes, base)) };
  });
  a.face.apply({}, { left: { yaw: 0.35, pitch: 0 }, right: { yaw: 0.35, pitch: 0 } });
  a.frame.updateMatrixWorld(true);
  const gaze = { by: a.face.gazeBy, mm: mm(Math.max(measure(eyeMeshes, eyeBase), measure(meshes, base))) };
  a.face.apply({}, NEUTRAL);
  return { channels, gaze, still: channels.filter((c) => c.mm < BARS.faceMm).map((c) => c.channel) };
}

function handAudition(a: LoadedAvatar, side: Side): AuditionReport['hands'][Side] {
  const hand = a.hands[side];
  if (!hand) return null;
  const read = (shape: 'fist' | 'point'): Record<FingerName, number | null> => {
    resetPose(a);
    hand.apply(shapePose(shape));
    a.frame.updateMatrixWorld(true);
    const palm = hand.palmCenter(new THREE.Vector3());
    const out = {} as Record<FingerName, number | null>;
    for (const f of FINGERS) {
      const tip = hand.tip(f, new THREE.Vector3());
      out[f] = tip ? mm(tip.distanceTo(palm)) : null;
    }
    return out;
  };
  return { lengthMm: mm(hand.length), fist: read('fist'), point: read('point') };
}

function reachAudition(a: LoadedAvatar): AuditionReport['reach'] {
  const out: AuditionReport['reach'] = [];
  for (const side of ['left', 'right'] as const) {
    const chain = a.arms[side];
    for (const t of REACH_TARGETS) {
      resetPose(a);
      const local = new THREE.Vector3(t.at[0] * (side === 'left' ? -1 : 1), t.at[1], t.at[2]).multiplyScalar(a.height);
      const target = toWorld(a, local);
      // In reach of the whole arm, clavicle included (the solver swings it out on a stretch).
      const clavicle = chain.shoulder.getWorldPosition(new THREE.Vector3());
      const shoulder = chain.upperArm.getWorldPosition(new THREE.Vector3());
      const reachable = clavicle.distanceTo(target) <= clavicle.distanceTo(shoulder) + chain.upperLength + chain.lowerLength - 0.01;
      solveArm(a, side, target);
      a.frame.updateMatrixWorld(true);
      const wrist = chain.hand.getWorldPosition(new THREE.Vector3());
      out.push({ side, target: t.name, reachable, errorMm: mm(wrist.distanceTo(target)) });
    }
  }
  return out;
}

function partOf(name: VrmHumanoidBone): Part {
  if (name === 'head' || name === 'jaw' || name.endsWith('Eye')) return 'head';
  const side = name.startsWith('left') ? 'L' : name.startsWith('right') ? 'R' : '';
  if (side && /UpperLeg|LowerLeg|Foot|Toes/.test(name)) return `leg${side}` as Part;
  if (side && /UpperArm|LowerArm|Hand|Thumb|Index|Middle|Ring|Little/.test(name)) return `arm${side}` as Part;
  return 'torso';
}

interface Cloud { readonly pos: number[]; readonly nrm: number[]; readonly grid: Map<string, number[]> }
const CELL = 0.03;
const key = (x: number, y: number, z: number): string => `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;

/** Vertices that belong wholly to one part (seams excluded), per part. */
function clouds(a: LoadedAvatar): Map<Part, Cloud> {
  const canonical = new Map<THREE.Object3D, Part>();
  for (const [name, b] of a.bind) canonical.set(b.bone, partOf(name));
  const partCache = new Map<THREE.Object3D, Part | null>();
  const part = (o: THREE.Object3D): Part | null => {
    if (partCache.has(o)) return partCache.get(o)!;
    let p: Part | null = null;
    for (let x: THREE.Object3D | null = o; x; x = x.parent) { const c = canonical.get(x); if (c) { p = c; break; } }
    partCache.set(o, p);
    return p;
  };
  a.frame.updateMatrixWorld(true);
  const out = new Map<Part, Cloud>();
  for (const mesh of meshesOf(a.scene)) {
    if (!(mesh as THREE.SkinnedMesh).isSkinnedMesh) continue;
    const s = skin(mesh);
    for (let i = 0; i < s.count; i += 1) {
      const totals = new Map<Part, number>();
      for (const [bone, w] of s.influences[i]!) { const p = part(bone); if (p) totals.set(p, (totals.get(p) ?? 0) + w); }
      let best: Part | null = null;
      let bestW = 0;
      for (const [p, w] of totals) if (w > bestW) { best = p; bestW = w; }
      if (!best || bestW < 0.98) continue;
      let c = out.get(best);
      if (!c) out.set(best, (c = { pos: [], nrm: [], grid: new Map() }));
      const at = c.pos.length / 3;
      c.pos.push(s.positions[i * 3]!, s.positions[i * 3 + 1]!, s.positions[i * 3 + 2]!);
      c.nrm.push(s.normals[i * 3]!, s.normals[i * 3 + 1]!, s.normals[i * 3 + 2]!);
      const k = key(s.positions[i * 3]!, s.positions[i * 3 + 1]!, s.positions[i * 3 + 2]!);
      const cell = c.grid.get(k);
      if (cell) cell.push(at); else c.grid.set(k, [at]);
    }
  }
  return out;
}

/** Vertices of `a` inside `b` (behind b's nearest surface, by its normal), deeper than `depthMm`. */
function inside(a: Cloud, b: Cloud): { count: number; maxDepth: number } {
  let count = 0;
  let maxDepth = 0;
  for (let i = 0; i < a.pos.length; i += 3) {
    const x = a.pos[i]!, y = a.pos[i + 1]!, z = a.pos[i + 2]!;
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL);
    let best = -1;
    let bestD = CELL * CELL;
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dz = -1; dz <= 1; dz += 1) {
      const cell = b.grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (!cell) continue;
      for (const j of cell) {
        const d = (b.pos[j * 3]! - x) ** 2 + (b.pos[j * 3 + 1]! - y) ** 2 + (b.pos[j * 3 + 2]! - z) ** 2;
        if (d < bestD) { bestD = d; best = j; }
      }
    }
    if (best === -1) continue;
    const depth = -((x - b.pos[best * 3]!) * b.nrm[best * 3]! + (y - b.pos[best * 3 + 1]!) * b.nrm[best * 3 + 1]! + (z - b.pos[best * 3 + 2]!) * b.nrm[best * 3 + 2]!);
    if (depth * 1000 > BARS.depthMm) { count += 1; maxDepth = Math.max(maxDepth, depth); }
  }
  return { count, maxDepth };
}

/** How far the hips sit below bind in the stance, as a share of leg length. */
export const STANCE_DROP = 0.02;

/** The stance every take starts from: feet planted at bind, arms hanging. */
export function stance(a: LoadedAvatar, yaw = 0): void {
  resetPose(a);
  if (yaw) turnBody(a, yaw);
  // Soft knees: the hips sit a little lower than a locked bind pose.
  const legLength = a.legs.left.thighLength + a.legs.left.shinLength;
  moveBoneWorld(a.humanoid.bone('hips')!, bodyUp(a).multiplyScalar(-STANCE_DROP * legLength));
  plantFeet(a, bindAnkles(a));
  const torsoYaw = yaw * TURN_SHARE.slice(0, 4).reduce((s, [, w]) => s + w, 0);
  const origin = toWorld(a, new THREE.Vector3());
  for (const side of ['left', 'right'] as const) hangArm(a, side, toWorld(a, armRestOffset(a, side).applyAxisAngle(new THREE.Vector3(0, 1, 0), torsoYaw)).sub(origin));
  for (const side of ['left', 'right'] as const) a.hands[side]?.apply(shapePose('relaxed'));
  a.frame.updateMatrixWorld(true);
}

/** Per pair of parts in the current pose: vertices of the first passing into the second. */
export function passThrough(a: LoadedAvatar): { pair: string; vertices: number; count: number; maxDepth: number }[] {
  const c = clouds(a);
  return PAIRS.map(([x, y]) => {
    const r = c.get(x) && c.get(y) ? inside(c.get(x)!, c.get(y)!) : { count: 0, maxDepth: 0 };
    return { pair: `${x} in ${y}`, vertices: (c.get(x)?.pos.length ?? 0) / 3, ...r };
  });
}

function turnAudition(a: LoadedAvatar): AuditionReport['turn'] {
  const ankles = bindAnkles(a);
  stance(a);
  const rest = passThrough(a);
  stance(a, THREE.MathUtils.degToRad(TURN_DEG));
  let slip = 0;
  for (const side of ['left', 'right'] as const) slip = Math.max(slip, a.legs[side].foot.bone.getWorldPosition(new THREE.Vector3()).distanceTo(ankles[side]));
  const pairs = passThrough(a).map((t, k) => ({ pair: t.pair, vertices: t.vertices, stance: rest[k]!.count, turn: t.count, maxDepthMm: mm(t.maxDepth) }));
  return { degrees: TURN_DEG, ankleSlipMm: mm(slip), pairs };
}

export async function audition(file: string): Promise<AuditionReport> {
  const a = await loadAvatar(file);
  const face = faceAudition(a);
  const hands = { left: handAudition(a, 'left'), right: handAudition(a, 'right') };
  const reach = reachAudition(a);
  const turn = turnAudition(a);
  resetPose(a);

  const fails: string[] = [];
  const stillKey = BARS.keyChannels.filter((c) => face.still.includes(c) || !face.channels.some((x) => x.channel === c));
  if (stillKey.length) fails.push(`face: ${stillKey.join(', ')} move the mesh less than ${BARS.faceMm} mm`);
  if (face.gaze.mm < BARS.faceMm) fails.push('face: nothing turns the eyes');
  for (const side of ['left', 'right'] as const) {
    const h = hands[side];
    if (!h) { fails.push(`hands: no ${side} finger bones`); continue; }
    const far = (r: Record<FingerName, number | null>, fingers: readonly FingerName[]) => fingers.filter((f) => r[f] === null || r[f]! > BARS.fistReach * h.lengthMm);
    const fist = far(h.fist, FINGERS);
    if (fist.length) fails.push(`hands: ${side} fist leaves ${fist.join(', ')} open`);
    const pointOut = (h.point.index ?? 0) >= BARS.pointReach * h.lengthMm;
    const pointRest = far(h.point, ['middle', 'ring', 'little']);
    if (!pointOut || pointRest.length) fails.push(`hands: ${side} point does not read (${!pointOut ? 'index not out' : `${pointRest.join(', ')} open`})`);
  }
  const missed = reach.filter((r) => r.reachable && r.errorMm > BARS.reachMm);
  if (missed.length) fails.push(`reach: ${missed.map((r) => `${r.side} ${r.target} by ${r.errorMm} mm`).join(', ')}`);
  for (const p of turn.pairs) {
    const added = p.turn - p.stance;
    if (p.vertices && added > BARS.turnShare * p.vertices) fails.push(`turn: ${p.pair} by ${added} vertices (up to ${p.maxDepthMm} mm)`);
  }
  if (turn.ankleSlipMm > 10) fails.push(`turn: feet slip ${turn.ankleSlipMm} mm`);
  return { file: basename(file), height: Math.round(a.height * 1000) / 1000, face, hands, reach, turn, fails };
}

export function summarizeAudition(r: AuditionReport): string {
  const moving = r.face.channels.filter((c) => c.mm >= BARS.faceMm);
  const strongest = [...moving].sort((x, y) => y.mm - x.mm).slice(0, 4).map((c) => `${c.channel} ${c.mm}`);
  const lines = [
    `${r.file}: ${r.height} m tall | ${r.fails.length ? `${r.fails.length} audition item(s) fail` : 'passes the audition'}`,
    `  face: ${moving.length}/${r.face.channels.length} channels move the mesh ≥ ${BARS.faceMm} mm (most: ${strongest.join(', ') || 'none'} mm); gaze by ${r.face.gaze.by}, ${r.face.gaze.mm} mm at 20°`
  ];
  if (r.face.still.length) lines.push(`  face: ${r.face.still.join(', ')} move the mesh less than ${BARS.faceMm} mm`);
  for (const side of ['left', 'right'] as const) {
    const h = r.hands[side];
    if (!h) { lines.push(`  ${side} hand: no finger bones`); continue; }
    const max = (o: Record<string, number | null>, ks: readonly string[]) => Math.max(...ks.map((k) => o[k] ?? Infinity));
    lines.push(`  ${side} hand (${h.lengthMm} mm): fist fingertips ≤ ${max(h.fist, FINGERS)} mm from the palm; point index ${h.point.index} mm out, others ≤ ${max(h.point, ['middle', 'ring', 'little'])} mm`);
  }
  const reachable = r.reach.filter((x) => x.reachable);
  lines.push(`  reach: ${reachable.length}/${r.reach.length} targets in reach, worst miss ${Math.max(0, ...reachable.map((x) => x.errorMm))} mm`);
  lines.push(`  turn ${r.turn.degrees}°: ${r.turn.pairs.map((p) => `${p.pair} ${p.stance}→${p.turn}`).join(', ')}; feet slip ${r.turn.ankleSlipMm} mm`);
  for (const f of r.fails) lines.push(`  FAIL ${f}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf('--json');
  const jsonOut = i === -1 ? undefined : args.splice(i, 2)[1];
  const file = args[0];
  if (!file) {
    console.error('usage: avatar-audition.ts <avatar.glb> [--json <out.json>]');
    process.exit(2);
  }
  const report = await audition(file);
  console.log(summarizeAudition(report));
  if (jsonOut) await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
