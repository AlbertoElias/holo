import { CircleGeometry, PlaneGeometry, Quaternion, Vector3 } from 'three';

// Shapes and math the showcase scenes share.

/** Axis-angle (radians) to a glTF quaternion [x, y, z, w]. */
export function quat(axis, angle) {
  const q = new Quaternion().setFromAxisAngle(new Vector3(...axis).normalize(), angle);
  return [q.x, q.y, q.z, q.w];
}

/** Product of glTF quaternions, applied right to left. */
export function quatMul(...quats) {
  const out = new Quaternion();
  for (const q of quats) out.multiply(new Quaternion(...q));
  return [out.x, out.y, out.z, out.w];
}

/** A filled ellipse lying on the floor (XZ plane, facing +Y), centered at the origin. */
export function floorEllipse(radiusX, radiusZ, segments = 32) {
  const geometry = new CircleGeometry(1, segments);
  geometry.rotateX(-Math.PI / 2);
  geometry.scale(radiusX, 1, radiusZ);
  return geometry;
}

/**
 * A label from `renderLabels` as a textured quad. It is built facing +Z with
 * its bottom edge on the node's origin; rotate the node to lay or tilt it.
 * `metersPerPx` sets its true size (CSS px of the label's font size).
 */
export function addLabel(glb, label, { name, metersPerPx, translation, rotation, parent }) {
  const width = label.width * metersPerPx;
  const height = label.height * metersPerPx;
  const geometry = new PlaneGeometry(width, height);
  geometry.translate(0, height / 2, 0);
  const material = glb.material({ name: `${name}Ink`, texture: glb.texture(label.png), unlit: true, blend: true });
  return glb.node({ name, mesh: glb.mesh(name, geometry, material), translation, rotation, parent });
}

function hash3(x, y, z, seed) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Smooth value noise in [0, 1]. */
export function noise3(x, y, z, seed = 1) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const fade = (t) => t * t * (3 - 2 * t);
  const u = fade(x - xi);
  const v = fade(y - yi);
  const w = fade(z - zi);
  const lerp = (a, b, t) => a + (b - a) * t;
  const corner = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz, seed);
  return lerp(
    lerp(lerp(corner(0, 0, 0), corner(1, 0, 0), u), lerp(corner(0, 1, 0), corner(1, 1, 0), u), v),
    lerp(lerp(corner(0, 0, 1), corner(1, 0, 1), u), lerp(corner(0, 1, 1), corner(1, 1, 1), u), v),
    w
  );
}

/** Fractal noise in [0, 1]: `octaves` layers of noise3, each twice as fine and half as strong. */
export function fbm3(x, y, z, { octaves = 4, seed = 1 } = {}) {
  let sum = 0;
  let amplitude = 0.5;
  let total = 0;
  let frequency = 1;
  for (let i = 0; i < octaves; i += 1) {
    sum += amplitude * noise3(x * frequency, y * frequency, z * frequency, seed + i);
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / total;
}

/** Deterministic random numbers in [0, 1). */
export function rng(seed = 1) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
