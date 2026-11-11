import { CylinderGeometry, SphereGeometry, type BufferGeometry } from "three";

// A small hologram whose sounds have places (docs/features/positional-audio.md):
// a floor, a still sphere to the left ("Bell") and a sphere circling the
// middle ("Orbiter"), each with a positional KHR_audio emitter on its node,
// and a global tone under them. Every sound is steady, so a level read over
// a fraction of a second does not depend on when it was read.

export const SPATIAL_CLIP_S = 8;
export const BELL_POSITION: [number, number, number] = [-1.0, 1.2, 0.3];
export const ORBIT_CENTRE: [number, number, number] = [0, 1.3, 0];
export const ORBIT_RADIUS = 1.1;
/** The global tone is shorter than the clip, so it only stays in step if every motion wrap restarts it. */
export const TONE_S = 5;
const SAMPLE_RATE = 16000;

/** Deterministic band-limited noise as 16-bit mono WAV. */
function noiseWav(seconds: number, seed: number, cutoffHz: number, amplitude: number): Buffer {
  const samples = Math.round(seconds * SAMPLE_RATE);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  let state = seed >>> 0 || 1;
  const white = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x7fffffff - 1;
  };
  const a = 1 - Math.exp((-2 * Math.PI * cutoffHz) / SAMPLE_RATE);
  let y = 0;
  for (let i = 0; i < samples; i++) {
    y += a * (white() - y);
    wav.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(y * amplitude * 32767))), 44 + i * 2);
  }
  return wav;
}

function toneWav(seconds: number, hz: number, amplitude: number): Buffer {
  const wav = noiseWav(seconds, 1, 1, 0);
  const samples = Math.round(seconds * SAMPLE_RATE);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * amplitude * 32767), 44 + i * 2);
  return wav;
}

interface Gltf {
  nodes: Array<Record<string, unknown>>;
  meshes: unknown[];
  materials: unknown[];
  accessors: unknown[];
  bufferViews: unknown[];
  [key: string]: unknown;
}

/** The fixture as GLB bytes. */
export function spatialAudioGlb(): Buffer {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  const json: Gltf = { asset: { version: "2.0", generator: "holoim-e2e" }, scene: 0, scenes: [{ nodes: [] as number[] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [] };
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
  const accessor = (values: Float32Array | Uint16Array, type: "SCALAR" | "VEC3", minMax = false): number => {
    const size = type === "SCALAR" ? 1 : 3;
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
  const node = (entry: Record<string, unknown>): number => {
    json.nodes.push(entry);
    const index = json.nodes.length - 1;
    (json.scenes as Array<{ nodes: number[] }>)[0]!.nodes.push(index);
    return index;
  };

  node({ name: "Floor", mesh: mesh(new CylinderGeometry(1.5, 1.5, 0.02, 48).translate(0, -0.01, 0), material([0.05, 0.2, 0.22])) });
  node({ name: "Bell", mesh: mesh(new SphereGeometry(0.12, 20, 14), material([1, 0.55, 0.15])), translation: BELL_POSITION, extensions: { KHR_audio: { emitter: 0 } } });
  const orbiter = node({ name: "Orbiter", mesh: mesh(new SphereGeometry(0.1, 20, 14), material([0.4, 0.8, 1])), translation: [ORBIT_CENTRE[0] + ORBIT_RADIUS, ORBIT_CENTRE[1], ORBIT_CENTRE[2]], extensions: { KHR_audio: { emitter: 1 } } });

  const keys = 64;
  const times = new Float32Array(keys + 1);
  const path = new Float32Array((keys + 1) * 3);
  for (let k = 0; k <= keys; k++) {
    const t = (k / keys) * SPATIAL_CLIP_S;
    const angle = (2 * Math.PI * k) / keys;
    times[k] = t;
    path.set([ORBIT_CENTRE[0] + ORBIT_RADIUS * Math.cos(angle), ORBIT_CENTRE[1], ORBIT_CENTRE[2] - ORBIT_RADIUS * Math.sin(angle)], k * 3);
  }
  json.animations = [{ name: "SpatialTake", samplers: [{ input: accessor(times, "SCALAR", true), output: accessor(path, "VEC3"), interpolation: "LINEAR" }], channels: [{ sampler: 0, target: { node: orbiter, path: "translation" } }] }];

  const clips = [noiseWav(SPATIAL_CLIP_S, 7, 2500, 0.5), noiseWav(SPATIAL_CLIP_S, 19, 4000, 0.5), toneWav(TONE_S, 220, 0.05)];
  const audio = clips.map((wav) => ({ bufferView: view(wav), mimeType: "audio/wav" }));
  json.extensions = {
    KHR_audio: {
      audio,
      sources: audio.map((_, index) => ({ audio: index, autoPlay: false, loop: true })),
      emitters: [
        { name: "bell", type: "positional", sources: [0], gain: 1, positional: { distanceModel: "inverse", refDistance: 1, maxDistance: 100, rolloffFactor: 1 } },
        { name: "orbiter", type: "positional", sources: [1], gain: 1, positional: { distanceModel: "inverse", refDistance: 1, maxDistance: 100, rolloffFactor: 1 } },
        { name: "room", type: "global", sources: [2], gain: 1 }
      ]
    }
  };
  (json.scenes as Array<Record<string, unknown>>)[0]!.extensions = { KHR_audio: { emitters: [2] } };
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
