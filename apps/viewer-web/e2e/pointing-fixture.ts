// A hand-written GLB carrying a valid HOLOIM_meaning record. It is deliberately
// hand-built, not a capture export, so it covers cases real takes do not: a
// large-surface (floor) ring, a mixed recorded/inferred pair of links to scene
// objects, an inferred link to the author's own hand (body part), and the
// no-extension case. Node indices below are the glTF node order.

export const NODE = {
  avatar: 0, hips: 1, head: 2, rightHand: 3, rightIndexDistal: 4, leftHand: 5,
  targetA: 6, targetB: 7, floor: 8, bubble: 9
} as const;

export const DURATION = 8;

type Mark = {
  kind: "link";
  anchor: { from: { bone: string; node: number }; to: { node: number; bone?: string; point?: number[]; radius?: number } };
  span: { start: number; end: number };
  provenance: { value: "recorded" } | { value: "inferred"; confidence: number };
};

const from = { bone: "rightIndexDistal", node: NODE.rightIndexDistal };
export const MARKS: Mark[] = [
  { kind: "link", anchor: { from, to: { node: NODE.targetA, point: [0, 0, 0.2] } }, span: { start: 0.5, end: 1.5 }, provenance: { value: "recorded" } },
  { kind: "link", anchor: { from, to: { node: NODE.targetB, point: [0, 0, 0.2] } }, span: { start: 2.5, end: 3.5 }, provenance: { value: "inferred", confidence: 0.8 } },
  { kind: "link", anchor: { from, to: { node: NODE.leftHand, bone: "leftHand", point: [0, 0, 0] } }, span: { start: 4.5, end: 5.5 }, provenance: { value: "inferred", confidence: 0.7 } },
  { kind: "link", anchor: { from, to: { node: NODE.floor, point: [0.6, 0, -0.4], radius: 0.35 } }, span: { start: 6.5, end: 7.5 }, provenance: { value: "recorded" } }
];

/** Mid-span times for each mark, plus times outside every span. */
export const MIDPOINTS = MARKS.map((mark) => (mark.span.start + mark.span.end) / 2);
export const OUTSIDE_TIMES = [0.2, 2.0, 4.0, 6.0];

type Geometry = { positions: number[]; normals: number[]; indices: number[] };

function box(w: number, h: number, d: number): Geometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faces: Array<[number[], number[][]]> = [
    [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
    [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
    [[1, 0, 0], [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]]],
    [[-1, 0, 0], [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]],
    [[0, 1, 0], [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]]],
    [[0, -1, 0], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]]
  ];
  for (const [normal, corners] of faces) {
    const base = positions.length / 3;
    for (const [x, y, z] of corners) positions.push((x! * w) / 2, (y! * h) / 2, (z! * d) / 2);
    for (let i = 0; i < 4; i += 1) normals.push(...normal!);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, indices };
}

function plane(size: number): Geometry {
  const s = size / 2;
  return {
    positions: [-s, 0, s, s, 0, s, s, 0, -s, -s, 0, -s],
    normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    indices: [0, 1, 2, 0, 2, 3]
  };
}

function sphere(radius: number, rings = 12, segments = 20): Geometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let r = 0; r <= rings; r += 1) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s <= segments; s += 1) {
      const theta = (s / segments) * Math.PI * 2;
      const n = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
      positions.push(n[0]! * radius, n[1]! * radius, n[2]! * radius);
      normals.push(...n);
    }
  }
  for (let r = 0; r < rings; r += 1) {
    for (let s = 0; s < segments; s += 1) {
      const a = r * (segments + 1) + s;
      const b = a + segments + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return { positions, normals, indices };
}

/** `withMeaning: false` is an old export: the same scene without the extension. */
export function buildPointingGlb({ withMeaning = true } = {}): Buffer {
  const chunks: Buffer[] = [];
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  const push = (data: Buffer, target?: number): number => {
    const offset = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    chunks.push(data);
    const pad = (4 - (data.length % 4)) % 4;
    if (pad) chunks.push(Buffer.alloc(pad));
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length, ...(target ? { target } : {}) });
    return bufferViews.length - 1;
  };
  const floats = (values: number[]) => Buffer.from(new Float32Array(values).buffer);
  const addAccessor = (view: number, componentType: number, count: number, type: string, extra: object = {}): number => {
    accessors.push({ bufferView: view, componentType, count, type, ...extra });
    return accessors.length - 1;
  };
  const meshes: object[] = [];
  const addMesh = (name: string, geometry: Geometry): number => {
    const xs = geometry.positions.filter((_, i) => i % 3 === 0);
    const ys = geometry.positions.filter((_, i) => i % 3 === 1);
    const zs = geometry.positions.filter((_, i) => i % 3 === 2);
    const position = addAccessor(push(floats(geometry.positions), 34962), 5126, xs.length, "VEC3", {
      min: [Math.min(...xs), Math.min(...ys), Math.min(...zs)],
      max: [Math.max(...xs), Math.max(...ys), Math.max(...zs)]
    });
    const normal = addAccessor(push(floats(geometry.normals), 34962), 5126, xs.length, "VEC3");
    const index = addAccessor(push(Buffer.from(new Uint16Array(geometry.indices).buffer), 34963), 5123, geometry.indices.length, "SCALAR");
    meshes.push({ name, primitives: [{ attributes: { POSITION: position, NORMAL: normal }, indices: index, material: meshes.length }] });
    return meshes.length - 1;
  };
  const colors: number[][] = [];
  const mesh = (name: string, geometry: Geometry, color: number[]) => { colors.push(color); return addMesh(name, geometry); };
  const targetA = mesh("TargetA", box(0.4, 0.4, 0.4), [0.55, 0.5, 0.45, 1]);
  const targetB = mesh("TargetB", box(0.3, 0.6, 0.3), [0.45, 0.5, 0.55, 1]);
  const floor = mesh("Floor", plane(8), [0.32, 0.34, 0.3, 1]);
  const bubble = mesh("RecordedBubbleSphere", sphere(3.5), [1, 1, 1, 0.1]);

  // Nodes in NODE order.
  const nodes = [
    { name: "RecordedAvatar", children: [1] },
    { name: "Hips", translation: [0, 0.9, 0], children: [2, 3, 5] },
    { name: "Head", translation: [0, 0.7, 0] },
    { name: "rightHand", translation: [-0.3, 0.2, 0.1], children: [4] },
    { name: "rightIndexDistal", translation: [0, 0, 0.25] },
    { name: "leftHand", translation: [0.3, 0.15, 0.1] },
    { name: "TargetA", mesh: targetA, translation: [-0.9, 0.2, 0.9] },
    { name: "TargetB", mesh: targetB, translation: [0.9, 0.3, 0.8] },
    { name: "Floor", mesh: floor },
    { name: "RecordedBubbleSphere", mesh: bubble, translation: [0, 1, 0] }
  ];

  // The right hand sways, so the fingertip ray visibly follows animation.
  const times = push(floats([0, 4, 8]));
  const input = addAccessor(times, 5126, 3, "SCALAR", { min: [0], max: [DURATION] });
  const output = addAccessor(push(floats([-0.3, 0.2, 0.1, -0.18, 0.28, 0.14, -0.3, 0.2, 0.1])), 5126, 3, "VEC3");

  const materials = colors.map((baseColorFactor, i) => ({
    pbrMetallicRoughness: { baseColorFactor, metallicFactor: 0, roughnessFactor: 0.8 },
    ...(i === colors.length - 1 ? { alphaMode: "BLEND" } : {})
  }));

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const json = {
    asset: { version: "2.0", generator: "holoim pointing e2e fixture" },
    ...(withMeaning
      ? { extensionsUsed: ["HOLOIM_meaning"], extensions: { HOLOIM_meaning: { version: 0, marks: MARKS, spans: [] } } }
      : {}),
    scene: 0,
    scenes: [{ nodes: [NODE.avatar, NODE.targetA, NODE.targetB, NODE.floor, NODE.bubble] }],
    nodes, meshes, materials, accessors, bufferViews,
    buffers: [{ byteLength: total }],
    animations: [{
      name: "RecordedAnimation",
      samplers: [{ input, output, interpolation: "LINEAR" }],
      channels: [{ sampler: 0, target: { node: NODE.rightHand, path: "translation" } }]
    }]
  };

  const pad = (data: Buffer, byte: number) => Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4, byte)]);
  const jsonChunk = pad(Buffer.from(JSON.stringify(json)), 0x20);
  const binChunk = pad(Buffer.concat(chunks), 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const chunkHeader = (length: number, type: number) => {
    const out = Buffer.alloc(8);
    out.writeUInt32LE(length, 0);
    out.writeUInt32LE(type, 4);
    return out;
  };
  return Buffer.concat([header, chunkHeader(jsonChunk.length, 0x4e4f534a), jsonChunk, chunkHeader(binChunk.length, 0x004e4942), binChunk]);
}
