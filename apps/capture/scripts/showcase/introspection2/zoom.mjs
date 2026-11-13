// The feed's framing: its dome fit and its Follow direction. Nothing here
// zooms: the viewer goes in by itself, through the HologramLayer nodes
// (docs/features/archive/deep-zoom.md). The fit is computed at build time to check
// that the inner layers leave it as the man alone sets it.

// The feed's dome fit (packages/xr-ui-core/src/cloche.ts fitCloche, no floor).

const EXPONENT = 2.6;
export function feedFit(points) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k += 1) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  const height = Math.max(max[1] - min[1], 0.05);
  const base = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2];
  const radii = [Math.max((max[0] - min[0]) / 2, height / 2), height, Math.max((max[2] - min[2]) / 2, height / 2)];
  let furthest = 0;
  for (const p of points) {
    let v = 0;
    for (let k = 0; k < 3; k += 1) v += Math.abs((p[k] - base[k]) / radii[k]) ** EXPONENT;
    furthest = Math.max(furthest, v);
  }
  const scale = (furthest > 0 ? furthest ** (1 / EXPONENT) : 1) * 1.04;
  for (let k = 0; k < 3; k += 1) radii[k] *= scale;
  radii[1] = Math.max(radii[1], 0.4 * Math.max(radii[0], radii[2]));
  const target = [base[0], base[1] + radii[1] / 2, base[2]];
  // Follow distance measured on the feed in the spike: 2.685 × the dome's height.
  const distance = 2.685 * radii[1];
  const reach = Math.max(...radii);
  return { base, radii, target, distance, far: distance + reach * 4, near: Math.max(0.01, (distance - reach * 1.5) / 40) };
}

/** The feed's Follow direction (from the target toward the camera). */
export const FOLLOW = (() => {
  const yaw = (18 * Math.PI) / 180;
  const pitch = (16 * Math.PI) / 180;
  return [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
})();
/** Screen axes at Follow: right and up, unit vectors. */
export const SCREEN = (() => {
  const f = FOLLOW;
  const r = [f[2], 0, -f[0]];
  const n = Math.hypot(...r);
  const right = r.map((v) => v / n);
  const up = [f[1] * right[2] - f[2] * right[1], f[2] * right[0] - f[0] * right[2], f[0] * right[1] - f[1] * right[0]];
  return { right, up, toward: f };
})();
/** C + a·right + b·up + c·toward. */
export const onScreen = (C, a, b, c) => C.map((v, k) => v + a * SCREEN.right[k] + b * SCREEN.up[k] + c * SCREEN.toward[k]);
