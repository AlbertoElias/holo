import { HOLOIM_MEANING_EXTENSION, pathExtent, STILL_EXTENT_METERS, validateHoloimMeaning } from "@holoim/meaning";
import { Matrix4, PropertyBinding, Quaternion, Vector3 } from "three";
import type { AnimationClip, Interpolant, Object3D } from "three";

// Author-marked hand traces (PRD-023 v1): where the fingertip a trace mark
// anchors went across the mark's span, read from the take's own primary clip.
// A segment is drawn only where tracked hands drove the hand (`recorded`
// motion spans over `<side>Hand`) and never while the author travels. Capture
// decided which hands moved enough to be marked; the viewer only suppresses a
// path that is still anyway (defensive).

export type HandSide = "left" | "right";
export const HAND_SIDES: readonly HandSide[] = ["left", "right"];

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

/** A trace mark as the sampler follows it: the fingertip node, its side and the marked span. */
export type SamplerMark = { side: HandSide; node: Object3D; span: Span };

export type SuppressedCounts = { outsideSpan: number; travel: number; jumps: number };

/** A mark's whole path, sampled once: positions at the keyframes inside its span (plus its exact ends). */
export type MarkPath = {
  count: number;
  times: Float32Array;
  /** xyz per sample. */
  positions: Float32Array;
  /** Horizontal hip speed at each sample, m/s. */
  hipSpeeds: Float32Array;
  /** Per segment (sample i to i + 1): drawn when its two ends are inside the span and a recorded hand span, not travelling, and not a jump. */
  usable: Uint8Array;
  /** Largest distance of a usable point from the newest usable point. */
  extent: number;
  /** False when the usable path stays within `STILL_EXTENT_METERS`: nothing is drawn. */
  drawable: boolean;
  suppressed: SuppressedCounts;
};

/** Keyframes ahead of a mark's span that are warmed with it, so its first segment is cached when it starts. */
const WARM_LEAD_SEC = 0.25;

/**
 * Samples each trace mark's fingertip node and the hips at the clip's
 * keyframe times, caching each keyframe once (a recording never changes), and
 * builds each mark's path once, ahead of its span.
 */
export class HandTraceSampler {
  private readonly sampler: ClipChainSampler;
  /** Each distinct fingertip node once, then the hips. */
  private readonly nodes: Object3D[];
  /** Per mark: its fingertip node's slot in `nodes`, shared by every mark on that node. */
  private readonly slots: number[];
  private readonly stride: number;
  private readonly hipOffset: number;
  private readonly keyed: Uint8Array;
  /** Per keyframe: each fingertip node, then the hips (xyz each). */
  private readonly positions: Float32Array;
  private readonly hipQuats: Float32Array;
  private readonly outs: Vector3[];
  private readonly outQuats: Quaternion[];
  private readonly qa = new Quaternion();
  private readonly qb = new Quaternion();
  private readonly paths: Array<MarkPath | null>;
  private warmMark = 0;
  private warmKey = -1;

  constructor(
    root: Object3D,
    clip: AnimationClip,
    readonly marks: readonly SamplerMark[],
    hips: Object3D,
    private readonly spans: Record<HandSide, Span[]>
  ) {
    this.sampler = new ClipChainSampler(root, clip);
    // One slot per distinct node, so the stride stays a few nodes however many marks a file holds.
    const tips: Object3D[] = [];
    this.slots = marks.map((mark) => {
      const found = tips.indexOf(mark.node);
      if (found >= 0) return found;
      tips.push(mark.node);
      return tips.length - 1;
    });
    this.nodes = [...tips, hips];
    this.stride = this.nodes.length * 3;
    this.hipOffset = tips.length * 3;
    const count = this.sampler.times.length;
    this.keyed = new Uint8Array(count);
    this.positions = new Float32Array(count * this.stride);
    this.hipQuats = new Float32Array(count * 4);
    this.outs = this.nodes.map(() => new Vector3());
    this.outQuats = this.nodes.map(() => new Quaternion());
    this.paths = marks.map(() => null);
  }

  get times(): Float32Array {
    return this.sampler.times;
  }

  /** The mark's fingertip node's world position at a clip time, exactly as the path samples it. */
  tipAt(mark: number, time: number, out: Vector3): Vector3 {
    this.sampler.sample(time, this.nodes, this.outs);
    return out.copy(this.outs[this.slots[mark]!]!);
  }

  isBuilt(mark: number): boolean {
    return this.paths[mark] !== null;
  }

  private key(index: number): void {
    if (this.keyed[index]) return;
    this.sampler.sample(this.sampler.times[index]!, this.nodes, this.outs, this.outQuats);
    for (let n = 0; n < this.nodes.length; n += 1) this.outs[n]!.toArray(this.positions, index * this.stride + n * 3);
    this.outQuats[this.nodes.length - 1]!.toArray(this.hipQuats, index * 4);
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

  /** Keyframes of a mark worth warming: from just before its span to its end. */
  private warmRange(mark: number): [number, number] {
    const { start, end } = this.marks[mark]!.span;
    return [this.lowerBound(start - WARM_LEAD_SEC), this.lowerBound(end + 2e-6)];
  }

  /**
   * Caches keyframes and builds paths in time order, mark by mark, for up to
   * `budgetMs`; true once every mark is built.
   */
  warm(budgetMs: number): boolean {
    const until = performance.now() + budgetMs;
    let steps = 0;
    while (this.warmMark < this.marks.length) {
      if (this.paths[this.warmMark]) {
        this.warmMark += 1;
        this.warmKey = -1;
        continue;
      }
      const [from, to] = this.warmRange(this.warmMark);
      if (this.warmKey < from) this.warmKey = from;
      if (this.warmKey < to) {
        this.key(this.warmKey);
        this.warmKey += 1;
        steps += 1;
      } else {
        this.path(this.warmMark);
        steps += 4;
      }
      if (steps >= 4 && performance.now() > until) break;
    }
    return this.warmMark >= this.marks.length;
  }

  /** The mark's path, built on first use (synchronously, whatever is not yet cached). */
  path(mark: number): MarkPath {
    return (this.paths[mark] ??= this.build(mark));
  }

  private build(markIndex: number): MarkPath {
    const { side, span } = this.marks[markIndex]!;
    const times = this.sampler.times;
    const sampleTimes: number[] = [];
    const sampleKeys: number[] = [];
    for (let i = this.lowerBound(span.start); i < times.length && times[i]! <= span.end + 1e-6; i += 1) {
      sampleTimes.push(times[i]!);
      sampleKeys.push(i);
    }
    if (sampleTimes.length === 0 || sampleTimes[0]! > span.start + 1e-6) {
      sampleTimes.unshift(span.start);
      sampleKeys.unshift(-1);
    }
    if (sampleTimes.at(-1)! < span.end - 1e-6) {
      sampleTimes.push(span.end);
      sampleKeys.push(-1);
    }

    const count = sampleTimes.length;
    const stride = this.stride;
    const pos = new Float32Array(count * stride);
    const quats = new Float32Array(count * 4);
    const hipQuat = this.nodes.length - 1;
    sampleKeys.forEach((key, s) => {
      if (key >= 0) {
        this.key(key);
        pos.set(this.positions.subarray(key * stride, key * stride + stride), s * stride);
        quats.set(this.hipQuats.subarray(key * 4, key * 4 + 4), s * 4);
      } else {
        this.sampler.sample(sampleTimes[s]!, this.nodes, this.outs, this.outQuats);
        for (let n = 0; n < this.nodes.length; n += 1) this.outs[n]!.toArray(pos, s * stride + n * 3);
        this.outQuats[hipQuat]!.toArray(quats, s * 4);
      }
    });

    // Hip speed: horizontal displacement since the keyframe 0.25 s back (less at the clip start).
    const hx = this.hipOffset;
    const hipSpeeds = new Float32Array(count);
    for (let s = 0; s < count; s += 1) {
      const t = sampleTimes[s]!;
      const back = this.lowerBound(Math.max(0, t - TRAVEL_SPEED_WINDOW_SEC));
      const dt = back < times.length ? t - times[back]! : 0;
      if (dt <= 1e-6) continue;
      this.key(back);
      const dx = pos[s * stride + hx]! - this.positions[back * stride + hx]!;
      const dz = pos[s * stride + hx + 2]! - this.positions[back * stride + hx + 2]!;
      hipSpeeds[s] = Math.hypot(dx, dz) / dt;
    }

    const suppressed: SuppressedCounts = { outsideSpan: 0, travel: 0, jumps: 0 };
    const ok = sampleTimes.map((t, s) => {
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

    const tip = this.slots[markIndex]! * 3;
    const positions = new Float32Array(count * 3);
    for (let s = 0; s < count; s += 1) {
      positions[s * 3] = pos[s * stride + tip]!;
      positions[s * 3 + 1] = pos[s * stride + tip + 1]!;
      positions[s * 3 + 2] = pos[s * stride + tip + 2]!;
    }
    const usable = new Uint8Array(Math.max(0, count - 1));
    const touched = new Uint8Array(count);
    for (let s = 1; s < count; s += 1) {
      if (!ok[s - 1] || !ok[s]) continue;
      // A root jump lies between two samples: a hip step or turn no body makes in one frame.
      const dt = sampleTimes[s]! - sampleTimes[s - 1]!;
      const hipStep = Math.hypot(pos[s * stride + hx]! - pos[(s - 1) * stride + hx]!, pos[s * stride + hx + 2]! - pos[(s - 1) * stride + hx + 2]!);
      this.qa.fromArray(quats, (s - 1) * 4);
      this.qb.fromArray(quats, s * 4);
      const rootJump = (hipStep > ROOT_JUMP_METERS && hipStep > ROOT_JUMP_SPEED * dt) || this.qa.angleTo(this.qb) > ROOT_JUMP_RADIANS;
      const step = Math.hypot(positions[s * 3]! - positions[(s - 1) * 3]!, positions[s * 3 + 1]! - positions[(s - 1) * 3 + 1]!, positions[s * 3 + 2]! - positions[(s - 1) * 3 + 2]!);
      const tipJump = step > TIP_JUMP_METERS && step > TIP_JUMP_SPEED * dt;
      if (rootJump || tipJump) {
        suppressed.jumps += 1;
        continue;
      }
      usable[s - 1] = 1;
      touched[s - 1] = 1;
      touched[s] = 1;
    }
    const used: Array<{ x: number; y: number; z: number }> = [];
    for (let s = 0; s < count; s += 1) {
      if (touched[s]) used.push({ x: positions[s * 3]!, y: positions[s * 3 + 1]!, z: positions[s * 3 + 2]! });
    }
    const extent = pathExtent(used);
    return {
      count,
      times: Float32Array.from(sampleTimes),
      positions,
      hipSpeeds,
      usable,
      extent,
      drawable: used.length > 1 && extent > STILL_EXTENT_METERS,
      suppressed
    };
  }
}
