/**
 * Edits on an imported take, by beat (slice 4a): retime a section, lengthen a
 * hold, redirect a look. Each edit names a span of the take's own time
 * (seconds, or one of its beats by id); everything outside the edited spans is
 * the recording, frame for frame, shifted by whatever the edits before it add.
 *
 * - `retime` plays [from, to] over `duration` seconds.
 * - `hold` stops the take at `at` for `add` seconds; with `life` (default
 *   true) the hold is filled by the life of `lib/life.ts`: glances, a sigh,
 *   breath and blinks, eased in and out so the hold joins the recording with
 *   no pop. Weight shifts are left out: they move the hips, and with the legs'
 *   rotations copied from the recording the feet would slide.
 * - `look` turns the head (and the neck, a little of the chest, and the eyes
 *   fully) toward a direction over [from, to], eased in and out over `ease`
 *   seconds, on top of whatever the recording does there.
 */
import * as THREE from 'three';
import type { FaceChannel } from '@holoim/avatar-face';
import type { VrmHumanoidBone } from '@holoim/meaning';

import { faceAt, GLANCE_HEAD_SHARE, glanceAt, LIFE_SIGH, lifeSchedule, sighAt } from './life.ts';
import { findBeats, quatAt, vecAt, type Take } from './take.ts';

export type Edit =
  | { readonly kind: 'retime'; readonly beat?: string; readonly from?: number; readonly to?: number; readonly duration: number }
  | { readonly kind: 'hold'; readonly beat?: string; readonly at?: number; readonly add: number; readonly life?: boolean }
  | { readonly kind: 'look'; readonly beat?: string; readonly from?: number; readonly to?: number; readonly yaw: number; readonly pitch?: number; readonly ease?: number };

export interface EditFile {
  /** The take to edit: an imported `.take.json` or a recorded GLB, relative to the edit file. */
  readonly take: string;
  /** What the edit is meant to read as, for the reader check. */
  readonly intent?: string;
  /** Seeds the life in lengthened holds. */
  readonly seed?: number;
  readonly edits: readonly Edit[];
}

/** One piece of the time map: output [outFrom, outTo) plays source [srcFrom, srcTo] linearly (a hold has srcFrom = srcTo). */
export interface TimePiece { readonly outFrom: number; readonly outTo: number; readonly srcFrom: number; readonly srcTo: number; readonly edit?: number }

export interface EditReport {
  readonly pieces: TimePiece[];
  readonly duration: { readonly source: number; readonly edited: number };
  /** Output frames outside every edited span, and the largest bone rotation, hips and face difference from the recording there. */
  readonly untouched: { readonly frames: number; /** Untouched frames whose source time falls between recorded frames (each a failure). */ readonly offGrid: number; readonly maxBoneDeg: number; readonly maxHipsMm: number; readonly maxFace: number };
  /** Per look edit: the head's yaw and pitch asked and reached at the middle of its span, degrees. */
  readonly looks: { readonly edit: number; readonly asked: { yaw: number; pitch: number }; readonly reached: { yaw: number; pitch: number }; readonly before: { yaw: number; pitch: number } }[];
  /** Per hold edit: the life events that fall in it. */
  readonly holds: { readonly edit: number; readonly at: number; readonly add: number; readonly glances: number; readonly sighs: number; readonly blinks: number }[];
}

const DEG = Math.PI / 180;
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smoother = (u: number): number => { const x = clamp01(u); return x * x * x * (x * (x * 6 - 15) + 10); };
const round = (v: number, places = 4): number => Number(v.toFixed(places));

function spanOf(take: Take, e: { beat?: string; from?: number; to?: number }): [number, number] {
  if (e.beat) {
    const b = take.beats.find((x) => x.id === e.beat);
    if (!b) throw new Error(`no beat ${e.beat} in ${take.source.file} (beats: ${take.beats.map((x) => x.id).join(', ')})`);
    return [b.from, b.to];
  }
  if (e.from === undefined || e.to === undefined || e.to <= e.from) throw new Error(`an edit needs a beat or from < to: ${JSON.stringify(e)}`);
  return [e.from, e.to];
}

/** Snaps a duration to whole frames, so the recording after an edit lands on its own frames. */
const snap = (v: number, fps: number): number => Math.round(v * fps) / fps;

/** The time map from the edits that change time (retime, hold), in source order. */
export function timeMap(take: Take, edits: readonly Edit[]): TimePiece[] {
  const fps = take.fps;
  const cuts = edits.flatMap((e, i) => {
    if (e.kind === 'retime') { const [a, b] = spanOf(take, e); return [{ i, from: snap(a, fps), to: snap(b, fps), out: snap(e.duration, fps) }]; }
    if (e.kind === 'hold') { const at = snap(e.beat ? (() => { const [a, b] = spanOf(take, e); return (a + b) / 2; })() : e.at ?? NaN, fps); if (!Number.isFinite(at)) throw new Error('a hold needs a beat or at'); return [{ i, from: at, to: at, out: snap(e.add, fps) }]; }
    return [];
  }).sort((x, y) => x.from - y.from || x.to - y.to);
  for (let k = 1; k < cuts.length; k += 1) if (cuts[k]!.from < cuts[k - 1]!.to) throw new Error(`edits ${cuts[k - 1]!.i + 1} and ${cuts[k]!.i + 1} overlap`);
  const pieces: TimePiece[] = [];
  let src = 0;
  let out = 0;
  for (const c of cuts) {
    if (c.from > src) { pieces.push({ outFrom: out, outTo: out + c.from - src, srcFrom: src, srcTo: c.from }); out += c.from - src; }
    pieces.push({ outFrom: out, outTo: out + c.out, srcFrom: c.from, srcTo: c.to, edit: c.i });
    out += c.out;
    src = c.to;
  }
  if (src < take.duration) pieces.push({ outFrom: out, outTo: out + take.duration - src, srcFrom: src, srcTo: take.duration });
  return pieces;
}

function sourceTime(pieces: TimePiece[], t: number): { src: number; piece: TimePiece } {
  const piece = pieces.find((p) => t < p.outTo - 1e-9) ?? pieces[pieces.length - 1]!;
  const u = piece.outTo > piece.outFrom ? (t - piece.outFrom) / (piece.outTo - piece.outFrom) : 0;
  return { src: piece.srcFrom + (piece.srcTo - piece.srcFrom) * clamp01(u), piece };
}

/** Rotation that turns +Z toward yaw/pitch (degrees; yaw + left, pitch + up). */
const aimQuat = (yaw: number, pitch: number): THREE.Quaternion => new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch * DEG, yaw * DEG, 0, 'YXZ'));

/** How much of a look each bone carries, so the head arrives at the asked direction and the eyes on it. */
const LOOK_SHARE: ReadonlyArray<readonly [VrmHumanoidBone, number]> = [['upperChest', 0.1], ['neck', 0.35], ['head', 1], ['leftEye', 1], ['rightEye', 1]];
/** Breath in a lengthened hold: degrees of pitch per spine bone at full inhale, and the cycle. */
const HOLD_BREATH: ReadonlyArray<readonly [VrmHumanoidBone, number]> = [['spine', 1.2], ['chest', 2], ['upperChest', 1.3]];
const BREATH_PERIOD = 4.2;
/** Life eases in and out of a hold over this long, seconds. */
const HOLD_EASE = 0.35;
/** A blink in a hold: one every this long (seconds), closing over `BLINK_SEC`. */
const BLINK_EVERY = 2.6;
const BLINK_SEC = 0.16;

export function applyEdits(take: Take, file: EditFile): { take: Take; report: EditReport } {
  const fps = take.fps;
  const pieces = timeMap(take, file.edits);
  const duration = pieces[pieces.length - 1]!.outTo;
  const frames = Math.round(duration * fps) + 1;
  const seed = file.seed ?? 7;

  const bones: Partial<Record<VrmHumanoidBone, number[]>> = {};
  for (const b of Object.keys(take.bones) as VrmHumanoidBone[]) bones[b] = [];
  const hips: number[] = [];
  const face: Partial<Record<FaceChannel, number[]>> = {};
  for (const c of Object.keys(take.face) as FaceChannel[]) face[c] = [];
  const joints: Take['joints'] = {};
  for (const j of Object.keys(take.joints) as (keyof Take['joints'])[]) joints[j] = [];

  const qa = new THREE.Quaternion(); const qb = new THREE.Quaternion();
  const va = new THREE.Vector3(); const vb = new THREE.Vector3();
  // A source time within a thousandth of a frame of a recorded frame is that frame (durations are rounded).
  const frameAt = (s: number): number => { const x = s * fps; const k = Math.round(x); return Math.min(take.frames - 1, Math.max(0, Math.abs(x - k) < 1e-3 ? k : x)); };
  const sampleQ = (track: number[], s: number, out: THREE.Quaternion): THREE.Quaternion => {
    const x = frameAt(s); const f = Math.floor(x); const k = x - f;
    quatAt(track, f, out);
    return k > 1e-6 && f + 1 < take.frames ? out.slerp(quatAt(track, f + 1, qb), k) : out;
  };
  const sampleV = (track: number[], s: number, out: THREE.Vector3): THREE.Vector3 => {
    const x = frameAt(s); const f = Math.floor(x); const k = x - f;
    vecAt(track, f, out);
    return k > 1e-6 && f + 1 < take.frames ? out.lerp(vecAt(track, f + 1, vb), k) : out;
  };
  const sampleS = (track: number[], s: number): number => {
    const x = frameAt(s); const f = Math.floor(x); const k = x - f;
    return f + 1 < take.frames ? track[f]! * (1 - k) + track[f + 1]! * k : track[f]!;
  };

  const looks = file.edits.flatMap((e, i) => (e.kind === 'look' ? [{ i, e, span: spanOf(take, e) }] : []));
  const holdLife = new Map<number, ReturnType<typeof lifeSchedule>>();
  file.edits.forEach((e, i) => { if (e.kind === 'hold' && e.life !== false) holdLife.set(i, lifeSchedule(seed + i, e.add + 1)); });
  const holdEvents = new Map<number, { glances: Set<number>; sighs: Set<number>; blinks: Set<number> }>();
  file.edits.forEach((e, i) => { if (e.kind === 'hold') holdEvents.set(i, { glances: new Set(), sighs: new Set(), blinks: new Set() }); });

  // Per-frame: bone pre-rotations in the body frame (look, life), on top of the sampled take.
  const pre = new Map<VrmHumanoidBone, THREE.Quaternion>();
  const add = (bone: VrmHumanoidBone, q: THREE.Quaternion): void => { const cur = pre.get(bone); pre.set(bone, cur ? q.clone().multiply(cur) : q.clone()); };
  for (let f = 0; f < frames; f += 1) {
    const t = f / fps;
    const { src, piece } = sourceTime(pieces, t);
    pre.clear();
    const faceAdd: Partial<Record<FaceChannel, number>> = {};

    // Look: toward the asked direction from wherever the recorded head points, by share, eased.
    for (const { e, span } of looks) {
      const ease = e.ease ?? 0.45;
      const w = Math.min(smoother((src - span[0]) / ease), smoother((span[1] - src) / ease));
      if (w <= 0) continue;
      const head = sampleQ(take.bones.head!, src, qa);
      const now = new THREE.Vector3(0, 0, 1).applyQuaternion(head);
      const want = new THREE.Vector3(0, 0, 1).applyQuaternion(aimQuat(e.yaw, e.pitch ?? 0));
      const full = new THREE.Quaternion().setFromUnitVectors(now, want);
      let carried = 0;
      for (const [bone, share] of LOOK_SHARE) {
        if (!take.bones[bone]) continue;
        // Each bone's share is its own world turn: a child's world rotation is independent of its parent's here.
        const k = bone === 'neck' || bone === 'upperChest' ? share : 1;
        add(bone, new THREE.Quaternion().slerp(full, w * k));
        carried = Math.max(carried, k);
      }
    }

    // Hold life: glances, a sigh, breath and blinks from the hold's own schedule, eased at its edges.
    if (piece.edit !== undefined && holdLife.has(piece.edit)) {
      const life = holdLife.get(piece.edit)!;
      const u = t - piece.outFrom;
      const len = piece.outTo - piece.outFrom;
      const k = Math.min(smoother(u / HOLD_EASE), smoother((len - u) / HOLD_EASE));
      const ev = holdEvents.get(piece.edit)!;
      const g = glanceAt(life, u);
      if (g.onset !== undefined && Math.abs(g.head.yaw) + Math.abs(g.head.pitch) > 0.5) ev.glances.add(g.onset);
      const headTurn = aimQuat(g.head.yaw * k, g.head.pitch * k);
      add('neck', new THREE.Quaternion().slerp(headTurn, 0.4));
      add('head', headTurn);
      const eyeTurn = aimQuat(g.eyes.yaw * k, g.eyes.pitch * k);
      add('leftEye', eyeTurn); add('rightEye', eyeTurn);
      const sigh = sighAt(life, u) * k;
      for (const p of life.sighs) if (p.at < u) ev.sighs.add(p.at);
      if (sigh !== 0) {
        add('leftShoulder', new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), LIFE_SIGH.shoulderDeg * DEG * sigh));
        add('rightShoulder', new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -LIFE_SIGH.shoulderDeg * DEG * sigh));
        add('upperChest', new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -LIFE_SIGH.chestDeg * DEG * sigh));
      }
      const breath = 0.5 - 0.5 * Math.cos((2 * Math.PI * u) / BREATH_PERIOD);
      for (const [bone, deg] of HOLD_BREATH) add(bone, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -deg * DEG * breath * k));
      for (const [c, v] of Object.entries(faceAt(life, u)) as [FaceChannel, number][]) faceAdd[c] = (faceAdd[c] ?? 0) + v * k;
      // Blinks: the recording's face stops with the hold, so the hold blinks on its own clock.
      const phase = (u + BLINK_EVERY * 0.5) % BLINK_EVERY;
      if (len > BLINK_EVERY * 0.6 && phase < BLINK_SEC && u > HOLD_EASE && len - u > HOLD_EASE) {
        ev.blinks.add(Math.floor((u + BLINK_EVERY * 0.5) / BLINK_EVERY));
        const b = Math.sin((Math.PI * phase) / BLINK_SEC);
        faceAdd.eyeBlinkLeft = Math.max(faceAdd.eyeBlinkLeft ?? 0, b);
        faceAdd.eyeBlinkRight = Math.max(faceAdd.eyeBlinkRight ?? 0, b);
      }
    }

    for (const [b, track] of Object.entries(take.bones) as [VrmHumanoidBone, number[]][]) {
      const q = sampleQ(track, src, qa);
      const p = pre.get(b);
      if (p) q.premultiply(p);
      bones[b]!.push(round(q.x, 5), round(q.y, 5), round(q.z, 5), round(q.w, 5));
    }
    sampleV(take.hips, src, va);
    hips.push(round(va.x, 5), round(va.y, 5), round(va.z, 5));
    for (const [c, track] of Object.entries(take.face) as [FaceChannel, number[]][]) {
      const v = sampleS(track, src);
      face[c]!.push(round(c in faceAdd ? Math.min(1, Math.max(v, (faceAdd[c] ?? 0) + (c.startsWith('eyeBlink') ? 0 : v))) : v, 4));
    }
    for (const [j, track] of Object.entries(take.joints) as [keyof Take['joints'], number[]][]) {
      sampleV(track, src, va);
      joints[j]!.push(round(va.x, 5), round(va.y, 5), round(va.z, 5));
    }
  }

  const base: Omit<Take, 'beats'> = { ...take, duration: round((frames - 1) / fps), frames, bones, hips, face, joints, edited: { from: take.source.file, edits: file.edits, pieces } };
  const out: Take = { ...base, beats: findBeats(base) };

  // Untouched frames, worked out from the edit file alone rather than from what the loop above applied:
  // an output frame in a piece no edit owns, whose source time is outside every look's span, must be the
  // recording's own frame at the piece's shift. A shift that lands between recorded frames is a failure.
  let n = 0; let maxDeg = 0; let maxMm = 0; let maxFace = 0; let offGrid = 0;
  for (let f = 0; f < frames; f += 1) {
    const piece = pieces.find((p) => p.edit === undefined && f >= Math.round(p.outFrom * fps) && f <= Math.round(p.outTo * fps) - (p.outTo < pieces[pieces.length - 1]!.outTo ? 1 : 0));
    if (!piece) continue;
    const exact = piece.srcFrom * fps + (f - piece.outFrom * fps);
    const sf = Math.round(exact);
    if (looks.some(({ span }) => sf / fps > span[0] && sf / fps < span[1])) continue;
    n += 1;
    if (Math.abs(sf - exact) > 1e-6 || sf < 0 || sf >= take.frames) { offGrid += 1; continue; }
    for (const [b, track] of Object.entries(take.bones) as [VrmHumanoidBone, number[]][]) maxDeg = Math.max(maxDeg, quatAt(track, sf, qa).angleTo(quatAt(bones[b]!, f, qb)) / DEG);
    maxMm = Math.max(maxMm, vecAt(take.hips, sf, va).distanceTo(vecAt(hips, f, vb)) * 1000);
    for (const [c, track] of Object.entries(take.face) as [FaceChannel, number[]][]) maxFace = Math.max(maxFace, Math.abs(track[sf]! - face[c]![f]!));
  }
  if (offGrid) maxDeg = Infinity;

  const lookOf = (t: Take, s: number): { yaw: number; pitch: number } => {
    const f = Math.min(t.frames - 1, Math.round(s * fps));
    const d = new THREE.Vector3(0, 0, 1).applyQuaternion(quatAt(t.bones.head!, f));
    return { yaw: round(Math.atan2(d.x, d.z) / DEG, 1), pitch: round(Math.atan2(d.y, Math.hypot(d.x, d.z)) / DEG, 1) };
  };
  const outTimeOf = (s: number): number => {
    const p = pieces.find((x) => s >= x.srcFrom && s <= x.srcTo && x.srcTo > x.srcFrom) ?? pieces[pieces.length - 1]!;
    return p.outFrom + ((s - p.srcFrom) / (p.srcTo - p.srcFrom)) * (p.outTo - p.outFrom);
  };
  const report: EditReport = {
    pieces: pieces.map((p) => ({ ...p, outFrom: round(p.outFrom, 3), outTo: round(p.outTo, 3), srcFrom: round(p.srcFrom, 3), srcTo: round(p.srcTo, 3) })),
    duration: { source: take.duration, edited: out.duration },
    untouched: { frames: n, offGrid, maxBoneDeg: round(maxDeg, 4), maxHipsMm: round(maxMm, 3), maxFace: round(maxFace, 4) },
    looks: looks.map(({ i, e, span }) => {
      const mid = (span[0] + span[1]) / 2;
      return { edit: i + 1, asked: { yaw: e.yaw, pitch: e.pitch ?? 0 }, reached: lookOf(out, outTimeOf(mid)), before: lookOf(take, mid) };
    }),
    holds: [...holdEvents.entries()].map(([i, ev]) => {
      const e = file.edits[i] as Extract<Edit, { kind: 'hold' }>;
      const piece = pieces.find((p) => p.edit === i)!;
      return { edit: i + 1, at: round(piece.srcFrom, 3), add: round(piece.outTo - piece.outFrom, 3), glances: ev.glances.size, sighs: ev.sighs.size, blinks: ev.blinks.size, ...(e.life === false ? { life: false } : {}) };
    })
  };
  return { take: out, report };
}

export { GLANCE_HEAD_SHARE };
