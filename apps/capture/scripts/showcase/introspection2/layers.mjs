import { BufferAttribute, BufferGeometry, Float32BufferAttribute, PlaneGeometry, SphereGeometry, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { lin } from '../introspection/common.mjs';
import { PI, clamp } from './timeline.mjs';

// The layers' geometry, each built at its home size round the zoom centre C,
// with its moving shapes as per-vertex deltas (see zoom.mjs morphLayer). Every
// layer stays inside a ball of radius R (the skies' base radius) round C: the
// feed's dome fit is convex, so nothing inside that ball can widen the dome.

export const rng = (seed) => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

/** Position, colour and index only, shaded from its normals (for unlit materials). */
export function paint(geo, colour, { amb = 0.7, light = [0.3, 0.85, 0.4] } = {}) {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const L = new Vector3(...light).normalize();
  const n = new Vector3();
  const base = typeof colour === 'function' ? null : lin(colour);
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 1) {
    n.fromBufferAttribute(nor, i);
    const k = amb + (1 - amb) * Math.max(0, n.dot(L));
    const c = base ?? colour(pos.getX(i), pos.getY(i), pos.getZ(i));
    col.set([c[0] * k, c[1] * k, c[2] * k], i * 3);
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(Array.from(pos.array), 3));
  out.setAttribute('color', new BufferAttribute(col, 3));
  out.setIndex(geo.index ? Array.from(geo.index.array) : Array.from({ length: pos.count }, (_, i) => i));
  return out;
}

/** Turns a mesh inside out (for skies seen from within). */
function flip(geo) {
  const idx = geo.index.array;
  for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
  return geo;
}

/** Merges parts [{geo, shapes: {name: Float32Array}}] into one geometry and its shape list, in `names` order. */
function mergeParts(parts, names) {
  const geo = mergeGeometries(parts.map((p) => p.geo));
  const shapes = names.map((name) => {
    const out = new Float32Array(geo.attributes.position.count * 3);
    let at = 0;
    for (const p of parts) {
      const d = p.shapes?.[name];
      if (d) out.set(d, at);
      at += p.geo.attributes.position.count * 3;
    }
    return out;
  });
  return { geo, shapes, names };
}

/** A per-vertex delta from fn(p) → [dx, dy, dz]. */
function shapeOf(geo, fn) {
  const pos = geo.attributes.position;
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 1) out.set(fn([pos.getX(i), pos.getY(i), pos.getZ(i)], i), i * 3);
  return out;
}

// ---------------------------------------------------------------------------
// Skies: inverted spheres with a vertical gradient.

export function sky(C, R, top, bottom) {
  const a = lin(top);
  const b = lin(bottom);
  const g = new SphereGeometry(R, 28, 18);
  g.translate(...C);
  const out = paint(g, (x, y) => {
    const t = clamp((y - C[1]) / (2 * R) + 0.5);
    return [b[0] + (a[0] - b[0]) * t, b[1] + (a[1] - b[1]) * t, b[2] + (a[2] - b[2]) * t];
  }, { amb: 1 });
  return flip(out);
}

/** The sky radii at zoom S: each sky grows with its layer up to `cap`, and stays 15% outside the next one in. */
export function skyRadii(S, R, U, cap) {
  const own = (layer) => Math.min(cap, (R * S) / U[layer]);
  const dark = own('dark');
  const liquid = Math.max(own('liquid'), 1.15 * dark);
  const gas = Math.max(own('gas'), 1.15 * liquid);
  return { gas, liquid, dark };
}

// ---------------------------------------------------------------------------
// The trap door on the man's shirt: a warm light behind a shutter that slides up.

export const DOOR = { w: 0.034, h: 0.04 };
export function door(hit, { right, up, normal }) {
  const quad = (lift, hex, w, h, dy = 0) => {
    const g = new PlaneGeometry(w, h, 1, 1);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i += 1) {
      const x = pos.getX(i);
      const y = pos.getY(i) + dy;
      pos.setXYZ(i, ...[0, 1, 2].map((k) => hit[k] + x * right[k] + y * up[k] + lift * normal[k]));
    }
    g.computeVertexNormals();
    return paint(g, hex, { amb: 1 });
  };
  const light = quad(0.0015, '#ffd890', DOOR.w, DOOR.h);
  const shutter = quad(0.0028, '#d8d0bd', DOOR.w * 1.04, DOOR.h * 1.04);
  const handle = quad(0.0032, '#8a7a5c', DOOR.w * 0.5, DOOR.h * 0.08, -DOOR.h * 0.4);
  const slide = (g) => shapeOf(g, () => up.map((v) => v * DOOR.h * 1.05));
  return mergeParts([{ geo: light }, { geo: shutter, shapes: { open: slide(shutter) } }, { geo: handle, shapes: { open: slide(handle) } }], ['open']);
}

// ---------------------------------------------------------------------------
// The dark: a floor just under C, black on black, seen only in his light.
// Its rings close in geometrically on C, where he kneels with the child.

export function darkFloor(C, R, drop) {
  const pos = [C[0], C[1] - drop, C[2]];
  const idx = [];
  const segs = 40;
  const radii = [];
  for (let r = 0.0012; r < 0.9 * R; r *= 1.55) radii.push(r);
  radii.push(0.9 * R);
  for (const r of radii) {
    for (let j = 0; j < segs; j += 1) {
      const a = (j / segs) * 2 * PI;
      pos.push(C[0] + r * Math.cos(a), C[1] - drop, C[2] + r * Math.sin(a));
    }
  }
  const at = (i, j) => (i === 0 ? 0 : 1 + (i - 1) * segs + (j % segs));
  for (let i = 0; i < radii.length; i += 1) {
    for (let j = 0; j < segs; j += 1) {
      if (i === 0) idx.push(0, at(1, j + 1), at(1, j));
      else idx.push(at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i + 1, j));
    }
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(pos, 3));
  const c = lin('#0c0b10');
  out.setAttribute('color', new Float32BufferAttribute(pos.map((_, i) => c[i % 3]), 3));
  out.setIndex(idx);
  return out;
}

/** A pool of warm light on a floor: a disc of `radius` at `centre`, RGBA fading to its rim. */
export function lightPool(centre, radius, hex = '#ffcf80') {
  const c = lin(hex);
  const rings = [0, 0.25, 0.5, 0.75, 1];
  const segs = 32;
  const pos = [];
  const col = [];
  const idx = [];
  for (const k of rings) {
    const n = k === 0 ? 1 : segs;
    const a = 0.55 * (1 - k) ** 1.6;
    for (let j = 0; j < n; j += 1) {
      const ang = (j / segs) * 2 * PI;
      pos.push(centre[0] + k * radius * Math.cos(ang), centre[1], centre[2] + k * radius * Math.sin(ang));
      col.push(c[0], c[1], c[2], a);
    }
  }
  const at = (i, j) => (i === 0 ? 0 : 1 + (i - 1) * segs + (j % segs));
  for (let i = 0; i < rings.length - 1; i += 1) {
    for (let j = 0; j < segs; j += 1) {
      if (i === 0) idx.push(0, at(1, j + 1), at(1, j));
      else idx.push(at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i + 1, j));
    }
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(pos, 3));
  out.setAttribute('color', new Float32BufferAttribute(col, 4));
  out.setIndex(idx);
  return out;
}

/** His glow: nested translucent shells round `centre`. */
export function glowShells(centre, radius) {
  const parts = [0.45, 0.7, 1].map((k) => {
    const g = new SphereGeometry(radius * k, 16, 10);
    g.translate(...centre);
    return paint(g, '#ffd98a', { amb: 1 });
  });
  return mergeGeometries(parts);
}

export { mergeParts, shapeOf };
