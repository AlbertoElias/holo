// The burnt globe's shared rules (3.4). Its failure modes: sparks leaving
// from where nothing burns (sites off the fronts or off the dome), a
// hologram whose burns or embers move between loads or match every other
// hologram's, embers floating free of the dome or under the floor, the noise
// leaving its 0–1 range (a threshold that burns all or nothing), and a quiet
// front that covers the event face-on, hides the silhouette, or burns
// further in at rest than in focus.
import { describe, expect, it } from "vitest";

import { fitCloche, type ClocheShape } from "./cloche.js";
import {
  clocheBurnAt,
  clocheBurnFronts,
  clocheBurnNoise,
  clocheEmbers,
  clocheLocalPoint,
  clocheNormalAt,
  clocheQuiet,
  clocheValue
} from "./index.js";

const shape = fitCloche([
  { x: 1, y: 0, z: -1 },
  { x: 3, y: 1.5, z: 1 }
]) as ClocheShape;
const atFoot = { ...shape, base: { x: 0, y: 0, z: 0 } };
const wider = Math.max(shape.radii.x, shape.radii.y, shape.radii.z);

describe("the burnt globe (3.4)", () => {
  it("keeps its noise between 0 and 1, spread enough that a threshold leaves both holes and shell", () => {
    let low = 1;
    let high = 0;
    let burnt = 0;
    for (let i = 0; i < 4000; i += 1) {
      const value = clocheBurnNoise({ x: i * 0.137, y: i * 0.071, z: i * 0.193 });
      low = Math.min(low, value);
      high = Math.max(high, value);
      if (value < 0.4) burnt += 1;
    }
    expect(low).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(1);
    expect(burnt / 4000).toBeGreaterThan(0.1);
    expect(burnt / 4000).toBeLessThan(0.6);
  });

  it("sheds sparks from the burning fronts, on the dome", () => {
    const sites = clocheBurnFronts(shape, 42, 80);
    expect(sites.length).toBe(80);
    for (const { point, normal } of sites) {
      expect(Math.abs(clocheBurnAt(shape, 42, point))).toBeLessThan(0.02);
      expect(clocheValue(atFoot, point)).toBeCloseTo(1, 6);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(Math.hypot(normal.x, normal.y, normal.z)).toBeCloseTo(1, 9);
    }
  });

  it("burns the same for one hologram on every load, and differently for another", () => {
    expect(clocheBurnFronts(shape, 42, 10)).toEqual(clocheBurnFronts(shape, 42, 10));
    expect(clocheEmbers(shape, 42, 50)).toEqual(clocheEmbers(shape, 42, 50));
    expect(clocheEmbers(shape, 43, 50).positions).not.toEqual(clocheEmbers(shape, 42, 50).positions);
    const point = clocheLocalPoint(shape, { x: 0.3, y: 0.8, z: 0.2 });
    expect(clocheBurnAt(shape, 42, point)).not.toBeCloseTo(clocheBurnAt(shape, 57, point), 3);
  });

  it("keeps every ember in the dome's surface and above its floor", () => {
    const { positions, normals } = clocheEmbers(shape, 7, 600);
    for (let i = 0; i < 600; i += 1) {
      const p = { x: positions[i * 3]!, y: positions[i * 3 + 1]!, z: positions[i * 3 + 2]! };
      expect(p.y).toBeGreaterThanOrEqual(0);
      const onDome = clocheLocalPoint(shape, p);
      expect(Math.hypot(p.x - onDome.x, p.y - onDome.y, p.z - onDome.z)).toBeLessThan(0.03 * wider);
      expect(Math.hypot(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!)).toBeCloseTo(1, 5);
    }
  });

  it("points its normals out of the dome", () => {
    const point = clocheLocalPoint(shape, { x: 0.5, y: 0.5, z: -0.4 });
    const normal = clocheNormalAt(shape, point);
    const out = { x: point.x + normal.x * 0.01, y: point.y + normal.y * 0.01, z: point.z + normal.z * 0.01 };
    expect(clocheValue(atFoot, out)).toBeGreaterThan(1);
  });

  it("is quiet face-on over the event, full at the silhouette, and burns further in when focused", () => {
    expect(clocheQuiet(1, 1)).toBeCloseTo(0, 9);
    expect(clocheQuiet(0.001, 0)).toBeGreaterThan(0.99);
    expect(clocheQuiet(-0.5, 0), "the far side shows through, behind the event").toBeGreaterThan(0.5);
    for (const facing of [0.2, 0.5, 0.8]) expect(clocheQuiet(facing, 0)).toBeLessThan(clocheQuiet(facing, 1));
    expect(clocheQuiet(0.5, 1)).toBeLessThan(0.6);
  });
});
