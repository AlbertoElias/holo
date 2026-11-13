import { forEachViewReference, readView, type GlbFile, type GltfAccessor, type GltfJson, type ViewSource } from "./glb-file.js";

// Q4 B (docs/features/hologram-budgets.md): smaller animation. Capture samples
// every bone every frame as float32. Keyframes that linear (or, for
// rotations, spherical) interpolation reproduces are dropped, and rotations
// are stored as normalized int16, which core glTF allows for rotation
// outputs. Every recorded frame of every reduced track is checked against
// what a viewer evaluates from the stored keys (quantized as stored): bone
// positions within 1 mm, rotations within 0.5 degrees. Morph weights and
// non-linear tracks are left as recorded.

/** The error bounds the served animation keeps at every recorded frame. */
export const ANIMATION_POSITION_BOUND_METERS = 0.001;
export const ANIMATION_ROTATION_BOUND_DEGREES = 0.5;
/** Scale tracks: relative error. */
const SCALE_BOUND = 0.001;
/** Nodes whose names start with this declare a nested layer (docs/features/deep-zoom.md). */
const LAYER_NODE_PREFIX = "HologramLayer";
/** Reduce to this share of the bound, leaving room for float rounding in the viewer. */
const BOUND_MARGIN = 0.9;

const FLOAT = 5126;
const SHORT = 5122;
const INT16_SCALE = 32767;
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC3: 3, VEC4: 4 };
/**
 * Work caps, checked on the JSON before any track is read: past either, the
 * animation is served as recorded. A 60 s take of a full avatar is ~140
 * tracks and ~1 M keys.
 */
export const MAX_ANIMATION_TRACKS = 4_000;
export const MAX_ANIMATION_KEYS = 4_000_000;
/**
 * The error check composes every node at or below an animated one at every
 * distinct recorded time, up to four times; past this many node-frames the
 * animation is served as recorded. A 60 s avatar take is ~4 k frames × ~70 nodes.
 */
export const MAX_ANIMATION_NODE_FRAMES = 20_000_000;

export type AnimationReport = {
  tracks: number;
  reducedTracks: number;
  keysBefore: number;
  keysAfter: number;
  /** Bytes of the reduced tracks' input and output views, before and after. */
  bytesBefore: number;
  bytesAfter: number;
  /** Bytes of every animation view, before and after (weights and untouched tracks included). */
  allAnimationBytesBefore: number;
  allAnimationBytesAfter: number;
  /**
   * Largest error at any recorded frame of any reduced track, in the track's
   * parent space (scaled to meters) and degrees. Inside a nested layer
   * (`HologramLayer…`) positions are in that layer's units: as if it were
   * full size.
   */
  maxPositionErrorMm: number;
  maxRotationErrorDeg: number;
  maxScaleError: number;
  /** The same, measured on world-space bone positions and rotations at every recorded frame (forward kinematics). */
  world: { frames: number; maxPositionErrorMm: number; maxRotationErrorDeg: number };
  /** Set when a cap stopped the reduction: the animation is served as recorded. */
  skipped?: "too-many-tracks" | "too-many-keys" | "too-many-node-frames";
};

type Track = {
  times: Float32Array;
  values: Float32Array;
  components: number;
};

async function readFloatAccessor(glb: GlbFile, json: GltfJson, index: number): Promise<Float32Array | null> {
  const accessor = json.accessors?.[index];
  if (!accessor || accessor.componentType !== FLOAT || accessor.sparse || typeof accessor.bufferView !== "number") return null;
  const components = COMPONENTS[accessor.type];
  if (!components) return null;
  const view = json.bufferViews?.[accessor.bufferView];
  if (!view) return null;
  const count = accessor.count;
  const stride = view.byteStride ?? components * 4;
  const offset = accessor.byteOffset ?? 0;
  // Bounds first, from the JSON: nothing is read or allocated for an accessor
  // whose last element would fall outside its view.
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_ANIMATION_KEYS) return null;
  if (!Number.isSafeInteger(stride) || stride < components * 4 || !Number.isSafeInteger(offset) || offset < 0) return null;
  if (!Number.isSafeInteger(view.byteLength) || offset + (count - 1) * stride + components * 4 > view.byteLength) return null;
  const bytes = await readView(glb, accessor.bufferView);
  if (offset + (count - 1) * stride + components * 4 > bytes.byteLength) return null;
  const out = new Float32Array(count * components);
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < accessor.count; i++) {
    for (let c = 0; c < components; c++) {
      const at = offset + i * stride + c * 4;
      if (at + 4 > bytes.byteLength) return null;
      out[i * components + c] = data.getFloat32(at, true);
    }
  }
  return out;
}

// ---- quaternions ----------------------------------------------------------

function normalize4(v: Float64Array | number[], at = 0): void {
  const length = Math.hypot(v[at]!, v[at + 1]!, v[at + 2]!, v[at + 3]!) || 1;
  for (let c = 0; c < 4; c++) v[at + c] = v[at + c]! / length;
}

/** Spherical interpolation the way three.js (and the glTF spec) evaluates it: shortest path, normalized. */
function slerp(a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number, t: number, out: Float64Array): void {
  let bx = b[bi]!;
  let by = b[bi + 1]!;
  let bz = b[bi + 2]!;
  let bw = b[bi + 3]!;
  const ax = a[ai]!;
  const ay = a[ai + 1]!;
  const az = a[ai + 2]!;
  const aw = a[ai + 3]!;
  let dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let s0 = 1 - t;
  let s1 = t;
  if (1 - dot > 1e-6) {
    const theta = Math.acos(Math.min(1, dot));
    const sin = Math.sin(theta);
    s0 = Math.sin(s0 * theta) / sin;
    s1 = Math.sin(t * theta) / sin;
  }
  out[0] = ax * s0 + bx * s1;
  out[1] = ay * s0 + by * s1;
  out[2] = az * s0 + bz * s1;
  out[3] = aw * s0 + bw * s1;
  normalize4(out);
}

function angleBetween(a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number): number {
  const la = Math.hypot(a[ai]!, a[ai + 1]!, a[ai + 2]!, a[ai + 3]!) || 1;
  const lb = Math.hypot(b[bi]!, b[bi + 1]!, b[bi + 2]!, b[bi + 3]!) || 1;
  const dot = Math.abs(a[ai]! * b[bi]! + a[ai + 1]! * b[bi + 1]! + a[ai + 2]! * b[bi + 2]! + a[ai + 3]! * b[bi + 3]!) / (la * lb);
  return 2 * Math.acos(Math.min(1, dot));
}

// ---- reduction ------------------------------------------------------------

type Kind = "translation" | "rotation" | "scale";

/** Stored key values as the viewer reads them back: rotations normalized and quantized to int16. */
function storedValues(kind: Kind, values: Float32Array): Float32Array {
  if (kind !== "rotation") return values;
  const out = new Float32Array(values.length);
  const q = new Float64Array(4);
  for (let i = 0; i < values.length; i += 4) {
    for (let c = 0; c < 4; c++) q[c] = values[i + c]!;
    normalize4(q);
    for (let c = 0; c < 4; c++) out[i + c] = Math.max(Math.round(q[c]! * INT16_SCALE) / INT16_SCALE, -1);
  }
  return out;
}

type Measure = (track: Track, stored: Float32Array, from: number, to: number) => number;

function measureFor(kind: Kind): Measure {
  const q = new Float64Array(4);
  if (kind === "rotation") {
    return (track, stored, from, to) => {
      let worst = 0;
      const t0 = track.times[from]!;
      const span = track.times[to]! - t0;
      for (let k = from + 1; k < to; k++) {
        slerp(stored, from * 4, stored, to * 4, span > 0 ? (track.times[k]! - t0) / span : 0, q);
        worst = Math.max(worst, angleBetween(q, 0, track.values, k * 4));
      }
      return worst;
    };
  }
  return (track, stored, from, to) => {
    let worst = 0;
    const t0 = track.times[from]!;
    const span = track.times[to]! - t0;
    for (let k = from + 1; k < to; k++) {
      const t = span > 0 ? (track.times[k]! - t0) / span : 0;
      let sum = 0;
      for (let c = 0; c < 3; c++) {
        const value = stored[from * 3 + c]! * (1 - t) + stored[to * 3 + c]! * t;
        const diff = value - track.values[k * 3 + c]!;
        sum += diff * diff;
      }
      worst = Math.max(worst, Math.sqrt(sum));
    }
    return worst;
  };
}

/**
 * Greedy key selection: from each kept key, the farthest next key whose
 * segment reproduces every recorded frame between them within `tolerance`
 * (exponential then binary search; every accepted segment is checked in full).
 */
function selectKeys(track: Track, stored: Float32Array, measure: Measure, tolerance: number): number[] {
  const count = track.times.length;
  const keys = [0];
  let from = 0;
  const ok = (to: number) => measure(track, stored, from, to) <= tolerance;
  while (from < count - 1) {
    let good = from + 1;
    let step = 1;
    let bad = -1;
    while (good + step < count) {
      const probe = good + step;
      if (ok(probe)) {
        good = probe;
        step *= 2;
      } else {
        bad = probe;
        break;
      }
    }
    if (bad < 0 && good < count - 1) bad = count;
    if (bad > 0) {
      let low = good;
      let high = Math.min(bad, count) - 1;
      // Largest checked-good index in (good, bad).
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (ok(mid)) low = mid;
        else high = mid - 1;
      }
      good = low;
    }
    keys.push(good);
    from = good;
  }
  return keys;
}

// ---- node transforms ------------------------------------------------------

type Trs = { t: number[]; r: number[]; s: number[] };

function restTrs(node: NonNullable<GltfJson["nodes"]>[number]): Trs {
  if (node.matrix && node.matrix.length === 16) {
    const m = node.matrix;
    const sx = Math.hypot(m[0]!, m[1]!, m[2]!);
    const sy = Math.hypot(m[4]!, m[5]!, m[6]!);
    const sz = Math.hypot(m[8]!, m[9]!, m[10]!);
    return { t: [m[12]!, m[13]!, m[14]!], r: matrixToQuat(m, sx, sy, sz), s: [sx, sy, sz] };
  }
  return { t: [...(node.translation ?? [0, 0, 0])], r: [...(node.rotation ?? [0, 0, 0, 1])], s: [...(node.scale ?? [1, 1, 1])] };
}

function matrixToQuat(m: number[], sx: number, sy: number, sz: number): number[] {
  const m00 = m[0]! / sx, m01 = m[4]! / sy, m02 = m[8]! / sz;
  const m10 = m[1]! / sx, m11 = m[5]! / sy, m12 = m[9]! / sz;
  const m20 = m[2]! / sx, m21 = m[6]! / sy, m22 = m[10]! / sz;
  const trace = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s; x = (m21 - m12) * s; y = (m02 - m20) * s; z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
  }
  return [x, y, z, w];
}

function quatMultiply(a: number[], b: number[]): number[] {
  const [ax, ay, az, aw] = a as [number, number, number, number];
  const [bx, by, bz, bw] = b as [number, number, number, number];
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz
  ];
}

function rotate(q: number[], v: number[]): number[] {
  const [qx, qy, qz, qw] = q as [number, number, number, number];
  const [vx, vy, vz] = v as [number, number, number];
  const ix = qw * vx + qy * vz - qz * vy;
  const iy = qw * vy + qz * vx - qx * vz;
  const iz = qw * vz + qx * vy - qy * vx;
  const iw = -qx * vx - qy * vy - qz * vz;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx
  ];
}

/** World transform as (position, rotation, uniform-ish scale vector), composed down the hierarchy. */
type World = { p: number[]; r: number[]; s: number[] };

function compose(parent: World, local: Trs): World {
  const scaled = [local.t[0]! * parent.s[0]!, local.t[1]! * parent.s[1]!, local.t[2]! * parent.s[2]!];
  const offset = rotate(parent.r, scaled);
  return {
    p: [parent.p[0]! + offset[0]!, parent.p[1]! + offset[1]!, parent.p[2]! + offset[2]!],
    r: quatMultiply(parent.r, local.r),
    s: [parent.s[0]! * local.s[0]!, parent.s[1]! * local.s[1]!, parent.s[2]! * local.s[2]!]
  };
}

function parentsOf(json: GltfJson): Int32Array {
  const parents = new Int32Array(json.nodes?.length ?? 0).fill(-1);
  (json.nodes ?? []).forEach((node, index) => {
    for (const child of node.children ?? []) if (child >= 0 && child < parents.length) parents[child] = index;
  });
  return parents;
}

/** Nodes ordered parents first. */
function topological(parents: Int32Array): number[] {
  const order: number[] = [];
  const seen = new Uint8Array(parents.length);
  const visit = (index: number) => {
    if (seen[index]) return;
    seen[index] = 1;
    if (parents[index]! >= 0) visit(parents[index]!);
    order.push(index);
  };
  for (let i = 0; i < parents.length; i++) visit(i);
  return order;
}

/** The largest scale a node's local translation is multiplied by on its way to world space (rest pose). */
function parentWorldScales(json: GltfJson, parents: Int32Array, order: number[]): Float64Array {
  const worlds: World[] = [];
  const identity: World = { p: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] };
  for (const index of order) worlds[index] = compose(parents[index]! >= 0 ? worlds[parents[index]!]! : identity, restTrs(json.nodes![index]!));
  const scales = new Float64Array(parents.length).fill(1);
  for (let i = 0; i < parents.length; i++) {
    const parent = parents[i]! >= 0 ? worlds[parents[i]!]! : identity;
    scales[i] = Math.max(Math.abs(parent.s[0]!), Math.abs(parent.s[1]!), Math.abs(parent.s[2]!)) || 1;
  }
  return scales;
}

/**
 * The unit each node's motion is judged in: 1 (metres), or inside a nested
 * layer (a node named `HologramLayer…`, docs/features/deep-zoom.md) that
 * layer's world size, so a bound of 1 mm is 1 mm as seen from inside the
 * layer rather than 1 mm against the whole hologram. A node's unit is that of
 * its nearest layer at or above it (rest pose); never above 1.
 */
function layerUnits(json: GltfJson, parents: Int32Array, order: number[]): Float64Array {
  const units = new Float64Array(parents.length).fill(1);
  const worlds: World[] = [];
  const identity: World = { p: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] };
  for (const index of order) {
    const node = json.nodes![index]!;
    const parent = parents[index]!;
    worlds[index] = compose(parent >= 0 ? worlds[parent]! : identity, restTrs(node));
    if (typeof node.name === "string" && node.name.startsWith(LAYER_NODE_PREFIX)) {
      const s = worlds[index]!.s;
      const size = Math.max(Math.abs(s[0]!), Math.abs(s[1]!), Math.abs(s[2]!));
      units[index] = size > 0 ? Math.min(size, 1) : 1;
    } else if (parent >= 0) {
      units[index] = units[parent]!;
    }
  }
  return units;
}

function sampleAt(times: Float32Array, values: Float32Array, components: number, kind: Kind, t: number, out: number[]): void {
  const count = times.length;
  if (t <= times[0]! || count === 1) {
    for (let c = 0; c < components; c++) out[c] = values[c]!;
    return;
  }
  if (t >= times[count - 1]!) {
    for (let c = 0; c < components; c++) out[c] = values[(count - 1) * components + c]!;
    return;
  }
  let low = 0;
  let high = count - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (times[mid]! <= t) low = mid;
    else high = mid;
  }
  const span = times[high]! - times[low]!;
  const u = span > 0 ? (t - times[low]!) / span : 0;
  if (kind === "rotation") {
    const q = new Float64Array(4);
    slerp(values, low * 4, values, high * 4, u, q);
    for (let c = 0; c < 4; c++) out[c] = q[c]!;
    return;
  }
  for (let c = 0; c < components; c++) out[c] = values[low * components + c]! * (1 - u) + values[high * components + c]! * u;
}

// ---- the pass -------------------------------------------------------------

type Reduced = { node: number; kind: Kind; original: Track; times: Float32Array; values: Float32Array };

function viewBytes(json: GltfJson, accessorIndex: number): { view: number; bytes: number } | null {
  const accessor = json.accessors?.[accessorIndex];
  if (!accessor || typeof accessor.bufferView !== "number") return null;
  return { view: accessor.bufferView, bytes: json.bufferViews?.[accessor.bufferView]?.byteLength ?? 0 };
}

function animationViewBytes(json: GltfJson): number {
  const views = new Set<number>();
  for (const clip of json.animations ?? []) {
    for (const sampler of clip.samplers) {
      for (const index of [sampler.input, sampler.output]) {
        const found = viewBytes(json, index);
        if (found) views.add(found.view);
      }
    }
  }
  let total = 0;
  for (const view of views) total += json.bufferViews?.[view]?.byteLength ?? 0;
  return total;
}


type Candidate = {
  sampler: { input: number; output: number };
  kind: Kind;
  nodes: number[];
  track: Track;
  stored: Float32Array;
  parentScale: number;
  /** The unit its motion is judged in: 1, or the size of the nested layer it is in. */
  unit: number;
  /** Rest-pose world distance from the track's node to its farthest descendant (meters). */
  reach: number;
};

type Selection = { keys: number[]; times: Float32Array; values: Float32Array };

function select(candidate: Candidate, tolerance: number): Selection {
  const { track, stored } = candidate;
  const keys = selectKeys(track, stored, measureFor(candidate.kind), tolerance);
  const times = new Float32Array(keys.length);
  const values = new Float32Array(keys.length * track.components);
  keys.forEach((key, i) => {
    times[i] = track.times[key]!;
    for (let c = 0; c < track.components; c++) values[i * track.components + c] = stored[key * track.components + c]!;
  });
  return { keys, times, values };
}

/** Rest-pose world positions, and for each node the farthest world distance to any of its descendants. */
function reaches(json: GltfJson, parents: Int32Array, order: number[]): Float64Array {
  const identity: World = { p: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] };
  const worlds: World[] = [];
  for (const index of order) worlds[index] = compose(parents[index]! >= 0 ? worlds[parents[index]!]! : identity, restTrs(json.nodes![index]!));
  const reach = new Float64Array(parents.length);
  for (let node = 0; node < parents.length; node++) {
    for (let ancestor = parents[node]!; ancestor >= 0; ancestor = parents[ancestor]!) {
      const a = worlds[ancestor]!.p;
      const b = worlds[node]!.p;
      reach[ancestor] = Math.max(reach[ancestor]!, Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!));
    }
  }
  return reach;
}

/**
 * Reduces every linear translation, rotation and scale track of `json` (a
 * copy the caller will write), pushing the new views onto `json.bufferViews`
 * with their bytes in `replace`. Returns the views it orphaned (the caller
 * drops those nothing else references) and the report.
 *
 * Errors add up down a bone chain (a shoulder's rotation error moves the
 * hand), so each track gets a share of the bound: the bound divided by the
 * number of animated tracks on the longest chain, and for rotations also the
 * position bound over the bone's reach. The result is then checked in world
 * space at every recorded frame (forward kinematics against the original);
 * if any bone is off by more than the bound, the shares are halved and the
 * selection redone, and after the last try the animation is left as recorded.
 */
export async function reduceAnimations(
  glb: GlbFile,
  json: GltfJson,
  replace: Map<number, ViewSource>
): Promise<{ orphaned: Set<number>; report: AnimationReport }> {
  const report: AnimationReport = {
    tracks: 0,
    reducedTracks: 0,
    keysBefore: 0,
    keysAfter: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    allAnimationBytesBefore: animationViewBytes(json),
    allAnimationBytesAfter: 0,
    maxPositionErrorMm: 0,
    maxRotationErrorDeg: 0,
    maxScaleError: 0,
    world: { frames: 0, maxPositionErrorMm: 0, maxRotationErrorDeg: 0 }
  };
  const orphaned = new Set<number>();
  const parents = parentsOf(json);
  const order = topological(parents);
  const scales = parentWorldScales(json, parents, order);
  const reach = reaches(json, parents, order);
  const units = layerUnits(json, parents, order);

  const accessorUses = new Map<number, number>();
  for (const clip of json.animations ?? []) {
    for (const sampler of clip.samplers) {
      for (const index of [sampler.input, sampler.output]) accessorUses.set(index, (accessorUses.get(index) ?? 0) + 1);
    }
  }

  // ---- the caps, on the JSON alone ----
  let trackCount = 0;
  let keyCount = 0;
  for (const clip of json.animations ?? []) {
    for (const sampler of clip.samplers) {
      trackCount += 1;
      const count = json.accessors?.[sampler.input]?.count;
      keyCount += typeof count === "number" && Number.isFinite(count) && count > 0 ? count : 0;
    }
  }
  if (trackCount > MAX_ANIMATION_TRACKS || keyCount > MAX_ANIMATION_KEYS) {
    report.skipped = trackCount > MAX_ANIMATION_TRACKS ? "too-many-tracks" : "too-many-keys";
    report.tracks = trackCount;
    report.allAnimationBytesAfter = report.allAnimationBytesBefore;
    return { orphaned, report };
  }

  // ---- read the reducible tracks ----
  const candidates: Candidate[] = [];
  for (const clip of json.animations ?? []) {
    for (let samplerIndex = 0; samplerIndex < clip.samplers.length; samplerIndex++) {
      const sampler = clip.samplers[samplerIndex]!;
      const channels = clip.channels.filter((channel) => channel.sampler === samplerIndex);
      if (channels.length === 0) continue;
      const kinds = new Set(channels.map((channel) => channel.target.path));
      if (kinds.size !== 1) continue;
      const kind = channels[0]!.target.path as Kind;
      if (kind !== "translation" && kind !== "rotation" && kind !== "scale") continue;
      report.tracks += 1;
      if ((sampler.interpolation ?? "LINEAR") !== "LINEAR") continue;
      const components = kind === "rotation" ? 4 : 3;
      const times = await readFloatAccessor(glb, json, sampler.input);
      const values = await readFloatAccessor(glb, json, sampler.output);
      if (!times || !values || values.length !== times.length * components || times.length < 3) continue;
      const nodes = channels.map((channel) => channel.target.node ?? -1).filter((node) => node >= 0);
      candidates.push({
        sampler,
        kind,
        nodes,
        track: { times, values, components },
        stored: storedValues(kind, values),
        parentScale: nodes.length ? Math.max(...nodes.map((node) => scales[node] ?? 1)) : 1,
        unit: nodes.length ? Math.min(...nodes.map((node) => units[node] ?? 1)) : 1,
        reach: nodes.length ? Math.max(...nodes.map((node) => reach[node] ?? 0)) : 0
      });
    }
  }
  if (candidates.length === 0) {
    report.allAnimationBytesAfter = report.allAnimationBytesBefore;
    return { orphaned, report };
  }

  // ---- the bound's share per track ----
  const ownTracks = new Map<number, { all: number; rotation: number }>();
  for (const candidate of candidates) {
    for (const node of candidate.nodes) {
      const own = ownTracks.get(node) ?? { all: 0, rotation: 0 };
      if (candidate.kind !== "scale") own.all += 1;
      if (candidate.kind === "rotation") own.rotation += 1;
      ownTracks.set(node, own);
    }
  }
  let chainAll = 1;
  let chainRotation = 1;
  for (let node = 0; node < parents.length; node++) {
    let all = 0;
    let rotation = 0;
    for (let at = node; at >= 0; at = parents[at]!) {
      all += ownTracks.get(at)?.all ?? 0;
      rotation += ownTracks.get(at)?.rotation ?? 0;
    }
    chainAll = Math.max(chainAll, all);
    chainRotation = Math.max(chainRotation, rotation);
  }
  const rotationBound = (ANIMATION_ROTATION_BOUND_DEGREES * Math.PI) / 180;
  const tolerance = (candidate: Candidate, share: number): number => {
    if (candidate.kind === "rotation") {
      const byAngle = rotationBound / chainRotation;
      const byReach = candidate.reach > 0 ? (ANIMATION_POSITION_BOUND_METERS * candidate.unit) / (chainAll * candidate.reach) : Infinity;
      return Math.min(byAngle, byReach) * share * BOUND_MARGIN;
    }
    if (candidate.kind === "translation") return ((ANIMATION_POSITION_BOUND_METERS * candidate.unit / chainAll) * share * BOUND_MARGIN) / candidate.parentScale;
    let largest = 1e-6;
    // A loop, not Math.max(...values): a long track overflows the call stack.
    for (const value of candidate.track.values) largest = Math.max(largest, Math.abs(value));
    return SCALE_BOUND * share * BOUND_MARGIN * largest;
  };

  if (nodeFrames(parents, order, candidates) > MAX_ANIMATION_NODE_FRAMES) {
    report.skipped = "too-many-node-frames";
    report.allAnimationBytesAfter = report.allAnimationBytesBefore;
    return { orphaned, report };
  }

  let selections: Selection[] | null = null;
  let world: AnimationReport["world"] = { frames: 0, maxPositionErrorMm: 0, maxRotationErrorDeg: 0 };
  for (const share of [1, 0.5, 0.25, 0.125]) {
    const tried = candidates.map((candidate) => select(candidate, tolerance(candidate, share)));
    const reduced: Reduced[] = [];
    candidates.forEach((candidate, i) => {
      for (const node of candidate.nodes) reduced.push({ node, kind: candidate.kind, original: candidate.track, times: tried[i]!.times, values: tried[i]!.values });
    });
    world = worldError(json, parents, order, reduced, units);
    if (world.maxPositionErrorMm <= ANIMATION_POSITION_BOUND_METERS * 1000 && world.maxRotationErrorDeg <= ANIMATION_ROTATION_BOUND_DEGREES) {
      selections = tried;
      break;
    }
  }
  if (!selections) {
    // Left as recorded: the report says what the last try reached.
    report.world = world;
    report.allAnimationBytesAfter = report.allAnimationBytesBefore;
    return { orphaned, report };
  }
  report.world = world;

  // ---- write the reduced tracks ----
  const countedViews = new Set<number>();
  const pushView = (bytes: Uint8Array): number => {
    json.bufferViews ??= [];
    const index = json.bufferViews.push({ buffer: 0, byteLength: bytes.byteLength }) - 1;
    replace.set(index, { bytes });
    return index;
  };
  const setAccessor = (index: number, next: GltfAccessor): number => {
    const accessors = json.accessors!;
    const old = accessors[index]!;
    if (typeof old.bufferView === "number") orphaned.add(old.bufferView);
    if (accessorUses.get(index) === 1) {
      accessors[index] = { ...(old.name ? { name: old.name } : {}), ...next };
      return index;
    }
    return accessors.push(next) - 1;
  };
  candidates.forEach((candidate, i) => {
    const { keys, times, values } = selections![i]!;
    const { kind, track, stored, sampler } = candidate;
    const measure = measureFor(kind);
    let worst = 0;
    for (let k = 0; k < keys.length - 1; k++) worst = Math.max(worst, measure(track, stored, keys[k]!, keys[k + 1]!));
    if (kind === "rotation") {
      for (const key of keys) worst = Math.max(worst, angleBetween(stored, key * 4, track.values, key * 4));
      report.maxRotationErrorDeg = Math.max(report.maxRotationErrorDeg, (worst * 180) / Math.PI);
    } else if (kind === "translation") {
      report.maxPositionErrorMm = Math.max(report.maxPositionErrorMm, (worst * candidate.parentScale * 1000) / candidate.unit);
    } else {
      report.maxScaleError = Math.max(report.maxScaleError, worst);
    }

    let outputBytes: Uint8Array;
    let output: GltfAccessor;
    if (kind === "rotation") {
      const quantized = new Int16Array(keys.length * 4);
      for (let q = 0; q < quantized.length; q++) quantized[q] = Math.round(values[q]! * INT16_SCALE);
      outputBytes = new Uint8Array(quantized.buffer);
      output = { bufferView: pushView(outputBytes), componentType: SHORT, normalized: true, count: keys.length, type: "VEC4" };
    } else {
      outputBytes = new Uint8Array(values.buffer);
      output = { bufferView: pushView(outputBytes), componentType: FLOAT, count: keys.length, type: "VEC3" };
    }
    const inputBytes = new Uint8Array(times.buffer);
    const input: GltfAccessor = {
      bufferView: pushView(inputBytes),
      componentType: FLOAT,
      count: keys.length,
      type: "SCALAR",
      min: [times[0]!],
      max: [times[times.length - 1]!]
    };
    for (const index of [sampler.input, sampler.output]) {
      const found = viewBytes(json, index);
      if (found && !countedViews.has(found.view)) {
        countedViews.add(found.view);
        report.bytesBefore += found.bytes;
      }
    }
    sampler.input = setAccessor(sampler.input, input);
    sampler.output = setAccessor(sampler.output, output);
    report.bytesAfter += inputBytes.byteLength + outputBytes.byteLength;
    report.reducedTracks += 1;
    report.keysBefore += track.times.length;
    report.keysAfter += keys.length;
  });

  // Views still referenced (shared with an untouched accessor) stay.
  forEachViewReference(json, (_holder, _key, index) => orphaned.delete(index));
  report.allAnimationBytesAfter = animationViewBytes(json);
  return { orphaned, report };
}

/** The error check's work: distinct recorded times × nodes at or below an animated node. */
function nodeFrames(parents: Int32Array, order: number[], candidates: Candidate[]): number {
  const times = new Set<number>();
  const animated = new Uint8Array(parents.length);
  for (const candidate of candidates) {
    for (const time of candidate.track.times) times.add(time);
    for (const node of candidate.nodes) animated[node] = 1;
  }
  let moving = 0;
  for (const index of order) {
    if (!animated[index] && parents[index]! >= 0 && animated[parents[index]!]) animated[index] = 1;
    moving += animated[index]!;
  }
  return times.size * moving;
}

/**
 * Forward kinematics at every recorded frame of the reduced tracks, original
 * against reduced: the largest world-space position (mm, in the node's layer
 * unit) and rotation (deg) difference of any node.
 */
function worldError(json: GltfJson, parents: Int32Array, order: number[], tracks: Reduced[], units: Float64Array): AnimationReport["world"] {
  if (tracks.length === 0) return { frames: 0, maxPositionErrorMm: 0, maxRotationErrorDeg: 0 };
  const frameSet = new Set<number>();
  for (const track of tracks) for (const time of track.original.times) frameSet.add(time);
  const frames = [...frameSet].sort((a, b) => a - b);
  const rest = (json.nodes ?? []).map(restTrs);
  const byNode = new Map<number, Reduced[]>();
  for (const track of tracks) byNode.set(track.node, [...(byNode.get(track.node) ?? []), track]);
  // Only nodes at or below an animated node can move.
  const moving = new Uint8Array(parents.length);
  for (const index of order) moving[index] = byNode.has(index) || (parents[index]! >= 0 && moving[parents[index]!]) ? 1 : 0;
  const identity: World = { p: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] };
  const restWorlds = new Map<number, World>();
  const sample = [0, 0, 0, 0];
  let maxPosition = 0;
  let maxRotation = 0;
  const original: World[] = new Array(parents.length);
  const reduced: World[] = new Array(parents.length);
  for (const time of frames) {
    for (const index of order) {
      if (!moving[index]) continue;
      const localA: Trs = { t: [...rest[index]!.t], r: [...rest[index]!.r], s: [...rest[index]!.s] };
      const localB: Trs = { t: [...rest[index]!.t], r: [...rest[index]!.r], s: [...rest[index]!.s] };
      for (const track of byNode.get(index) ?? []) {
        const key = track.kind === "translation" ? "t" : track.kind === "rotation" ? "r" : "s";
        sampleAt(track.original.times, track.original.values, track.original.components, track.kind, time, sample);
        localA[key] = sample.slice(0, track.original.components);
        sampleAt(track.times, track.values, track.original.components, track.kind, time, sample);
        localB[key] = sample.slice(0, track.original.components);
      }
      const parent = parents[index]!;
      original[index] = compose(parent >= 0 && moving[parent] ? original[parent]! : parent >= 0 ? restWorld(parent) : identity, localA);
      reduced[index] = compose(parent >= 0 && moving[parent] ? reduced[parent]! : parent >= 0 ? restWorld(parent) : identity, localB);
      const a = original[index]!;
      const b = reduced[index]!;
      maxPosition = Math.max(maxPosition, Math.hypot(a.p[0]! - b.p[0]!, a.p[1]! - b.p[1]!, a.p[2]! - b.p[2]!) / units[index]!);
      maxRotation = Math.max(maxRotation, angleBetween(a.r, 0, b.r, 0));
    }
  }
  return { frames: frames.length, maxPositionErrorMm: maxPosition * 1000, maxRotationErrorDeg: (maxRotation * 180) / Math.PI };

  function restWorld(index: number): World {
    const cached = restWorlds.get(index);
    if (cached) return cached;
    const parent = parents[index]!;
    const world = compose(parent >= 0 ? restWorld(parent) : identity, rest[index]!);
    restWorlds.set(index, world);
    return world;
  }
}
