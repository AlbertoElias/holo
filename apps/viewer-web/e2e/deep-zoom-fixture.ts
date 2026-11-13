import { BoxGeometry, CylinderGeometry, SphereGeometry, type BufferGeometry } from "three";

import { noiseWav } from "./spatial-audio-fixture";

// A hologram with layers nested inside it (docs/features/deep-zoom.md): a
// grey body 1.8 m tall holding three `HologramLayer…` nodes, each 100, 40
// and 40 times smaller than the one before, as "The way down II" nests the
// gas, the liquid and the dark. Every layer is unlit and rigid: a marker
// sphere in its own colour at its aim, a blade that spins round it over the
// take, and a placed sound on the marker. The body has a placed sound too.
// `declared: false` builds the same file with the layers renamed, a
// hologram that declares nothing.

export const DEEP_CLIP_S = 4;
/** Each marker's radius, in its own layer's units. */
export const MARKER_RADIUS = 0.3;

export type FixtureLayer = { name: string; scale: number; translation: [number, number, number]; color: [number, number, number] };

/** Scale and translation are against the parent layer (the hologram for the first). */
export const FIXTURE_LAYERS: FixtureLayer[] = [
  { name: "gas", scale: 0.01, translation: [0, 1.0, 0.05], color: [1, 0.08, 0.08] },
  { name: "liquid", scale: 0.025, translation: [0.06, 0.03, 0], color: [0.08, 1, 0.08] },
  { name: "dark", scale: 0.025, translation: [-0.05, 0.04, 0.02], color: [0.1, 0.25, 1] }
];

/** Each layer's size against the hologram, outermost first. */
export const LAYER_SIZES = FIXTURE_LAYERS.reduce<number[]>((sizes, layer) => [...sizes, (sizes.at(-1) ?? 1) * layer.scale], []);

export function layerNodeName(layer: FixtureLayer, declared: boolean): string {
  return `${declared ? "HologramLayer" : "Layer"}_${layer.name}`;
}

interface Gltf {
  nodes: Array<Record<string, unknown> & { children?: number[] }>;
  meshes: unknown[];
  materials: unknown[];
  accessors: unknown[];
  bufferViews: unknown[];
  [key: string]: unknown;
}

export function deepZoomGlb(declared: boolean): Buffer {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  const roots: number[] = [];
  const json: Gltf = { asset: { version: "2.0", generator: "holoim-e2e" }, scene: 0, scenes: [{ nodes: roots }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [] };
  const view = (bytes: Buffer): number => {
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      byteLength += pad;
    }
    json.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length });
    chunks.push(bytes);
    byteLength += bytes.length;
    return json.bufferViews.length - 1;
  };
  const accessor = (values: Float32Array | Uint16Array, type: "SCALAR" | "VEC3" | "VEC4", minMax = false): number => {
    const size = type === "SCALAR" ? 1 : type === "VEC3" ? 3 : 4;
    const entry: Record<string, unknown> = { bufferView: view(Buffer.from(values.buffer, values.byteOffset, values.byteLength)), componentType: values instanceof Float32Array ? 5126 : 5123, count: values.length / size, type };
    if (minMax) {
      const min = new Array<number>(size).fill(Infinity);
      const max = new Array<number>(size).fill(-Infinity);
      values.forEach((value, i) => {
        min[i % size] = Math.min(min[i % size]!, value);
        max[i % size] = Math.max(max[i % size]!, value);
      });
      Object.assign(entry, { min, max });
    }
    json.accessors.push(entry);
    return json.accessors.length - 1;
  };
  const material = (color: [number, number, number]): number => json.materials.push({ pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: 0, roughnessFactor: 0.9 }, extensions: { KHR_materials_unlit: {} } }) - 1;
  const mesh = (geometry: BufferGeometry, mat: number): number => {
    const position = accessor(new Float32Array(geometry.getAttribute("position").array), "VEC3", true);
    const normal = accessor(new Float32Array(geometry.getAttribute("normal").array), "VEC3");
    const indices = accessor(new Uint16Array(geometry.index!.array), "SCALAR");
    return json.meshes.push({ primitives: [{ attributes: { POSITION: position, NORMAL: normal }, indices, material: mat }] }) - 1;
  };
  const node = (entry: Record<string, unknown>, parent: number | null = null): number => {
    json.nodes.push(entry);
    const index = json.nodes.length - 1;
    if (parent === null) roots.push(index);
    else (json.nodes[parent]!.children ??= []).push(index);
    return index;
  };

  node({ name: "Floor", mesh: mesh(new CylinderGeometry(1, 1, 0.02, 48).translate(0, -0.01, 0), material([0.12, 0.12, 0.14])) });
  node({ name: "Body", mesh: mesh(new CylinderGeometry(0.3, 0.3, 1.8, 40).translate(0, 0.9, 0), material([0.5, 0.5, 0.5])), extensions: { KHR_audio: { emitter: 0 } } });

  const spinners: number[] = [];
  let parent: number | null = null;
  FIXTURE_LAYERS.forEach((layer, index) => {
    const s = layer.scale;
    const layerNode: number = node({ name: layerNodeName(layer, declared), translation: layer.translation, scale: [s, s, s] }, parent);
    node({ name: `Marker_${layer.name}`, mesh: mesh(new SphereGeometry(MARKER_RADIUS, 24, 16), material(layer.color)), extensions: { KHR_audio: { emitter: index + 1 } } }, layerNode);
    const spin = node({ name: `Spin_${layer.name}` }, layerNode);
    node({ name: `Blade_${layer.name}`, mesh: mesh(new BoxGeometry(0.12, 0.05, 0.05), material(layer.color.map((c) => c * 0.6) as [number, number, number])), translation: [0.45, 0, 0] }, spin);
    spinners.push(spin);
    parent = layerNode;
  });

  // One turn of every blade over the take, in eighths so each key is a short slerp.
  const keys = 8;
  const times = new Float32Array(keys + 1);
  const turn = new Float32Array((keys + 1) * 4);
  for (let k = 0; k <= keys; k++) {
    times[k] = (k / keys) * DEEP_CLIP_S;
    const half = (Math.PI * k) / keys;
    turn.set([0, Math.sin(half), 0, Math.cos(half)], k * 4);
  }
  const input = accessor(times, "SCALAR", true);
  const output = accessor(turn, "VEC4");
  json.animations = [{
    name: "DeepTake",
    samplers: spinners.map(() => ({ input, output, interpolation: "LINEAR" })),
    channels: spinners.map((spin, index) => ({ sampler: index, target: { node: spin, path: "rotation" } }))
  }];

  const audio = [0, 1, 2, 3].map((seed) => ({ bufferView: view(noiseWav(DEEP_CLIP_S, 11 + seed * 7, 2500, 0.4)), mimeType: "audio/wav" }));
  json.extensions = {
    KHR_audio: {
      audio,
      sources: audio.map((_, index) => ({ audio: index, autoPlay: false, loop: true })),
      emitters: ["body", ...FIXTURE_LAYERS.map((layer) => layer.name)].map((name, index) => ({
        name,
        type: "positional",
        sources: [index],
        gain: 1,
        positional: { distanceModel: "inverse", refDistance: 1, maxDistance: 100, rolloffFactor: 1 }
      }))
    }
  };
  json.extensionsUsed = ["KHR_materials_unlit", "KHR_audio"];

  const pad = (4 - (byteLength % 4)) % 4;
  const bin = Buffer.concat([...chunks, Buffer.alloc(pad)]);
  json.buffers = [{ byteLength: bin.length }];
  let jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
  jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + bin.length, 8);
  const chunk = (type: number, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, data]);
  };
  return Buffer.concat([header, chunk(0x4e4f534a, jsonBytes), chunk(0x004e4942, bin)]);
}
