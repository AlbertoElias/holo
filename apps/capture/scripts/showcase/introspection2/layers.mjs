import { BufferAttribute, BufferGeometry, Float32BufferAttribute, PlaneGeometry, SphereGeometry, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { lin } from '../introspection/common.mjs';
import { PI, K, clamp, smooth } from './timeline.mjs';
import { FOLLOW, SCREEN } from './zoom.mjs';

// The layers' geometry, each built at its home size round the zoom centre C,
// with its moving shapes as per-vertex deltas (see zoom.mjs morphLayer). Every
// layer stays inside a ball of radius R (the skies' base radius) round C: the
// feed's dome fit is convex, so nothing inside that ball can widen the dome.

export const rng = (seed) => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

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
// The gas: pastel clouds in a ball round C, a hollow at the centre, a clear
// tunnel toward the camera, and the knot: a striped ball round C that spins
// about the view axis and opens like an iris onto the layer below.

const PASTELS = ['#f7b8d0', '#bff2d5', '#d6c4f7', '#f7e3b0', '#b8e0f7', '#f7c6b0', '#c0cbf7'];
const KNOT_COLOURS = ['#f49ac1', '#8fdcc0', '#b9a3f0', '#f2d48a'];
export const KNOT_R = 0.05;
export const GAS_SHAPES = ['d1c', 'd1s', 'd2c', 'd2s', 'rotC', 'rotS', 'open'];

export function gas(C, R, seed = 11) {
  const rand = rng(seed);
  const parts = [];
  let tries = 0;
  while (parts.length < 15 && tries < 4000) {
    tries += 1;
    const rc = 0.09 + 0.17 * rand();
    const dir = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1];
    if (len(dir) > 1 || len(dir) < 0.2) continue;
    const d = 0.22 + (0.9 * R - 0.22 - rc * 1.4) * rand();
    const u = dir.map((v) => v / len(dir));
    const p = C.map((c, k) => c + u[k] * d);
    const rel = sub(p, C);
    const along = Math.max(0, dot(rel, FOLLOW));
    const off = len(rel.map((v, k) => v - along * FOLLOW[k]));
    if (off < rc * 1.4 + 0.07) continue;
    if (d + rc * 1.4 > 0.9 * R) continue;
    const g = new SphereGeometry(rc, 14, 9);
    g.scale(1.4, 0.75, 1.05);
    g.rotateY(rand() * PI);
    g.translate(...p);
    const geo = paint(g, PASTELS[parts.length % PASTELS.length], { amb: 0.62 });
    const v = (a) => {
      const q = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1];
      return q.map((x) => (x * a) / Math.max(0.3, len(q)));
    };
    const d1c = v(0.08);
    const d1s = v(0.08);
    const d2c = v(0.04);
    const d2s = v(0.04);
    parts.push({ geo, shapes: { d1c: shapeOf(geo, () => d1c), d1s: shapeOf(geo, () => d1s), d2c: shapeOf(geo, () => d2c), d2s: shapeOf(geo, () => d2s) } });
  }
  // The knot.
  const kg = new SphereGeometry(KNOT_R, 30, 20);
  kg.translate(...C);
  const k = FOLLOW;
  const e1 = SCREEN.right;
  const e2 = SCREEN.up;
  const knot = paint(kg, (x, y, z) => {
    const r = sub([x, y, z], C);
    const th = Math.acos(clamp(dot(r, k) / KNOT_R, -1, 1));
    const ph = Math.atan2(dot(r, e2), dot(r, e1));
    const band = Math.floor((((ph * 2 + th * 5) / (PI / 2)) % 4 + 4) % 4);
    return lin(KNOT_COLOURS[band]);
  }, { amb: 0.7 });
  const THETA0 = 2.25;
  parts.push({
    geo: knot,
    shapes: {
      rotC: shapeOf(knot, (p) => {
        const r = sub(p, C);
        const a = dot(r, k);
        return r.map((v, i) => v - a * k[i]);
      }),
      rotS: shapeOf(knot, (p) => cross(k, sub(p, C))),
      open: shapeOf(knot, (p) => {
        const r = sub(p, C);
        const th = Math.acos(clamp(dot(r, k) / len(r), -1, 1));
        let perp = r.map((v, i) => v - dot(r, k) * k[i]);
        if (len(perp) < 1e-6) perp = e1.slice();
        const pu = perp.map((v) => v / len(perp));
        const th2 = THETA0 + (th * (PI - THETA0)) / PI;
        const R2 = KNOT_R * 2.6;
        return [0, 1, 2].map((i) => R2 * (Math.cos(th2) * k[i] + Math.sin(th2) * pu[i]) - r[i]);
      })
    }
  });
  return mergeParts(parts, GAS_SHAPES);
}

/** The gas's shape weights at t (drift envelope, knot spin, iris). */
const GAS_ENV = K([[0, 0.25], [7, 0.3], [12, 0.6], [16, 0.9], [20, 1], [24, 1], [27, 0.6], [55, 0.25], [57, 0.12], [60, 0.25]]);
// The knot's spin: it winds up through the clawing and stops at a whole turn when the iris opens.
const SPIN = K([[0, 0], [12, 0], [20, 6 * PI], [23.9, 16 * PI], [60, 16 * PI]]);
const OPEN = K([[0, 0], [24, 0], [25.2, 1], [58.3, 1], [59.6, 0], [60, 0]]);
export function gasShapeWeights(t) {
  const e = GAS_ENV(t);
  const w1 = (2 * PI * t) / 3.0;
  const w2 = (2 * PI * t) / 1.25;
  const phi = SPIN(t);
  return [e * Math.cos(w1), e * Math.sin(w1), e * Math.cos(w2), e * Math.sin(w2), Math.cos(phi) - 1, Math.sin(phi), OPEN(t)];
}

// ---------------------------------------------------------------------------
// The liquid: heavy slabs of Rothko colour. Each is a disc slab (top, bottom,
// rim) with two travelling waves and a heave toward the centre on each crash.
// The central slab's top passes 5 cm (home) above C; C itself is inside it,
// where the dark waits, until the slab parts round C.

export const LIQUID_SHAPES = ['w1s', 'w1c', 'w2s', 'w2c', 'crash', 'part'];
export const SLAB_TOP = 0.05;
const W1 = { k: (2 * PI) / 0.7, a: 0.035, dir: [Math.cos(0.4), Math.sin(0.4)] };
const W2 = { k: (2 * PI) / 0.4, a: 0.02, dir: [Math.cos(2.1), Math.sin(2.1)] };
// The swell calms round C, where she floats, so crests in front of her don't hide her from the feed.
const near = (r) => 0.15 + 0.85 * smooth(0.1, 0.4, r);

function discSlab(centre, radius, thick, { rings, segs, sx = 1, sz = 1 }) {
  const pos = [];
  const idx = [];
  const ringAt = (y) => {
    const start = pos.length / 3;
    pos.push(0, y, 0);
    for (let i = 1; i <= rings; i += 1) {
      for (let j = 0; j < segs; j += 1) {
        const a = (j / segs) * 2 * PI;
        const r = (radius * i) / rings;
        pos.push(r * Math.cos(a) * sx, y, r * Math.sin(a) * sz);
      }
    }
    return start;
  };
  const top = ringAt(thick / 2);
  const bot = ringAt(-thick / 2);
  const at = (s, i, j) => (i === 0 ? s : s + 1 + (i - 1) * segs + (((j % segs) + segs) % segs));
  for (const [s, up] of [[top, true], [bot, false]]) {
    for (let i = 0; i < rings; i += 1) {
      for (let j = 0; j < segs; j += 1) {
        const a = at(s, i, j);
        const b = at(s, i, j + 1);
        const c = at(s, i + 1, j);
        const d = at(s, i + 1, j + 1);
        const tris = i === 0 ? [[a, d, c]] : [[a, b, d], [a, d, c]];
        for (const tri of tris) idx.push(...(up ? tri : [tri[0], tri[2], tri[1]]));
      }
    }
  }
  for (let j = 0; j < segs; j += 1) {
    const a = at(top, rings, j);
    const b = at(top, rings, j + 1);
    const c = at(bot, rings, j);
    const d = at(bot, rings, j + 1);
    idx.push(a, d, c, a, b, d);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.translate(...centre);
  return g;
}

const SLABS = [
  // centre offset from C (the central slab is nudged off C so no vertex sits on it), radius, thickness, tilt, colour, crash heave
  { off: [0.035, SLAB_TOP - 0.06, 0.028], r: 0.9, thick: 0.12, tilt: [0, 0, 0], hex: '#6e1b17', top: '#82261d', heave: [0, 0, 0], rings: 16, segs: 44, central: true },
  { off: [0.22, 0.34, -0.26], r: 0.48, thick: 0.1, tilt: [-0.15, 0, 0.12], hex: '#d4601c', top: '#e47a2c', heave: [-0.04, -0.24, 0.06], rings: 8, segs: 28, sx: 1.25, sz: 0.85 },
  { off: [-0.18, -0.32, -0.2], r: 0.5, thick: 0.12, tilt: [0.08, 0, -0.12], hex: '#4a2140', top: '#5c2a50', heave: [0.03, 0.2, 0.02], rings: 8, segs: 28, sx: 1.2, sz: 0.85 },
  { off: [-0.32, 0.14, -0.52], r: 0.34, thick: 0.1, tilt: [1.05, 0, 0], hex: '#9c1f1f', top: '#ad2c24', heave: [0.06, -0.05, 0.3], rings: 7, segs: 24, sx: 1.3, sz: 1 }
];

export function liquid(C) {
  const parts = SLABS.map((s) => {
    const g = discSlab([0, 0, 0], s.r, s.thick, s);
    g.rotateX(s.tilt[0]);
    g.rotateZ(s.tilt[2]);
    g.translate(...C.map((c, k) => c + s.off[k]));
    g.computeVertexNormals();
    const lo = lin(s.hex);
    const hi = lin(s.top);
    const normal = new Vector3(0, 1, 0).applyAxisAngle(new Vector3(1, 0, 0), s.tilt[0]).applyAxisAngle(new Vector3(0, 0, 1), s.tilt[2]).toArray();
    const centreY = C[1] + s.off[1];
    const geo = paint(g, (x, y) => (y > centreY ? hi : lo), { amb: 0.78, light: [0.2, 1, 0.3] });
    const wave = (W, trig) => shapeOf(geo, (p) => {
      const rel = sub(p, C);
      const ph = W.k * (rel[0] * W.dir[0] + rel[2] * W.dir[1]);
      const f = s.central ? near(Math.hypot(rel[0], rel[2])) : 1;
      const a = W.a * f * trig(ph);
      return normal.map((v) => v * a);
    });
    const part = s.central
      ? shapeOf(geo, (p) => {
          const rel = sub(p, C);
          const r = Math.hypot(rel[0], rel[2]);
          if (r > 0.4) return [0, 0, 0];
          const push = 0.06 * (1 - r / 0.4) ** 2;
          return [(rel[0] / r) * push, 0, (rel[2] / r) * push];
        })
      : null;
    return {
      geo,
      shapes: {
        w1s: wave(W1, Math.sin), w1c: wave(W1, Math.cos), w2s: wave(W2, Math.sin), w2c: wave(W2, Math.cos),
        crash: shapeOf(geo, () => s.heave), ...(part ? { part } : {})
      }
    };
  });
  return mergeParts(parts, LIQUID_SHAPES);
}

const LIQ_ENV = K([[0, 0.15], [24, 0.3], [27, 0.6], [30, 0.9], [33, 1], [35.5, 0.85], [37, 0.6], [55, 0.15], [57, 0.1], [60, 0.15]]);
// Crashes: fast in, slow out.
const CRASHES = [[28.3, 0.5], [30.0, 1], [31.6, 0.6], [33.0, 1], [35.2, 0.7]];
const crash = (t) => Math.max(0, ...CRASHES.map(([c, a]) => a * (t < c ? smooth(c - 0.5, c, t) : 1 - smooth(c, c + 1.3, t))));
const PART = K([[0, 0], [36.4, 0], [37.0, 1], [58.3, 1], [59.4, 0], [60, 0]]);
const WAVE_W = [(2 * PI) / 2.6, (2 * PI) / 1.7];
export function liquidShapeWeights(t) {
  const e = LIQ_ENV(t);
  const [a, b] = WAVE_W.map((w) => w * t);
  // sin(ph − ωt) = sin(ph)cos(ωt) − cos(ph)sin(ωt): a travelling wave.
  return [e * Math.cos(a), -e * Math.sin(a), 0.8 * e * Math.cos(b), -0.8 * e * Math.sin(b), crash(t), PART(t)];
}
/** The central slab's top over C (home units, relative to C.y) at t. */
export function liquidSurface(t) {
  const e = LIQ_ENV(t);
  const f = near(0);
  const [a, b] = WAVE_W.map((w) => w * t);
  return SLAB_TOP + f * (W1.a * e * Math.sin(-a) + W2.a * 0.8 * e * Math.sin(-b));
}

// ---------------------------------------------------------------------------
// The dark: a floor just under C, black on black, seen only in her light.
// Its rings close in geometrically on C, where she kneels with the child.

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

/** Her glow: nested translucent shells round `centre`. */
export function glowShells(centre, radius) {
  const parts = [0.45, 0.7, 1].map((k) => {
    const g = new SphereGeometry(radius * k, 16, 10);
    g.translate(...centre);
    return paint(g, '#ffd98a', { amb: 1 });
  });
  return mergeGeometries(parts);
}

export { mergeParts, shapeOf };
