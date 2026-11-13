import { BufferAttribute } from 'three';

// Growing the world without moving a node.
//
// The feed fits its dome once, from every mesh's own vertices as they stand
// and the box corners of every mesh whose transform the clip moves, sampled
// through the take (viewer-web drawnPoints.ts). A world grown by a node's
// scale would be in that fit at its largest, and the camera would stand back
// to frame it. A morph target is not: a still node's mesh is fitted by its
// base vertices alone. So each layer is built at its "home" size (the size
// it fills the view at) on a node that never moves, and two morph targets
// scale it about the zoom centre: one shrinks it to `inner` of home (inside
// the layer before it), one grows it to `outer` of home (past the camera,
// once the viewer is inside). A uniform scale is linear in the vertex
// position, so a morph weight reproduces it exactly at every value.

/** Adds the shrink and grow targets to `geo` (indexed or not), about `centre`. */
export function zoomable(geo, centre, { inner, outer }) {
  const pos = geo.attributes.position;
  const shrink = new Float32Array(pos.count * 3);
  const grow = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 1) {
    for (let k = 0; k < 3; k += 1) {
      const d = pos.array[i * 3 + k] - centre[k];
      shrink[i * 3 + k] = (inner - 1) * d;
      grow[i * 3 + k] = (outer - 1) * d;
    }
  }
  geo.morphAttributes.position = [new BufferAttribute(shrink, 3), new BufferAttribute(grow, 3)];
  geo.morphTargetsRelative = true;
  geo.userData.zoom = { inner, outer };
  return geo;
}

/** The two weights that draw a zoomable layer at `s` times its home size. */
export function zoomWeights(s, { inner, outer }) {
  if (s <= 1) return [Math.min(1, (1 - s) / (1 - inner)), 0];
  return [0, Math.min(1, (s - 1) / (outer - 1))];
}

/** Where a point at `p` (home) is when its layer is drawn at `s`. */
export const zoomed = (p, centre, s) => p.map((v, k) => centre[k] + s * (v - centre[k]));

// ---------------------------------------------------------------------------
// Moving shapes inside a zooming layer. A shape is a per-vertex delta Δ (gas
// drift, a travelling wave, a door sliding). Drawn at zoom s it must move by
// s·Δ, so each shape gets two targets, Δ and (outer−1)Δ. Below home size the
// first alone, weighted w·s, gives s·Δ; above it, w and w·g (g the grow
// weight) give Δ + (s−1)Δ. Every weight stays within 0..1.

/** Zoom targets plus two per shape (Float32Array deltas, one VEC3 per vertex). */
export function morphLayer(geo, centre, zoom, shapes = [], normals = null) {
  zoomable(geo, centre, zoom);
  const { outer } = zoom;
  const list = geo.morphAttributes.position;
  for (const d of shapes) {
    list.push(new BufferAttribute(Float32Array.from(d), 3));
    list.push(new BufferAttribute(d.map((v) => (outer - 1) * v), 3));
  }
  // Optional normal deltas, one per shape: on the first target of its pair
  // (weighted by the shape's weight once the layer is at or above home size).
  if (normals) {
    const none = () => new BufferAttribute(new Float32Array(geo.attributes.position.count * 3), 3);
    geo.morphAttributes.normal = [none(), none(), ...normals.flatMap((n) => [new BufferAttribute(Float32Array.from(n), 3), none()])];
  }
  geo.userData.shapes = shapes.length;
  return geo;
}

/** Weights for a morphLayer drawn at `s` with each shape at weight `w[i]`. */
export function layerWeights(s, zoom, w = []) {
  const [h, g] = zoomWeights(s, zoom);
  const below = Math.min(1, Math.max(s, zoom.inner));
  return [h, g, ...w.flatMap((x) => [x * below, x * g])];
}

/** The scale a layer actually reaches at s (the targets clamp it to [inner, outer]). */
export const clampScale = (s, { inner, outer }) => Math.min(outer, Math.max(inner, s));

// ---------------------------------------------------------------------------
// The feed's dome fit (packages/xr-ui-core/src/cloche.ts fitCloche, no floor):
// computed at build time so the zoom centre can be the Follow target.

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
