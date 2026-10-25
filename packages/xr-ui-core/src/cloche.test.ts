// The cloche (styleguide 3.4). Written from its failure modes: a fit that
// leaves drawn content outside the glass, a flat take with no volume, a
// pancake dome, a foot that floats or sinks, Follow framing that cuts the
// dome, a dome still drawn with the eye inside it, burns that change between
// loads, and char that ignores the ground.
import { tokens } from "@holoim/design-tokens";
import { describe, expect, it } from "vitest";

import golden from "./fixtures/cloche-golden.json" with { type: "json" };
import { clocheBurnAt, clocheBurnFronts, clocheBurnNoise, clocheCharShare, clocheEmbers, clocheLocalPoint, clocheNormalAt, clocheRandom, clocheTearAt, clocheFollowDirection, clocheFraming, clocheOpacityAt, clocheSeedOffset, clocheSurfacePoints, clocheValue, fitCloche, type ClocheShape } from "./index.js";

const { cloche } = tokens.edge;

/** A deterministic scatter: a town 4 × 1.2 × 2 m, off the origin. */
function town(): { x: number; y: number; z: number }[] {
  const points = [];
  let seed = 7;
  const next = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 500; i += 1) points.push({ x: 3 + next() * 4, y: 0.5 + next() * 1.2, z: -1 + next() * 2 });
  return points;
}

function fitted(points: { x: number; y: number; z: number }[]): ClocheShape {
  const shape = fitCloche(points);
  if (!shape) throw new Error("no shape");
  return shape;
}

describe("fitting the cloche (3.4)", () => {
  it("draws nothing for a hologram that draws nothing", () => {
    expect(fitCloche([])).toBeNull();
  });

  it("holds every drawn point inside the glass, with the margin to spare", () => {
    const points = town();
    const shape = fitted(points);
    const limit = (1 / cloche.fitMargin) ** shape.exponent;
    for (const point of points) expect(clocheValue(shape, point)).toBeLessThanOrEqual(limit + 1e-9);
  });

  it("rests its foot on the lowest point, centred over the content", () => {
    const shape = fitted(town());
    expect(shape.base.y).toBeCloseTo(Math.min(...town().map((p) => p.y)), 9);
    expect(shape.base.x).toBeGreaterThan(3);
    expect(shape.base.x).toBeLessThan(7);
  });

  it("gives a flat take a volume", () => {
    const shape = fitted([{ x: -1, y: 0, z: -1 }, { x: 1, y: 0, z: 1 }]);
    expect(shape.radii.y).toBeGreaterThan(0);
    expect(shape.radii.y).toBeGreaterThanOrEqual(cloche.minHeightShare * Math.max(shape.radii.x, shape.radii.z) - 1e-9);
  });

  it("never makes a pancake: the same shoulders for a wide, low hologram", () => {
    const shape = fitted([{ x: -10, y: 0, z: -10 }, { x: 10, y: 0.1, z: 10 }]);
    expect(shape.radii.y / Math.max(shape.radii.x, shape.radii.z)).toBeGreaterThanOrEqual(cloche.minHeightShare - 1e-9);
  });

  it("shades the content's footprint, not the glass", () => {
    const points = town();
    const shape = fitted(points);
    const halfX = (Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x))) / 2;
    expect(shape.shade.radiusX).toBeCloseTo(halfX * cloche.shadeScale, 9);
    expect(shape.shade.radiusZ).toBeLessThan(shape.radii.z);
  });
});

describe("Follow framing (3.4)", () => {
  it("keeps every point of the drawn dome inside the viewing box at its share, from Follow's direction", () => {
    const shape = fitted(town());
    for (const aspect of [390 / 600, 1280 / 560]) {
      const fovY = (50 * Math.PI) / 180;
      const { target, distance } = clocheFraming(shape, { fovY, aspect });
      const d = clocheFollowDirection();
      const eye = { x: target.x + d.x * distance, y: target.y + d.y * distance, z: target.z + d.z * distance };
      const forward = { x: -d.x, y: -d.y, z: -d.z };
      const right = normalise({ x: -forward.z, y: 0, z: forward.x });
      const up = cross(right, forward);
      let widest = 0;
      for (const point of clocheSurfacePoints(shape)) {
        const offset = { x: point.x - eye.x, y: point.y - eye.y, z: point.z - eye.z };
        const depth = dot(offset, forward);
        expect(depth, "the dome is in front of the camera").toBeGreaterThan(0);
        const sx = Math.abs(dot(offset, right) / depth) / (Math.tan(fovY / 2) * aspect);
        const sy = Math.abs(dot(offset, up) / depth) / Math.tan(fovY / 2);
        widest = Math.max(widest, sx, sy);
      }
      expect(widest, "inside the share, so the title and controls stay clear").toBeLessThanOrEqual(cloche.frameShare + 1e-6);
      expect(widest, "and as big as the share allows").toBeGreaterThan(cloche.frameShare - 0.02);
    }
  });

  it("looks a little right of front and a little from above", () => {
    const d = clocheFollowDirection();
    expect(d.x).toBeGreaterThan(0);
    expect(d.y).toBeGreaterThan(0);
    expect(d.z).toBeGreaterThan(d.x);
  });
});

describe("going inside (3.4)", () => {
  it("is fully drawn from outside and gone before the eye reaches the glass", () => {
    const shape = fitted(town());
    const centre = { x: shape.base.x, y: shape.base.y + shape.radii.y * 0.3, z: shape.base.z };
    const at = (k: number) => clocheOpacityAt(shape, { x: centre.x, y: centre.y, z: centre.z + shape.radii.z * k });
    expect(at(3)).toBe(1);
    expect(at(0)).toBe(0);
    expect(at(1), "at the glass itself").toBe(0);
    let previous = 0;
    for (let k = 0; k <= 3; k += 0.05) {
      expect(at(k), "it only grows walking out").toBeGreaterThanOrEqual(previous - 1e-12);
      previous = at(k);
    }
  });
});

describe("burns and char (3.2, 3.4)", () => {
  it("keeps one hologram's burns wherever it loads", () => {
    expect(clocheSeedOffset("cmvmig68e0000oejsj9pd83rz")).toBe(clocheSeedOffset("cmvmig68e0000oejsj9pd83rz"));
    expect(clocheSeedOffset("a")).not.toBe(clocheSeedOffset("b"));
    for (const seed of ["", "a", "x".repeat(200)]) {
      expect(clocheSeedOffset(seed)).toBeGreaterThanOrEqual(0);
      expect(clocheSeedOffset(seed)).toBeLessThan(100);
    }
  });

  it("chars at rest on dark ground, fully where the soot rule says the ground is light", () => {
    expect(clocheCharShare({ sootOpacity: 0 })).toBe(tokens.edge.char.rest);
    expect(clocheCharShare({ sootOpacity: tokens.edge.soot.flatOpacity })).toBe(tokens.edge.char.bright);
    expect(clocheCharShare({ sootOpacity: tokens.edge.soot.arNoEstimateOpacity })).toBe(tokens.edge.char.bright);
  });
});

describe("the golden cloche the USDZ builder's port must reproduce (9.5)", () => {
  const vector = ([x, y, z]: number[]) => ({ x: x!, y: y!, z: z! });

  it("fits the same domes", () => {
    for (const fit of golden.fits) expect(fitCloche(fit.points.map(vector))).toEqual(fit.shape);
  });

  it("offsets the same seeds", () => {
    for (const { seed, offset } of golden.seeds) expect(clocheSeedOffset(seed)).toBe(offset);
  });

  // Within a tolerance, not bit for bit: the fronts and embers run through
  // Math.sin and Math.cos, which V8 takes from the platform's libm on some
  // builds (Linux x64), so their last bits differ between machines. The
  // Python port is held to the same tolerances.
  const near = (actual: number[], expected: number[], tolerance: number) => {
    expect(actual.length).toBe(expected.length);
    actual.forEach((value, i) => expect(Math.abs(value - expected[i]!)).toBeLessThanOrEqual(tolerance * Math.max(1, Math.abs(expected[i]!))));
  };

  it("burns the same globe: noise, holes, tears, dome points, fronts and embers", () => {
    for (const { at, value } of golden.noise) near([clocheBurnNoise({ x: at[0]! * 9.3, y: at[1]! * 9.3, z: at[2]! * 9.3 })], [value], 1e-9);
    for (const entry of golden.globe) {
      const shape = fitCloche(golden.fits.find((fit) => fit.name === entry.fit)!.points.map(vector))!;
      const offset = clocheSeedOffset(entry.seed);
      const random = clocheRandom(offset);
      expect(entry.random.map(() => random())).toEqual(entry.random);
      for (const sample of entry.surface) {
        const point = clocheLocalPoint(shape, vector(sample.direction));
        near([point.x, point.y, point.z], sample.point, 1e-9);
        const normal = clocheNormalAt(shape, point);
        near([normal.x, normal.y, normal.z], sample.normal, 1e-9);
        near([clocheBurnAt(shape, offset, point), clocheTearAt(shape, offset, point)], [sample.burn, sample.tear], 1e-9);
      }
      const fronts = clocheBurnFronts(shape, offset, 12);
      expect(fronts.length).toBe(entry.fronts.length);
      fronts.forEach(({ point, normal }, i) => {
        near([point.x, point.y, point.z], entry.fronts[i]!.point, 1e-9);
        near([normal.x, normal.y, normal.z], entry.fronts[i]!.normal, 1e-9);
      });
      const embers = clocheEmbers(shape, offset, 64);
      // Kept in 32-bit floats.
      near(Array.from(embers.positions), entry.embers.positions, 1e-6);
      near(Array.from(embers.seeds), entry.embers.seeds, 1e-6);
    }
  });

  it("burns holes and tears on part of every golden dome, not all or none", () => {
    for (const entry of golden.globe) {
      const burns = entry.surface.map((sample) => sample.burn);
      const tears = entry.surface.map((sample) => sample.tear);
      expect(burns.some((burn) => burn < 0) && burns.some((burn) => burn > 0)).toBe(true);
      for (const tear of tears) expect(tear >= 0 && tear <= 1).toBe(true);
    }
    expect(golden.globe.flatMap((entry) => entry.surface).some((sample) => sample.tear === 0)).toBe(true);
    expect(golden.globe.flatMap((entry) => entry.surface).some((sample) => sample.tear === 1)).toBe(true);
  });
});

function dot(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function normalise(v: { x: number; y: number; z: number }) {
  const length = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}
