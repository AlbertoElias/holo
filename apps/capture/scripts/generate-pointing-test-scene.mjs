import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { TARGETS } from './lib/pointing-scene.mjs';

// Writes fixtures/scenes/pointing-targets.gltf: the scene the pointing check's
// synthetic take points in. A 14 m floor at y = 0 and two named, separated
// targets in front of the spawn (the capture rig faces -Z): TargetA, a red box
// to the left, and TargetB, a blue box to the right. Nothing stands above the
// horizon, so a point into the sky hits no geometry. Load it with
// ?scene=/fixtures/scenes/pointing-targets.gltf&sceneScale=1.
// Targets are exported as `<name>_RecordedBubble`, which the check matches.

const OUT = path.resolve('fixtures/scenes/pointing-targets.gltf');
const FLOOR = 7;
const SLAB = 0.01;

const positions = [];
const normals = [];
const meshRanges = [];
function triangle(a, b, c) {
  const u = b.map((v, i) => v - a[i]);
  const w = c.map((v, i) => v - a[i]);
  const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const length = Math.hypot(...n);
  for (const p of [a, b, c]) {
    positions.push(...p);
    normals.push(...n.map((v) => v / length));
  }
}
// Counter-clockwise quad seen from the side its normal faces.
const quad = (a, b, c, d) => {
  triangle(a, b, c);
  triangle(a, c, d);
};
function box([cx, cy, cz], size) {
  const h = size / 2;
  const p = (x, y, z) => [cx + x * h, cy + y * h, cz + z * h];
  quad(p(-1, -1, 1), p(1, -1, 1), p(1, 1, 1), p(-1, 1, 1));
  quad(p(1, -1, -1), p(-1, -1, -1), p(-1, 1, -1), p(1, 1, -1));
  quad(p(-1, -1, -1), p(-1, -1, 1), p(-1, 1, 1), p(-1, 1, -1));
  quad(p(1, -1, 1), p(1, -1, -1), p(1, 1, -1), p(1, 1, 1));
  quad(p(-1, 1, 1), p(1, 1, 1), p(1, 1, -1), p(-1, 1, -1));
  quad(p(-1, -1, -1), p(1, -1, -1), p(1, -1, 1), p(-1, -1, 1));
}
function addMesh(name, build, material) {
  const start = positions.length / 3;
  build();
  meshRanges.push({ name, start, count: positions.length / 3 - start, material });
}

addMesh('PointingFloor', () => {
  quad([-FLOOR, 0, -FLOOR], [-FLOOR, 0, FLOOR], [FLOOR, 0, FLOOR], [FLOOR, 0, -FLOOR]);
  // A 1 cm slab edge keeps the floor clear of capture's own ground disc.
  quad([-FLOOR, -SLAB, FLOOR], [FLOOR, -SLAB, FLOOR], [FLOOR, 0, FLOOR], [-FLOOR, 0, FLOOR]);
}, 0);
Object.entries(TARGETS).forEach(([name, { center, size }], index) => {
  addMesh(name, () => box(center, size), index + 1);
});

const bytes = Buffer.alloc((positions.length + normals.length) * 4);
positions.forEach((v, i) => bytes.writeFloatLE(v, i * 4));
normals.forEach((v, i) => bytes.writeFloatLE(v, (positions.length + i) * 4));
const normalsOffset = positions.length * 4;

// One accessor pair per mesh, so each target is its own node and mesh.
const accessors = [];
const bufferViews = [];
for (const range of meshRanges) {
  const slice = positions.slice(range.start * 3, (range.start + range.count) * 3);
  const min = [0, 1, 2].map((axis) => Math.min(...slice.filter((_, i) => i % 3 === axis)));
  const max = [0, 1, 2].map((axis) => Math.max(...slice.filter((_, i) => i % 3 === axis)));
  bufferViews.push(
    { buffer: 0, byteOffset: range.start * 12, byteLength: range.count * 12 },
    { buffer: 0, byteOffset: normalsOffset + range.start * 12, byteLength: range.count * 12 }
  );
  const view = bufferViews.length - 2;
  accessors.push(
    { bufferView: view, componentType: 5126, count: range.count, type: 'VEC3', min, max },
    { bufferView: view + 1, componentType: 5126, count: range.count, type: 'VEC3' }
  );
}
const gltf = {
  asset: { version: '2.0', generator: 'holoim generate-pointing-test-scene.mjs' },
  scene: 0,
  scenes: [{ nodes: meshRanges.map((_, i) => i) }],
  nodes: meshRanges.map((range, i) => ({ name: range.name, mesh: i })),
  meshes: meshRanges.map((_, i) => ({ primitives: [{ attributes: { POSITION: i * 2, NORMAL: i * 2 + 1 }, material: i }] })),
  materials: [
    { pbrMetallicRoughness: { baseColorFactor: [0.42, 0.45, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
    ...Object.values(TARGETS).map(({ color }) => ({ pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: 0, roughnessFactor: 0.6 } }))
  ],
  buffers: [{ byteLength: bytes.length, uri: `data:application/octet-stream;base64,${bytes.toString('base64')}` }],
  bufferViews,
  accessors
};
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(gltf, null, 2)}\n`);
console.log(`[pointing-scene] ${OUT}: ${positions.length / 9} triangles, targets ${Object.keys(TARGETS).join(', ')}`);
