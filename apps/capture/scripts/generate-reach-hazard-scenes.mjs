import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Writes fixtures/scenes/reach-{trench,wall,railing,pit}.gltf: the hazards the flat-screen floor reach must respect.
// Each is a 14 m square floor (the avatar spawns at the origin facing -Z; a prop set down in front of it rests about 0.5 m ahead) with:
//   trench: a 0.2 m wide, 1.2 m deep gap across the floor (z 0.10 to 0.30): a prop set down at z -0.24 and an avatar backed off to z 0.38 have it between them.
//   wall:   a thin 2.2 m wall along x -0.36 with a doorway (z 0.6 to 1.4): an avatar that walks round to x -0.72 has a prop at x 0 within its radius, behind the wall.
//   railing: an 8 cm bar at 0.55 to 0.63 m along x -0.36 (doorway at z 0.6 to 1.4): clear of the shoulder-to-prop line standing, in its way mid-squat.
//   pit:    the floor ends at z -0.1 and drops 1.2 m: the prop the avatar sets down falls to the bottom, a drop away from its feet.
// Capture grounds a scene by its lowest point, so in the trench and the pit scenes the floor the avatar stands on is 1.2 m up.
// Load one with ?scene=/fixtures/scenes/reach-trench.gltf&sceneScale=1.

const FLOOR = 7;
const SLAB = 0.01;
const DEPTH = 1.2;

function build(name, add) {
  const positions = [];
  const normals = [];
  const triangle = (a, b, c) => {
    const u = b.map((v, i) => v - a[i]);
    const w = c.map((v, i) => v - a[i]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const length = Math.hypot(...n) || 1;
    for (const p of [a, b, c]) {
      positions.push(...p);
      normals.push(...n.map((v) => v / length));
    }
  };
  const quad = (a, b, c, d) => {
    triangle(a, b, c);
    triangle(a, c, d);
  };
  // Seen from both sides, for walls.
  const both = (a, b, c, d) => {
    quad(a, b, c, d);
    quad(a, d, c, b);
  };
  // A horizontal rectangle at height y, facing up.
  const top = (x0, z0, x1, z1, y) => quad([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0]);
  // A floor with a rectangular hole [hx0, hx1] x [hz0, hz1] in it, four strips around the hole.
  const floorWithHole = (hx0, hz0, hx1, hz1) => {
    top(-FLOOR, -FLOOR, hx0, FLOOR, 0);
    top(hx1, -FLOOR, FLOOR, FLOOR, 0);
    top(hx0, -FLOOR, hx1, hz0, 0);
    top(hx0, hz1, hx1, FLOOR, 0);
    top(hx0, hz0, hx1, hz1, -DEPTH);
    both([hx0, -DEPTH, hz0], [hx0, 0, hz0], [hx1, 0, hz0], [hx1, -DEPTH, hz0]);
    both([hx0, -DEPTH, hz1], [hx0, 0, hz1], [hx1, 0, hz1], [hx1, -DEPTH, hz1]);
    both([hx0, -DEPTH, hz0], [hx0, 0, hz0], [hx0, 0, hz1], [hx0, -DEPTH, hz1]);
    both([hx1, -DEPTH, hz0], [hx1, 0, hz0], [hx1, 0, hz1], [hx1, -DEPTH, hz1]);
    // A backdrop wall keeps the floor under the terrain helper's ceiling cut (85% of the scene height).
    both([-FLOOR, 0, -FLOOR], [-FLOOR, 2.5, -FLOOR], [FLOOR, 2.5, -FLOOR], [FLOOR, 0, -FLOOR]);
  };
  add({ quad, both, top, floorWithHole });
  const bytes = Buffer.alloc((positions.length + normals.length) * 4);
  positions.forEach((v, i) => bytes.writeFloatLE(v, i * 4));
  normals.forEach((v, i) => bytes.writeFloatLE(v, (positions.length + i) * 4));
  const count = positions.length / 3;
  const min = [0, 1, 2].map((axis) => Math.min(...positions.filter((_, i) => i % 3 === axis)));
  const max = [0, 1, 2].map((axis) => Math.max(...positions.filter((_, i) => i % 3 === axis)));
  return {
    count,
    gltf: {
      asset: { version: '2.0', generator: 'holoim generate-reach-hazard-scenes.mjs' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: name, mesh: 0 }],
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
    }
  };
}

const scenes = {
  'reach-trench': ({ floorWithHole }) => floorWithHole(-2, 0.1, 2, 0.3),
  'reach-pit': ({ floorWithHole }) => floorWithHole(-3, -3, 3, -0.1),
  'reach-railing': ({ quad, both, top }) => {
    top(-FLOOR, -FLOOR, FLOOR, FLOOR, 0);
    quad([-FLOOR, -SLAB, FLOOR], [FLOOR, -SLAB, FLOOR], [FLOOR, 0, FLOOR], [-FLOOR, 0, FLOOR]);
    // A tall backdrop keeps the floor under the terrain helper's ceiling cut; the railing itself is a bar 8 cm tall at 0.55 to 0.63 m along x -0.36, with the doorway at z 0.6 to 1.4.
    both([-FLOOR, 0, -FLOOR], [-FLOOR, 2.5, -FLOOR], [FLOOR, 2.5, -FLOOR], [FLOOR, 0, -FLOOR]);
    for (const [z0, z1] of [[-3, 0.6], [1.4, 3]]) {
      both([-0.36, 0.55, z0], [-0.36, 0.63, z0], [-0.36, 0.63, z1], [-0.36, 0.55, z1]);
      top(-0.38, z0, -0.34, z1, 0.63);
      top(-0.38, z0, -0.34, z1, 0.55);
    }
  },
  'reach-wall': ({ quad, both, top }) => {
    top(-FLOOR, -FLOOR, FLOOR, FLOOR, 0);
    // A 1 cm slab edge, as the body-floor scene has: the floor ends up 1 cm above capture's own ground disc.
    quad([-FLOOR, -SLAB, FLOOR], [FLOOR, -SLAB, FLOOR], [FLOOR, 0, FLOOR], [-FLOOR, 0, FLOOR]);
    // Along x -0.36 from z -3 to 3 with a doorway at z 0.6 to 1.4, seen from both sides.
    both([-0.36, 0, -3], [-0.36, 2.2, -3], [-0.36, 2.2, 0.6], [-0.36, 0, 0.6]);
    both([-0.36, 0, 1.4], [-0.36, 2.2, 1.4], [-0.36, 2.2, 3], [-0.36, 0, 3]);
  }
};

await mkdir(path.resolve('fixtures/scenes'), { recursive: true });
for (const [name, add] of Object.entries(scenes)) {
  const { gltf, count } = build(name, add);
  const out = path.resolve(`fixtures/scenes/${name}.gltf`);
  await writeFile(out, `${JSON.stringify(gltf, null, 2)}\n`);
  console.log(`[reach-scenes] ${out}: ${count / 3} triangles`);
}
