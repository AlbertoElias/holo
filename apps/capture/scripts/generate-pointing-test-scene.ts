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
//
// Also writes fixtures/scenes/pointing-room.gltf for the real headset take,
// whose points (recorded in a real room) aim about 20° above the horizon: the
// same floor and a wall ahead of the spawn, so those points hit something.
// What they hit is not a referent; that take proves timing and silence.

const OUT = path.resolve('fixtures/scenes/pointing-targets.gltf');
const ROOM_OUT = path.resolve('fixtures/scenes/pointing-room.gltf');
// Bubble clipping keeps triangles with two vertices within 6 m of the
// recording, so the wall is split into 0.5 m quads.
const ROOM_WALL = { x0: -2.5, x1: 2.5, height: 3.2, z: -3, cell: 0.5 };
const FLOOR = 7;
const SLAB = 0.01;

let positions = [];
let normals = [];
let meshRanges = [];
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

const addFloor = () => addMesh('PointingFloor', () => {
  quad([-FLOOR, 0, -FLOOR], [-FLOOR, 0, FLOOR], [FLOOR, 0, FLOOR], [FLOOR, 0, -FLOOR]);
  // A 1 cm slab edge keeps the floor clear of capture's own ground disc.
  quad([-FLOOR, -SLAB, FLOOR], [FLOOR, -SLAB, FLOOR], [FLOOR, 0, FLOOR], [-FLOOR, 0, FLOOR]);
}, 0);

async function writeScene(out, materials) {
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
  materials,
  buffers: [{ byteLength: bytes.length, uri: `data:application/octet-stream;base64,${bytes.toString('base64')}` }],
  bufferViews,
  accessors
};
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(gltf, null, 2)}\n`);
console.log(`[pointing-scene] ${out}: ${positions.length / 9} triangles, meshes ${meshRanges.map((range) => range.name).join(', ')}`);
}

const FLOOR_MATERIAL = { pbrMetallicRoughness: { baseColorFactor: [0.42, 0.45, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.9 } };

addFloor();
Object.entries(TARGETS).forEach(([name, { center, size }], index) => {
  addMesh(name, () => box(center, size), index + 1);
});
await writeScene(OUT, [
  FLOOR_MATERIAL,
  ...Object.values(TARGETS).map(({ color }) => ({ pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: 0, roughnessFactor: 0.6 } }))
]);

positions = [];
normals = [];
meshRanges = [];
addFloor();
addMesh('RoomWall', () => {
  const { x0, x1, height, z, cell } = ROOM_WALL;
  for (let x = x0; x < x1 - 1e-6; x += cell) {
    for (let y = 0; y < height - 1e-6; y += cell) {
      const xe = Math.min(x + cell, x1);
      const ye = Math.min(y + cell, height);
      // Faces +Z, toward the spawn.
      quad([x, y, z], [xe, y, z], [xe, ye, z], [x, ye, z]);
    }
  }
}, 1);
await writeScene(ROOM_OUT, [FLOOR_MATERIAL, { pbrMetallicRoughness: { baseColorFactor: [0.75, 0.72, 0.66, 1], metallicFactor: 0, roughnessFactor: 0.9 } }]);
