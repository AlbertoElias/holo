// The 3D halo (styleguide 3.4, decided 2026-10-25): a glass dome, the
// cloche, resting on the hologram's floor and fitted to what is drawn, with
// the burnt edge at its silhouette and along its foot. It is anchored to the
// hologram in world space, so it orbits and zooms with it. Every renderer
// fits, frames and fades it with these functions; none of it is exported in
// a GLB.
import { tokens } from "@holoim/design-tokens";

import { clocheBentSurfacePoints, clocheUnbend } from "./clocheRim.js";
import type { EdgeFrame, Vector3Like } from "./edge.js";

const { cloche } = tokens.edge;

/**
 * A superellipsoid `|x/rx|^n + |y/ry|^n + |z/rz|^n = 1` around `base`, drawn
 * only above the floor (y ≥ base.y). Lengths are metres in the hologram's
 * world space.
 */
export interface ClocheShape {
  /** The centre of the dome's foot, on the floor. */
  base: Vector3Like;
  /** Horizontal semi-axes (x, z) and the height (y). */
  radii: Vector3Like;
  exponent: number;
  /** The drawn footprint the hologram's shade covers: an ellipse on the floor. */
  shade: { center: Vector3Like; radiusX: number; radiusZ: number };
}

/** `|x/rx|^n + |y/ry|^n + |z/rz|^n` of a point: below 1 inside the dome's full superellipsoid. */
export function clocheValue(shape: Pick<ClocheShape, "base" | "radii" | "exponent">, point: Vector3Like): number {
  const { base, radii, exponent: n } = shape;
  return (
    Math.abs((point.x - base.x) / radii.x) ** n +
    Math.abs((point.y - base.y) / radii.y) ** n +
    Math.abs((point.z - base.z) / radii.z) ** n
  );
}

/**
 * The dome around every drawn point (the bubble's content, never the bubble
 * mesh): its foot on the lowest point, its proportions the content's, then
 * scaled until the furthest point is inside, plus the margin. Fitted once per
 * hologram: a dome that refits as the take plays would breathe. Null with no
 * points.
 *
 * With `floorY` (the recorded floor), the foot stands on it instead: a
 * recorded person stands on the floor, and the ground under it (a terrain's
 * flanks, water below) is not what the dome is fitted to.
 */
export function fitCloche(allPoints: readonly Vector3Like[], { floorY }: { floorY?: number | undefined } = {}): ClocheShape | null {
  if (allPoints.length === 0) return null;
  const hasFloor = floorY !== undefined && Number.isFinite(floorY);
  // What lies below the floor (ground falling away from a hilltop, the
  // valley a walk goes down into) still belongs under the dome: it is lifted
  // onto the floor, so it widens the foot instead of being dropped.
  const points = hasFloor ? allPoints.map((point) => (point.y >= floorY ? point : { x: point.x, y: floorY, z: point.z })) : allPoints;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const point of points) {
    min.x = Math.min(min.x, point.x);
    min.y = Math.min(min.y, point.y);
    min.z = Math.min(min.z, point.z);
    max.x = Math.max(max.x, point.x);
    max.y = Math.max(max.y, point.y);
    max.z = Math.max(max.z, point.z);
  }
  if (hasFloor) min.y = floorY;
  const height = Math.max(max.y - min.y, 0.05);
  const halfX = (max.x - min.x) / 2;
  const halfZ = (max.z - min.z) / 2;
  const base = { x: (min.x + max.x) / 2, y: min.y, z: (min.z + max.z) / 2 };
  const exponent = cloche.exponent;
  // A flat take still gets a volume: no axis thinner than half the height.
  const radii = { x: Math.max(halfX, height / 2), y: height, z: Math.max(halfZ, height / 2) };
  let furthest = 0;
  for (const point of points) furthest = Math.max(furthest, clocheValue({ base, radii, exponent }, point));
  const scale = (furthest > 0 ? furthest ** (1 / exponent) : 1) * cloche.fitMargin;
  radii.x *= scale;
  radii.y *= scale;
  radii.z *= scale;
  // One shoulder curvature for every hologram: never a pancake.
  radii.y = Math.max(radii.y, cloche.minHeightShare * Math.max(radii.x, radii.z));
  return {
    base,
    radii,
    exponent,
    shade: { center: { x: base.x, y: base.y, z: base.z }, radiusX: Math.max(halfX, 0.05) * cloche.shadeScale, radiusZ: Math.max(halfZ, 0.05) * cloche.shadeScale }
  };
}

/** A point on the full superellipsoid in the direction of the unit vector `d`. */
export function clochePoint(shape: Pick<ClocheShape, "base" | "radii" | "exponent">, d: Vector3Like): Vector3Like {
  const { base, radii, exponent: n } = shape;
  const k = (Math.abs(d.x) ** n + Math.abs(d.y) ** n + Math.abs(d.z) ** n) ** (1 / n);
  return { x: base.x + (d.x / k) * radii.x, y: base.y + (d.y / k) * radii.y, z: base.z + (d.z / k) * radii.z };
}

/** Points on the drawn dome (y ≥ the floor), its foot included, for framing it. */
export function clocheSurfacePoints(shape: ClocheShape, rings = 12, perRing = 48): Vector3Like[] {
  const points: Vector3Like[] = [];
  for (let i = 0; i <= rings; i += 1) {
    const polar = (i / rings) * (Math.PI / 2);
    for (let j = 0; j < perRing; j += 1) {
      const around = (j / perRing) * Math.PI * 2;
      points.push(clochePoint(shape, { x: Math.sin(polar) * Math.cos(around), y: Math.cos(polar), z: Math.sin(polar) * Math.sin(around) }));
    }
  }
  return points;
}

/** The unit vector from the dome toward the Follow camera: a little right of front, a little above. */
export function clocheFollowDirection(): Vector3Like {
  const yaw = (cloche.followYaw * Math.PI) / 180;
  const pitch = (cloche.followPitch * Math.PI) / 180;
  return { x: Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: Math.cos(yaw) * Math.cos(pitch) };
}

export interface ClocheFraming {
  /** Where the camera looks: the middle of the drawn dome. */
  target: Vector3Like;
  /** How far back along the view direction the camera stands. */
  distance: number;
}

/**
 * The Follow view of a dome in a viewing box: the camera on `direction`
 * from the dome's middle, just far enough that every point of the drawn dome
 * is inside the box's frustum at `frameShare` of its size. `fovY` is the
 * vertical field of view of the box in radians; `aspect` its width over
 * height. With `rim` (the feed's lowest rim over the take), the dome is
 * framed bent onto it.
 */
export function clocheFraming(shape: ClocheShape, { fovY, aspect, direction = clocheFollowDirection(), frameShare = cloche.frameShare, rim }: { fovY: number; aspect: number; direction?: Vector3Like; frameShare?: number; rim?: ArrayLike<number> | null | undefined }): ClocheFraming {
  const points = rim ? clocheBentSurfacePoints(shape, rim) : clocheSurfacePoints(shape);
  const target = {
    x: shape.base.x,
    y: shape.base.y + shape.radii.y / 2,
    z: shape.base.z
  };
  const forward = normalize(direction);
  // right = up × forward, up' = forward × right (a camera that never rolls).
  const right = normalize({ x: forward.z, y: 0, z: -forward.x });
  const up = cross(forward, right);
  const tanY = Math.tan(fovY / 2) * frameShare;
  const tanX = tanY * aspect;
  let distance = 0;
  for (const point of points) {
    const offset = { x: point.x - target.x, y: point.y - target.y, z: point.z - target.z };
    const depth = dot(offset, forward);
    distance = Math.max(distance, depth + Math.abs(dot(offset, right)) / tanX, depth + Math.abs(dot(offset, up)) / tanY);
  }
  return { target, distance };
}

/**
 * How much of the dome is drawn with the eye at `eye`: 1 outside, easing to 0
 * as the viewer goes in, so inside the hologram nothing of the dome stands
 * between them and the event. With `rim`, against the bent dome.
 */
export function clocheOpacityAt(shape: ClocheShape, eye: Vector3Like, rim?: ArrayLike<number> | null): number {
  const value = clocheValue(shape, rim ? clocheUnbend(shape, rim, eye) : eye);
  const from = cloche.insideFadeFrom;
  const to = cloche.insideFadeTo;
  const t = Math.min(Math.max((value - to) / (from - to), 0), 1);
  return t * t * (3 - 2 * t);
}

/** A hologram's seed (its id, Q10) as the shader's noise offset, 0 to 100. */
export function clocheSeedOffset(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
  return ((hash >>> 0) % 10000) / 100;
}

function dot(a: Vector3Like, b: Vector3Like): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vector3Like, b: Vector3Like): Vector3Like {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function normalize(v: Vector3Like): Vector3Like {
  const length = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

/**
 * The char beside the gold (3.4): at rest on dark ground, full where the
 * soot rule (3.2) says the ground is light or the AR room bright. The cloche
 * draws no soot; its own char line keeps the edge legible instead.
 */
export function clocheCharShare(frame: Pick<EdgeFrame, "sootOpacity">): number {
  const { rest, bright } = tokens.edge.char;
  const t = Math.min(Math.max(frame.sootOpacity / tokens.edge.soot.flatOpacity, 0), 1);
  return rest + (bright - rest) * t;
}
