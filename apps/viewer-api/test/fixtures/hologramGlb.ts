import { deflateSync, gzipSync } from "node:zlib";

import { spzDecodedBytes } from "@holoim/contracts";

// Builds capture-shaped GLBs for the hologram-budgets route checks: an avatar
// bone chain with a recorded 120 Hz animation, a recorded object and its
// HOLOIM_objects record, a HOLOIM_meaning record, a KHR_audio clip, a base
// colour texture, and a HOLOIM_place with an optional detail level.

/** A valid SPZ (v2, all-zero splats) of `numPoints` splats and SH degree `shDegree`. */
export function spz(numPoints: number, shDegree = 0, fill = 0): Buffer {
  const decoded = Buffer.alloc(spzDecodedBytes({ version: 2, numPoints, shDegree }), fill);
  decoded.writeUInt32LE(0x5053474e, 0);
  decoded.writeUInt32LE(2, 4);
  decoded.writeUInt32LE(numPoints, 8);
  decoded.writeUInt8(shDegree, 12);
  decoded.writeUInt8(12, 13);
  decoded.writeUInt8(0, 14);
  decoded.writeUInt8(0, 15);
  return gzipSync(decoded);
}

/** An SPZ whose header claims one splat but whose stream inflates to 8 MB: a gzip bomb. */
export function spzBomb(): Buffer {
  const decoded = Buffer.alloc(8 * 1024 * 1024);
  decoded.writeUInt32LE(0x5053474e, 0);
  decoded.writeUInt32LE(2, 4);
  decoded.writeUInt32LE(1, 8);
  return gzipSync(decoded);
}

function crc32(bytes: Buffer): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** An RGB PNG of a gradient, `width` x `height`. */
export function png(width: number, height: number, flat = false): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = flat ? 200 : (x * 255) / width;
      raw[row + 2 + x * 3] = flat ? 120 : (y * 255) / height;
      raw[row + 3 + x * 3] = 128;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

export type PlaceSpec = {
  light: Buffer;
  splatCount: number;
  maxSh?: number;
  detail?: { spz: Buffer; splatCount: number; maxSh?: number };
};

export type HologramGlbSpec = {
  place?: PlaceSpec;
  /** Width and height of the base colour texture; none when omitted. */
  texture?: { width: number; height: number; /** One colour: the PNG deflates to a few hundred bytes. */ flat?: boolean };
  /** Recorded frames at 120 Hz (default 240). */
  frames?: number;
  /** Pad the file to exactly this many bytes with an unreferenced view. */
  padTo?: number;
  /** Edits the finished glTF JSON (accessors, bufferViews, animations) before it is written. */
  mutate?: (json: { accessors: Array<Record<string, unknown>>; animations: Array<{ samplers: Array<{ input: number; output: number }> }> }) => void;
};

export const MEANING = {
  version: 1,
  marks: [{ kind: "trace", id: "t1", hand: "right", start: 0.25, end: 1.5, points: [[0, 1, 0], [0.1, 1.1, 0]] }]
};

const FPS = 120;

/** Avatar bones (0-3), the recorded object (4), the place (5); scene root 6. */
export function hologramGlb(spec: HologramGlbSpec = {}): Buffer {
  const views: Buffer[] = [];
  const bufferViews: Array<Record<string, unknown>> = [];
  const accessors: Array<Record<string, unknown>> = [];
  const addView = (bytes: Buffer): number => {
    bufferViews.push({ buffer: 0, byteLength: bytes.length });
    views.push(bytes);
    return bufferViews.length - 1;
  };
  const addAccessor = (values: number[], type: "SCALAR" | "VEC3" | "VEC4", minMax = false): number => {
    const bytes = Buffer.from(new Float32Array(values).buffer);
    accessors.push({
      bufferView: addView(bytes),
      componentType: 5126,
      count: values.length / { SCALAR: 1, VEC3: 3, VEC4: 4 }[type],
      type,
      ...(minMax ? { min: [Math.min(...values)], max: [Math.max(...values)] } : {})
    });
    return accessors.length - 1;
  };

  const frames = spec.frames ?? 240;
  const times = Array.from({ length: frames }, (_, i) => i / FPS);
  const channels: Array<Record<string, unknown>> = [];
  const samplers: Array<Record<string, unknown>> = [];
  const track = (node: number, pathName: string, values: number[], interpolation = "LINEAR") => {
    samplers.push({ input: addAccessor(times, "SCALAR", true), output: addAccessor(values, pathName === "rotation" ? "VEC4" : "VEC3"), interpolation });
    channels.push({ sampler: samplers.length - 1, target: { node, path: pathName } });
  };
  // Hips walk forward (cm units under a 0.01 armature) and sway; spine and arm swing.
  track(1, "translation", times.flatMap((t) => [Math.sin(t * 3) * 5, 100 + Math.sin(t * 6) * 2, t * 80]));
  for (const [node, speed] of [[1, 2], [2, 3], [3, 5]] as const) {
    track(node, "rotation", times.flatMap((t) => {
      const angle = Math.sin(t * speed) * 0.6;
      return [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)];
    }));
  }
  // The object's presence track: STEP scale, never reduced.
  track(4, "scale", times.flatMap((t) => (t < 0.5 ? [0, 0, 0] : [1, 1, 1])), "STEP");

  const audio = Buffer.from(Array.from({ length: 4000 }, (_, i) => i % 251));
  const audioView = addView(audio);

  const extensionsUsed = ["KHR_audio", "HOLOIM_meaning", "HOLOIM_objects"];
  const nodes: Array<Record<string, unknown>> = [
    { name: "Armature", scale: [0.01, 0.01, 0.01], children: [1] },
    { name: "Hips", translation: [0, 100, 0], children: [2], mesh: 0 },
    { name: "Spine", translation: [0, 30, 0], children: [3] },
    { name: "RightHand", translation: [60, 20, 0] },
    { name: "RecordedObject", translation: [0.3, 1, 0.2] }
  ];
  if (spec.place) {
    const lightView = addView(spec.place.light);
    const detailView = spec.place.detail ? addView(spec.place.detail.spz) : undefined;
    nodes.push({
      name: "RecordedPlace",
      extensions: {
        HOLOIM_place: {
          version: 1,
          bufferView: lightView,
          splatCount: spec.place.splatCount,
          maxSh: spec.place.maxSh ?? 0,
          ...(spec.place.detail
            ? { detail: { bufferView: detailView, splatCount: spec.place.detail.splatCount, maxSh: spec.place.detail.maxSh ?? 0 } }
            : {}),
          provenance: { kind: "reconstruction", relation: "set", app: "fixture" }
        }
      }
    });
    extensionsUsed.push("HOLOIM_place");
  }
  nodes.push({ name: "Scene", children: nodes.map((_, index) => index).filter((index) => index !== 1 && index !== 2 && index !== 3) });

  // One triangle with UVs for the textured material.
  const position = addAccessor([0, 0, 0, 1, 0, 0, 0, 1, 0], "VEC3");
  accessors[position]!.min = [0, 0, 0];
  accessors[position]!.max = [1, 1, 0];
  const uv = Buffer.from(new Float32Array([0, 0, 1, 0, 0, 1]).buffer);
  accessors.push({ bufferView: addView(uv), componentType: 5126, count: 3, type: "VEC2" });
  const uvAccessor = accessors.length - 1;

  const json: Record<string, unknown> = {
    asset: { version: "2.0", generator: "hologram-budgets fixture" },
    extensionsUsed,
    scene: 0,
    scenes: [{ nodes: [nodes.length - 1] }],
    nodes,
    meshes: [{ primitives: [{ attributes: { POSITION: position, TEXCOORD_0: uvAccessor }, material: 0 }] }],
    materials: [{ name: "Skin", pbrMetallicRoughness: spec.texture ? { baseColorTexture: { index: 0 } } : {} }],
    animations: [{ name: "RecordedMotion", channels, samplers }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: 0 }],
    extensions: {
      // Capture's shape; no scene names the emitter, so the Quick Look converter skips the (unplayable) clip.
      KHR_audio: { audio: [{ bufferView: audioView, mimeType: "audio/mpeg" }], sources: [{ audio: 0 }], emitters: [{ type: "global", sources: [0] }] },
      HOLOIM_meaning: MEANING,
      HOLOIM_objects: {
        version: 0,
        objects: [
          { node: 4, name: "Cup", origin: "summoned", source: { name: "Cup" }, presence: [{ start: 0.5, end: frames / FPS }], holds: [] }
        ]
      }
    }
  };
  // Root-node children: Scene holds Armature (0), RecordedObject (4) and the place.
  (nodes[nodes.length - 1] as { children: number[] }).children = [0, 4, ...(spec.place ? [5] : [])];
  if (spec.texture) {
    const image = addView(png(spec.texture.width, spec.texture.height, spec.texture.flat));
    json.images = [{ bufferView: image, mimeType: "image/png" }];
    json.samplers = [{ magFilter: 9729, minFilter: 9987 }];
    json.textures = [{ source: 0, sampler: 0 }];
  }

  spec.mutate?.(json as never);
  const assemble = (padding: number): Buffer => {
    const allViews = padding > 0 ? [...views, Buffer.alloc(padding)] : views;
    const allBufferViews = padding > 0 ? [...bufferViews, { buffer: 0, byteLength: padding }] : bufferViews;
    let offset = 0;
    const placed: Buffer[] = [];
    allBufferViews.forEach((view, index) => {
      const pad = (4 - (offset % 4)) % 4;
      if (pad) placed.push(Buffer.alloc(pad));
      offset += pad;
      view.byteOffset = offset;
      placed.push(allViews[index]!);
      offset += allViews[index]!.length;
    });
    const tail = (4 - (offset % 4)) % 4;
    if (tail) placed.push(Buffer.alloc(tail));
    const bin = Buffer.concat(placed);
    const finalJson = { ...json, bufferViews: allBufferViews, buffers: [{ byteLength: bin.length }] };
    let jsonBytes = Buffer.from(JSON.stringify(finalJson));
    jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
    header.writeUInt32LE(total, 8);
    const jsonHeader = Buffer.alloc(8);
    jsonHeader.writeUInt32LE(jsonBytes.length, 0);
    jsonHeader.writeUInt32LE(0x4e4f534a, 4);
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(bin.length, 0);
    binHeader.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, jsonHeader, jsonBytes, binHeader, bin]);
  };
  if (!spec.padTo) return assemble(0);
  // The padding view's length changes the JSON's digits; converge on the exact size.
  let padding = Math.max(0, spec.padTo - assemble(0).length - 8);
  for (let attempt = 0; attempt < 8; attempt++) {
    const size = assemble(padding).length;
    if (size === spec.padTo) return assemble(padding);
    padding += spec.padTo - size;
  }
  throw new Error(`could not pad the fixture to ${spec.padTo} bytes`);
}
