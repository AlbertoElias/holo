import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Writes fixtures/objects/bracket.glb: the supplied object the object check
// and the viewer's object spec record with (PRD-043). An L bracket whose two
// arms and corner marker have different colors, so its orientation reads
// from any side: a red base along +X (16 cm), a blue upright along +Y
// (10 cm), and a yellow cube on the corner. About 2 KB; meters.
// Load it with ?object=/fixtures/objects/bracket.glb.

const OUT = path.resolve('fixtures/objects/bracket.glb');

const PARTS = [
  { name: 'BracketBase', center: [0.06, 0, 0], size: [0.16, 0.03, 0.04], color: [0.85, 0.16, 0.12, 1] },
  { name: 'BracketUpright', center: [-0.02, 0.05, 0], size: [0.03, 0.1, 0.04], color: [0.12, 0.32, 0.88, 1] },
  { name: 'BracketMarker', center: [-0.02, 0, 0.03], size: [0.03, 0.03, 0.02], color: [0.95, 0.82, 0.1, 1] }
];

// 24 vertices (4 per face, flat normals) and 36 indices per box.
function boxGeometry([cx, cy, cz], [sx, sy, sz]) {
  const positions = [];
  const normals = [];
  const indices = [];
  const faces = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]
  ];
  const half = [sx / 2, sy / 2, sz / 2];
  for (const [normal, u, v] of faces) {
    const base = positions.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let axis = 0; axis < 3; axis += 1) {
        positions.push([cx, cy, cz][axis] + (normal[axis] + u[axis] * a + v[axis] * b) * half[axis]);
        normals.push(normal[axis]);
      }
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, indices };
}

const chunks = [];
let byteLength = 0;
const bufferViews = [];
const accessors = [];
function addView(buffer, target) {
  const padded = Buffer.alloc(Math.ceil(buffer.length / 4) * 4);
  buffer.copy(padded);
  bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: buffer.length, target });
  chunks.push(padded);
  byteLength += padded.length;
  return bufferViews.length - 1;
}
const floats = (values) => Buffer.from(new Float32Array(values).buffer);

const meshes = [];
const nodes = [];
const materials = [];
for (const [i, part] of PARTS.entries()) {
  const { positions, normals, indices } = boxGeometry(part.center, part.size);
  const min = [0, 1, 2].map((axis) => Math.min(...positions.filter((_, k) => k % 3 === axis)));
  const max = [0, 1, 2].map((axis) => Math.max(...positions.filter((_, k) => k % 3 === axis)));
  accessors.push({ bufferView: addView(floats(positions), 34962), componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max });
  accessors.push({ bufferView: addView(floats(normals), 34962), componentType: 5126, count: normals.length / 3, type: 'VEC3' });
  accessors.push({ bufferView: addView(Buffer.from(new Uint16Array(indices).buffer), 34963), componentType: 5123, count: indices.length, type: 'SCALAR' });
  materials.push({ name: `${part.name}Material`, pbrMetallicRoughness: { baseColorFactor: part.color, metallicFactor: 0.1, roughnessFactor: 0.6 } });
  meshes.push({ name: part.name, primitives: [{ attributes: { POSITION: i * 3, NORMAL: i * 3 + 1 }, indices: i * 3 + 2, material: i }] });
  nodes.push({ name: part.name, mesh: i });
}
nodes.push({ name: 'Bracket', children: PARTS.map((_, i) => i) });

const json = {
  asset: { version: '2.0', generator: 'holoim generate-object-fixture' },
  scene: 0,
  scenes: [{ name: 'Bracket', nodes: [nodes.length - 1] }],
  nodes,
  meshes,
  materials,
  accessors,
  bufferViews,
  buffers: [{ byteLength }]
};

const jsonBytes = Buffer.from(JSON.stringify(json));
const jsonChunk = Buffer.alloc(Math.ceil(jsonBytes.length / 4) * 4, 0x20);
jsonBytes.copy(jsonChunk);
const binChunk = Buffer.concat(chunks);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
const chunkHeader = (length, type) => {
  const out = Buffer.alloc(8);
  out.writeUInt32LE(length, 0);
  out.writeUInt32LE(type, 4);
  return out;
};
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, Buffer.concat([header, chunkHeader(jsonChunk.length, 0x4e4f534a), jsonChunk, chunkHeader(binChunk.length, 0x004e4942), binChunk]));
console.log(`Wrote ${path.relative(process.cwd(), OUT)}`);
