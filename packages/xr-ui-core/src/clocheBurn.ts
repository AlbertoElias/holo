// The burnt globe (styleguide 3.4): the cloche burnt through by seeded 3D
// noise, so only torn burning fronts remain, with embers in its surface and
// sparks shed from the fronts. The noise is written twice, here and as GLSL
// below, so renderers that bake (Quick Look) and renderers that shade (the
// feed, AR) burn the same holes for the same hologram. Points are in the
// dome's own space: the foot at the origin, y up.
import { tokens } from "@holoim/design-tokens";

import type { ClocheShape } from "./cloche.js";
import type { Vector3Like } from "./edge.js";

const { cloche } = tokens.edge;

/** Value noise and its fbm, the same as `clocheBurnNoise` (hash without sine). */
export const CLOCHE_NOISE_GLSL = /* glsl */ `
float clocheHash(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float clocheNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(clocheHash(i), clocheHash(i + vec3(1, 0, 0)), f.x), mix(clocheHash(i + vec3(0, 1, 0)), clocheHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(clocheHash(i + vec3(0, 0, 1)), clocheHash(i + vec3(1, 0, 1)), f.x), mix(clocheHash(i + vec3(0, 1, 1)), clocheHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float clocheFbm(vec3 p) {
  return 0.55 * clocheNoise(p) + 0.3 * clocheNoise(p * 2.13 + 7.1) + 0.15 * clocheNoise(p * 4.7 + 3.3);
}`;

const fract = (x: number) => x - Math.floor(x);

function hash(x: number, y: number, z: number): number {
  const a = fract(x * 0.1031);
  const b = fract(y * 0.1031);
  const c = fract(z * 0.1031);
  const d = a * (c + 31.32) + b * (b + 31.32) + c * (a + 31.32);
  return fract((a + d + (b + d)) * (c + d));
}

function noise(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const s = (t: number) => t * t * (3 - 2 * t);
  const fx = s(x - ix);
  const fy = s(y - iy);
  const fz = s(z - iz);
  const h = (dx: number, dy: number, dz: number) => hash(ix + dx, iy + dy, iz + dz);
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  return mix(
    mix(mix(h(0, 0, 0), h(1, 0, 0), fx), mix(h(0, 1, 0), h(1, 1, 0), fx), fy),
    mix(mix(h(0, 0, 1), h(1, 0, 1), fx), mix(h(0, 1, 1), h(1, 1, 1), fx), fy),
    fz
  );
}

/** The burn noise at a point in noise space, 0 to 1 (the GLSL `clocheFbm`). */
export function clocheBurnNoise(p: Vector3Like): number {
  return (
    0.55 * noise(p.x, p.y, p.z) +
    0.3 * noise(p.x * 2.13 + 7.1, p.y * 2.13 + 7.1, p.z * 2.13 + 7.1) +
    0.15 * noise(p.x * 4.7 + 3.3, p.y * 4.7 + 3.3, p.z * 4.7 + 3.3)
  );
}

function wider(shape: Pick<ClocheShape, "radii">): number {
  return Math.max(shape.radii.x, shape.radii.y, shape.radii.z);
}

/**
 * How far past burnt a point of the shell is: below 0 it has burnt away,
 * 0 is a burning front. `seedOffset` is `clocheSeedOffset(id)`.
 */
export function clocheBurnAt(shape: Pick<ClocheShape, "radii">, seedOffset: number, local: Vector3Like): number {
  const k = cloche.burnFrequency / wider(shape);
  return clocheBurnNoise({ x: local.x * k + seedOffset, y: local.y * k + seedOffset, z: local.z * k + seedOffset }) - cloche.burnThreshold;
}

/** The point on the dome in a direction from its foot (y ≥ 0), in the dome's space. */
export function clocheLocalPoint(shape: Pick<ClocheShape, "radii" | "exponent">, d: Vector3Like): Vector3Like {
  const { radii, exponent: n } = shape;
  const k = (Math.abs(d.x / radii.x) ** n + Math.abs(d.y / radii.y) ** n + Math.abs(d.z / radii.z) ** n) ** (1 / n) || 1;
  return { x: d.x / k, y: d.y / k, z: d.z / k };
}

/** The dome's outward unit normal at a point on it. */
export function clocheNormalAt(shape: Pick<ClocheShape, "radii" | "exponent">, p: Vector3Like): Vector3Like {
  const { radii, exponent: n } = shape;
  const g = (c: number, r: number) => (Math.sign(c) * Math.abs(c / r) ** (n - 1)) / r;
  const x = g(p.x, radii.x);
  const y = g(p.y, radii.y);
  const z = g(p.z, radii.z);
  const length = Math.hypot(x, y, z) || 1;
  return { x: x / length, y: y / length, z: z / length };
}

/**
 * How strongly a front or an ember shows where the shell faces the eye by
 * `facing` (N·V, above 0 on the near side). Quiet over the event, full at the
 * silhouette; out of focus only the silhouette band shows. `focus` runs 0 to 1.
 */
export function clocheQuiet(facing: number, focus: number): number {
  if (facing <= 0) return cloche.farSide;
  return (1 - Math.min(facing, 1)) ** (cloche.quietRest + (cloche.quietFocus - cloche.quietRest) * focus);
}

/** A seeded generator, so one hologram's embers sit in the same places on every load. */
export function clocheRandom(seedOffset: number): () => number {
  let s = (Math.floor(seedOffset * 1000) % 2147483646) + 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

function direction(random: () => number, foot = 1): Vector3Like {
  // Uniform over the upper hemisphere when `foot` is 1; above 1 leans to the foot.
  const polar = Math.acos(1 - random() ** (1 / foot));
  const around = random() * Math.PI * 2;
  return { x: Math.sin(polar) * Math.cos(around), y: Math.cos(polar), z: Math.sin(polar) * Math.sin(around) };
}

export interface ClocheSite {
  point: Vector3Like;
  normal: Vector3Like;
}

/** Up to `count` points on the burning fronts, where sparks leave from. */
export function clocheBurnFronts(shape: Pick<ClocheShape, "radii" | "exponent">, seedOffset: number, count: number): ClocheSite[] {
  const random = clocheRandom(seedOffset + 11);
  const sites: ClocheSite[] = [];
  for (let i = 0; i < count * 40 && sites.length < count; i += 1) {
    const point = clocheLocalPoint(shape, direction(random));
    if (Math.abs(clocheBurnAt(shape, seedOffset, point)) < 0.02) sites.push({ point, normal: clocheNormalAt(shape, point) });
  }
  return sites;
}

export interface ClocheEmbers {
  /** xyz per ember, in the dome's space. */
  positions: Float32Array;
  /** The dome's normal under each ember. */
  normals: Float32Array;
  /** Four seeded values per ember: rest share and drift rate, phase, flicker rate, size. */
  seeds: Float32Array;
}

/** The embers: in and just off the dome's surface, a little denser toward the foot. */
export function clocheEmbers(shape: Pick<ClocheShape, "radii" | "exponent">, seedOffset: number, count: number = cloche.emberCount): ClocheEmbers {
  const random = clocheRandom(seedOffset + 5);
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 4);
  const spread = cloche.emberSpread * wider(shape);
  for (let i = 0; i < count; i += 1) {
    const point = clocheLocalPoint(shape, direction(random, 1.25));
    const normal = clocheNormalAt(shape, point);
    const off = (random() - 0.3) * spread;
    positions.set([point.x + normal.x * off, Math.max(0, point.y + normal.y * off), point.z + normal.z * off], i * 3);
    normals.set([normal.x, normal.y, normal.z], i * 3);
    seeds.set([random(), random(), random(), random()], i * 4);
  }
  return { positions, normals, seeds };
}
