import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Writes fixtures/scenes/body-floor.gltf: the terrain the room-scale body
// check walks on. A 14 m square floor at y = 0; behind the spawn (+Z), an 8°
// ramp 2 m long and 3 m wide climbs 0.28 m onto a platform, with vertical
// sides; a 2.5 m backdrop wall at the far edge keeps the platform below the
// terrain helper's ceiling cut (85% of the scene height). Load it with ?scene=/fixtures/scenes/body-floor.gltf&sceneScale=1.

const OUT = path.resolve('fixtures/scenes/body-floor.gltf');
const FLOOR = 7;
const SLAB = 0.01;
const RAMP = { x0: -1.5, x1: 1.5, z0: 1.6, z1: 3.6, z2: 6, h: 0.28 };

const positions = [];
const normals = [];
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

const { x0, x1, z0, z1, z2, h } = RAMP;
quad([-FLOOR, 0, -FLOOR], [-FLOOR, 0, FLOOR], [FLOOR, 0, FLOOR], [FLOOR, 0, -FLOOR]);
// A 1 cm slab edge: capture grounds the scene by its lowest point, so the
// floor ends up 1 cm above capture's own ground disc instead of z-fighting it.
quad([-FLOOR, -SLAB, FLOOR], [FLOOR, -SLAB, FLOOR], [FLOOR, 0, FLOOR], [-FLOOR, 0, FLOOR]);
quad([x0, 0.001, z0], [x0, h, z1], [x1, h, z1], [x1, 0.001, z0]);
quad([x0, h, z1], [x0, h, z2], [x1, h, z2], [x1, h, z1]);
quad([x0, 0, z0], [x0, 0, z2], [x0, h, z2], [x0, h, z1]);
quad([x1, 0, z0], [x1, h, z1], [x1, h, z2], [x1, 0, z2]);
quad([x0, 0, z2], [x1, 0, z2], [x1, h, z2], [x0, h, z2]);
quad([-FLOOR, 0, -FLOOR], [FLOOR, 0, -FLOOR], [FLOOR, 2.5, -FLOOR], [-FLOOR, 2.5, -FLOOR]);

const bytes = Buffer.alloc((positions.length + normals.length) * 4);
positions.forEach((v, i) => bytes.writeFloatLE(v, i * 4));
normals.forEach((v, i) => bytes.writeFloatLE(v, (positions.length + i) * 4));
const count = positions.length / 3;
const min = [0, 1, 2].map((axis) => Math.min(...positions.filter((_, i) => i % 3 === axis)));
const max = [0, 1, 2].map((axis) => Math.max(...positions.filter((_, i) => i % 3 === axis)));
const gltf = {
  asset: { version: '2.0', generator: 'holoim generate-body-test-scene.mjs' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: 'BodyTestFloor', mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0 }] }],
  materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.42, 0.45, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.9 } }],
  buffers: [{ byteLength: bytes.length, uri: `data:application/octet-stream;base64,${bytes.toString('base64')}` }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: positions.length * 4 },
    { buffer: 0, byteOffset: positions.length * 4, byteLength: normals.length * 4 }
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count, type: 'VEC3', min, max },
    { bufferView: 1, componentType: 5126, count, type: 'VEC3' }
  ]
};
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(gltf, null, 2)}\n`);
console.log(`[body-scene] ${OUT}: ${count / 3} triangles`);
