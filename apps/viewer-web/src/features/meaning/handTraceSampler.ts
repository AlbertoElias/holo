import { HOLOIM_MEANING_EXTENSION, validateHoloimMeaning } from "@holoim/meaning";
import type { VrmHumanoidBone } from "@holoim/meaning";
import { Matrix4, PropertyBinding, Quaternion, Vector3 } from "three";
import type { AnimationClip, Interpolant, Object3D } from "three";

import type { HumanoidAnchors } from "../hologram/humanoidAnchors";

// Hand traces (PRD-023): where each hand's index fingertip went before a
// moment, read from the take's own primary clip. A trace is drawn only where
// tracked hands drove the hand (`recorded` motion spans over `<side>Hand`),
// never while the author travels, and not at all for a hand that stayed put.

export type HandSide = "left" | "right";
export const HAND_SIDES: readonly HandSide[] = ["left", "right"];

/** Seconds of path behind a paused moment. */
export const PAUSED_WINDOW_SEC = 3;
/** Seconds of tail behind each hand while playing with Traces on. */
export const TAIL_WINDOW_SEC = 1;
/** A hand whose path stays this close to its newest point stood still: no trace, however much it jittered. */
export const STILL_EXTENT_METERS = 0.05;
/** Above this horizontal hip speed the author is travelling, and nothing is drawn. */
export const TRAVEL_SPEED = 0.3;
/** The hip speed is the horizontal displacement over this many seconds. */
export const TRAVEL_SPEED_WINDOW_SEC = 0.25;
/**
 * A hip step between two samples at least this long and faster than
 * `ROOT_JUMP_SPEED` is a teleport (capture's respawn steps the root a few
 * centimetres in one frame), not a body moving.
 */
const ROOT_JUMP_METERS = 0.03;
const ROOT_JUMP_SPEED = 2.5;
/** A hip turn larger than this between two samples is a snap turn. */
const ROOT_JUMP_RADIANS = (12 * Math.PI) / 180;
/**
 * A fingertip step at least this long and faster than `TIP_JUMP_SPEED` is no
 * hand moving: capture records a take in its rig's frame, so a snap turn
 * leaves the body still and snaps the arms to the turned hands in one frame.
 */
const TIP_JUMP_METERS = 0.08;
const TIP_JUMP_SPEED = 6;

type Span = { start: number; end: number };

/** Recorded spans over each side's hand, from a loaded glTF's `HOLOIM_meaning`; empty for files without them. */
export function readRecordedHandSpans(userData: Record<string, unknown> | undefined): Record<HandSide, Span[]> {
  const out: Record<HandSide, Span[]> = { left: [], right: [] };
  const raw = (userData?.gltfExtensions as Record<string, unknown> | undefined)?.[HOLOIM_MEANING_EXTENSION];
  if (raw === undefined) return out;
  const result = validateHoloimMeaning(raw);
  if (!result.ok) return out;
  for (const span of result.value.spans) {
    if (span.provenance.value !== "recorded") continue;
    for (const side of HAND_SIDES) {
      if (span.bones.includes(`${side}Hand`)) out[side].push({ start: span.span.start, end: span.span.end });
    }
  }
  for (const side of HAND_SIDES) out[side].sort((a, b) => a.start - b.start);
  return out;
}

export type TipSource = "tip" | "distal" | "hand";

/**
 * The index fingertip: capture's rule (the first child bone of `indexDistal`
 * that is not itself a canonical bone, its end site), then the distal bone,
 * then the hand.
 */
export function resolveIndexTip(anchors: HumanoidAnchors, side: HandSide): { node: Object3D; source: TipSource } | null {
  const distal = anchors.bones.get(`${side}IndexDistal` as VrmHumanoidBone);
  if (distal) {
    const canonical = new Set(anchors.bones.values());
    const tip = distal.children.find((child) => (child as Object3D & { isBone?: boolean }).isBone === true && !canonical.has(child));
    if (tip) return { node: tip, source: "tip" };
    return { node: distal, source: "distal" };
  }
  const hand = anchors.bones.get(`${side}Hand` as VrmHumanoidBone);
  return hand ? { node: hand, source: "hand" } : null;
}

type NodeTracks = { position?: Interpolant; quaternion?: Interpolant; scale?: Interpolant };

/**
 * World transforms of nodes at any clip time, without a mixer: each node of
 * the chain up to the scene root from its track's interpolant when the clip
 * animates it, else its own (static) local transform. Tracks bind the way
 * the mixer binds them, by `PropertyBinding.findNode` under `root`.
 */
export class ClipChainSampler {
  private readonly tracks = new Map<Object3D, NodeTracks>();
  private readonly chains = new Map<Object3D, Object3D[]>();
  private readonly memo = new Map<Object3D, Matrix4>();
  private readonly pool: Matrix4[] = [];
  private poolUsed = 0;
  private readonly local = new Matrix4();
  private readonly p = new Vector3();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();
  /** Keyframe times of the clip, ascending. */
  readonly times: Float32Array;
  readonly duration: number;

  constructor(root: Object3D, clip: AnimationClip) {
    let times: Float32Array | null = null;
    for (const track of clip.tracks) {
      const parsed = PropertyBinding.parseTrackName(track.name);
      const property = parsed.propertyName as keyof NodeTracks;
      if (property !== "position" && property !== "quaternion" && property !== "scale") continue;
      const node = PropertyBinding.findNode(root, parsed.nodeName) as Object3D | null;
      if (!node) continue;
      const entry = this.tracks.get(node) ?? {};
      entry[property] = track.createInterpolant();
      this.tracks.set(node, entry);
      if (!times || track.times.length > times.length) times = track.times as Float32Array;
    }
    this.times = times ?? new Float32Array(0);
    this.duration = clip.duration;
  }

  animates(node: Object3D): boolean {
    return this.tracks.has(node);
  }

  /** World positions of `nodes` at clip time `time`, sharing their common ancestors' work. */
  sample(time: number, nodes: readonly Object3D[], out: Vector3[], outQuaternion?: Quaternion[]): void {
    this.memo.clear();
    this.poolUsed = 0;
    nodes.forEach((node, index) => {
      const matrix = this.world(node, time);
      out[index]!.setFromMatrixPosition(matrix);
      if (outQuaternion) matrix.decompose(this.p, outQuaternion[index]!, this.s);
    });
  }

  private world(node: Object3D, time: number): Matrix4 {
    let chain = this.chains.get(node);
    if (!chain) {
      chain = [];
      for (let current: Object3D | null = node; current; current = current.parent) chain.unshift(current);
      this.chains.set(node, chain);
    }
    let parent: Matrix4 | null = null;
    for (const current of chain) {
      let matrix = this.memo.get(current);
      if (!matrix) {
        const tracks = this.tracks.get(current);
        this.p.copy(current.position);
        this.q.copy(current.quaternion);
        this.s.copy(current.scale);
        if (tracks?.position) this.p.fromArray(tracks.position.evaluate(time));
        if (tracks?.quaternion) this.q.fromArray(tracks.quaternion.evaluate(time));
        if (tracks?.scale) this.s.fromArray(tracks.scale.evaluate(time));
        this.local.compose(this.p, this.q, this.s);
        matrix = this.take();
        if (parent) matrix.multiplyMatrices(parent, this.local);
        else matrix.copy(this.local);
        this.memo.set(current, matrix);
      }
      parent = matrix;
    }
    return parent!;
  }

  private take(): Matrix4 {
    if (this.poolUsed === this.pool.length) this.pool.push(new Matrix4());
    return this.pool[this.poolUsed++]!;
  }
}

/** One point of a hand's trace. */
export type TracePoint = {
  time: number;
  position: Vector3;
  /** 0 at the newest end, 1 at the oldest end of the window. */
  age: number;
};

export type HandTrace = {
  points: TracePoint[];
  /** Pairs of indices into `points` that are drawn. */
  segments: Array<[number, number]>;
  /** Largest distance of a drawn point from the newest drawn point. */
  extent: number;
  drawn: boolean;
  /** Why samples in the window were left out. */
  suppressed: { outsideSpan: number; travel: number; jumps: number };
};

export type TraceFrame = {
  time: number;
  windowStart: number;
  hands: Record<HandSide, HandTrace>;
  /** Horizontal hip speed at each sample in the window, m/s. */
  hipSpeeds: number[];
};

/**
 * Samples both hands' fingertips and the hips at the clip's keyframe times,
 * caching each keyframe once (a recording never changes), and turns a window
 * ending at a moment into drawable traces.
 */
export class HandTraceSampler {
  private readonly sampler: ClipChainSampler;
  private readonly nodes: Object3D[];
  private readonly keyed: Uint8Array;
  /** Per keyframe: left tip, right tip, hips (xyz each). */
  private readonly positions: Float32Array;
  private readonly hipTurns: Float32Array;
  private readonly hipQuats: Float32Array;
  private readonly outs = [new Vector3(), new Vector3(), new Vector3()];
  private readonly outQuats = [new Quaternion(), new Quaternion(), new Quaternion()];
  private readonly qa = new Quaternion();
  private readonly qb = new Quaternion();

  constructor(
    root: Object3D,
    clip: AnimationClip,
    tips: Record<HandSide, Object3D>,
    hips: Object3D,
    private readonly spans: Record<HandSide, Span[]>
  ) {
    this.sampler = new ClipChainSampler(root, clip);
    this.nodes = [tips.left, tips.right, hips];
    const count = this.sampler.times.length;
    this.keyed = new Uint8Array(count);
    this.positions = new Float32Array(count * 9);
    this.hipQuats = new Float32Array(count * 4);
    this.hipTurns = new Float32Array(count);
  }

  get times(): Float32Array {
    return this.sampler.times;
  }

  /** The fingertip's world position at a clip time, exactly as the trace samples it. */
  tipAt(side: HandSide, time: number, out: Vector3): Vector3 {
    this.sampler.sample(time, this.nodes, this.outs);
    return out.copy(this.outs[side === "left" ? 0 : 1]!);
  }

  private warmed = 0;

  /** Caches keyframes in clip order for up to `budgetMs`; true once all are cached. */
  warm(budgetMs: number): boolean {
    const count = this.keyed.length;
    const until = performance.now() + budgetMs;
    while (this.warmed < count) {
      this.key(this.warmed);
      this.warmed += 1;
      if ((this.warmed & 7) === 0 && performance.now() > until) break;
    }
    return this.warmed >= count;
  }

  private key(index: number): void {
    if (this.keyed[index]) return;
    this.sampler.sample(this.sampler.times[index]!, this.nodes, this.outs, this.outQuats);
    for (let n = 0; n < 3; n += 1) this.outs[n]!.toArray(this.positions, index * 9 + n * 3);
    this.outQuats[2]!.toArray(this.hipQuats, index * 4);
    this.keyed[index] = 1;
  }

  private inSpan(side: HandSide, time: number): boolean {
    return this.spans[side].some((span) => time >= span.start - 1e-4 && time <= span.end + 1e-4);
  }

  /** First keyframe index at or after `time`. */
  private lowerBound(time: number): number {
    const times = this.sampler.times;
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! < time - 1e-6) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The traces for the window of `windowSec` ending at clip time `time` (clamped at the clip start; no loop wrap). */
  trace(time: number, windowSec: number): TraceFrame {
    const times = this.sampler.times;
    const windowStart = Math.max(0, time - windowSec);
    const first = this.lowerBound(windowStart);
    // Keyframes inside the window, then the moment itself when it falls between keyframes.
    const sampleTimes: number[] = [];
    const sampleKeys: number[] = [];
    for (let i = first; i < times.length && times[i]! <= time + 1e-6; i += 1) {
      sampleTimes.push(times[i]!);
      sampleKeys.push(i);
    }
    if (sampleTimes.length === 0 || Math.abs(sampleTimes.at(-1)! - time) > 1e-6) {
      sampleTimes.push(time);
      sampleKeys.push(-1);
    }

    // Positions per sample: [left, right, hips].
    const count = sampleTimes.length;
    const pos = new Float32Array(count * 9);
    const quats = new Float32Array(count * 4);
    sampleKeys.forEach((key, s) => {
      if (key >= 0) {
        this.key(key);
        pos.set(this.positions.subarray(key * 9, key * 9 + 9), s * 9);
        quats.set(this.hipQuats.subarray(key * 4, key * 4 + 4), s * 4);
      } else {
        this.sampler.sample(sampleTimes[s]!, this.nodes, this.outs, this.outQuats);
        for (let n = 0; n < 3; n += 1) this.outs[n]!.toArray(pos, s * 9 + n * 3);
        this.outQuats[2]!.toArray(quats, s * 4);
      }
    });

    // Hip speed: horizontal displacement since the keyframe 0.25 s back (less at the clip start).
    const hipSpeeds = sampleTimes.map((t, s) => {
      const back = this.lowerBound(Math.max(0, t - TRAVEL_SPEED_WINDOW_SEC));
      const dt = back < times.length ? t - times[back]! : 0;
      if (dt <= 1e-6) return 0;
      this.key(back);
      const dx = pos[s * 9 + 6]! - this.positions[back * 9 + 6]!;
      const dz = pos[s * 9 + 8]! - this.positions[back * 9 + 8]!;
      return Math.hypot(dx, dz) / dt;
    });
    // A root jump lies between two samples: a hip step or turn no body makes in one frame.
    const jumpBefore = sampleTimes.map((_, s) => {
      if (s === 0) return false;
      const dx = pos[s * 9 + 6]! - pos[(s - 1) * 9 + 6]!;
      const dz = pos[s * 9 + 8]! - pos[(s - 1) * 9 + 8]!;
      const step = Math.hypot(dx, dz);
      const dt = sampleTimes[s]! - sampleTimes[s - 1]!;
      if (step > ROOT_JUMP_METERS && step > ROOT_JUMP_SPEED * dt) return true;
      this.qa.fromArray(quats, (s - 1) * 4);
      this.qb.fromArray(quats, s * 4);
      return this.qa.angleTo(this.qb) > ROOT_JUMP_RADIANS;
    });

    const hands = {} as Record<HandSide, HandTrace>;
    HAND_SIDES.forEach((side, h) => {
      const suppressed = { outsideSpan: 0, travel: 0, jumps: 0 };
      const usable = sampleTimes.map((t, s) => {
        if (!this.inSpan(side, t)) {
          suppressed.outsideSpan += 1;
          return false;
        }
        if (hipSpeeds[s]! > TRAVEL_SPEED) {
          suppressed.travel += 1;
          return false;
        }
        return true;
      });
      const points: TracePoint[] = sampleTimes.map((t, s) => ({
        time: t,
        position: new Vector3(pos[s * 9 + h * 3]!, pos[s * 9 + h * 3 + 1]!, pos[s * 9 + h * 3 + 2]!),
        age: windowSec > 0 ? Math.min(1, Math.max(0, (time - t) / windowSec)) : 0
      }));
      const segments: Array<[number, number]> = [];
      for (let s = 1; s < count; s += 1) {
        if (!usable[s - 1] || !usable[s]) continue;
        const step = Math.hypot(
          pos[s * 9 + h * 3]! - pos[(s - 1) * 9 + h * 3]!,
          pos[s * 9 + h * 3 + 1]! - pos[(s - 1) * 9 + h * 3 + 1]!,
          pos[s * 9 + h * 3 + 2]! - pos[(s - 1) * 9 + h * 3 + 2]!
        );
        const tipJump = step > TIP_JUMP_METERS && step > TIP_JUMP_SPEED * (sampleTimes[s]! - sampleTimes[s - 1]!);
        if (jumpBefore[s] || tipJump) {
          suppressed.jumps += 1;
          continue;
        }
        segments.push([s - 1, s]);
      }
      let extent = 0;
      const newest = segments.at(-1)?.[1];
      if (newest !== undefined) {
        const end = points[newest]!.position;
        for (const [a, b] of segments) {
          extent = Math.max(extent, points[a]!.position.distanceTo(end), points[b]!.position.distanceTo(end));
        }
      }
      hands[side] = { points, segments, extent, drawn: segments.length > 0 && extent > STILL_EXTENT_METERS, suppressed };
    });

    return { time, windowStart, hands, hipSpeeds };
  }
}
