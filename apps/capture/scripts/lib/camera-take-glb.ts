import { readGlbJson } from './pointing-score.ts';

// A pure inspector for camera takes (docs/features/ar-recording.md, slice 2a):
// Node only, no browser. `inspectCameraTake(glb)` returns a JSON-serialisable
// report of what the export contains (skins, names, the author camera and its
// sampled path, the bubble, extensions, event objects, the set's nodes), and
// the helpers below compare two reports (the same walk under two set
// placements) or list what a camera take must not contain.
//
// Units are metres in the file; the comparison helpers report centimetres and
// degrees. Times are seconds.

const MAGIC_BIN = 0x004e4942;
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

export const CAMERA_NODE_NAME = 'RecordedAuthorCamera';
export const AVATAR_NODE_NAME = 'RecordedAvatar';
export const BUBBLE_NODE_NAME = 'RecordedBubbleSphere';
export const OBJECT_NODE_NAME = 'RecordedObject';

/**
 * Names that mean chrome, a bridge or a presence marker reached the export.
 * Chrome is flagged by `userData.holoimChrome` (three's exporter writes it to
 * `extras`), which `assertCameraTake` also checks; the names catch the nodes
 * the flag cannot reach (the bridge's ray object, the presence marker).
 */
export const FORBIDDEN_NODE_NAME = /chrome|bridge|presence|\bdock\b|status[-_ ]?line|halo|reticle|laser|wrist|finger[-_ ]?mark/i;

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

type GltfNode = {
  name?: string;
  mesh?: number;
  skin?: number;
  camera?: number;
  children?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  extras?: Record<string, unknown>;
};
type GltfAnimation = {
  channels: Array<{ sampler: number; target: { node?: number; path: string } }>;
  samplers: Array<{ input: number; output: number; interpolation?: string }>;
};
type GltfFile = {
  nodes?: GltfNode[];
  skins?: unknown[];
  accessors?: Array<{ bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }>;
  bufferViews?: Array<{ byteOffset?: number; byteStride?: number; byteLength?: number }>;
  animations?: GltfAnimation[];
  extensions?: Record<string, { version?: unknown; objects?: Array<{ node?: number }>; audio?: Array<{ bufferView?: number; uri?: string }> } | undefined>;
  extensionsUsed?: string[];
};

/** Keyframes of one animated property: `values[i]` is the value at `times[i]`. */
export type Sampled = { times: number[]; values: number[][]; interpolation: string };

/** A camera path: translation (metres, `[x, y, z]`) and rotation (`[x, y, z, w]`), each sampled by time. */
export type CameraPath = { translation: Sampled | null; rotation: Sampled | null };

export type ChannelSamples = { translation?: Sampled; rotation?: Sampled; scale?: Sampled };

export type SetNode = {
  name: string;
  /** Unique key: the name, suffixed `#n` from the second node with the same name. */
  key: string;
  index: number;
  translation: Vec3;
  /** Rest position in the scene root's frame (parents composed). */
  worldTranslation: Vec3;
  animated: boolean;
};

export type CameraTakeReport = {
  skins: number;
  nodeCount: number;
  nodeNames: string[];
  animations: number;
  /** Latest keyframe time over every channel, seconds. */
  duration: number;
  hasRecordedAvatar: boolean;
  extensionsUsed: string[];
  khrAudio: boolean;
  /** `KHR_audio` audio sources and the bytes they carry (a bufferView's length or a data URI's payload). */
  audio: { sources: number; payloadBytes: number };
  /** `HOLOIM_meaning` version, or null when the file has none. */
  meaningVersion: number | null;
  holoimObjects: boolean;
  camera: null | {
    nodeIndex: number;
    parentIndex: number | null;
    /** `extras.yfov`, whatever it holds (a check asserts it is finite). */
    yfov: unknown;
    extras: Record<string, unknown> | null;
    restTranslation: Vec3;
    translationKeys: number;
    rotationKeys: number;
    /** Last keyframe time over the camera's own channels, seconds. */
    durationSec: number;
    /** A glTF `camera` on the node (it must be a plain node: presence only). */
    hasGltfCamera: boolean;
    /** Every ancestor has an identity transform. */
    ancestorsIdentity: boolean;
    /** Any ancestor is animated. */
    ancestorsAnimated: boolean;
    path: CameraPath;
  };
  bubble: null | {
    nodeIndex: number;
    channels: string[];
    animated: boolean;
    translation: Vec3;
    /** The sphere's world transform is the identity (within 1e-6): pinned at the set's origin. */
    worldIdentity: boolean;
    /** The sphere or any ancestor is animated. */
    chainAnimated: boolean;
  };
  /** Mesh nodes under `RecordedSceneBubble` that are not event objects: the set itself. */
  sceneBubbleMeshes: number;
  /** Nodes that look like chrome by their `extras.holoimChrome` flag or `FORBIDDEN_NODE_NAME`. */
  chromeNodes: string[];
  /** Event objects: `HOLOIM_objects` entries' nodes plus nodes named `RecordedObject`. */
  objects: Array<{ nodeIndex: number; name: string; channels: ChannelSamples }>;
  /** Mesh nodes that are not event objects, the camera or the bubble: the set. */
  setNodes: SetNode[];
};

function readChunks(buffer: Buffer): { bin: Buffer | null } {
  const jsonLength = buffer.readUInt32LE(12);
  let offset = 20 + jsonLength;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    if (buffer.readUInt32LE(offset + 4) === MAGIC_BIN) return { bin: buffer.subarray(offset + 8, offset + 8 + length) };
    offset += 8 + length;
  }
  return { bin: null };
}

function readAccessor(gltf: GltfFile, bin: Buffer | null, index: number): number[][] {
  const accessor = gltf.accessors?.[index];
  if (!accessor) throw new Error(`accessor ${index} missing`);
  if (accessor.componentType !== 5126) throw new Error(`accessor ${index}: expected float components`);
  if (accessor.bufferView === undefined) return Array.from({ length: accessor.count }, () => new Array<number>(COMPONENTS[accessor.type]!).fill(0));
  if (!bin) throw new Error('GLB has no binary chunk');
  const view = gltf.bufferViews![accessor.bufferView]!;
  const width = COMPONENTS[accessor.type]!;
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride ?? width * 4;
  return Array.from({ length: accessor.count }, (_, i) => Array.from({ length: width }, (__, k) => bin.readFloatLE(offset + i * stride + k * 4)));
}

function samplesOf(gltf: GltfFile, bin: Buffer | null, animation: GltfAnimation, channelIndex: number): Sampled {
  const sampler = animation.samplers[animation.channels[channelIndex]!.sampler]!;
  const times = readAccessor(gltf, bin, sampler.input).map((row) => row[0]!);
  let values = readAccessor(gltf, bin, sampler.output);
  const interpolation = sampler.interpolation ?? 'LINEAR';
  // CUBICSPLINE stores in-tangent, value, out-tangent per key: keep the values.
  if (interpolation === 'CUBICSPLINE') values = times.map((_, i) => values[i * 3 + 1]!);
  return { times, values, interpolation };
}

const round = (value: number, places = 3) => Number(value.toFixed(places));

/** Composes TRS matrices up the parent chain (column-major 4x4). */
function composeMatrix(node: GltfNode): number[] {
  const [x, y, z, w] = (node.rotation ?? [0, 0, 0, 1]) as Quat;
  const [sx, sy, sz] = (node.scale ?? [1, 1, 1]) as Vec3;
  const [tx, ty, tz] = (node.translation ?? [0, 0, 0]) as Vec3;
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1
  ];
}
function multiply(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let k = 0; k < 4; k += 1) out[column * 4 + row]! += a[k * 4 + row]! * b[column * 4 + k]!;
    }
  }
  return out;
}

/** Reads a camera take (or any capture export) from its GLB bytes. */
export function inspectCameraTake(glb: Buffer): CameraTakeReport {
  const gltf = readGlbJson(glb) as unknown as GltfFile;
  const { bin } = readChunks(glb);
  const nodes = gltf.nodes ?? [];
  const names = nodes.map((node) => node.name ?? '');
  const parents = new Map<number, number>();
  nodes.forEach((node, index) => node.children?.forEach((child) => parents.set(child, index)));

  // Channels per node, from every animation.
  const channels = new Map<number, ChannelSamples>();
  const animatedNodes = new Set<number>();
  let duration = 0;
  for (const animation of gltf.animations ?? []) {
    animation.channels.forEach((channel, channelIndex) => {
      const nodeIndex = channel.target.node;
      if (nodeIndex === undefined) return;
      animatedNodes.add(nodeIndex);
      const path = channel.target.path;
      if (path !== 'translation' && path !== 'rotation' && path !== 'scale') return;
      const sampled = samplesOf(gltf, bin, animation, channelIndex);
      duration = Math.max(duration, sampled.times[sampled.times.length - 1] ?? 0);
      const entry = channels.get(nodeIndex) ?? {};
      entry[path] = sampled;
      channels.set(nodeIndex, entry);
    });
  }

  const worldOf = (index: number): number[] => {
    let matrix = composeMatrix(nodes[index]!);
    for (let parent = parents.get(index); parent !== undefined; parent = parents.get(parent)) matrix = multiply(composeMatrix(nodes[parent]!), matrix);
    return matrix;
  };

  const cameraIndex = names.indexOf(CAMERA_NODE_NAME);
  const cameraNode = cameraIndex >= 0 ? nodes[cameraIndex]! : null;
  const cameraChannels = cameraIndex >= 0 ? (channels.get(cameraIndex) ?? {}) : {};
  const bubbleIndex = names.indexOf(BUBBLE_NODE_NAME);

  const objectIndices = new Set<number>();
  for (const entry of gltf.extensions?.HOLOIM_objects?.objects ?? []) if (typeof entry.node === 'number') objectIndices.add(entry.node);
  names.forEach((name, index) => {
    if (name === OBJECT_NODE_NAME) objectIndices.add(index);
  });

  const seen = new Map<string, number>();
  const setNodes: SetNode[] = [];
  nodes.forEach((node, index) => {
    if (node.mesh === undefined || objectIndices.has(index) || index === cameraIndex || index === bubbleIndex) return;
    const name = node.name ?? '';
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    const world = worldOf(index);
    setNodes.push({
      name,
      key: count === 1 ? name : `${name}#${count}`,
      index,
      translation: (node.translation ?? [0, 0, 0]) as Vec3,
      worldTranslation: [round(world[12]!, 6), round(world[13]!, 6), round(world[14]!, 6)],
      animated: animatedNodes.has(index)
    });
  });

  const ancestorsOf = (index: number): number[] => {
    const out: number[] = [];
    for (let parent = parents.get(index); parent !== undefined; parent = parents.get(parent)) out.push(parent);
    return out;
  };
  const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const isIdentity = (matrix: number[]) => matrix.every((value, k) => Math.abs(value - IDENTITY[k]!) <= 1e-6);
  const sceneBubbleIndex = names.indexOf('RecordedSceneBubble');
  let sceneBubbleMeshes = 0;
  if (sceneBubbleIndex >= 0) {
    const stack = [...(nodes[sceneBubbleIndex]!.children ?? [])];
    while (stack.length > 0) {
      const index = stack.pop()!;
      if (objectIndices.has(index)) continue;
      if (nodes[index]!.mesh !== undefined) sceneBubbleMeshes += 1;
      stack.push(...(nodes[index]!.children ?? []));
    }
  }
  const audioEntries = gltf.extensions?.KHR_audio?.audio ?? [];
  let audioBytes = 0;
  for (const entry of audioEntries) {
    if (typeof entry.bufferView === 'number') audioBytes += gltf.bufferViews?.[entry.bufferView]?.byteLength ?? 0;
    else if (typeof entry.uri === 'string' && entry.uri.startsWith('data:')) audioBytes += Math.max(0, entry.uri.length - entry.uri.indexOf(',') - 1);
  }

  const meaningVersion = gltf.extensions?.HOLOIM_meaning?.version;
  return {
    skins: gltf.skins?.length ?? 0,
    nodeCount: nodes.length,
    nodeNames: names,
    animations: gltf.animations?.length ?? 0,
    duration: round(duration, 6),
    hasRecordedAvatar: names.includes(AVATAR_NODE_NAME),
    extensionsUsed: gltf.extensionsUsed ?? [],
    khrAudio: Boolean(gltf.extensions?.KHR_audio) || (gltf.extensionsUsed ?? []).includes('KHR_audio'),
    audio: { sources: audioEntries.length, payloadBytes: audioBytes },
    meaningVersion: typeof meaningVersion === 'number' ? meaningVersion : gltf.extensions?.HOLOIM_meaning ? NaN : null,
    holoimObjects: Boolean(gltf.extensions?.HOLOIM_objects),
    camera: cameraNode
      ? {
        nodeIndex: cameraIndex,
        parentIndex: parents.get(cameraIndex) ?? null,
        yfov: cameraNode.extras?.yfov,
        extras: cameraNode.extras ?? null,
        restTranslation: (cameraNode.translation ?? [0, 0, 0]) as Vec3,
        translationKeys: cameraChannels.translation?.times.length ?? 0,
        rotationKeys: cameraChannels.rotation?.times.length ?? 0,
        durationSec: round(Math.max(cameraChannels.translation?.times.at(-1) ?? 0, cameraChannels.rotation?.times.at(-1) ?? 0), 6),
        hasGltfCamera: cameraNode.camera !== undefined,
        ancestorsIdentity: ancestorsOf(cameraIndex).every((ancestor) => isIdentity(composeMatrix(nodes[ancestor]!))),
        ancestorsAnimated: ancestorsOf(cameraIndex).some((ancestor) => animatedNodes.has(ancestor)),
        path: { translation: cameraChannels.translation ?? null, rotation: cameraChannels.rotation ?? null }
      }
      : null,
    bubble: bubbleIndex >= 0
      ? {
        nodeIndex: bubbleIndex,
        channels: Object.keys(channels.get(bubbleIndex) ?? {}),
        animated: animatedNodes.has(bubbleIndex),
        translation: (nodes[bubbleIndex]!.translation ?? [0, 0, 0]) as Vec3,
        worldIdentity: isIdentity(worldOf(bubbleIndex)),
        chainAnimated: animatedNodes.has(bubbleIndex) || ancestorsOf(bubbleIndex).some((ancestor) => animatedNodes.has(ancestor))
      }
      : null,
    sceneBubbleMeshes,
    chromeNodes: nodes.flatMap((node, index) => (node.extras?.holoimChrome === true || FORBIDDEN_NODE_NAME.test(names[index]!) ? [names[index] || `#${index}`] : [])),
    objects: [...objectIndices].sort((a, b) => a - b).map((nodeIndex) => ({ nodeIndex, name: names[nodeIndex] ?? '', channels: channels.get(nodeIndex) ?? {} })),
    setNodes
  };
}

// ---------------------------------------------------------------------------
// Pure comparisons

function lerp(a: number[], b: number[], t: number): number[] {
  return a.map((value, k) => value + (b[k]! - value) * t);
}

function slerp(a: number[], b: number[], t: number): number[] {
  let dot = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!;
  const sign = dot < 0 ? -1 : 1;
  dot *= sign;
  const target = b.map((value) => value * sign);
  if (dot > 0.9995) {
    const mixed = lerp(a, target, t);
    const length = Math.hypot(...mixed) || 1;
    return mixed.map((value) => value / length);
  }
  const theta = Math.acos(Math.min(1, dot));
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sin;
  const wb = Math.sin(t * theta) / sin;
  return a.map((value, k) => value * wa + target[k]! * wb);
}

/** Value at `time`, held at the ends, linear (or slerp for quaternions) between keys; STEP holds. */
function sampleAt(track: Sampled, time: number, rotation: boolean): number[] {
  const { times, values } = track;
  if (time <= times[0]!) return values[0]!;
  if (time >= times[times.length - 1]!) return values[values.length - 1]!;
  let hi = 1;
  while (times[hi]! < time) hi += 1;
  const lo = hi - 1;
  if (track.interpolation === 'STEP') return values[lo]!;
  const span = times[hi]! - times[lo]!;
  const t = span > 0 ? (time - times[lo]!) / span : 0;
  return rotation ? slerp(values[lo]!, values[hi]!, t) : lerp(values[lo]!, values[hi]!, t);
}

export type PathComparison = {
  /** Largest translation difference, centimetres. */
  maxPositionCm: number;
  /** Largest rotation difference, degrees. */
  maxRotationDeg: number;
  /** Times compared: every key of both paths inside their common time range. */
  samples: number;
  /** |duration(a) - duration(b)|, seconds (the later of each path's two last keys). */
  durationDeltaSec: number;
  /** Differences between each track's first and last key times, seconds (a truncated path shows here). */
  endDeltaSec: number;
  startDeltaSec: number;
};

/**
 * How far two sampled camera paths differ. Both are evaluated at every key
 * time of either path inside their common time range (linear for translation,
 * slerp for rotation), so a path with extra keys still compares. A missing
 * track, or no overlap in time, gives `Infinity` (serialises as null) so a
 * check fails closed.
 */
export function comparePaths(a: CameraPath, b: CameraPath): PathComparison {
  const empty: PathComparison = { maxPositionCm: Infinity, maxRotationDeg: Infinity, samples: 0, durationDeltaSec: Infinity, endDeltaSec: Infinity, startDeltaSec: Infinity };
  if (!a.translation || !b.translation || !a.rotation || !b.rotation) return empty;
  const end = (path: CameraPath) => Math.max(path.translation!.times.at(-1) ?? 0, path.rotation!.times.at(-1) ?? 0);
  const start = Math.max(a.translation.times[0] ?? 0, b.translation.times[0] ?? 0, a.rotation.times[0] ?? 0, b.rotation.times[0] ?? 0);
  const stop = Math.min(a.translation.times.at(-1) ?? 0, b.translation.times.at(-1) ?? 0, a.rotation.times.at(-1) ?? 0, b.rotation.times.at(-1) ?? 0);
  if (stop < start) return empty;
  const times = [...new Set([...a.translation.times, ...b.translation.times, ...a.rotation.times, ...b.rotation.times])].filter((time) => time >= start && time <= stop).sort((x, y) => x - y);
  let maxPositionCm = 0;
  let maxRotationDeg = 0;
  for (const time of times) {
    const pa = sampleAt(a.translation, time, false);
    const pb = sampleAt(b.translation, time, false);
    maxPositionCm = Math.max(maxPositionCm, Math.hypot(pa[0]! - pb[0]!, pa[1]! - pb[1]!, pa[2]! - pb[2]!) * 100);
    const qa = sampleAt(a.rotation, time, true);
    const qb = sampleAt(b.rotation, time, true);
    const dot = Math.abs(qa[0]! * qb[0]! + qa[1]! * qb[1]! + qa[2]! * qb[2]! + qa[3]! * qb[3]!) / ((Math.hypot(...qa) * Math.hypot(...qb)) || 1);
    maxRotationDeg = Math.max(maxRotationDeg, (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI);
  }
  const ends = [Math.abs((a.translation.times.at(-1) ?? 0) - (b.translation.times.at(-1) ?? 0)), Math.abs((a.rotation.times.at(-1) ?? 0) - (b.rotation.times.at(-1) ?? 0))];
  const starts = [Math.abs((a.translation.times[0] ?? 0) - (b.translation.times[0] ?? 0)), Math.abs((a.rotation.times[0] ?? 0) - (b.rotation.times[0] ?? 0))];
  return {
    maxPositionCm: round(maxPositionCm),
    maxRotationDeg: round(maxRotationDeg),
    samples: times.length,
    durationDeltaSec: round(Math.abs(end(a) - end(b)), 6),
    endDeltaSec: round(Math.max(...ends), 6),
    startDeltaSec: round(Math.max(...starts), 6)
  };
}

export type NodeComparison = {
  /** Largest distance between matching nodes' world positions, per `SetNode.key`, centimetres. */
  perNode: Record<string, number>;
  maxCm: number;
  /** Keys present in only one of the two. */
  onlyInA: string[];
  onlyInB: string[];
};

/** Matches nodes by `key` and measures how far each moved between two takes (centimetres). */
export function compareNodePositions(a: readonly SetNode[], b: readonly SetNode[]): NodeComparison {
  const byKey = new Map(b.map((node) => [node.key, node]));
  const perNode: Record<string, number> = {};
  const onlyInA: string[] = [];
  for (const node of a) {
    const other = byKey.get(node.key);
    if (!other) {
      onlyInA.push(node.key);
      continue;
    }
    byKey.delete(node.key);
    perNode[node.key] = round(Math.hypot(...node.worldTranslation.map((value, k) => value - other.worldTranslation[k]!)) * 100);
  }
  const values = Object.values(perNode);
  return { perNode, maxCm: values.length > 0 ? Math.max(...values) : 0, onlyInA, onlyInB: [...byKey.keys()] };
}

/** What a camera take must not have, as failure strings (empty when it is clean). */
export function assertCameraTake(report: CameraTakeReport): string[] {
  const failures: string[] = [];
  if (report.skins > 0) failures.push(`${report.skins} skin(s) in a camera take; there is no performer`);
  if (report.hasRecordedAvatar) failures.push(`${AVATAR_NODE_NAME} exists in a camera take`);
  if (!report.camera) {
    failures.push(`${CAMERA_NODE_NAME} node missing`);
  } else {
    const { yfov } = report.camera;
    if (typeof yfov !== 'number' || !Number.isFinite(yfov) || yfov <= 0 || yfov >= Math.PI) {
      failures.push(`${CAMERA_NODE_NAME} extras.yfov is ${JSON.stringify(yfov) ?? 'missing'}, not a finite number in (0, pi)`);
    }
    if (report.camera.translationKeys < 2) failures.push(`${CAMERA_NODE_NAME} has ${report.camera.translationKeys} translation keyframe(s), need at least 2`);
    if (report.camera.rotationKeys < 2) failures.push(`${CAMERA_NODE_NAME} has ${report.camera.rotationKeys} rotation keyframe(s), need at least 2`);
    for (const track of [report.camera.path.translation, report.camera.path.rotation]) {
      if (track?.values.some((row) => row.some((value) => !Number.isFinite(value)))) failures.push(`${CAMERA_NODE_NAME} has a non-finite keyframe value`);
      if (track?.times.some((time) => !Number.isFinite(time))) failures.push(`${CAMERA_NODE_NAME} has a non-finite keyframe time`);
    }
    if (report.camera.hasGltfCamera) failures.push(`${CAMERA_NODE_NAME} carries a glTF camera; it must be a plain node`);
    if (report.camera.parentIndex !== null && (!report.camera.ancestorsIdentity || report.camera.ancestorsAnimated)) {
      failures.push(`${CAMERA_NODE_NAME} is not a root node and its ancestors are not identity and unanimated`);
    }
  }
  if (!report.bubble) {
    failures.push(`${BUBBLE_NODE_NAME} missing`);
  } else {
    if (!report.bubble.worldIdentity) failures.push(`${BUBBLE_NODE_NAME} is not at the set's origin (world transform is not the identity)`);
    if (report.bubble.chainAnimated) failures.push(`${BUBBLE_NODE_NAME} or an ancestor is animated; it must be pinned (channels: ${report.bubble.channels.join(', ') || 'on an ancestor'})`);
  }
  if (report.sceneBubbleMeshes < 1) failures.push('the set is empty: no mesh node under RecordedSceneBubble');
  if (report.chromeNodes.length > 0) failures.push(`chrome, bridge or presence nodes in the export: ${report.chromeNodes.join(', ')}`);
  if (report.meaningVersion !== null && !Number.isFinite(report.meaningVersion)) failures.push('HOLOIM_meaning has no numeric version');
  if (report.khrAudio && (report.audio.sources < 1 || report.audio.payloadBytes <= 0)) {
    failures.push(`KHR_audio is declared but carries ${report.audio.sources} source(s) and ${report.audio.payloadBytes} byte(s)`);
  }
  return failures;
}
