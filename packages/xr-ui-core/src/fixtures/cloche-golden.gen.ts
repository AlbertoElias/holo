// Writes cloche-golden.json: `tsx src/fixtures/cloche-golden.gen.ts`. Run
// only on a deliberate change to the fit or the burnt globe; the TypeScript and
// Python tests both read the file.
import { writeFileSync } from "node:fs";

import {
  clocheBurnAt,
  clocheBurnFronts,
  clocheBurnNoise,
  clocheEmbers,
  clocheLocalPoint,
  clocheNormalAt,
  clocheRandom,
  clocheSeedOffset,
  clocheTearAt,
  fitCloche,
  type ClocheShape,
  type Vector3Like
} from "../index.js";

function scatter(seed: number, count: number, [x0, y0, z0]: number[], [sx, sy, sz]: number[]): Vector3Like[] {
  let state = seed;
  const next = () => (state = (state * 16807) % 2147483647) / 2147483647;
  return Array.from({ length: count }, () => ({ x: x0! + next() * sx!, y: y0! + next() * sy!, z: z0! + next() * sz! }));
}

const pointSets: Record<string, Vector3Like[]> = {
  town: scatter(7, 500, [3, 0.5, -1], [4, 1.2, 2]),
  flatTake: scatter(11, 200, [-0.4, 0, -0.3], [0.8, 0.01, 0.6]),
  walk: scatter(13, 300, [-2, 0, 0.5], [4, 1.95, 0.4]),
  lone: [{ x: 1, y: 2, z: 3 }]
};
const seeds = ["cm3golden0hologram0id", "cmvdjjzsd0000kcsfmrllxeqf", "abf8gsmcbpvrzcpe5n1w8o6i", "", "ü→hologram"];
const directions = scatter(17, 48, [-1, 0, -1], [2, 1, 2]);
const xyz = (p: Vector3Like) => [p.x, p.y, p.z];

const golden = {
  note: "Golden cloche (styleguide 3.4 and 9.5): the fit, the seed offset and the burnt globe (burns, tears, dome points and normals, fronts, embers). The USDZ builder's port (apps/viewer-api/tools/cloche.py) must reproduce them; regenerate only on a deliberate change.",
  fits: Object.entries(pointSets).map(([name, points]) => ({ name, points: points.map((p) => [p.x, p.y, p.z]), shape: fitCloche(points) })),
  seeds: seeds.map((seed) => ({ seed, offset: clocheSeedOffset(seed) })),
  // The burnt globe (clocheBurn.ts) on each fitted dome for three seeds.
  globe: Object.entries(pointSets).slice(0, 3).flatMap(([name, points]) => {
    const shape = fitCloche(points) as ClocheShape;
    return seeds.slice(0, 3).map((seed) => {
      const offset = clocheSeedOffset(seed);
      const random = clocheRandom(offset);
      const embers = clocheEmbers(shape, offset, 64);
      return {
        fit: name,
        seed,
        random: Array.from({ length: 8 }, () => random()),
        surface: directions.map((d) => {
          const point = clocheLocalPoint(shape, d);
          return { direction: xyz(d), point: xyz(point), normal: xyz(clocheNormalAt(shape, point)), burn: clocheBurnAt(shape, offset, point), tear: clocheTearAt(shape, offset, point) };
        }),
        fronts: clocheBurnFronts(shape, offset, 12).map(({ point, normal }) => ({ point: xyz(point), normal: xyz(normal) })),
        embers: { positions: Array.from(embers.positions), normals: Array.from(embers.normals), seeds: Array.from(embers.seeds) }
      };
    });
  }),
  noise: directions.map((d) => ({ at: xyz(d), value: clocheBurnNoise({ x: d.x * 9.3, y: d.y * 9.3, z: d.z * 9.3 }) }))
};
writeFileSync(new URL("./cloche-golden.json", import.meta.url), JSON.stringify(golden) + "\n");
