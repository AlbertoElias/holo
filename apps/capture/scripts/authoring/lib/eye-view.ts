/**
 * Keeps each iris in view. An eye turned past its lids shows only white: on
 * the house avatar a 25° down look puts the iris under the lower lid, and a
 * reader sees the eyes roll. Here, per avatar and from its mesh alone:
 *
 * - `eyeApertures`: what each eye shows from straight in front at bind pose
 *   with neutral lids, as a grid of the cells where a ray meets the eye first.
 * - `irisLimits`: the largest turn up, down, left and right that keeps the
 *   pupil centre (and 1 mm around it) inside that opening, as an ellipse the
 *   solve clamps the gaze to (`clampGaze`); the head takes the rest of a look.
 * - `blinkCap`: the opening again with the upper lids part closed; a held
 *   closure opens as the eyes look up until the pupil shows (B-111).
 * - `EyeMeter`: per frame, where each eye bone actually points, and whether
 *   its pupil centre is in view under the held lids; the `eyes.<performer>`
 *   bar counts the frames.
 *
 * The frame is the avatar's body frame (+Y up, +Z the way it faces); gaze yaw
 * is + toward the avatar's own left, pitch + up, as `FaceRig` takes them.
 */
import * as THREE from 'three';

import type { LoadedAvatar, Side } from './avatar.ts';
import { resetPose } from './avatar.ts';
import { hitUv, triangles } from './face-geometry.ts';
import { meshesOf, skin } from './skin.ts';
import type { FaceWeights } from '../../../src/face/faceTypes.ts';

const NEUTRAL = { left: { yaw: 0, pitch: 0 }, right: { yaw: 0, pitch: 0 } };
/** Grid step (m). */
const STEP = 0.0005;
/** The pupil centre and this far around it must show (m). */
const MARGIN = 0.001;
/** Frames an iris may be out of view over a take before the bar fails. */
export const IRIS_OUT_MAX_FRAMES = 2;

export interface EyeAperture {
  /** Eye centre, body frame at bind (m). */
  readonly centre: THREE.Vector3;
  /** The farthest eye vertex from the centre (m): where the pupil sits on the ball. */
  readonly radius: number;
  /** Cells `n + 1` a side, `STEP` apart, from `-half` to `half` about the centre in x and y; 1 where the eye shows first. */
  readonly half: number;
  readonly n: number;
  readonly open: Uint8Array;
}

export interface Gaze { readonly yaw: number; readonly pitch: number }
/** Radians: the largest turn each way that keeps the pupil in view. `left` is + yaw (toward the avatar's left). */
export interface IrisLimit { readonly up: number; readonly down: number; readonly left: number; readonly right: number }

/** Upper-lid closures (eyeBlink) at which `eyeView` measures the opening again, for `blinkCap`. */
const BLINK_LEVELS = [0.15, 0.3, 0.45, 0.6, 0.75] as const;
/** A blink this closed or more is meant to hide the eye (eyes shut), so no cap applies. */
export const BLINK_SHUT = 0.85;

/** What each eye shows from in front at bind pose, with the face at `weights` (neutral by default). Eyes without an eye bone or eye triangles are left out. */
export function eyeApertures(a: LoadedAvatar, weights: FaceWeights = {}): Partial<Record<Side, EyeAperture>> {
  resetPose(a);
  a.face.apply(weights, NEUTRAL);
  a.frame.updateMatrixWorld(true);
  const meshes = meshesOf(a.scene);
  const frameOf = a.body.name === 'HumanoidFacing' && a.body.parent ? a.body.parent : a.body;
  const bodyQ = frameOf.getWorldQuaternion(new THREE.Quaternion()).invert();
  const bodyO = frameOf.getWorldPosition(new THREE.Vector3());
  const v = new THREE.Vector3();
  const skins = meshes.map((m) => skin(m));
  const positions = skins.map((s) => {
    const out = new Float32Array(s.positions.length);
    for (let i = 0; i < out.length; i += 3) {
      v.set(s.positions[i]! - bodyO.x, s.positions[i + 1]! - bodyO.y, s.positions[i + 2]! - bodyO.z).applyQuaternion(bodyQ);
      out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z;
    }
    return out;
  });
  const soups = meshes.map((m, k) => triangles(m, positions[k]!, k));
  const out: Partial<Record<Side, EyeAperture>> = {};
  for (const side of ['left', 'right'] as const) {
    const eyeBone = a.humanoid.bone(side === 'left' ? 'leftEye' : 'rightEye');
    if (!eyeBone) continue;
    const centre = eyeBone.getWorldPosition(new THREE.Vector3()).sub(bodyO).applyQuaternion(bodyQ);
    let radius = 0;
    meshes.forEach((_, k) => {
      const s = skins[k]!;
      for (let i = 0; i < s.count; i += 1) {
        if (s.dominant[i] !== eyeBone) continue;
        radius = Math.max(radius, Math.hypot(positions[k]![i * 3]! - centre.x, positions[k]![i * 3 + 1]! - centre.y, positions[k]![i * 3 + 2]! - centre.z));
      }
    });
    if (radius === 0) continue;
    const half = 1.3 * radius;
    const n = Math.ceil((2 * half) / STEP);
    // The triangles over the grid's square, and whether each is the eye's.
    const kept: { tri: Float32Array; t: number; eye: boolean }[] = [];
    for (const s of soups) {
      const mesh = meshes[s.mesh]!;
      const index = mesh.geometry.index;
      const dom = skins[s.mesh]!.dominant;
      const count = s.box.length / 6;
      for (let t = 0; t < count; t += 1) {
        const b = t * 6;
        if (s.box[b + 3]! < centre.x - half || s.box[b]! > centre.x + half || s.box[b + 4]! < centre.y - half || s.box[b + 1]! > centre.y + half) continue;
        if (s.box[b + 5]! < centre.z - 2 * radius) continue;
        kept.push({ tri: s.tri, t, eye: dom[index ? index.getX(t * 3) : t * 3] === eyeBone });
      }
    }
    if (!kept.some((k) => k.eye)) continue;
    const open = new Uint8Array((n + 1) * (n + 1));
    const o = new Float64Array(3);
    const dir = [0, 0, -1];
    // Each ray is parallel to -z, so it can meet only a triangle whose xy box covers it. Each grid
    // point lists those triangles (the box one cell wider each way), in `kept` order, so that a tie
    // keeps the same first hit as a test of every triangle.
    const bins: number[][] = Array.from({ length: (n + 1) * (n + 1) }, () => []);
    const x0 = centre.x - half, y0 = centre.y - half;
    kept.forEach((k, idx) => {
      const b = k.t * 9, tr = k.tri;
      const i0 = Math.max(0, Math.floor((Math.min(tr[b]!, tr[b + 3]!, tr[b + 6]!) - x0) / STEP) - 1);
      const i1 = Math.min(n, Math.ceil((Math.max(tr[b]!, tr[b + 3]!, tr[b + 6]!) - x0) / STEP) + 1);
      const j0 = Math.max(0, Math.floor((Math.min(tr[b + 1]!, tr[b + 4]!, tr[b + 7]!) - y0) / STEP) - 1);
      const j1 = Math.min(n, Math.ceil((Math.max(tr[b + 1]!, tr[b + 4]!, tr[b + 7]!) - y0) / STEP) + 1);
      for (let i = i0; i <= i1; i += 1) for (let j = j0; j <= j1; j += 1) bins[i * (n + 1) + j]!.push(idx);
    });
    for (let i = 0; i <= n; i += 1) {
      for (let j = 0; j <= n; j += 1) {
        o[0] = centre.x - half + i * STEP; o[1] = centre.y - half + j * STEP; o[2] = centre.z + 1;
        let near = Infinity, eye = false;
        for (const idx of bins[i * (n + 1) + j]!) {
          const k = kept[idx]!;
          const r = hitUv(k.tri, k.t, o, dir);
          if (r && r[0] > 0 && r[0] < near) { near = r[0]; eye = k.eye; }
        }
        open[i * (n + 1) + j] = eye ? 1 : 0;
      }
    }
    out[side] = { centre, radius, half, n, open };
  }
  return out;
}

/** The pupil's direction in the body frame for a gaze (`FaceRig`'s YXZ order: yaw about up, then pitch). */
function gazeDir(g: Gaze): THREE.Vector3 {
  return new THREE.Vector3(Math.sin(g.yaw) * Math.cos(g.pitch), Math.sin(g.pitch), Math.cos(g.yaw) * Math.cos(g.pitch));
}

/** Whether the pupil centre, pointing along `dir` (body frame), shows: it and MARGIN around it fall on open cells. */
export function pupilShows(ap: EyeAperture, dir: THREE.Vector3): boolean {
  if (dir.z <= 0.2) return false;
  const px = dir.x * ap.radius, py = dir.y * ap.radius;
  for (const [dx, dy] of [[0, 0], [MARGIN, 0], [-MARGIN, 0], [0, MARGIN], [0, -MARGIN]] as const) {
    const i = Math.round((px + dx + ap.half) / STEP), j = Math.round((py + dy + ap.half) / STEP);
    if (i < 0 || j < 0 || i > ap.n || j > ap.n || !ap.open[i * (ap.n + 1) + j]) return false;
  }
  return true;
}

/**
 * Per eye: how far it can turn each way with the pupil in view, then shrunk
 * until the ellipse through those four (`clampGaze`) shows the pupil all round.
 */
export function irisLimits(ap: EyeAperture): IrisLimit {
  const DEG = Math.PI / 180;
  const along = (yawSign: number, pitchSign: number): number => {
    let last = 0;
    for (let d = 0.5; d <= 45; d += 0.5) {
      if (!pupilShows(ap, gazeDir({ yaw: yawSign * d * DEG, pitch: pitchSign * d * DEG }))) break;
      last = d;
    }
    return last * DEG;
  };
  let lim: IrisLimit = { up: along(0, 1), down: along(0, -1), left: along(1, 0), right: along(-1, 0) };
  let k = 1;
  for (let i = 0; i < 32; i += 1) {
    const th = (i / 32) * 2 * Math.PI;
    const u = Math.cos(th), w = Math.sin(th);
    const edge = (s: number): Gaze => ({ yaw: s * u * (u >= 0 ? lim.left : lim.right), pitch: s * w * (w >= 0 ? lim.up : lim.down) });
    for (let s = 1; s > 0; s -= 0.02) if (pupilShows(ap, gazeDir(edge(s)))) { k = Math.min(k, s); break; }
  }
  lim = { up: lim.up * k, down: lim.down * k, left: lim.left * k, right: lim.right * k };
  return lim;
}

/** The gaze pulled back onto the ellipse of `lim` along its own direction, when it is outside. */
export function clampGaze(g: Gaze, lim: IrisLimit): Gaze {
  const ax = g.yaw >= 0 ? lim.left : lim.right;
  const ay = g.pitch >= 0 ? lim.up : lim.down;
  const u = ax > 0 ? g.yaw / ax : (g.yaw === 0 ? 0 : Infinity);
  const w = ay > 0 ? g.pitch / ay : (g.pitch === 0 ? 0 : Infinity);
  const r = Math.hypot(u, w);
  if (r <= 1) return g;
  if (!Number.isFinite(r)) return { yaw: Number.isFinite(u) ? g.yaw : 0, pitch: Number.isFinite(w) ? g.pitch : 0 };
  return { yaw: g.yaw / r, pitch: g.pitch / r };
}

/** Both eyes' limits in one, for the head: a turn either eye can make. */
export function bothEyes(l: IrisLimit | undefined, r: IrisLimit | undefined): IrisLimit | undefined {
  if (!l || !r) return l ?? r;
  return { up: Math.min(l.up, r.up), down: Math.min(l.down, r.down), left: Math.min(l.left, r.left), right: Math.min(l.right, r.right) };
}

export interface EyeView {
  readonly apertures: Partial<Record<Side, EyeAperture>>;
  readonly limits: Partial<Record<Side, IrisLimit>>;
  /** The opening again with the upper lids lowered to each of `BLINK_LEVELS`, and how far up each eye then turns with the pupil in view (radians). */
  readonly lids: readonly { readonly blink: number; readonly apertures: Partial<Record<Side, EyeAperture>>; readonly up: Partial<Record<Side, number>> }[];
}

/** The largest straight-up turn that keeps the pupil in view (radians). */
function upLimit(ap: EyeAperture): number {
  let last = -45;
  for (let d = -45; d <= 45; d += 0.5) {
    if (pupilShows(ap, gazeDir({ yaw: 0, pitch: d * Math.PI / 180 }))) last = d;
    else if (last > -45) break;
  }
  return last * Math.PI / 180;
}

/** Each loaded avatar's view, measured once: every solve pass of a build starts from the same bind pose. */
const views = new WeakMap<LoadedAvatar, EyeView>();

/**
 * The apertures and limits of an avatar; call at bind pose, before the solve.
 * The first call measures them (most of a solve pass's time); a later call on
 * the same loaded avatar gives the same view and puts the avatar back at bind
 * pose with a neutral face, as the first call does.
 */
export function eyeView(a: LoadedAvatar): EyeView {
  const known = views.get(a);
  if (known) {
    resetPose(a);
    a.face.apply({}, NEUTRAL);
    a.frame.updateMatrixWorld(true);
    return known;
  }
  const apertures = eyeApertures(a);
  const limits: Partial<Record<Side, IrisLimit>> = {};
  for (const side of ['left', 'right'] as const) { const ap = apertures[side]; if (ap) limits[side] = irisLimits(ap); }
  const lids = BLINK_LEVELS.map((blink) => {
    const aps = eyeApertures(a, { eyeBlinkLeft: blink, eyeBlinkRight: blink });
    const up: Partial<Record<Side, number>> = {};
    for (const side of ['left', 'right'] as const) { const ap = aps[side]; if (ap) up[side] = upLimit(ap); }
    return { blink, apertures: aps, up };
  });
  resetPose(a);
  a.face.apply({}, NEUTRAL);
  a.frame.updateMatrixWorld(true);
  const view = { apertures, limits, lids };
  views.set(a, view);
  return view;
}

/**
 * The most the upper lids may close while the eyes look `pitch` up (radians)
 * with the pupil in view: a lid follows the eye up, as a real one does. 1 when
 * any closure up to the last measured level keeps the pupil in view.
 */
export function blinkCap(view: EyeView, pitch: number): number {
  let prev = { blink: 0, up: Infinity };
  for (const l of view.lids) {
    const ups = Object.values(l.up);
    if (!ups.length) return 1;
    const up = Math.min(...ups);
    if (up < pitch) {
      // Between the last level that shows the pupil and this one, as the limit falls.
      const f = prev.up === Infinity ? 0 : (prev.up - pitch) / Math.max(1e-6, prev.up - up);
      return prev.blink + (l.blink - prev.blink) * Math.max(0, Math.min(1, f));
    }
    prev = { blink: l.blink, up };
  }
  return 1;
}

export interface EyeReport {
  readonly frames: number;
  /** Frames with either pupil out of view. */
  readonly out: number;
  /** The first such frame's time and eye, and the gaze there in degrees. */
  readonly first?: { readonly t: number; readonly side: Side; readonly yawDeg: number; readonly pitchDeg: number };
  /** Per eye, the limits in degrees (up, down, left, right). */
  readonly limitsDeg: Partial<Record<Side, [number, number, number, number]>>;
}

/**
 * Reads where each eye bone points every frame, from its local rotation alone:
 * the bone's turn since bind, carried into the body frame through its parent's
 * bind rotation, applied to straight ahead.
 */
export class EyeMeter {
  private readonly eyes: { side: Side; bone: THREE.Object3D; l0Inv: THREE.Quaternion; m: THREE.Quaternion; mInv: THREE.Quaternion; ap: EyeAperture }[] = [];
  private frames = 0;
  private out = 0;
  private first: EyeReport['first'];
  private readonly q = new THREE.Quaternion();
  private readonly d = new THREE.Vector3();

  /** Construct at bind pose with a neutral gaze (as `eyeView` leaves the avatar). */
  constructor(a: LoadedAvatar, private readonly view: EyeView) {
    const frameOf = a.body.name === 'HumanoidFacing' && a.body.parent ? a.body.parent : a.body;
    const bodyQ0 = frameOf.getWorldQuaternion(new THREE.Quaternion());
    for (const side of ['left', 'right'] as const) {
      const bone = a.humanoid.bone(side === 'left' ? 'leftEye' : 'rightEye');
      const ap = view.apertures[side];
      if (!bone?.parent || !ap) continue;
      const m = bodyQ0.clone().invert().multiply(bone.parent.getWorldQuaternion(new THREE.Quaternion()));
      this.eyes.push({ side, bone, l0Inv: bone.quaternion.clone().invert(), m, mInv: m.clone().invert(), ap });
    }
  }

  /** The eye's gaze now, in the body frame of its head. */
  gazeOf(side: Side): Gaze | undefined {
    const e = this.eyes.find((x) => x.side === side);
    if (!e) return undefined;
    const d = this.direction(e);
    return { yaw: Math.atan2(d.x, d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) };
  }

  private direction(e: (typeof this.eyes)[number]): THREE.Vector3 {
    this.q.copy(e.m).multiply(e.bone.quaternion).multiply(e.l0Inv).multiply(e.mInv);
    return this.d.set(0, 0, 1).applyQuaternion(this.q);
  }

  /** `blink`: the upper lids' held closure this frame (an expression's, not a passing blink); below `BLINK_SHUT` the pupil must show under it. */
  sample(t: number, blink = 0): void {
    this.frames += 1;
    let bad: Side | undefined;
    // The opening at the most closed measured level at or below `blink` (a little kinder than the lid itself).
    const level = blink < BLINK_SHUT ? [...this.view.lids].reverse().find((l) => l.blink <= blink + 1e-6) : undefined;
    for (const e of this.eyes) if (!pupilShows(level?.apertures[e.side] ?? e.ap, this.direction(e))) { bad = e.side; break; }
    if (!bad) return;
    this.out += 1;
    if (!this.first) {
      const g = this.gazeOf(bad)!;
      this.first = { t: Math.round(t * 100) / 100, side: bad, yawDeg: Math.round((g.yaw * 180) / Math.PI), pitchDeg: Math.round((g.pitch * 180) / Math.PI) };
    }
  }

  report(): EyeReport {
    const deg = (x: number): number => Math.round((x * 1800) / Math.PI) / 10;
    const limitsDeg: EyeReport['limitsDeg'] = {};
    for (const side of ['left', 'right'] as const) {
      const l = this.view.limits[side];
      if (l) limitsDeg[side] = [deg(l.up), deg(l.down), deg(l.left), deg(l.right)];
    }
    return { frames: this.frames, out: this.out, ...(this.first ? { first: this.first } : {}), limitsDeg };
  }
}
