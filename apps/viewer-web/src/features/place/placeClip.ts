// The cloche's cut through a scanned place (docs/features/splat-place.md,
// Clipping). The dome is the feed's flat one (a place turns the rim off), read
// from the same shape and shift the cloche is drawn from. A splat is tested by
// its extent, not its centre, and fades out toward the glass: the GLSL here
// runs in Spark's shader, and the function below is its twin for the e2e
// report and the load-time crop.

/** Spark draws a splat's ellipse out to this many standard deviations (`SparkRenderer.maxStdDev`). */
export const SPLAT_EXTENT_SIGMA = Math.sqrt(8);
/** The fade starts this share of the way in from the glass, as a share of the dome's radius at that point. */
export const CLIP_FADE_SHARE = 0.08;
/** Splats this far under the dome's foot are floaters, metres; the floor's own splats straddle it. */
export const FLOOR_SLACK_METERS = 0.05;
/** A splat larger than this is background, never a part of the place, metres. */
export const MAX_SPLAT_EXTENT_METERS = 1.5;

export type DomeShape = {
  base: { x: number; y: number; z: number };
  radii: { x: number; y: number; z: number };
  exponent: number;
};

/** The most a per-axis norm of exponent `n` grows by for a unit step along a diagonal of the three axes. */
export function diagonalFactor(n: number): number {
  return 3 ** (1 / n);
}

/**
 * How much of the splat shows, 0 at or past the glass to 1 well inside it.
 * The dome's value `f` is a norm (the exponent is above 2), so moving a
 * point by the splat's extent changes it by at most extent / the dome's
 * smallest radius, and by at most `3^(1/n)` times that for a move along a
 * diagonal in the per-axis norm; the test takes the larger, so a splat with
 * `f` plus that under 1 lies wholly inside however its extent points. The
 * GLSL twin below uses the same factor.
 */
export function placeClipFade(dome: DomeShape, center: { x: number; y: number; z: number }, largestScale: number): number {
  const extent = SPLAT_EXTENT_SIGMA * largestScale;
  if (extent > MAX_SPLAT_EXTENT_METERS) return 0;
  const lx = center.x - dome.base.x;
  const ly = center.y - dome.base.y;
  const lz = center.z - dome.base.z;
  if (ly < -FLOOR_SLACK_METERS) return 0;
  const n = dome.exponent;
  const f = (Math.abs(lx / dome.radii.x) ** n + Math.abs(Math.max(ly, 0) / dome.radii.y) ** n + Math.abs(lz / dome.radii.z) ** n) ** (1 / n);
  const value = f + (extent * diagonalFactor(n)) / Math.min(dome.radii.x, dome.radii.y, dome.radii.z);
  const from = 1 - CLIP_FADE_SHARE;
  const t = Math.min(Math.max((value - from) / CLIP_FADE_SHARE, 0), 1);
  return 1 - t * t * (3 - 2 * t);
}

/** The splat's own extent leaves the dome's sides or top: probed in 26 directions, apart from the shader's shrunken-dome test. The floor is exempt. */
export function extentLeavesDome(dome: DomeShape, center: { x: number; y: number; z: number }, largestScale: number): boolean {
  const extent = SPLAT_EXTENT_SIGMA * largestScale;
  const n = dome.exponent;
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const length = Math.hypot(dx, dy, dz);
        const x = center.x + (dx / length) * extent - dome.base.x;
        const y = center.y + (dy / length) * extent - dome.base.y;
        const z = center.z + (dz / length) * extent - dome.base.z;
        // Below the foot is the floor's slack, not the glass.
        if (y < 0) continue;
        if (Math.abs(x / dome.radii.x) ** n + Math.abs(y / dome.radii.y) ** n + Math.abs(z / dome.radii.z) ** n > 1 + 1e-6) return true;
      }
    }
  }
  return false;
}

/** GLSL twin of `placeClipFade`; `place_clip_fade(center, scales, base, radii, n)`. */
export const PLACE_CLIP_GLSL = /* glsl */ `
float place_clip_fade(vec3 center, vec3 scales, vec3 base, vec3 radii, float n) {
  float extent = ${SPLAT_EXTENT_SIGMA.toFixed(6)} * max(scales.x, max(scales.y, scales.z));
  if (extent > ${MAX_SPLAT_EXTENT_METERS.toFixed(3)}) return 0.0;
  vec3 l = center - base;
  if (l.y < -${FLOOR_SLACK_METERS.toFixed(3)}) return 0.0;
  vec3 q = vec3(abs(l.x) / radii.x, max(l.y, 0.0) / radii.y, abs(l.z) / radii.z);
  float f = pow(pow(q.x, n) + pow(q.y, n) + pow(q.z, n), 1.0 / n);
  float value = f + extent * pow(3.0, 1.0 / n) / min(radii.x, min(radii.y, radii.z));
  float from = ${(1 - CLIP_FADE_SHARE).toFixed(4)};
  float t = clamp((value - from) / ${CLIP_FADE_SHARE.toFixed(4)}, 0.0, 1.0);
  return 1.0 - t * t * (3.0 - 2.0 * t);
}`;
