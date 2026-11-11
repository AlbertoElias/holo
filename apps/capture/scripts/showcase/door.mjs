import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Euler,
  Float32BufferAttribute,
  LatheGeometry,
  Matrix4,
  Object3D,
  Quaternion,
  SphereGeometry,
  Vector2,
  Vector3
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { SAMPLE_RATE, add, lowpass, noise, toWav } from './lib/audio.mjs';
import { Glb, linear } from './lib/glb.mjs';
import { fbm3, noise3, quat } from './lib/parts.mjs';
import { T } from './lib/tokens.mjs';

// "Two sides of a door": a closed door at true scale, one person on each
// side. From the front you see someone outside at blue hour, about to knock;
// from the back, someone inside with their forehead on the wood. Only by
// walking around, or looking down from above, do you learn there are two,
// and that the fist and the forehead are a few centimetres of walnut apart.
// Nobody knocks. Nobody opens. The one clue from outside is the strip of
// lamplight under the door, broken in three by two feet.

export const meta = {
  slug: 'two-sides-of-a-door',
  name: 'Two sides of a door',
  submittedBy: 'Claude (agent-authored)'
};

const LOOP = 16;
const FPS = 30;

// The door plane is x-y at z = 0; +Z is outside, -Z is inside.
const LEAF_W = 0.82;
const LEAF_H = 2.03;
const LEAF_T = 0.04;
const GAP = 0.014; // light gap under the leaf
const OPEN_HALF = 0.45; // half width of the opening (leaf + jambs)
const OPEN_H = 2.08;
const WALL_HALF = 1.3;
const WALL_H = 2.35;
const WALL_Z = 0.06; // half the 12 cm wall
const KNOB_X = 0.355;
const KNOB_Y = 0.97;
const MAT = 0.006; // doormat thickness

const GOLD = T.gold;
const GLOW = T.glow;
const HIGHLIGHT = T.highlight;

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const scale3 = (a, k) => a.map((v) => v * k);
const lin = (hex) => linear(hex);

// ---------------------------------------------------------------------------
// Keyframe curves. Keys are [t, ...values] from t = 0 to t = LOOP with the
// last values equal to the first, so every curve loops without a pop.

/** Cyclic cubic through the keys; flat at extrema and holds, no overshoot. */
function spline(keys) {
  const n = keys.length;
  const at = (j) => {
    if (j < 0) return [keys[n - 1 + j][0] - LOOP, ...keys[n - 1 + j].slice(1)];
    if (j >= n) return [keys[j - n + 1][0] + LOOP, ...keys[j - n + 1].slice(1)];
    return keys[j];
  };
  const slope = (j, d) => {
    const a = at(j - 1);
    const b = at(j);
    const c = at(j + 1);
    const left = (b[d] - a[d]) / (b[0] - a[0]);
    const right = (c[d] - b[d]) / (c[0] - b[0]);
    if (left * right <= 0) return 0;
    const m = (c[d] - a[d]) / (c[0] - a[0]);
    return Math.sign(m) * Math.min(Math.abs(m), 3 * Math.abs(left), 3 * Math.abs(right));
  };
  return (t) => {
    t = ((t % LOOP) + LOOP) % LOOP;
    let i = 0;
    while (i < n - 2 && t > keys[i + 1][0]) i += 1;
    const k0 = keys[i];
    const k1 = keys[i + 1];
    const h = k1[0] - k0[0];
    const u = h > 0 ? (t - k0[0]) / h : 0;
    const u2 = u * u;
    const u3 = u2 * u;
    const out = [];
    for (let d = 1; d < k0.length; d += 1) {
      const m0 = slope(i, d) * h;
      const m1 = slope(i + 1, d) * h;
      out.push((2 * u3 - 3 * u2 + 1) * k0[d] + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * k1[d] + (u3 - u2) * m1);
    }
    return out;
  };
}

/** Piecewise ease in-out between keys: for steps that start and stop. */
function ease(keys) {
  return (t) => {
    t = ((t % LOOP) + LOOP) % LOOP;
    let i = 0;
    while (i < keys.length - 2 && t > keys[i + 1][0]) i += 1;
    const k0 = keys[i];
    const k1 = keys[i + 1];
    const x = clamp((t - k0[0]) / (k1[0] - k0[0] || 1));
    const u = x * x * x * (x * (x * 6 - 15) + 10);
    return k0.slice(1).map((v, d) => v + (k1[d + 1] - v) * u);
  };
}

/** 0 outside [a, b], rising over `ramp` at each end. */
const span = (t, a, b, ramp) => smooth(a, a + ramp, t) * (1 - smooth(b - ramp, b, t));

// ---------------------------------------------------------------------------
// Painted surfaces: unlit triangles with vertex colours, so blue hour and
// lamplight are exactly what we paint, whatever the viewer's lights do.

class Paint {
  constructor() {
    this.p = [];
    this.c = [];
    this.n = [];
  }

  tri(a, b, c, ca, cb, cc, up) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    if (n[0] * up[0] + n[1] * up[1] + n[2] * up[2] < 0) {
      [b, c] = [c, b];
      [cb, cc] = [cc, cb];
      n = n.map((v) => -v);
    }
    const len = Math.hypot(...n);
    n = len > 1e-12 ? n.map((v) => v / len) : up;
    this.p.push(...a, ...b, ...c);
    this.c.push(...ca, ...cb, ...cc);
    this.n.push(...n, ...n, ...n);
  }

  quad(a, b, c, d, ca, cb, cc, cd, up) {
    this.tri(a, b, c, ca, cb, cc, up);
    this.tri(a, c, d, ca, cc, cd, up);
  }

  geometry() {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.p, 3));
    // Unlit: no normals needed, which keeps the file a third smaller.
    g.setAttribute('color', new Float32BufferAttribute(this.c, 3));
    return g;
  }
}

/** Torn-paper displacement along an edge parameter `u` in meters. */
function tear(u, seed, big = 0.11) {
  return (
    big * (fbm3(u * 1.3, 0.5, seed * 1.7, { octaves: 3, seed }) - 0.5) * 2 +
    0.03 * (fbm3(u * 7, 2.5, seed, { octaves: 3, seed: seed + 5 }) - 0.5) * 2 +
    0.008 * (noise3(u * 33, 4.5, seed, seed + 9) - 0.5) * 2
  );
}

const rimWidth = (u, seed) => 0.011 + 0.016 * fbm3(u * 4, 7.7, seed, { octaves: 2, seed: seed + 3 });
const charWidth = (u, seed) => 0.02 + 0.05 * fbm3(u * 2.2, 3.3, seed, { octaves: 3, seed: seed + 7 });

// The burnt rim: body -> dark scorch, then a crisp jump to glowing gold.
const SCORCH = lin('#24140b');
const EMBER = lin(GLOW);
const RIM = lin(GOLD);
const EDGE = lin(HIGHLIGHT);
function bandColor(tag, end, body) {
  if (tag === 'char') return end === 'lo' ? body : mix(body, SCORCH, 0.85);
  if (tag === 'rim') return end === 'lo' ? EMBER : RIM;
  if (tag === 'edge') return end === 'lo' ? RIM : EDGE;
  return body;
}

// The wall: a polar fan between the door opening and a torn outline.
const WALL_P = 3.2;
function wallOuter(th) {
  const c = Math.abs(Math.cos(th));
  const s = Math.sin(th);
  const r0 = 1 / Math.pow(Math.pow(c / WALL_HALF, WALL_P) + Math.pow(s / WALL_H, WALL_P), 1 / WALL_P);
  return Math.max(r0 + tear(th * 2.4, 3, 0.09), doorRay(th) + 0.17);
}
function doorRay(th) {
  const c = Math.abs(Math.cos(th));
  const s = Math.sin(th);
  return Math.min(c > 1e-9 ? OPEN_HALF / c : Infinity, s > 1e-9 ? OPEN_H / s : Infinity);
}

function outsideWall(x, y) {
  const m = 0.9 + 0.2 * fbm3(x * 2.2, y * 2.2, 1.3, { octaves: 3, seed: 2 });
  return scale3(mix(lin('#0f262d'), lin('#24505c'), smooth(0, 2.4, y)), m);
}
function insideWall(x, y) {
  const m = 0.92 + 0.16 * fbm3(x * 2.2, y * 2.2, 5.1, { octaves: 3, seed: 4 });
  const glow = Math.exp(-((x - 0.5) ** 2) / 1.0 - ((y - 1.15) ** 2) / 1.5);
  return scale3(mix(lin('#3a2414'), lin('#b07440'), glow), m);
}

function wallGeometry() {
  const paint = new Paint();
  const thetas = [];
  const N = 520;
  for (let i = 0; i <= N; i += 1) thetas.push((i / N) * Math.PI);
  const corner = Math.atan2(OPEN_H, OPEN_HALF);
  thetas.push(corner, Math.PI - corner);
  thetas.sort((a, b) => a - b);
  const K = 7;
  const levelsAt = (th) => {
    const u = th * 2.4;
    const rd = doorRay(th);
    const R = wallOuter(th);
    const w = rimWidth(u, 3);
    const c = charWidth(u, 3);
    const rin = Math.max(rd, R - w - c);
    const out = [];
    for (let k = 0; k <= K; k += 1) out.push([rd + ((rin - rd) * k) / K, 'body']);
    out.push([Math.max(rin, R - w), 'char'], [Math.max(rin, R - w * 0.35), 'rim'], [R, 'edge']);
    return out.map(([r, tag]) => [r * Math.cos(th), r * Math.sin(th), tag]);
  };
  for (let i = 0; i < thetas.length - 1; i += 1) {
    if (thetas[i + 1] - thetas[i] < 1e-7) continue;
    const A = levelsAt(thetas[i]);
    const B = levelsAt(thetas[i + 1]);
    for (const [z, body, up] of [
      [WALL_Z, outsideWall, [0, 0, 1]],
      [-WALL_Z, insideWall, [0, 0, -1]]
    ]) {
      for (let k = 0; k < A.length - 1; k += 1) {
        const tag = A[k + 1][2];
        const col = (p, end) => bandColor(tag, end, body(p[0], p[1]));
        const a = [A[k][0], A[k][1], z];
        const b = [B[k][0], B[k][1], z];
        const c = [B[k + 1][0], B[k + 1][1], z];
        const d = [A[k + 1][0], A[k + 1][1], z];
        paint.quad(a, b, c, d, col(a, 'lo'), col(b, 'lo'), col(c, 'hi'), col(d, 'hi'), up);
      }
    }
    // The torn edge seen edge-on: a band of gold through the wall's thickness.
    const pa = A[A.length - 1];
    const pb = B[B.length - 1];
    const out = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, 0];
    // Charred through the middle, glowing toward both faces.
    const tone = (x, y, z) => mix(mix(SCORCH, EMBER, 0.15 * fbm3(x * 9, y * 9, 1, { octaves: 2, seed: 8 })), RIM, Math.pow(Math.abs(z) / WALL_Z, 6));
    const bands = [-WALL_Z, -WALL_Z * 0.8, -WALL_Z * 0.4, 0, WALL_Z * 0.4, WALL_Z * 0.8, WALL_Z];
    for (let k = 0; k < bands.length - 1; k += 1) {
      const a = [pa[0], pa[1], bands[k]];
      const b = [pb[0], pb[1], bands[k]];
      const c = [pb[0], pb[1], bands[k + 1]];
      const d = [pa[0], pa[1], bands[k + 1]];
      paint.quad(a, b, c, d, tone(...a), tone(...b), tone(...c), tone(...d), out);
    }
  }
  return paint.geometry();
}

// Floors: strips running away from the wall, ending in a torn, burnt edge.
function floorEnd(x, { halfW, depth, p, seed }) {
  const a = Math.abs(x) / halfW;
  if (a >= 1) return 0;
  return Math.max(0, depth * Math.pow(1 - Math.pow(a, p), 1 / p) + tear(x, seed, 0.1));
}

function floorPatch(paint, { side, shape, columns, body, seams, seamColor }) {
  const step = 0.1;
  const edge = (x) => {
    const e = floorEnd(x, shape);
    const slope = Math.abs(floorEnd(x + 0.004, shape) - floorEnd(x - 0.004, shape)) / 0.008;
    const k = Math.min(5, Math.sqrt(1 + slope * slope));
    return { e, w: rimWidth(x, shape.seed) * k, c: charWidth(x, shape.seed) * k };
  };
  for (const col of columns) {
    const E0 = edge(col.x0);
    const E1 = edge(col.x1);
    if (E0.e < 0.004 && E1.e < 0.004) continue;
    const inner = Math.min(E0.e - E0.w - E0.c, E1.e - E1.w - E1.c) - 0.01;
    const shared = [];
    for (let s = step; s < inner; s += step) shared.push([s, 'body']);
    for (const s of seams(col)) if (s > 0.01 && s < inner - 0.01) shared.push([s - 0.004, 'body'], [s + 0.004, 'seam']);
    shared.sort((a, b) => a[0] - b[0]);
    const levels = (E) => {
      const rin = Math.max(0, E.e - E.w - E.c);
      const raw = [[0, 'body'], ...shared, [rin, 'body'], [E.e - E.w, 'char'], [E.e - E.w * 0.35, 'rim'], [E.e, 'edge']];
      let last = 0;
      return raw.map(([s, tag]) => {
        last = Math.max(last, Math.min(s, E.e));
        return [last, tag];
      });
    };
    const L0 = levels(E0);
    const L1 = levels(E1);
    for (let k = 0; k < L0.length - 1; k += 1) {
      const tag = L0[k + 1][1];
      const pos = (x, s) => [x, 0, side * s];
      const color = (x, s, end) => {
        if (tag === 'seam' || (col.seam && (tag === 'body' || tag === 'char'))) {
          return tag === 'char' && end === 'hi' ? SCORCH : seamColor;
        }
        return bandColor(tag, end, body(x, s, col));
      };
      const a = pos(col.x0, L0[k][0]);
      const b = pos(col.x1, L1[k][0]);
      const c = pos(col.x1, L1[k + 1][0]);
      const d = pos(col.x0, L0[k + 1][0]);
      paint.quad(
        a,
        b,
        c,
        d,
        color(col.x0, L0[k][0], 'lo'),
        color(col.x1, L1[k][0], 'lo'),
        color(col.x1, L1[k + 1][0], 'hi'),
        color(col.x0, L0[k + 1][0], 'hi'),
        [0, 1, 0]
      );
    }
  }
}

function hash(i, j = 0, seed = 0) {
  return noise3(i * 1.37 + 0.5, j * 2.11 + 0.5, seed + 0.5, 77);
}

const STONE = 0.36;
const stoneRowOffset = (col) => (col.index % 2 ? STONE / 2 : 0) + 0.05;
function stoneColor(x, s, col) {
  const row = Math.floor((s - stoneRowOffset(col)) / STONE);
  const tone = 0.85 + 0.3 * hash(col.index, row, 3);
  const m = 0.92 + 0.16 * fbm3(x * 4, s * 4, 0.7, { octaves: 3, seed: 12 });
  return scale3(mix(lin('#173740'), lin('#0f262d'), smooth(0.1, 1.4, s)), tone * m);
}
function stoneBare(x, s) {
  return stoneColor(x, s, { index: Math.floor((x + 1.5) / STONE) });
}

function boardColor(x, s, col) {
  const tone = 0.82 + 0.3 * hash(col.plank, 0, 9);
  const grain = 0.9 + 0.2 * fbm3(x * 30, s * 1.5, col.plank, { octaves: 3, seed: 14 });
  const lamp = Math.exp(-((x - 0.45) ** 2) / 0.9 - ((s - 0.7) ** 2) / 0.8);
  return scale3(mix(lin('#4a2a14'), lin('#b8783e'), 0.35 + 0.65 * lamp), tone * grain);
}

function floorsGeometry() {
  const paint = new Paint();
  // Outside: flagstones at blue hour.
  const outside = [];
  const outShape = { halfW: 1.45, depth: 1.45, p: 2.6, seed: 21 };
  for (let i = 0; i * STONE < 2 * outShape.halfW; i += 1) {
    const x0 = -outShape.halfW + i * STONE;
    const x1 = Math.min(outShape.halfW, x0 + STONE - 0.01);
    const sub = 12;
    for (let k = 0; k < sub; k += 1) outside.push({ x0: x0 + ((x1 - x0) * k) / sub, x1: x0 + ((x1 - x0) * (k + 1)) / sub, index: i });
    if (x1 + 0.01 <= outShape.halfW) outside.push({ x0: x1, x1: x1 + 0.01, seam: true, index: i });
  }
  floorPatch(paint, {
    side: 1,
    shape: outShape,
    columns: outside,
    body: stoneColor,
    seamColor: lin('#081519'),
    seams: (col) => {
      const out = [];
      for (let s = stoneRowOffset(col); s < 2; s += STONE) out.push(s);
      return out;
    }
  });
  // Inside: walnut-brown floorboards under lamplight.
  const inside = [];
  const inShape = { halfW: 1.5, depth: 1.4, p: 2.4, seed: 33 };
  const PLANK = 0.13;
  for (let i = 0; i * PLANK < 2 * inShape.halfW; i += 1) {
    const x0 = -inShape.halfW + i * PLANK;
    const x1 = Math.min(inShape.halfW, x0 + PLANK - 0.006);
    const sub = 6;
    for (let k = 0; k < sub; k += 1) inside.push({ x0: x0 + ((x1 - x0) * k) / sub, x1: x0 + ((x1 - x0) * (k + 1)) / sub, plank: i });
    if (x1 + 0.006 <= inShape.halfW) inside.push({ x0: x1, x1: x1 + 0.006, seam: true, plank: i });
  }
  floorPatch(paint, {
    side: -1,
    shape: inShape,
    columns: inside,
    body: boardColor,
    seamColor: lin('#1c0f07'),
    seams: (col) => (col.seam ? [] : [0.55 + 0.7 * hash(col.plank, 1, 5)])
  });
  return paint.geometry();
}

// The light under the door, broken by the inside person's feet.
function shadowAt(feet, x, s) {
  let shade = 0;
  for (const f of feet) {
    const hw = f.hw + 0.32 * s;
    const soft = 0.008 + 0.09 * s;
    shade = Math.max(shade, 1 - smooth(hw - soft, hw + soft, Math.abs(x - f.x - f.drift * s)));
  }
  return shade;
}

function lightStripGeometry(feet) {
  const paint = new Paint();
  const reach = 0.3;
  const levels = [0, 0.012, 0.03, 0.055, 0.085, 0.12, 0.16, 0.21, 0.26, reach];
  const dx = 0.006;
  for (let x = -0.5; x < 0.5 - 1e-6; x += dx) {
    const xs = [x, x + dx];
    const color = (px, s) => {
      const spread = 1 - smooth(0.36 + 0.25 * s, 0.41 + 0.4 * s, Math.abs(px));
      const I = Math.pow(1 - s / reach, 1.7) * (1 - 0.95 * shadowAt(feet, px, s)) * spread;
      return mix(stoneBare(px, s), mix(lin(GLOW), lin(HIGHLIGHT), I * I), clamp(I * 1.15));
    };
    for (let k = 0; k < levels.length - 1; k += 1) {
      const y = 0.0012;
      const a = [xs[0], y, levels[k]];
      const b = [xs[1], y, levels[k]];
      const c = [xs[1], y, levels[k + 1]];
      const d = [xs[0], y, levels[k + 1]];
      paint.quad(a, b, c, d, color(xs[0], levels[k]), color(xs[1], levels[k]), color(xs[1], levels[k + 1]), color(xs[0], levels[k + 1]), [0, 1, 0]);
    }
  }
  // The gap itself: a hairline of lamplight with two dark breaks.
  const dark = lin('#1a0e07');
  const z = LEAF_T / 2 + 0.0006;
  for (let x = -LEAF_W / 2; x < LEAF_W / 2 - 1e-6; x += dx) {
    const c0 = mix(dark, lin(HIGHLIGHT), 1 - 0.97 * shadowAt(feet, x, 0));
    const c1 = mix(dark, lin(HIGHLIGHT), 1 - 0.97 * shadowAt(feet, x + dx, 0));
    paint.quad([x, 0.0004, z], [x + dx, 0.0004, z], [x + dx, GAP, z], [x, GAP, z], c0, c1, c1, c0, [0, 0, 1]);
  }
  return paint.geometry();
}

// ---------------------------------------------------------------------------
// Door, frame, knobs, mat.

function box(x0, x1, y0, y1, z0, z1) {
  const g = new BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  g.deleteAttribute('uv');
  return g;
}

function doorFace(sign) {
  const x0 = -LEAF_W / 2;
  const y0 = GAP;
  const z0 = sign * (LEAF_T / 2 - 0.005);
  const z1 = sign * (LEAF_T / 2);
  const member = (u0, u1, v0, v1) => box(x0 + u0, x0 + u1, y0 + v0, y0 + v1, Math.min(z0, z1), Math.max(z0, z1));
  return mergeGeometries([
    member(0, 0.11, 0, LEAF_H),
    member(LEAF_W - 0.11, LEAF_W, 0, LEAF_H),
    member(0.11, LEAF_W - 0.11, 0, 0.24),
    member(0.11, LEAF_W - 0.11, 0.9, 1.08),
    member(0.11, LEAF_W - 0.11, LEAF_H - 0.12, LEAF_H),
    member(0.36, 0.46, 0.24, 0.9),
    member(0.36, 0.46, 1.08, LEAF_H - 0.12)
  ]);
}

function knob(sign) {
  const parts = [];
  const rosette = new CylinderGeometry(0.03, 0.032, 0.008, 28);
  rosette.rotateX(Math.PI / 2);
  rosette.translate(0, 0, sign * (LEAF_T / 2 + 0.004));
  const neck = new CylinderGeometry(0.009, 0.011, 0.045, 16);
  neck.rotateX(Math.PI / 2);
  neck.translate(0, 0, sign * (LEAF_T / 2 + 0.03));
  const ball = new SphereGeometry(0.029, 24, 16);
  ball.scale(1, 1, 0.82);
  ball.translate(0, 0, sign * (LEAF_T / 2 + 0.068));
  for (const g of [rosette, neck, ball]) {
    g.deleteAttribute('uv');
    g.translate(KNOB_X, KNOB_Y, 0);
    parts.push(g);
  }
  return mergeGeometries(parts);
}

function casing(sign) {
  const za = sign * WALL_Z;
  const zb = sign * (WALL_Z + 0.018);
  const z0 = Math.min(za, zb);
  const z1 = Math.max(za, zb);
  return mergeGeometries([
    box(-0.52, -0.425, 0, 2.17, z0, z1),
    box(0.425, 0.52, 0, 2.17, z0, z1),
    box(-0.545, 0.545, 2.065, 2.185, Math.min(z0, z0 - (sign < 0 ? 0.004 : 0)), Math.max(z1, z1 + (sign > 0 ? 0.004 : 0)))
  ]);
}

// ---------------------------------------------------------------------------
// The figures: jointed mannequins of light. Joint nodes carry their segment;
// rest pose stands facing +Z, limbs hanging along -Y; lengths follow standard
// anthropometric ratios for a 1.70 m adult and scale with height.

const SKELETON = [
  ['pelvis', null, [0, 0.96, 0]],
  ['spine', 'pelvis', [0, 0.08, -0.005]],
  ['chest', 'spine', [0, 0.18, 0]],
  ['neck', 'chest', [0, 0.225, -0.014]],
  ['head', 'neck', [0, 0.09, 0.01]],
  ['shoulderL', 'chest', [0.172, 0.168, -0.014]],
  ['elbowL', 'shoulderL', [0, -0.3, 0]],
  ['wristL', 'elbowL', [0, -0.25, 0]],
  ['shoulderR', 'chest', [-0.172, 0.168, -0.014]],
  ['elbowR', 'shoulderR', [0, -0.3, 0]],
  ['wristR', 'elbowR', [0, -0.25, 0]],
  ['hipL', 'pelvis', [0.088, -0.065, 0]],
  ['kneeL', 'hipL', [0, -0.42, 0]],
  ['ankleL', 'kneeL', [0, -0.415, 0]],
  ['hipR', 'pelvis', [-0.088, -0.065, 0]],
  ['kneeR', 'hipR', [0, -0.42, 0]],
  ['ankleR', 'kneeR', [0, -0.415, 0]]
];
const ANKLE_H = 0.065;

function ell(rx, ry, rz, c = [0, 0, 0], ws = 22, hs = 16) {
  const g = new SphereGeometry(1, ws, hs);
  g.scale(rx, ry, rz);
  g.translate(...c);
  return g;
}

/** A tapered capsule from a (radius ra) to b (radius rb), squashed sx / sz across. */
function limb(a, b, ra, rb, sx = 1, sz = 1, radial = 18) {
  const A = new Vector3(...a);
  const B = new Vector3(...b);
  const L = A.distanceTo(B);
  const pts = [];
  const cap = 6;
  for (let i = 0; i <= cap; i += 1) {
    const ang = -Math.PI / 2 + (i / cap) * (Math.PI / 2);
    pts.push(new Vector2(Math.max(1e-4, ra * Math.cos(ang)), ra * Math.sin(ang)));
  }
  for (let i = 1; i <= 4; i += 1) {
    const f = i / 5;
    pts.push(new Vector2(ra + (rb - ra) * f, L * f));
  }
  for (let i = 0; i <= cap; i += 1) {
    const ang = (i / cap) * (Math.PI / 2);
    pts.push(new Vector2(Math.max(1e-4, rb * Math.cos(ang)), L + rb * Math.sin(ang)));
  }
  const g = new LatheGeometry(pts, radial);
  g.scale(sx, 1, sz);
  const dir = B.clone().sub(A).normalize();
  const up = new Vector3(0, 1, 0);
  const q = dir.dot(up) < -0.9999 ? new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI) : new Quaternion().setFromUnitVectors(up, dir);
  g.applyQuaternion(q);
  g.translate(A.x, A.y, A.z);
  return g;
}

function figureParts({ fist }) {
  const side = (sx) => ({
    shoulder: [ell(0.054, 0.054, 0.056, [0, -0.012, 0]), limb([0, -0.01, 0], [0, -0.3, 0], 0.048, 0.037)],
    elbow: [limb([0, 0, 0], [0, -0.25, 0], 0.039, 0.027, 0.8, 1.15)],
    hip: [limb([0, 0, 0], [0, -0.42, 0], 0.078, 0.05, 1, 1.05)],
    knee: [limb([0, 0, 0], [0, -0.415, 0], 0.052, 0.034), ell(0.047, 0.12, 0.052, [0, -0.13, -0.014])],
    ankle: [ell(0.037, 0.037, 0.04, [0, -0.004, -0.004]), limb([0, -0.03, -0.045], [0, -0.038, 0.16], 0.035, 0.027, 1.25, 1)],
    hand: [limb([sx * 0.007, -0.006, 0], [sx * 0.007, -0.155, 0.006], 0.025, 0.019, 0.58, 1.75), limb([sx * 0.011, -0.028, 0.03], [sx * 0.013, -0.085, 0.056], 0.014, 0.011)]
  });
  const L = side(-1);
  const R = side(1);
  const fistParts = [ell(0.037, 0.052, 0.046, [0, -0.056, 0.004]), ell(0.016, 0.03, 0.016, [0.01, -0.05, 0.038])];
  return {
    pelvis: [ell(0.152, 0.11, 0.1, [0, -0.03, 0]), ell(0.14, 0.085, 0.09, [0, -0.055, -0.03])],
    spine: [ell(0.122, 0.13, 0.09, [0, 0.07, 0.006])],
    chestBreath: [
      ell(0.152, 0.165, 0.104, [0, 0.085, 0.012]),
      ell(0.13, 0.09, 0.095, [0, 0.0, 0.01]),
      limb([0.03, 0.2, -0.008], [0.165, 0.17, -0.014], 0.034, 0.036),
      limb([-0.03, 0.2, -0.008], [-0.165, 0.17, -0.014], 0.034, 0.036)
    ],
    neck: [limb([0, -0.02, 0], [0, 0.085, 0.006], 0.05, 0.045)],
    head: [ell(0.079, 0.113, 0.096, [0, 0.062, 0.014]), ell(0.058, 0.055, 0.066, [0, 0.008, 0.036])],
    shoulderL: L.shoulder,
    elbowL: L.elbow,
    wristL: L.hand,
    shoulderR: R.shoulder,
    elbowR: R.elbow,
    wristR: fist ? fistParts : R.hand,
    hipL: L.hip,
    kneeL: L.knee,
    ankleL: L.ankle,
    hipR: R.hip,
    kneeR: R.knee,
    ankleR: R.ankle
  };
}

function mergedParts(list, s) {
  const g = mergeGeometries(list.map((p) => (p.attributes.uv ? p.deleteAttribute('uv') : p)));
  g.scale(s, s, s);
  return g;
}

class Rig {
  constructor({ s, x0, z0, yaw, fist }) {
    this.s = s;
    this.root = new Object3D();
    this.root.position.set(x0, 0, z0);
    this.root.quaternion.fromArray(quat([0, 1, 0], yaw));
    this.j = {};
    for (const [name, parent, offset] of SKELETON) {
      const o = new Object3D();
      o.name = name;
      o.position.set(...offset.map((v) => v * s));
      (parent ? this.j[parent] : this.root).add(o);
      this.j[name] = o;
    }
    this.breath = new Object3D();
    this.j.chest.add(this.breath);
    const parts = figureParts({ fist });
    this.geo = {};
    for (const [name, list] of Object.entries(parts)) this.geo[name] = mergedParts(list, s);
    this.root.updateMatrixWorld(true);
  }

  holder(name) {
    return name === 'chestBreath' ? this.breath : this.j[name];
  }

  /** Visits every mesh vertex in world space. */
  eachVertex(names, fn) {
    const v = new Vector3();
    for (const name of names) {
      const obj = this.holder(name);
      obj.updateWorldMatrix(true, false);
      const pos = this.geo[name].attributes.position;
      for (let i = 0; i < pos.count; i += 1) {
        v.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
        fn(v);
      }
    }
  }

  extreme(names, axis, sign) {
    let best = -Infinity;
    this.eachVertex(names, (v) => {
      best = Math.max(best, sign * v[axis]);
    });
    return sign * best;
  }

  toWorld(local) {
    this.root.updateMatrixWorld(true);
    return this.root.localToWorld(new Vector3(...local));
  }

  dirToWorld(local) {
    return new Vector3(...local).applyQuaternion(this.root.quaternion).normalize();
  }
}

const _basis = new Matrix4();
/** Two-bone IK: upper / lower joints, end at the lower's child; sign +1 bends like an elbow, -1 like a knee. */
function twoBone(upper, lower, endOffset, target, pole, sign) {
  const parentQ = upper.parent.getWorldQuaternion(new Quaternion());
  const s = upper.getWorldPosition(new Vector3());
  const a = lower.position.length();
  const b = endOffset;
  const toT = target.clone().sub(s);
  const dHat = toT.clone().normalize();
  const d = clamp(toT.length(), Math.abs(a - b) + 1e-4, (a + b) * 0.9995);
  const pPerp = pole.clone().sub(dHat.clone().multiplyScalar(pole.dot(dHat))).normalize();
  const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const u = dHat.clone().multiplyScalar(cosA).add(pPerp.clone().multiplyScalar(sinA));
  const e = s.clone().add(u.clone().multiplyScalar(a));
  const f = s.clone().add(dHat.clone().multiplyScalar(d)).sub(e).normalize();
  let bend = f.clone().sub(u.clone().multiplyScalar(f.dot(u)));
  if (bend.lengthSq() < 1e-10) bend = pPerp.clone().negate();
  bend.normalize();
  const Y = u.clone().negate();
  const Z = sign > 0 ? bend : bend.clone().negate();
  const X = new Vector3().crossVectors(Y, Z);
  _basis.makeBasis(X, Y, Z);
  const qWorld = new Quaternion().setFromRotationMatrix(_basis);
  upper.quaternion.copy(parentQ.invert().multiply(qWorld));
  const phi = Math.acos(clamp(u.dot(f), -1, 1));
  lower.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), sign > 0 ? -phi : phi);
  upper.updateMatrixWorld(true);
}

const eul = (x, y, z, order = 'YXZ') => new Quaternion().setFromEuler(new Euler(x, y, z, order));

/**
 * Poses a rig from a pose description:
 * pelvis [x, y, z] + pelvisYaw, torso eulers, feet {pos, yaw, pitch} (local),
 * arms {fk: {shoulder, elbow, wrist}, ik?: {weight, solve(rig)}}.
 */
function applyPose(rig, P) {
  const { j } = rig;
  j.pelvis.position.set(...P.pelvis);
  j.pelvis.quaternion.copy(eul(P.pelvisPitch ?? 0, P.pelvisYaw, P.pelvisRoll ?? 0));
  j.spine.quaternion.copy(eul(...P.spine));
  j.chest.quaternion.copy(eul(...P.chest));
  j.neck.quaternion.copy(eul(...P.neck));
  j.head.quaternion.copy(eul(...P.head));
  rig.breath.scale.set(...P.breath);
  rig.root.updateMatrixWorld(true);

  const rootQ = rig.root.quaternion;
  for (const sideName of ['L', 'R']) {
    const foot = P.feet[sideName];
    const target = rig.toWorld(foot.pos);
    const pole = rig.dirToWorld([sideName === 'L' ? 0.12 : -0.12, 0, 1]).applyAxisAngle(new Vector3(0, 1, 0), foot.yaw * 0.6);
    twoBone(j[`hip${sideName}`], j[`knee${sideName}`], j[`ankle${sideName}`].position.length(), target, pole, -1);
    const desired = rootQ.clone().multiply(eul(foot.pitch ?? 0, foot.yaw, 0));
    const kneeQ = j[`knee${sideName}`].getWorldQuaternion(new Quaternion());
    j[`ankle${sideName}`].quaternion.copy(kneeQ.invert().multiply(desired));
  }

  for (const sideName of ['L', 'R']) {
    const arm = P.arms[sideName];
    const sh = j[`shoulder${sideName}`];
    const el = j[`elbow${sideName}`];
    const wr = j[`wrist${sideName}`];
    const fk = [eul(...arm.fk.shoulder, 'XYZ'), eul(...arm.fk.elbow, 'XYZ'), eul(...arm.fk.wrist, 'XYZ')];
    sh.quaternion.copy(fk[0]);
    el.quaternion.copy(fk[1]);
    wr.quaternion.copy(fk[2]);
    sh.updateMatrixWorld(true);
    if (arm.ik && arm.ik.weight > 0) {
      arm.ik.solve(rig, sh, el, wr);
      const ik = [sh.quaternion.clone(), el.quaternion.clone(), wr.quaternion.clone()];
      const w = arm.ik.blend ?? arm.ik.weight;
      sh.quaternion.copy(fk[0].slerp(ik[0], w));
      el.quaternion.copy(fk[1].slerp(ik[1], w));
      wr.quaternion.copy(fk[2].slerp(ik[2], w));
    } else {
      sh.quaternion.copy(fk[0]);
      el.quaternion.copy(fk[1]);
      wr.quaternion.copy(fk[2]);
    }
  }
  rig.root.updateMatrixWorld(true);
}

// ---------------------------------------------------------------------------
// The performance. Times in seconds of the 16 s loop.

const KNOCK_UP = [2.6, 4.4];
const KNOCK_DOWN = [7.0, 8.9];
const HOLD = [KNOCK_UP[1], KNOCK_DOWN[0]];

// Outside: 1.70 m, 45 cm from the door, facing it (-Z).
const OUT = { s: 1.0, x0: -0.1, z0: 0.53, yaw: Math.PI, fist: true };
const DOOR_OUT = LEAF_T / 2; // world z of the outside face

const outPelvis = spline([
  [0, 0, 0.965, 0, 0],
  [1.6, 0.012, 0.966, 0.004, 0.02],
  [2.6, 0.006, 0.966, 0.008, 0],
  [4.4, -0.004, 0.964, 0.022, -0.02],
  [7.0, -0.006, 0.964, 0.02, -0.02],
  [8.6, 0.004, 0.962, 0.0, 0],
  [9.7, 0.036, 0.960, -0.005, -0.1],
  [10.6, 0.032, 0.954, -0.02, -0.45],
  [11.5, 0.045, 0.958, -0.08, -0.95],
  [12.0, 0.046, 0.960, -0.085, -1.0],
  [12.8, 0.045, 0.960, -0.083, -0.94],
  [13.8, 0.03, 0.952, -0.04, -0.48],
  [14.8, 0.004, 0.963, 0.0, -0.04],
  [16, 0, 0.965, 0, 0]
]);
// spine pitch, chest pitch, chest yaw, neck pitch, neck yaw, head pitch, head yaw, head roll
const outTorso = spline([
  [0, 0.02, 0, 0, 0.06, 0, 0.02, 0, 0],
  [2.4, 0.02, 0.01, 0, 0.06, 0, 0.1, 0, 0],
  [4.4, 0.04, 0.06, 0.02, 0.07, 0, 0.04, 0, 0],
  [6.0, 0.04, 0.08, 0.02, 0.09, 0, 0.1, 0, 0.06],
  [7.0, 0.04, 0.08, 0.02, 0.1, 0, 0.12, 0, 0.06],
  [8.8, 0.06, 0.11, 0, 0.22, 0, 0.34, 0, 0.02],
  [9.6, 0.06, 0.1, -0.06, 0.2, -0.1, 0.3, -0.2, 0],
  [11.5, 0.05, 0.08, -0.18, 0.18, -0.2, 0.22, -0.25, 0],
  [12.0, 0.05, 0.08, -0.18, 0.18, -0.2, 0.22, -0.25, 0],
  [12.6, 0.04, 0.06, -0.1, 0.12, 0.15, 0.12, 0.4, -0.04],
  [13.0, 0.04, 0.05, -0.06, 0.1, 0.2, 0.08, 0.42, -0.04],
  [14.0, 0.03, 0.03, 0.04, 0.08, 0.1, 0.06, 0.12, 0],
  [15.0, 0.02, 0.0, 0, 0.06, 0, 0.03, 0, 0],
  [16, 0.02, 0, 0, 0.06, 0, 0.02, 0, 0]
]);
// Feet: x, z, yaw (local). The right foot steps back to turn away, then returns.
const outFootL = ease([
  [0, 0.1, 0, 0.14],
  [9.9, 0.1, 0, 0.14],
  [11.4, 0.1, 0, -0.55],
  [13.0, 0.1, 0, -0.55],
  [14.4, 0.1, 0, 0.14],
  [16, 0.1, 0, 0.14]
]);
const STEP_OUT = [10.1, 11.3];
const STEP_BACK = [13.0, 14.3];
const outFootR = ease([
  [0, -0.1, 0, -0.14],
  [STEP_OUT[0], -0.1, 0, -0.14],
  [STEP_OUT[1], -0.01, -0.17, -1.15],
  [STEP_BACK[0], -0.01, -0.17, -1.15],
  [STEP_BACK[1], -0.1, 0, -0.14],
  [16, -0.1, 0, -0.14]
]);
const arc = (t, [a, b]) => (t > a && t < b ? Math.sin((Math.PI * (t - a)) / (b - a)) : 0);
const knockWeight = ease([
  [0, 0],
  [KNOCK_UP[0], 0],
  [KNOCK_UP[1], 1],
  [KNOCK_DOWN[0], 1],
  [KNOCK_DOWN[1], 0],
  [16, 0]
]);
// Knuckles to wood, meters: approaches, hovers, edges closer, pulls back.
const knockGap = spline([
  [0, 0.22],
  [KNOCK_UP[0], 0.22],
  [3.6, 0.12],
  [KNOCK_UP[1], 0.07],
  [5.0, 0.04],
  [5.6, 0.055],
  [6.2, 0.022],
  [6.7, 0.045],
  [KNOCK_DOWN[0], 0.07],
  [7.8, 0.17],
  [KNOCK_DOWN[1], 0.22],
  [16, 0.22]
]);

function poseOut(t) {
  const [px, py, pz, yaw] = outPelvis(t);
  const [sp, cp, cy, np, ny, hp, hy, hr] = outTorso(t);
  const hold = span(t, HOLD[0] - 0.2, HOLD[1], 0.5);
  // The breath is held at the door and let go as the hand comes down.
  const breathAmp = 1 - 0.75 * hold + 0.7 * span(t, 7.2, 9.0, 0.6);
  const b = 0.5 + 0.5 * Math.sin((2 * Math.PI * 5 * t) / LOOP) * breathAmp;
  const lean = sp + cp;
  const [lx, lz, lyaw] = outFootL(t);
  const [rx, rz, ryaw] = outFootR(t);
  const lift = 0.05 * (arc(t, STEP_OUT) + arc(t, STEP_BACK));
  const w = knockWeight(t)[0];
  const sway = 0.06 * Math.sin((2 * Math.PI * t) / LOOP);
  return {
    pelvis: [px, py, pz],
    pelvisYaw: yaw,
    spine: [sp + 0.006 * b, 0, 0],
    chest: [cp - 0.012 * b, cy, 0],
    neck: [np, ny, 0],
    head: [hp + 0.006 * b, hy, hr],
    breath: [1 + 0.02 * b, 1 + 0.012 * b, 1 + 0.035 * b],
    feet: {
      L: { pos: [lx, ANKLE_H + MAT, lz], yaw: lyaw },
      R: { pos: [rx, ANKLE_H + MAT + lift, rz], yaw: ryaw, pitch: 0.3 * (arc(t, STEP_OUT) + arc(t, STEP_BACK)) }
    },
    arms: {
      L: { fk: { shoulder: [-0.04 + lean + sway * 0.3, 0, 0.09], elbow: [-0.2, 0, 0], wrist: [0, 0, 0.05] } },
      R: {
        fk: { shoulder: [-0.04 + lean - sway * 0.3, 0, -0.09], elbow: [-0.24, 0, 0], wrist: [0, 0, -0.05] },
        ik: {
          weight: w,
          blend: smooth(0, 0.15, w),
          solve: (rig, sh, el, wr) => {
            // A loose fist at face height in front of the right shoulder,
            // reached by bending the elbow first: hand up past the chest, then out.
            const hang = wr.getWorldPosition(new Vector3());
            const fkWrist = wr.quaternion.clone();
            const fistQ = eul(0.15, 0, -0.25, 'XYZ');
            const gap = knockGap(t)[0] + 0.003 * Math.sin(2 * Math.PI * 5.25 * t) * hold;
            const waver = 0.008 * Math.sin(2 * Math.PI * 0.9 * t) * hold;
            const knock = rig.toWorld([-0.1, 1.4 + waver, 0.4]);
            const pole = rig.dirToWorld([-0.45, -1, -0.5]);
            for (let k = 0; k < 4; k += 1) {
              wr.quaternion.copy(fistQ);
              twoBone(sh, el, wr.position.length(), knock, pole, 1);
              const near = rig.extreme(['wristR'], 'z', -1);
              knock.z += DOOR_OUT + gap - near;
            }
            if (w < 1) {
              const via = rig.toWorld([-0.15, 1.12, 0.2]);
              const target = hang.clone().multiplyScalar((1 - w) ** 2).addScaledVector(via, 2 * w * (1 - w)).addScaledVector(knock, w * w);
              wr.quaternion.copy(fkWrist.slerp(fistQ, w));
              twoBone(sh, el, wr.position.length(), target, pole, 1);
            }
          }
        }
      }
    }
  };
}

// Inside: 1.62 m, forehead resting on the door, right palm flat on it.
const IN = { s: 1.62 / 1.7, x0: 0.0, z0: 0, yaw: 0, fist: false };
const DOOR_IN = -LEAF_T / 2;
const LISTEN = [4.7, 5.4]; // head lifts a beat after the fist rises
const inHead = spline([
  [0, 0.14, 0.3, 0.0, 0.05],
  [LISTEN[0], 0.14, 0.3, 0.0, 0.05],
  [LISTEN[1], 0.06, 0.0, 0.1, -0.03],
  [6.7, 0.06, 0.02, 0.09, -0.03],
  [8.6, 0.14, 0.3, 0.0, 0.05],
  [16, 0.14, 0.3, 0.0, 0.05]
]);
const inPress = spline([
  [0, 0],
  [5.1, 0],
  [5.8, 1],
  [6.6, 1],
  [7.8, 0],
  [16, 0]
]);

function poseIn(t) {
  const s = IN.s;
  const [np, hp, hy, hr] = inHead(t);
  const press = inPress(t)[0];
  const b = 0.5 + 0.5 * Math.sin((2 * Math.PI * 4 * t) / LOOP + 1.1);
  const shift = Math.sin((2 * Math.PI * t) / LOOP);
  const sp = 0.06;
  const cp = 0.07 + 0.035 * press - 0.012 * b;
  return {
    pelvis: [0.008 * shift, 0.905 * (s / 0.953), 0.0 + 0.012 * press],
    pelvisYaw: 0.02 * shift,
    pelvisPitch: 0.06,
    pelvisRoll: -0.015 * shift,
    spine: [sp, 0, 0.01 * shift],
    chest: [cp, -0.02 * press, 0],
    neck: [np, hy * 0.4, 0],
    head: [hp, hy, hr],
    breath: [1 + 0.02 * b, 1 + 0.012 * b, 1 + 0.035 * b],
    feet: {
      L: { pos: [0.1, ANKLE_H * s, -0.2], yaw: 0.2 },
      R: { pos: [-0.105, ANKLE_H * s, -0.15], yaw: -0.12 }
    },
    arms: {
      L: { fk: { shoulder: [0.06 + sp + cp + 0.02, 0, 0.07], elbow: [-0.16, 0, 0], wrist: [0, 0, 0.06] } },
      R: {
        fk: { shoulder: [0, 0, 0], elbow: [0, 0, 0], wrist: [0, 0, 0] },
        ik: {
          weight: 1,
          solve: (rig, sh, el, wr) => {
            // Palm flat on the wood at shoulder height, fingers up and a little out.
            const fingers = new Vector3(-Math.sin(0.25), Math.cos(0.25), 0);
            const X = new Vector3(0, 0, 1);
            const Y = fingers.clone().negate();
            const Z = new Vector3().crossVectors(X, Y);
            const handQ = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(X, Y, Z));
            const palm = new Vector3(-0.235, 1.3 + 0.006 * press, DOOR_IN - 0.02);
            const target = palm.clone().addScaledVector(fingers, -0.075);
            const pole = new Vector3(-0.8, -0.7, -1.0).normalize();
            for (let k = 0; k < 4; k += 1) {
              twoBone(sh, el, wr.position.length(), target, pole, 1);
              const elQ = el.getWorldQuaternion(new Quaternion());
              wr.quaternion.copy(elQ.invert().multiply(handQ));
              const near = rig.extreme(['wristR'], 'z', 1);
              target.z += DOOR_IN - 0.0008 - near;
            }
          }
        }
      }
    }
  };
}

const FIGURE_PARTS = SKELETON.map(([name]) => name).concat('chestBreath').filter((n) => n !== 'chest');

function sampleFigure(rig, pose) {
  const count = LOOP * FPS;
  const frames = [];
  for (let i = 0; i <= count; i += 1) {
    const t = (i / count) * LOOP;
    applyPose(rig, pose(t));
    const f = { t, q: {}, pelvis: rig.j.pelvis.position.toArray(), breath: rig.breath.scale.toArray() };
    for (const [name] of SKELETON) f.q[name] = rig.j[name].quaternion.toArray();
    frames.push(f);
  }
  return frames;
}

function writeFigure(glb, rig, frames, { name, material, times }) {
  const root = glb.node({ name, translation: rig.root.position.toArray(), rotation: rig.root.quaternion.toArray() });
  const nodes = {};
  const meshFor = (part) => glb.mesh(`${name}-${part}`, rig.geo[part], material);
  for (const [joint, parent, offset] of SKELETON) {
    nodes[joint] = glb.node({
      name: `${name}-${joint}`,
      mesh: rig.geo[joint] ? meshFor(joint) : undefined,
      // The static transform is the first frame, so anything that reads the
      // file without playing it still sees feet on the floor.
      translation: joint === 'pelvis' ? frames[0].pelvis : offset.map((v) => v * rig.s),
      rotation: frames[0].q[joint],
      parent: parent ? nodes[parent] : root
    });
    if (joint === 'chest') {
      nodes.chestBreath = glb.node({ name: `${name}-chestBreath`, mesh: meshFor('chestBreath'), scale: frames[0].breath, parent: nodes.chest });
    }
  }
  for (const [joint] of SKELETON) {
    const values = [];
    let prev = null;
    for (const f of frames) {
      let q = f.q[joint];
      if (prev && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0) q = q.map((v) => -v);
      values.push(...q);
      prev = q;
    }
    glb.animate(nodes[joint], 'rotation', times, values);
  }
  glb.animate(nodes.pelvis, 'translation', times, frames.flatMap((f) => f.pelvis));
  glb.animate(nodes.chestBreath, 'scale', times, frames.flatMap((f) => f.breath));
}

// ---------------------------------------------------------------------------
// Sound: a quiet room and two hearts, 18 and 17 beats a loop, that drift
// through one full cycle of phase; both quicken around the near-knock and
// they beat together at its closest moment. No knock ever sounds.

function beatTimes(N, bumps, phase = 0) {
  const steps = 32000;
  const F = new Float64Array(steps + 1);
  const rate = (t) => {
    let r = 1;
    for (const b of bumps) {
      let d = Math.abs(t - b.at);
      d = Math.min(d, LOOP - d);
      r += b.amp * Math.exp(-(d * d) / (2 * b.width * b.width));
    }
    return r;
  };
  for (let i = 1; i <= steps; i += 1) F[i] = F[i - 1] + rate(((i - 0.5) / steps) * LOOP);
  const total = F[steps];
  const phaseAt = (t) => (N * F[Math.round((t / LOOP) * steps)]) / total;
  const times = [];
  for (let k = 0; k < N; k += 1) {
    const goal = k + phase;
    let lo = 0;
    let hi = steps;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((N * F[mid]) / total < goal) lo = mid;
      else hi = mid;
    }
    times.push((hi / steps) * LOOP);
  }
  return { times, phaseAt };
}

function thump(hz) {
  return (t) => {
    const ph = 2 * Math.PI * (hz * t + hz * 0.7 * 0.025 * (1 - Math.exp(-t / 0.025)));
    return Math.sin(ph) + 0.4 * Math.sin(2 * ph) + 0.15 * Math.sin(3 * ph);
  };
}

function heart(buf, times, hz, gain) {
  const env = (t) => (t < 0.006 ? t / 0.006 : Math.exp(-(t - 0.006) / 0.055));
  for (const tb of times) {
    add(buf, tb, 0.4, thump(hz), (t) => gain * env(t));
    add(buf, tb + 0.23, 0.4, thump(hz * 0.88), (t) => gain * 0.6 * env(t));
  }
}

function sound() {
  const n = Math.round(LOOP * SAMPLE_RATE);
  const out = new Float32Array(n);

  // Room tone: low filtered air, crossfaded over its own tail to loop cleanly.
  const fade = SAMPLE_RATE;
  const raw = new Float32Array(n + fade);
  const random = noise(5);
  for (let i = 0; i < raw.length; i += 1) raw[i] = random();
  lowpass(raw, 220);
  lowpass(raw, 300);
  let rms = 0;
  for (let i = 0; i < n; i += 1) rms += raw[i] * raw[i];
  rms = Math.sqrt(rms / n);
  for (let i = 0; i < n; i += 1) {
    let v = raw[i];
    if (i < fade) {
      const a = i / fade;
      v = Math.sqrt(a) * raw[i] + Math.sqrt(1 - a) * raw[i + n];
    }
    out[i] = (v / rms) * 0.012;
  }

  const hb = new Float32Array(n);
  const outside = beatTimes(18, [{ at: 5.4, width: 1.6, amp: 0.24 }]);
  const closest = outside.times.reduce((best, tb) => (Math.abs(tb - 6.2) < Math.abs(best - 6.2) ? tb : best));
  const insideProbe = beatTimes(17, [{ at: 6.0, width: 1.5, amp: 0.18 }]);
  const phase = insideProbe.phaseAt(closest) % 1;
  const inside = beatTimes(17, [{ at: 6.0, width: 1.5, amp: 0.18 }], phase);
  heart(hb, outside.times, 64, 1.0);
  heart(hb, inside.times, 55, 0.85);
  lowpass(hb, 380);
  let peak = 0;
  for (const v of hb) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < n; i += 1) out[i] += (hb[i] / peak) * 0.5;
  return toWav(out);
}

// ---------------------------------------------------------------------------

export async function build() {
  const glb = new Glb();
  glb.provenance({ holoim: { authored: 'synthetic', author: meta.submittedBy, title: meta.name } });

  const times = [];
  const count = LOOP * FPS;
  for (let i = 0; i <= count; i += 1) times.push((i / count) * LOOP);

  // Figures first: the inside person's feet decide where the light breaks.
  const inside = new Rig(IN);
  // Find how far forward the forehead reaches, then stand them so it rests on the wood.
  let reach = -Infinity;
  for (let i = 0; i <= count; i += 1) {
    const P = poseIn((i / count) * LOOP);
    P.arms.R.ik = null;
    applyPose(inside, P);
    reach = Math.max(reach, inside.extreme(['head', 'neck', 'chestBreath', 'spine', 'pelvis'], 'z', 1));
  }
  inside.root.position.z = DOOR_IN - 0.0015 - reach;
  inside.root.updateMatrixWorld(true);
  const inFrames = sampleFigure(inside, poseIn);

  const outside = new Rig(OUT);
  const outFrames = sampleFigure(outside, poseOut);

  // Diagnostics (stderr): door clearances through the loop.
  const diag = { outsideNearestToDoor: Infinity, outsideNearestT: 0, insideFarthestIn: -Infinity, insideFloorMin: Infinity, outsideFloorMin: Infinity };
  for (let i = 0; i <= count; i += 6) {
    const t = (i / count) * LOOP;
    applyPose(outside, poseOut(t));
    const near = outside.extreme(FIGURE_PARTS, 'z', -1);
    if (near < diag.outsideNearestToDoor) {
      diag.outsideNearestToDoor = near;
      diag.outsideNearestT = t;
    }
    diag.outsideFloorMin = Math.min(diag.outsideFloorMin, outside.extreme(FIGURE_PARTS, 'y', -1));
    applyPose(inside, poseIn(t));
    for (const part of FIGURE_PARTS) {
      const z = inside.extreme([part], 'z', 1);
      if (z > diag.insideFarthestIn) {
        diag.insideFarthestIn = z;
        diag.insideFarthestPart = `${part}@${t.toFixed(1)}`;
      }
    }
    diag.insideFloorMin = Math.min(diag.insideFloorMin, inside.extreme(FIGURE_PARTS, 'y', -1));
  }
  applyPose(inside, poseIn(0));
  const feet = ['L', 'R'].map((side) => {
    const p = inside.j[`ankle${side}`].getWorldPosition(new Vector3());
    return { x: p.x, hw: 0.05, drift: p.x * 0.6 };
  });
  diag.insideRootZ = +inside.root.position.z.toFixed(3);
  diag.feet = feet.map((f) => +f.x.toFixed(3));
  console.error('door diagnostics', JSON.stringify(diag));

  const scene = glb.node({ name: 'TwoSidesOfADoor' });
  const painted = glb.material({ name: 'Painted', color: '#ffffff', unlit: true });
  glb.node({ name: 'Wall', mesh: glb.mesh('Wall', wallGeometry(), painted), parent: scene });
  glb.node({ name: 'Floors', mesh: glb.mesh('Floors', floorsGeometry(), painted), parent: scene });
  glb.node({ name: 'LightUnderDoor', mesh: glb.mesh('LightUnderDoor', lightStripGeometry(feet), painted), parent: scene });

  const walnut = glb.material({ name: 'Walnut', color: '#5b3a24', roughness: 0.55 });
  const walnutOut = glb.material({ name: 'WalnutOutside', color: '#3e2c22', roughness: 0.5, emissive: '#0b1a22' });
  const walnutIn = glb.material({ name: 'WalnutInside', color: '#6e4528', roughness: 0.5, emissive: '#3a1c0a' });
  const brass = glb.material({ name: 'Brass', color: '#c9a24a', metallic: 0.45, roughness: 0.32, emissive: '#4a3010' });
  const trimOut = glb.material({ name: 'TrimOutside', color: '#2e4650', roughness: 0.8 });
  const trimIn = glb.material({ name: 'TrimInside', color: '#a88560', roughness: 0.75, emissive: '#3a200c' });
  const matInk = glb.material({ name: 'Doormat', color: '#141e22', roughness: 1 });

  const leaf = box(-LEAF_W / 2, LEAF_W / 2, GAP, GAP + LEAF_H, -LEAF_T / 2 + 0.005, LEAF_T / 2 - 0.005);
  glb.node({ name: 'DoorLeaf', mesh: glb.mesh('DoorLeaf', leaf, walnut), parent: scene });
  glb.node({ name: 'DoorOutsideFace', mesh: glb.mesh('DoorOutsideFace', doorFace(1), walnutOut), parent: scene });
  glb.node({ name: 'DoorInsideFace', mesh: glb.mesh('DoorInsideFace', doorFace(-1), walnutIn), parent: scene });
  glb.node({ name: 'Knobs', mesh: glb.mesh('Knobs', mergeGeometries([knob(1), knob(-1)]), brass), parent: scene });
  const jambs = mergeGeometries([
    box(-OPEN_HALF, -LEAF_W / 2 - 0.002, 0, OPEN_H, -WALL_Z, WALL_Z),
    box(LEAF_W / 2 + 0.002, OPEN_HALF, 0, OPEN_H, -WALL_Z, WALL_Z),
    box(-OPEN_HALF, OPEN_HALF, GAP + LEAF_H + 0.002, OPEN_H, -WALL_Z, WALL_Z),
    box(-LEAF_W / 2 - 0.002, -LEAF_W / 2 + 0.012, 0, GAP + LEAF_H + 0.002, -LEAF_T / 2 - 0.014, -LEAF_T / 2 - 0.001),
    box(LEAF_W / 2 - 0.012, LEAF_W / 2 + 0.002, 0, GAP + LEAF_H + 0.002, -LEAF_T / 2 - 0.014, -LEAF_T / 2 - 0.001)
  ]);
  glb.node({ name: 'Jambs', mesh: glb.mesh('Jambs', jambs, walnut), parent: scene });
  glb.node({ name: 'CasingOutside', mesh: glb.mesh('CasingOutside', casing(1), trimOut), parent: scene });
  glb.node({ name: 'CasingInside', mesh: glb.mesh('CasingInside', casing(-1), trimIn), parent: scene });
  glb.node({ name: 'Doormat', mesh: glb.mesh('Doormat', box(-0.42, 0.36, 0, MAT, 0.26, 0.86), matInk), parent: scene });

  const coolBody = glb.material({ name: 'OutsidePerson', color: T.identity[3], emissive: T.identity[5], emissiveStrength: 0.55, roughness: 0.4 });
  const warmBody = glb.material({ name: 'InsidePerson', color: T.gold, emissive: T.glow, emissiveStrength: 0.6, roughness: 0.4 });
  writeFigure(glb, outside, outFrames, { name: 'Outside', material: coolBody, times });
  writeFigure(glb, inside, inFrames, { name: 'Inside', material: warmBody, times });

  glb.audio(sound());
  return glb;
}

export const tiles = [
  { view: 'front', t: 6.2 },
  { view: 'back', t: 6.2 },
  { view: 'top', t: 6.2 },
  { view: 'quarter', t: 6.2 },
  { label: 'both, from above', cam: [1.25, 4.4, -0.04], look: [0, 0.8, 0.0], t: 6.2, fov: 45 },
  { label: 'profile', cam: [3.4, 1.35, 0.05], look: [0, 1.05, 0.05], t: 6.2, fov: 40 },
  { label: 'the near-knock', cam: [1.1, 1.65, 1.5], look: [0, 1.35, 0.25], t: 6.2, fov: 40 },
  { label: 'the listener', cam: [-1.5, 1.45, -0.75], look: [0, 1.15, -0.2], t: 6.2, fov: 40 },
  { label: 'light under the door', cam: [0.95, 0.28, 0.5], look: [-0.1, 0.0, 0.06], t: 6.2, fov: 40 },
  { label: 'turning away, above', cam: [1.25, 4.4, -0.04], look: [0, 0.8, 0.0], t: 12.5, fov: 45 },
  { label: 'loop start', view: 'quarter', t: 0 }
];

