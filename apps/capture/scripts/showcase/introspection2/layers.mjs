import { BufferAttribute, BufferGeometry, Float32BufferAttribute, SphereGeometry, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { lin } from '../introspection/common.mjs';
import { fbm, noise3 } from './flow.mjs';
import { PI, clamp, mix, smooth } from './timeline.mjs';

// The layers' still geometry, each built in its own layer's units under its
// static HologramLayer node (see BEATS.md, "The nesting").

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

/**
 * The dark's sky: black, with Rothko's soft fields (oxblood, a red seam,
 * plum) dim across its upper half, the sea he sank through seen from under.
 */
export function darkSky(C, R) {
  const FIELDS = [[-1, '#020203'], [0.05, '#030305'], [0.3, '#12040a'], [0.5, '#2a0a10'], [0.62, '#4a1414'], [0.7, '#6a2414'], [0.78, '#3a0c12'], [0.9, '#1a0612'], [1, '#08030a']].map(([y, h]) => [y, lin(h)]);
  const field = (y) => {
    let i = 0;
    while (i < FIELDS.length - 2 && FIELDS[i + 1][0] < y) i += 1;
    const [y0, c0] = FIELDS[i];
    const [y1, c1] = FIELDS[i + 1];
    const x = smooth(y0, y1, y);
    return c0.map((v, k) => mix(v, c1[k], x));
  };
  const n = fbm(noise3(733), 3);
  const g = new SphereGeometry(R, 40, 28);
  g.translate(...C);
  return flip(paint(g, (x, y, z) => {
    const u = (y - C[1]) / R;
    return field(u + 0.06 * n(((x - C[0]) / R) * 2, u * 6, ((z - C[2]) / R) * 2)).map((v) => v * (0.85 + 0.15 * n(x * 3, y * 3, z * 3)));
  }, { amb: 1 }));
}

/**
 * A knot: a ball of marbled colour, the door into the next layer, seen from
 * outside (its inside is that layer's sky). palette: hex stops dark to light.
 */
export function knotShell(C, R, palette, seed = 5) {
  const stops = palette.map(lin);
  const n = fbm(noise3(seed), 4);
  const g = new SphereGeometry(R, 32, 22);
  g.translate(...C);
  return paint(g, (x, y, z) => {
    const v = clamp(0.5 + 0.7 * n(((x - C[0]) / R) * 1.6, ((y - C[1]) / R) * 1.6, ((z - C[2]) / R) * 1.6));
    const f = v * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(f));
    return stops[i].map((c, k) => mix(c, stops[i + 1][k], f - i));
  }, { amb: 0.65 });
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

export { flip, mergeParts, shapeOf };
