// The feed's rim follows the ground (styleguide 3.4, 2026-10-27): the dome's
// foot bends up, per direction around it, onto the recorded ground under its
// edge, so a take recorded on a hill stands on its own ground instead of
// floating in empty glass. The shape stays the fitted one (`fitCloche`); the
// rim is a lift per direction, and every point of the dome rises by
// L(θ) · w(ρ) · (1 − y/ry): full at the foot, none at the crown, none near
// the axis under the author's feet. One angle for bins and samples,
// θ = atan2(z/rz, x/rx), so a footprint stretched by a walk lifts the right
// way. Lengths are metres in the shape's space (the hologram's world, less
// the bubble's shift since the fit). XR, AR and Quick Look keep a flat foot.
import { tokens } from "@holoim/design-tokens";

import type { ClocheShape } from "./cloche.js";
import { clochePoint, clocheValue } from "./cloche.js";
import type { Vector3Like } from "./edge.js";

const { rim: rimTokens } = tokens.edge.cloche;

/** Directions around the foot: the rim's heights, one per bin. */
export const CLOCHE_RIM_BINS: number = rimTokens.bins;

type Shape = Pick<ClocheShape, "base" | "radii" | "exponent">;

/** The direction of a point around the foot, 0 to 2π, as the shader reads it. */
export function clocheRimAngle(shape: Shape, x: number, z: number): number {
  const angle = Math.atan2((z - shape.base.z) / shape.radii.z, (x - shape.base.x) / shape.radii.x);
  return angle < 0 ? angle + Math.PI * 2 : angle;
}

/** The lift in a direction: the bins linearly filtered and wrapped, as the GPU's texture does. */
export function clocheRimLift(rim: ArrayLike<number>, angle: number): number {
  const bins = rim.length;
  if (bins === 0) return 0;
  const f = (angle / (Math.PI * 2)) * bins - 0.5;
  const i0 = Math.floor(f);
  const t = f - i0;
  const a = rim[((i0 % bins) + bins) % bins]!;
  const b = rim[(((i0 + 1) % bins) + bins) % bins]!;
  return a + (b - a) * t;
}

/** How much of the lift a point takes by its footprint: smoothstep(bendFrom, 1, ρ) of the superellipse norm. */
export function clocheRimWeight(shape: Shape, x: number, z: number): number {
  const n = shape.exponent;
  const rho = (Math.abs((x - shape.base.x) / shape.radii.x) ** n + Math.abs((z - shape.base.z) / shape.radii.z) ** n) ** (1 / n);
  const t = Math.min(Math.max((rho - rimTokens.bendFrom) / (1 - rimTokens.bendFrom), 0), 1);
  return t * t * (3 - 2 * t);
}

/** L(θ) · w(ρ): how far the foot rises under a point. */
export function clocheRimRise(shape: Shape, rim: ArrayLike<number> | null | undefined, x: number, z: number): number {
  if (!rim || rim.length === 0) return 0;
  const weight = clocheRimWeight(shape, x, z);
  return weight > 0 ? clocheRimLift(rim, clocheRimAngle(shape, x, z)) * weight : 0;
}

/** A point of the flat dome, bent onto the rim. Above the crown nothing moves. */
export function clocheBend(shape: Shape, rim: ArrayLike<number> | null | undefined, point: Vector3Like): Vector3Like {
  const rise = clocheRimRise(shape, rim, point.x, point.z);
  const y = point.y - shape.base.y;
  return { x: point.x, y: point.y + rise * Math.max(0, 1 - y / shape.radii.y), z: point.z };
}

/** The flat dome's point that bends onto `point`: the inverse of `clocheBend`. */
export function clocheUnbend(shape: Shape, rim: ArrayLike<number> | null | undefined, point: Vector3Like): Vector3Like {
  const rise = clocheRimRise(shape, rim, point.x, point.z);
  const y = point.y - shape.base.y;
  if (rise === 0 || y >= shape.radii.y) return { x: point.x, y: point.y, z: point.z };
  return { x: point.x, y: shape.base.y + (y - rise) / (1 - rise / shape.radii.y), z: point.z };
}

/**
 * Whether a point is under the drawn glass: above the (bent) foot and inside
 * the (bent) superellipsoid. The feed's scene clip is its GLSL twin
 * (`CLOCHE_RIM_GLSL`); a touch, a pointing highlight and the inside fade
 * read it here.
 */
export function clocheInside(shape: Shape, rim: ArrayLike<number> | null | undefined, point: Vector3Like): boolean {
  const flat = clocheUnbend(shape, rim, point);
  return flat.y >= shape.base.y && clocheValue(shape, flat) <= 1;
}

/** The foot's edge (ρ = 1) at the middle of bin `bin`, in the shape's space. */
export function clocheRimEdge(shape: Shape, bin: number, bins = CLOCHE_RIM_BINS): { x: number; z: number } {
  const angle = ((bin + 0.5) / bins) * Math.PI * 2;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const n = shape.exponent;
  const k = (Math.abs(c) ** n + Math.abs(s) ** n) ** (1 / n);
  return { x: shape.base.x + (c / k) * shape.radii.x, z: shape.base.z + (s / k) * shape.radii.z };
}

/**
 * The dead-band: ground less than `deadBand` over the foot does not lift it
 * (a flat take's foot a few cm under its surface), and above that the lift
 * ramps back to the full height by twice the band, so a lifted rim stands on
 * the ground rather than the band below it.
 */
function deadBand(height: number): number {
  const band = rimTokens.deadBand;
  if (height <= band) return 0;
  return height >= band * 2 ? height : (height - band) * 2;
}

/**
 * The lift each bin wants: the ground at the foot's edge over the foot,
 * through the dead-band, capped at a share of the dome's height. `groundAt`
 * gives the ground's height in the shape's space, NaN where there is none
 * (no lift).
 */
export function clocheRimRaw(shape: Shape, groundAt: (x: number, z: number) => number, out: Float32Array = new Float32Array(CLOCHE_RIM_BINS)): Float32Array {
  const cap = rimTokens.maxShare * shape.radii.y;
  for (let bin = 0; bin < out.length; bin += 1) {
    const edge = clocheRimEdge(shape, bin, out.length);
    const ground = groundAt(edge.x, edge.z);
    out[bin] = Number.isFinite(ground) ? Math.min(deadBand(ground - shape.base.y), cap) : 0;
  }
  return out;
}

const SIGMA_REACH = Math.ceil(rimTokens.sigma * 3);
const GAUSSIAN = (() => {
  const weights = Array.from({ length: SIGMA_REACH * 2 + 1 }, (_, i) => Math.exp(-((i - SIGMA_REACH) ** 2) / (2 * rimTokens.sigma ** 2)));
  const sum = weights.reduce((total, weight) => total + weight, 0);
  return weights.map((weight) => weight / sum);
})();

/**
 * Across bins: a max filter (none by default: one bin either side already
 * stands 10 cm over a 30° flank), then a circular Gaussian, never below the
 * raw lift, so the rim is never under the ground it reads, and never more
 * than `smoothRise` over it, so a cliff's corner does not float its
 * neighbours. Where the ground itself steps (a ledge, a crag), the rim
 * steps with it: it hugs the ground rather than standing over the lower side.
 */
export function smoothClocheRim(raw: ArrayLike<number>, out: Float32Array = new Float32Array(raw.length)): Float32Array {
  const bins = raw.length;
  const peak = new Float32Array(bins);
  const reach = rimTokens.maxFilter;
  for (let bin = 0; bin < bins; bin += 1) {
    let highest = 0;
    for (let k = -reach; k <= reach; k += 1) highest = Math.max(highest, raw[(((bin + k) % bins) + bins) % bins]!);
    peak[bin] = highest;
  }
  for (let bin = 0; bin < bins; bin += 1) {
    let sum = 0;
    for (let k = -SIGMA_REACH; k <= SIGMA_REACH; k += 1) sum += GAUSSIAN[k + SIGMA_REACH]! * peak[(((bin + k) % bins) + bins) % bins]!;
    out[bin] = Math.min(Math.max(sum, raw[bin]!), raw[bin]! + rimTokens.smoothRise);
  }
  return out;
}

/**
 * The rim over time: it rises fast and settles slowly, never faster than
 * `maxRate`, so ground passing under the edge never pops it. `snap` (a loop, a seek, the bubble jumping,
 * reduced motion, the first frame) takes the target at once.
 */
export function easeClocheRim(current: Float32Array, target: ArrayLike<number>, dtS: number, snap: boolean): Float32Array {
  const up = snap ? 1 : 1 - Math.exp(-Math.max(dtS, 0) / rimTokens.easeUp);
  const down = snap ? 1 : 1 - Math.exp(-Math.max(dtS, 0) / rimTokens.easeDown);
  const limit = rimTokens.maxRate * Math.max(dtS, 0);
  for (let bin = 0; bin < current.length; bin += 1) {
    const goal = target[bin] ?? 0;
    const value = current[bin]!;
    const step = (goal - value) * (goal > value ? up : down);
    current[bin] = snap ? goal : value + Math.min(Math.max(step, -limit), limit);
  }
  return current;
}

/** Points on the drawn dome bent onto `rim`, its foot included, for framing it. */
export function clocheBentSurfacePoints(shape: Shape, rim: ArrayLike<number> | null | undefined, rings = 12, perRing = 48): Vector3Like[] {
  const points: Vector3Like[] = [];
  for (let i = 0; i <= rings; i += 1) {
    const polar = (i / rings) * (Math.PI / 2);
    for (let j = 0; j < perRing; j += 1) {
      const around = (j / perRing) * Math.PI * 2;
      points.push(clocheBend(shape, rim, clochePoint(shape, { x: Math.sin(polar) * Math.cos(around), y: Math.cos(polar), z: Math.sin(polar) * Math.sin(around) })));
    }
  }
  return points;
}

/**
 * GLSL twin of the rim: `clocheRimRise(rim, radii, n, local.xz)` and
 * `clocheBentInside(rim, radii, n, local)`, with `local` relative to the foot's
 * centre and the heights in a `CLOCHE_RIM_BINS`×1 texture, linearly filtered,
 * wrapping in u.
 */
export const CLOCHE_RIM_GLSL = /* glsl */ `
float clocheRimRise(sampler2D rim, vec3 radii, float n, vec2 xz) {
  vec2 q = xz / radii.xz;
  float rho = pow(pow(abs(q.x), n) + pow(abs(q.y), n), 1.0 / n);
  float w = smoothstep(${rimTokens.bendFrom.toFixed(4)}, 1.0, rho);
  if (w <= 0.0) return 0.0;
  float u = atan(q.y, q.x) / 6.28318530718;
  return texture2D(rim, vec2(fract(u), 0.5)).r * w;
}
vec3 clocheRimBend(sampler2D rim, vec3 radii, float n, vec3 local) {
  float rise = clocheRimRise(rim, radii, n, local.xz);
  return vec3(local.x, local.y + rise * max(0.0, 1.0 - local.y / radii.y), local.z);
}
bool clocheBentInside(sampler2D rim, vec3 radii, float n, vec3 local) {
  float rise = clocheRimRise(rim, radii, n, local.xz);
  float y = local.y >= radii.y ? local.y : (local.y - rise) / (1.0 - rise / radii.y);
  if (y < 0.0) return false;
  vec3 q = abs(vec3(local.x, y, local.z) / radii);
  return pow(q.x, n) + pow(q.y, n) + pow(q.z, n) <= 1.0;
}`;
