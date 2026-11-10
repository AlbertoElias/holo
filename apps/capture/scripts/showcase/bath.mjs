import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  Object3D,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { SAMPLE_RATE, add, lowpass, noise, normalize, pluck, swell, toWav, track as audioTrack } from './lib/audio.mjs';
import { Glb, sample } from './lib/glb.mjs';
import { fbm3, noise3, quat, quatMul, rng } from './lib/parts.mjs';
import { T } from './lib/tokens.mjs';

// "The sea in the bathtub": a true-size clawfoot bath on a torn slab of
// bathroom tiles, and in it the sea as a five-year-old knew it was. A storm
// rolls the length of the tub, a paper boat fights into it, a kraken rises by
// the plug, the tap is a lighthouse and a thundercloud hangs under the shower
// head. Outside the rim the bathroom stays quiet, dry and warm.

export const meta = {
  slug: 'the-sea-in-the-bathtub',
  name: 'The sea in the bathtub',
  submittedBy: 'Claude (agent-authored)'
};

const LOOP = 16;
const FPS = 20;
const TAU = Math.PI * 2;
const HIDDEN = [1e-4, 1e-4, 1e-4];
const ONE = [1, 1, 1];

// The tub, in its own frame: long axis X (taps at -X), long side facing +Z.
const TOP = 0.03; // top of the floor slab
const YB = 0.17; // underside of the tub
const RIM = 0.6;
const RR = 0.024; // radius of the rolled lip
const YC = RIM - RR;
const YIB = 0.215; // inside bottom
const PEXP = 2.6; // superellipse exponent of the tub's outline
const PLANE = 0.505; // still-water level (about 9 cm under the rim)
const LIGHTNING = [4.0, 11.5];
const SWAMP = 9.0;
const YAW = (6 * Math.PI) / 180;

// The swell: 8 waves in 16 s, travelling from the storm (tap) end to the calm end.
const WK = TAU / 0.52;
const WW = (TAU * 8) / LOOP;

const col = (hex) => new Color(hex);
const mix = (a, b, t) => col(a).lerp(col(b), Math.min(1, Math.max(0, t)));
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const bump = (t, at, width) => {
  // A periodic gaussian bump at `at`, so it joins across the loop.
  let d = (((t - at) % LOOP) + LOOP) % LOOP;
  if (d > LOOP / 2) d -= LOOP;
  return Math.exp(-((d / width) ** 2));
};

// ---------------------------------------------------------------- the tub's shape

const uOf = (y) => clamp((y - YB) / (YC - YB));
const tuck = (y) => 0.012 * (1 - smooth(YC - 0.035, YC, y));
const outerAt = (y) => {
  const u = uOf(y);
  return { rx: 0.825 - 0.15 * (1 - u) ** 2 - tuck(y), rz: 0.39 - 0.1 * (1 - u) ** 2 - tuck(y), cx: -0.06 * (1 - u) ** 1.5 };
};
const innerAt = (y) => {
  const o = outerAt(y);
  const d = 2 * RR + 0.02 * (1 - uOf(y));
  return { rx: o.rx - d, rz: o.rz - d, cx: o.cx };
};
function outline(th, { rx, rz, cx }, f = 1) {
  const c = Math.cos(th);
  const s = Math.sin(th);
  const e = 2 / PEXP;
  return [cx + f * rx * Math.sign(c) * Math.abs(c) ** e, f * rz * Math.sign(s) * Math.abs(s) ** e];
}
/** A point is legal inside the tub if it is above the rim, or inside the inner wall with a margin. */
function insideTub(x, y, z, margin = 0.006) {
  if (y > RIM + 0.005) return true;
  if (y < YIB + 0.004) return false;
  const o = innerAt(y);
  return (Math.abs(x - o.cx) / (o.rx - margin)) ** PEXP + (Math.abs(z) / (o.rz - margin)) ** PEXP <= 1;
}

// ---------------------------------------------------------------- geometry helpers

const KEEP = new Set(['position', 'normal', 'color']);

/** Non-indexed, position / normal / color; `color` is a hex or fn(x, y, z, nx, ny, nz) -> Color. */
function prep(geometry, color) {
  let g = geometry;
  if (!g.attributes.normal) g.computeVertexNormals();
  if (g.index) g = g.toNonIndexed();
  for (const key of Object.keys(g.attributes)) if (!KEEP.has(key)) g.deleteAttribute(key);
  g.clearGroups();
  if (color === undefined && !g.attributes.color) color = '#ffffff';
  if (color !== undefined) {
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    const out = new Float32Array(pos.count * 3);
    const fixed = typeof color === 'function' ? null : col(color);
    for (let i = 0; i < pos.count; i += 1) {
      const c = fixed ?? color(pos.getX(i), pos.getY(i), pos.getZ(i), nor.getX(i), nor.getY(i), nor.getZ(i));
      out.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('color', new BufferAttribute(out, 3));
  }
  return g;
}

/** Scale, rotate (z, x, y order) and move a geometry in place. */
function xf(g, { s, rx, ry, rz, at } = {}) {
  if (Array.isArray(s)) g.scale(...s);
  else if (s !== undefined) g.scale(s, s, s);
  if (rz) g.rotateZ(rz);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (at) g.translate(...at);
  return g;
}

/** Smaller files: unlit paint needs no normals, and shared corners become one vertex. */
function compact(geometry, unlit) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  for (const key of Object.keys(g.attributes)) if (!KEEP.has(key)) g.deleteAttribute(key);
  if (unlit) g.deleteAttribute('normal');
  return mergeVertices(g, 1e-5);
}

/** A (rows+1) x (cols+1) indexed grid from fn(i, j) -> { p, c }, with smooth normals. */
function grid(rows, cols, fn) {
  const positions = [];
  const colors = [];
  for (let i = 0; i <= rows; i += 1) {
    for (let j = 0; j <= cols; j += 1) {
      const { p, c } = fn(i, j);
      positions.push(...p);
      colors.push(c.r, c.g, c.b);
    }
  }
  const index = [];
  for (let i = 0; i < rows; i += 1) {
    for (let j = 0; j < cols; j += 1) {
      const a = i * (cols + 1) + j;
      index.push(a, a + cols + 1, a + 1, a + 1, a + cols + 1, a + cols + 2);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** Flat triangles with per-vertex colours (unlit paint). */
class Paint {
  constructor() {
    this.p = [];
    this.c = [];
  }
  tri(a, b, c, ca, cb = ca, cc = ca) {
    this.p.push(...a, ...b, ...c);
    this.c.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b, cc.r, cc.g, cc.b);
  }
  quad(a, b, c, d, ca, cb = ca, cc = ca, cd = ca) {
    this.tri(a, b, c, ca, cb, cc);
    this.tri(a, c, d, ca, cc, cd);
  }
  geometry() {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.p), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.c), 3));
    g.computeVertexNormals();
    return g;
  }
}

/** A tube along points whose radius runs r0 -> r1. */
function taperTube(points, r0, r1, radial = 10, segs = 24) {
  const curve = new CatmullRomCurve3(points.map((p) => new Vector3(...p)));
  const g = new TubeGeometry(curve, segs, 1, radial, false);
  const pos = g.attributes.position;
  const centre = new Vector3();
  const v = new Vector3();
  for (let i = 0; i < pos.count; i += 1) {
    const ring = Math.floor(i / (radial + 1));
    const u = ring / segs;
    curve.getPointAt(u, centre);
    v.fromBufferAttribute(pos, i).sub(centre).multiplyScalar(r0 + (r1 - r0) * u).add(centre);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.deleteAttribute('normal');
  g.computeVertexNormals();
  return g;
}

/** Keys a quaternion sequence so neighbours never flip sign (LINEAR then takes the short way). */
function quatKeys(fn) {
  const values = [];
  let prev = null;
  for (const t of TIMES) {
    let q = fn(t);
    if (prev && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0) q = q.map((v) => -v);
    values.push(...q);
    prev = q;
  }
  return values;
}
const TIMES = sample(LOOP, FPS, () => [0]).times;
const vecKeys = (fn) => TIMES.flatMap((t) => fn(t));

// ---------------------------------------------------------------- the sea

const stormAmp = (x) => 0.075 * (1 - 0.68 * smooth(-0.2, 0.5, x));
const phaseAt = (x, z, t) => WK * x - WW * t + 0.45 * Math.sin(z * 6 + 1.3) + 0.4 * Math.sin(x * 3.1);
const crest = (p) => ((1 + Math.sin(p)) / 2) ** 1.2;
/** The sea's height under a floating thing at (x, z). */
const seaY = (x, z, t) => PLANE + 0.004 + Math.max(0, stormAmp(x) * crest(phaseAt(x, z, t)) - 0.02) * 0.9;
const seaSlope = (x, z, t) => (seaY(x + 0.04, z, t) - seaY(x - 0.04, z, t)) / 0.08;

/**
 * One crest piece: a rounded swell across the tub, leaning a little the way
 * it travels; unit size. Smooth teal that darkens into the trough, a thin
 * broken line of foam along the very top, a few flecks down the back.
 */
function crestGeometry(seed) {
  const U = 18;
  const W = 14;
  const g = grid(U, W, (i, j) => {
    const u = (i / U) * 2 - 1;
    const w = (j / W) * 2 - 1;
    const n = fbm3(u * 1.2 + seed, w * 1.6, seed, { octaves: 3, seed });
    const ridge = Math.cos((Math.PI / 2) * Math.abs(u)) ** 1.5;
    const along = (1 - Math.abs(w) ** 4) ** 0.6;
    const y = Math.max(0, ridge * along * (0.85 + 0.3 * n));
    // Painted from the shape itself: dark low, teal body, foam only on the ridge line.
    const h = ridge * along;
    let c;
    if (h < 0.3) c = mix('#051b23', '#0b333c', h / 0.3);
    else if (h < 0.8) c = mix('#0b333c', '#185c63', (h - 0.3) / 0.5);
    else c = mix('#185c63', '#2b7779', (h - 0.8) / 0.2);
    const broken = noise3(w * 7 + seed, seed, 0.5, seed + 1);
    if (Math.abs(u) < 0.07 && along > 0.55 && broken > 0.48) c = mix('#cfe8e4', '#f4fbfa', broken);
    const fleck = noise3(u * 9 + seed, w * 12, 1.5, seed + 2);
    if (u < -0.3 && u > -0.65 && along > 0.6 && fleck > 0.8) c = col('#9cc8c4');
    return { p: [u + 0.22 * y, y, w * (0.94 + 0.12 * n)], c };
  });
  return prep(g);
}

function waterGeometry() {
  const o = innerAt(PLANE);
  const N = 96;
  const R = 8;
  return grid(R, N, (i, j) => {
    const th = (j / N) * TAU;
    const f = i / R;
    const [x, z] = outline(th, { ...o, rx: o.rx + 0.004, rz: o.rz + 0.004 }, f);
    const n = fbm3(x * 5, 0, z * 5, { octaves: 3, seed: 61 });
    const streak = smooth(0.62, 0.74, fbm3(x * 9 - z * 2, 1, z * 14, { octaves: 2, seed: 62 }));
    const c = mix('#04161c', '#0a2b33', n);
    c.lerp(col('#2f6a6c'), streak * 0.4 + smooth(0.85, 1, f) * 0.25);
    return { p: [x, PLANE, z], c };
  });
}

function foamPiles(random) {
  const parts = [];
  const piles = [
    [0.63, 0.0, 0.1, 0.22],
    [0.56, 0.13, 0.08, 0.15],
    [0.57, -0.13, 0.085, 0.17],
    [0.69, 0.09, 0.07, 0.13],
    [0.69, -0.09, 0.07, 0.11],
    [0.5, 0.03, 0.07, 0.1],
    [0.49, -0.19, 0.06, 0.07],
    [0.49, 0.21, 0.06, 0.08]
  ];
  for (const [px, pz, r0, h0] of piles) {
    const seed = Math.floor(random() * 1000);
    let fit = 1;
    let g;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      g = new ConeGeometry(r0 * fit, h0 * fit, 22, 8);
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i += 1) {
        const x = pos.getX(i);
        const y = pos.getY(i) + (h0 * fit) / 2;
        const z = pos.getZ(i);
        const n = fbm3(x * 18 + seed, y * 18, z * 18, { octaves: 3, seed });
        const k = 0.82 + 0.36 * n;
        pos.setXYZ(i, px + x * k, PLANE - 0.012 + y * (0.9 + 0.2 * n), pz + z * k);
      }
      let ok = true;
      for (let i = 0; i < pos.count && ok; i += 1) ok = insideTub(pos.getX(i), pos.getY(i), pos.getZ(i), 0.008);
      if (ok) break;
      fit *= 0.93;
    }
    g.computeVertexNormals();
    parts.push(
      prep(g, (x, y, z, nx) => {
        const hgt = smooth(PLANE, PLANE + 0.15, y);
        const shade = 0.5 + 0.5 * nx * -1;
        const c = mix('#7fa3ab', '#f4f8f7', 0.35 + 0.65 * hgt);
        return c.lerp(col('#5d8790'), 0.35 * shade * (1 - hgt));
      })
    );
  }
  return mergeGeometries(parts);
}

// ---------------------------------------------------------------- the floor

const SLAB = { rx: 1.13, rz: 0.74, p: 3.4 };
function tear(u, seed, big) {
  return (
    big * (fbm3(u * 1.3, 0.5, seed * 1.7, { octaves: 3, seed }) - 0.5) * 2 +
    0.025 * (fbm3(u * 7, 2.5, seed, { octaves: 3, seed: seed + 5 }) - 0.5) * 2 +
    0.007 * (noise3(u * 33, 4.5, seed, seed + 9) - 0.5) * 2
  );
}
function slabR(th) {
  const c = Math.abs(Math.cos(th));
  const s = Math.abs(Math.sin(th));
  const r0 = 1 / ((c / SLAB.rx) ** SLAB.p + (s / SLAB.rz) ** SLAB.p) ** (1 / SLAB.p);
  return r0 + tear(th * 1.9, 6, 0.07);
}

/** The warm, dry light on the floor, with the tub's soft contact shadow. */
function floorLight(x, z) {
  const warm = 0.86 + 0.2 * smooth(-1.2, 1.0, x * 0.35 + z * 0.8);
  const o = outerAt(RIM);
  const q = ((Math.abs(x + 0.03) / (o.rx * 0.92)) ** 2.4 + (Math.abs(z) / (o.rz * 0.95)) ** 2.4) ** (1 / 2.4);
  const shadow = 1 - 0.38 * (1 - smooth(0.75, 1.25, q));
  const stool = 1 - 0.25 * (1 - smooth(0.08, 0.2, Math.hypot(x - 0.93, z - 0.36)));
  return warm * shadow * stool;
}

function floorGeometry() {
  const paint = new Paint();
  const P = 0.07;
  const G = 0.005;
  const tileA = col('#e9dcc4');
  const tileB = col('#b9cdb9');
  const grout = col('#a2957f');
  const lit = (c, x, z) => c.clone().multiplyScalar(floorLight(x, z));
  const inside = (x, z, m) => Math.hypot(x, z) < slabR(Math.atan2(z, x)) - m;
  // Grout underlay: a fan to the torn edge.
  const N = 260;
  for (let j = 0; j < N; j += 1) {
    const a = (j / N) * TAU;
    const b = ((j + 1) / N) * TAU;
    const ra = slabR(a) - 0.02;
    const rb = slabR(b) - 0.02;
    const pa = [ra * Math.cos(a), TOP - 0.0015, ra * Math.sin(a)];
    const pb = [rb * Math.cos(b), TOP - 0.0015, rb * Math.sin(b)];
    paint.tri([0, TOP - 0.0015, 0], pb, pa, lit(grout, 0, 0), lit(grout, pb[0], pb[2]), lit(grout, pa[0], pa[2]));
  }
  // Tiles, each split 3 x 3 so the torn edge breaks them.
  for (let i = -18; i < 18; i += 1) {
    for (let k = -12; k < 12; k += 1) {
      const base = (i + k) % 2 === 0 ? tileA : tileB;
      const vary = 0.95 + 0.08 * noise3(i * 1.7, k * 1.3, 0.5, 5);
      const x0 = i * P + G / 2;
      const z0 = k * P + G / 2;
      const w = (P - G) / 3;
      for (let a = 0; a < 3; a += 1) {
        for (let b = 0; b < 3; b += 1) {
          const xa = x0 + a * w;
          const za = z0 + b * w;
          if (!inside(xa + w / 2, za + w / 2, 0.03)) continue;
          const c = (x, z) => lit(base, x, z).multiplyScalar(vary);
          paint.quad([xa, TOP, za], [xa, TOP, za + w], [xa + w, TOP, za + w], [xa + w, TOP, za], c(xa, za), c(xa, za + w), c(xa + w, za + w), c(xa + w, za));
        }
      }
    }
  }
  // The burnt rim on top, the gold edge down the side, a dark underside.
  const scorch = col('#2b1a10');
  const gold = col(T.gold);
  const high = col(T.highlight);
  for (let j = 0; j < N; j += 1) {
    const a = (j / N) * TAU;
    const b = ((j + 1) / N) * TAU;
    const ra = slabR(a);
    const rb = slabR(b);
    const ring = (r, th, y = TOP + 0.0008) => [r * Math.cos(th), y, r * Math.sin(th)];
    const wa = 0.035 + 0.02 * fbm3(a * 5, 1, 2, { octaves: 2, seed: 8 });
    const wb = 0.035 + 0.02 * fbm3(b * 5, 1, 2, { octaves: 2, seed: 8 });
    const bands = [
      [1, mix('#8a6f55', '#8a6f55', 0)],
      [0.45, scorch],
      [0.18, gold],
      [0, high]
    ];
    for (let q = 0; q < bands.length - 1; q += 1) {
      const [f0, c0] = bands[q];
      const [f1, c1] = bands[q + 1];
      paint.quad(ring(ra - wa * f0, a), ring(rb - wb * f0, b), ring(rb - wb * f1, b), ring(ra - wa * f1, a), c0, c0, c1, c1);
    }
    // Side: gold at the top, scorched below.
    paint.quad(ring(ra, a, TOP + 0.0008), ring(rb, b, TOP + 0.0008), ring(rb * 0.995, b, TOP * 0.55), ring(ra * 0.995, a, TOP * 0.55), gold, gold, scorch, scorch);
    paint.quad(ring(ra * 0.995, a, TOP * 0.55), ring(rb * 0.995, b, TOP * 0.55), ring(rb * 0.985, b, 0), ring(ra * 0.985, a, 0), scorch, scorch, col('#160d08'), col('#160d08'));
    paint.tri([0, 0, 0], ring(ra * 0.985, a, 0), ring(rb * 0.985, b, 0), col('#120a06'));
  }
  return paint.geometry();
}

// ---------------------------------------------------------------- the tub

function tubGeometry() {
  const N = 112;
  const rows = [];
  for (let k = 0; k <= 4; k += 1) rows.push({ y: YB, f: Math.max(0.02, k / 4), part: 'under' });
  for (let k = 1; k <= 16; k += 1) rows.push({ y: YB + ((YC - YB) * k) / 16, f: 1, part: 'outer' });
  for (let k = 1; k <= 10; k += 1) rows.push({ phi: (Math.PI * k) / 10, part: 'lip' });
  for (let k = 1; k <= 16; k += 1) {
    const s = k / 16;
    rows.push({ y: YC - (YC - YIB) * (1 - (1 - s) ** 1.3), f: 1, part: 'inner' });
  }
  for (let k = 1; k <= 4; k += 1) rows.push({ y: YIB, f: Math.max(0.02, 1 - k / 4), part: 'floor' });
  return grid(rows.length - 1, N, (i, j) => {
    const th = (j / N) * TAU;
    const row = rows[i];
    let x;
    let z;
    let y;
    if (row.part === 'lip') {
      const o = outerAt(YC);
      const d = RR - RR * Math.cos(row.phi);
      y = YC + RR * Math.sin(row.phi);
      [x, z] = outline(th, { rx: o.rx - d, rz: o.rz - d, cx: o.cx });
    } else {
      y = row.y;
      const o = row.part === 'inner' || row.part === 'floor' ? innerAt(y) : outerAt(y);
      [x, z] = outline(th, o, row.f);
    }
    const n = fbm3(x * 3, y * 3, z * 3, { octaves: 2, seed: 70 });
    let c;
    if (row.part === 'under') c = col('#9c978e');
    else if (row.part === 'outer') {
      const s = smooth(YB, YC, y);
      c = mix('#bdb7ac', '#f3efe7', 0.25 + 0.75 * s);
      // Warm floor bounce low down, cool rim light high on the back curve.
      c.lerp(col('#f1d9b4'), 0.25 * (1 - s));
      c.lerp(col('#d4e7f2'), smooth(0.4, 0.85, s) * smooth(0, -0.9, Math.sin(th)) * 0.5);
    } else if (row.part === 'lip') c = mix('#eaf4fa', '#ffffff', Math.sin(row.phi));
    else {
      const wet = smooth(PLANE + 0.03, PLANE - 0.005, y);
      c = mix('#e4ebee', '#b9d3d6', wet);
    }
    c.multiplyScalar(0.97 + 0.06 * n);
    return { p: [x, y, z], c };
  });
}

function footGeometry(fx, fz) {
  const sx = Math.sign(fx);
  const sz = Math.sign(fz);
  const paw = [fx + sx * 0.06, TOP + 0.03, fz + sz * 0.05];
  const leg = taperTube(
    [
      [fx, YB + 0.03, fz],
      [fx + sx * 0.015, YB - 0.03, fz + sz * 0.012],
      [fx + sx * 0.035, TOP + 0.08, fz + sz * 0.03],
      [paw[0] - sx * 0.005, paw[1] + 0.02, paw[2] - sz * 0.004]
    ],
    0.034,
    0.02,
    10,
    16
  );
  const parts = [leg, xf(new SphereGeometry(0.045, 14, 10), { s: [1, 0.55, 1], at: [fx, YB + 0.01, fz] }), xf(new SphereGeometry(0.03, 14, 10), { at: paw })];
  for (let k = -1; k <= 1; k += 1) {
    const a = Math.atan2(sz, sx) + k * 0.6;
    const claw = xf(new SphereGeometry(1, 10, 8), { s: [0.032, 0.013, 0.013], ry: -a, at: [paw[0] + 0.022 * Math.cos(a), TOP + 0.012, paw[2] + 0.022 * Math.sin(a)] });
    parts.push(claw);
  }
  return mergeGeometries(parts.map((g) => prep(g, '#c39a52')));
}

function tapsGeometry() {
  const chrome = '#cfd4d8';
  const parts = [];
  const tx = -0.801;
  // Lighthouse tower: red and white bands.
  const tower = new CylinderGeometry(0.019, 0.026, 0.13, 20, 10);
  tower.translate(tx, RIM + 0.065, 0);
  parts.push(prep(tower, (x, y) => (Math.floor((y - RIM) / 0.0325) % 2 === 0 ? col('#c8443a') : col('#f6f1e6'))));
  parts.push(prep(xf(new CylinderGeometry(0.031, 0.031, 0.006, 20), { at: [tx, RIM + 0.133, 0] }), '#2c2a2a'));
  parts.push(prep(xf(new ConeGeometry(0.025, 0.028, 20), { at: [tx, RIM + 0.181, 0] }), '#a8322b'));
  parts.push(prep(xf(new SphereGeometry(0.006, 8, 6), { at: [tx, RIM + 0.198, 0] }), '#2c2a2a'));
  // Spout from the tower's flank out over the water.
  parts.push(
    prep(
      taperTube(
        [
          [tx, RIM + 0.085, 0],
          [tx + 0.05, RIM + 0.1, 0],
          [tx + 0.1, RIM + 0.08, 0],
          [tx + 0.118, RIM + 0.055, 0]
        ],
        0.011,
        0.008
      ),
      chrome
    )
  );
  // Pillar taps with cross handles.
  for (const [z, cap] of [
    [0.088, '#c0453c'],
    [-0.088, '#3d6fa8']
  ]) {
    parts.push(prep(xf(new CylinderGeometry(0.014, 0.019, 0.065, 14), { at: [tx, RIM + 0.0325, z] }), chrome));
    for (const r of [Math.PI / 4, -Math.PI / 4]) parts.push(prep(xf(new BoxGeometry(0.075, 0.008, 0.011), { ry: r, at: [tx, RIM + 0.07, z] }), chrome));
    for (let k = 0; k < 4; k += 1) {
      const a = Math.PI / 4 + (k * Math.PI) / 2;
      parts.push(prep(xf(new SphereGeometry(0.008, 8, 6), { at: [tx + 0.037 * Math.cos(a), RIM + 0.07, z + 0.037 * Math.sin(a)] }), chrome));
    }
    parts.push(prep(xf(new CylinderGeometry(0.009, 0.009, 0.006, 12), { at: [tx, RIM + 0.077, z] }), cap));
  }
  // The shower riser stands on the floor behind the tap end; a feed pipe joins it to the tower.
  const rx = -0.93;
  const rz = -0.2;
  parts.push(prep(xf(new CylinderGeometry(0.014, 0.014, 1.6 - TOP, 14), { at: [rx, (1.6 + TOP) / 2, rz] }), chrome));
  parts.push(prep(xf(new CylinderGeometry(0.03, 0.04, 0.02, 16), { at: [rx, TOP + 0.01, rz] }), chrome));
  parts.push(
    prep(
      taperTube(
        [
          [rx, RIM + 0.06, rz],
          [rx + 0.06, RIM + 0.06, rz + 0.11],
          [tx, RIM + 0.06, 0]
        ],
        0.011,
        0.011,
        10,
        12
      ),
      chrome
    )
  );
  parts.push(
    prep(
      taperTube(
        [
          [rx, 1.58, rz],
          [rx + 0.01, 1.66, rz + 0.03],
          [rx + 0.12, 1.69, rz + 0.07],
          [-0.55, 1.67, -0.05],
          [-0.44, 1.62, -0.02],
          [-0.42, 1.59, -0.02]
        ],
        0.013,
        0.012,
        10,
        30
      ),
      chrome
    )
  );
  parts.push(prep(xf(new ConeGeometry(0.1, 0.035, 28, 1, true), { rx: Math.PI, at: [-0.42, 1.575, -0.02] }), chrome));
  parts.push(prep(xf(new CylinderGeometry(0.1, 0.1, 0.006, 28), { at: [-0.42, 1.556, -0.02] }), '#9aa1a8'));
  // Plug chain, from the overflow on the end wall down into the sea.
  for (let k = 0; k < 9; k += 1) {
    const s = k / 8;
    const p = [-0.745 + 0.075 * s, RIM - 0.045 - 0.06 * s - 0.03 * Math.sin(Math.PI * s), -0.06 + 0.02 * s];
    parts.push(prep(xf(new TorusGeometry(0.008, 0.0025, 6, 12), { ry: k % 2 ? Math.PI / 2 : 0, rz: 0.8, at: p }), chrome));
  }
  parts.push(prep(xf(new CylinderGeometry(0.02, 0.02, 0.008, 16), { rz: Math.PI / 2, at: [-0.752, RIM - 0.045, -0.06] }), chrome));
  return mergeGeometries(parts);
}

function cloudPuffs(random) {
  const C = [-0.33, 1.31, -0.01];
  const puffs = [];
  for (let k = 0; k < 30; k += 1) {
    let u;
    let v;
    let w;
    do {
      u = random() * 2 - 1;
      v = random() * 2 - 1;
      w = random() * 2 - 1;
    } while (u * u + v * v + w * w > 1);
    const r = (0.085 + 0.08 * random()) * (1 - 0.35 * Math.abs(u));
    puffs.push({ p: [C[0] + u * 0.44, C[1] + v * 0.1 + 0.03, C[2] + w * 0.24], r });
  }
  return { C, puffs };
}

function cloudGeometry({ C, puffs }, colorFn) {
  const parts = puffs.map(({ p, r }, k) => {
    const g = new IcosahedronGeometry(1, 3);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i += 1) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const n = fbm3(x * 2 + k, y * 2, z * 2, { octaves: 3, seed: 80 + k });
      const rr = r * (0.82 + 0.36 * n);
      let py = p[1] + y * rr;
      // A flat, lumpy base: storm clouds sit on their own level.
      const floor = C[1] - 0.15 + 0.025 * fbm3(p[0] + x * r, 0, p[2] + z * r, { seed: 9 });
      if (py < floor) py = floor - (floor - py) * 0.15;
      pos.setXYZ(i, p[0] + x * rr, py, p[2] + z * rr);
    }
    g.computeVertexNormals();
    return prep(g, colorFn);
  });
  return mergeGeometries(parts);
}

function boltPoints(top, end, random) {
  const pts = [top];
  const n = 7;
  for (let k = 1; k < n; k += 1) {
    const s = k / n;
    const j = 0.055 * (1 - s * 0.5);
    pts.push([top[0] + (end[0] - top[0]) * s + (random() * 2 - 1) * j, top[1] + (end[1] - top[1]) * s, top[2] + (end[2] - top[2]) * s + (random() * 2 - 1) * j]);
  }
  pts.push(end);
  return pts;
}

function ribbon(paint, pts, width, c) {
  for (let k = 0; k < pts.length - 1; k += 1) {
    const a = pts[k];
    const b = pts[k + 1];
    const w = width * (1 - (0.5 * k) / pts.length);
    paint.quad([a[0] - w, a[1], a[2]], [a[0] + w, a[1], a[2]], [b[0] + w, b[1], b[2]], [b[0] - w, b[1], b[2]], c);
    paint.quad([a[0], a[1], a[2] - w], [a[0], a[1], a[2] + w], [b[0], b[1], b[2] + w], [b[0], b[1], b[2] - w], c);
    // Joints: small diamonds so the zigzag has no gaps.
    paint.quad([b[0] - w, b[1], b[2]], [b[0], b[1] + w, b[2]], [b[0] + w, b[1], b[2]], [b[0], b[1] - w, b[2]], c);
  }
}

function boltGeometry(top, end, seed, width) {
  const random = rng(seed);
  const main = boltPoints(top, end, random);
  const fork = boltPoints(main[2], [main[2][0] + 0.12, main[2][1] - 0.28, main[2][2] + 0.06], random).slice(0, 5);
  const paint = new Paint();
  ribbon(paint, main, width, col('#f7f4ff'));
  ribbon(paint, fork, width * 0.6, col('#e6e2ff'));
  return { geometry: paint.geometry(), points: [...main, ...fork] };
}

function rainGeometry(random) {
  const paint = new Paint();
  const S = RAIN_S;
  const c = col('#a9c8d2');
  let made = 0;
  while (made < 55) {
    const x = -0.72 + random() * 0.82;
    const z = (random() * 2 - 1) * 0.24;
    if (!insideTub(x, PLANE, z, 0.03)) continue;
    if (Math.hypot((x + 0.33) / 0.48, z / 0.27) > 1) continue;
    made += 1;
    const len = 0.07 + 0.06 * random();
    for (let y = RAIN_LO + random() * S; y + len < RAIN_HI + S; y += S) {
      const w = 0.0018;
      paint.quad([x - w, y, z], [x + w, y, z], [x + w, y + len, z], [x - w, y + len, z], c);
      paint.quad([x, y, z - w], [x, y, z + w], [x, y + len, z + w], [x, y + len, z - w], c);
    }
  }
  return paint.geometry();
}
const RAIN_S = 0.25;
const RAIN_LO = 0.48;
const RAIN_HI = 1.15;
const RAIN_P = 0.125;

function boatGeometry() {
  // A big folded paper boat, 24 cm: flat paper tones per face so every fold is crisp.
  const paint = new Paint();
  const tone = {
    front: col('#fffdf7'),
    back: col('#e3ddcf'),
    end: col('#d2c9b6'),
    keel: col('#bdb4a1'),
    sailLit: col('#ffffff'),
    sailHalf: col('#ece6d8'),
    sailBack: col('#d9d2c2'),
    flap: col('#f3eee2')
  };
  const L = 0.12;
  const B = 0.068;
  const W = 0.046;
  const yb = -0.018;
  const yt = 0.042;
  for (const s of [1, -1]) {
    const side = s > 0 ? tone.front : tone.back;
    const top = [
      [-L, yt, 0],
      [-0.06, yt, W * s],
      [0.06, yt, W * s],
      [L, yt, 0]
    ];
    const bot = [
      [-B, yb, 0.012 * s],
      [B, yb, 0.012 * s]
    ];
    paint.quad(bot[0], bot[1], top[2], top[1], side);
    paint.tri(bot[0], top[1], top[0], s > 0 ? tone.flap : tone.back);
    paint.tri(bot[1], top[3], top[2], s > 0 ? tone.flap : tone.back);
    paint.tri(top[0], bot[0], [-B, yb, 0], tone.end);
    paint.tri(top[3], bot[1], [B, yb, 0], tone.end);
    // The sail, the folded hat: a crease down its middle, one half in light.
    const z = 0.006 * s;
    const apex = [0, 0.135, 0];
    const mid = [0, yt, z];
    if (s > 0) {
      paint.tri([-0.07, yt, z], mid, apex, tone.sailLit);
      paint.tri(mid, [0.07, yt, z], apex, tone.sailHalf);
    } else {
      paint.tri([-0.07, yt, z], [0.07, yt, z], apex, tone.sailBack);
    }
  }
  paint.quad([-B, yb, -0.012], [B, yb, -0.012], [B, yb, 0.012], [-B, yb, 0.012], tone.keel);
  // A thin rim of shadow along the gunwale, so the hull and sail separate.
  const rim = new Paint();
  for (const s of [1, -1]) {
    const pts = [[-L, yt, 0], [-0.06, yt, W * s], [0.06, yt, W * s], [L, yt, 0]];
    for (let k = 0; k < 3; k += 1) {
      const a = pts[k];
      const b = pts[k + 1];
      rim.quad([a[0], a[1] - 0.003, a[2]], [b[0], b[1] - 0.003, b[2]], [b[0], b[1] + 0.0015, b[2]], [a[0], a[1] + 0.0015, a[2]], col('#b8ae9a'));
    }
  }
  const mast = prep(xf(new CylinderGeometry(0.003, 0.003, 0.05, 6), { at: [0, 0.155, 0] }), '#7a5434');
  const flag = new Paint();
  flag.tri([0, 0.178, 0], [0, 0.152, 0], [0.05, 0.165, 0.005], col('#e0483a'));
  return mergeGeometries([prep(paint.geometry()), prep(rim.geometry()), mast, prep(flag.geometry())]);
}

function duckGeometry() {
  const yellow = '#f5c518';
  const parts = [
    prep(xf(new SphereGeometry(1, 20, 14), { s: [0.056, 0.036, 0.042], at: [0, 0.028, 0] }), yellow),
    prep(xf(new SphereGeometry(1, 14, 10), { s: [0.022, 0.02, 0.025], rz: 0.7, at: [-0.048, 0.048, 0] }), yellow),
    prep(xf(new SphereGeometry(0.03, 18, 14), { at: [0.03, 0.082, 0] }), yellow),
    prep(xf(new SphereGeometry(1, 14, 10), { s: [0.022, 0.0075, 0.017], at: [0.062, 0.076, 0] }), '#f08a24')
  ];
  for (const s of [1, -1]) {
    parts.push(prep(xf(new SphereGeometry(0.0055, 8, 6), { at: [0.052, 0.093, 0.018 * s] }), '#1a1410'));
    parts.push(prep(xf(new SphereGeometry(1, 12, 8), { s: [0.03, 0.016, 0.01], rz: 0.25, at: [-0.005, 0.042, 0.036 * s] }), '#e8b412'));
  }
  return mergeGeometries(parts);
}

function tentacleSegment(len, r0, r1, tip) {
  // A gently bent tapered tube (it carries part of the curl itself), so the
  // jointed tentacle reads as one smooth spiral rather than straight pipes.
  const bend = 0.18;
  const pts = [0, 0.33, 0.66, 1].map((s) => [-Math.sin(bend * s) * len * 0.5 * s, s * len, 0]);
  const end = tip ? Math.max(0.002, r0 * 0.15) : r1;
  const skinGeometry = taperTube(pts, r0, end, 14, 10);
  const parts = [skinGeometry, xf(new SphereGeometry(r0, 14, 10), { at: [0, 0, 0] })];
  if (tip) parts.push(xf(new SphereGeometry(end, 8, 6), { at: pts[3] }));
  const skin = parts.map((p) =>
    prep(p, (x, y, z, nx) => {
      const belly = smooth(-0.15, 0.75, nx);
      const n = fbm3(x * 40, y * 40, z * 40, { octaves: 2, seed: 33 });
      const c = mix('#c4566c', '#f8ab92', belly);
      c.lerp(col('#fbe2cc'), smooth(0.65, 0.95, nx) * 0.7);
      return c.multiplyScalar(0.9 + 0.2 * n);
    })
  );
  // Two rows of suckers down the belly (+X), large near the base, small at the tip.
  const count = Math.max(2, Math.round(len / 0.024));
  for (let k = 0; k < count; k += 1) {
    const s = (k + 0.5) / count;
    const r = r0 + (end - r0) * s;
    const sr = Math.max(0.004, r * 0.3);
    const cx = -Math.sin(bend * s) * len * 0.5 * s;
    for (const side of [-0.55, 0.55]) {
      const at = [cx + r * 0.95 * Math.cos(side), s * len, r * 0.95 * Math.sin(side)];
      skin.push(prep(xf(new SphereGeometry(1, 8, 5), { s: [sr * 0.4, sr, sr], ry: -side, at }), '#fff0e2'));
      skin.push(prep(xf(new SphereGeometry(1, 6, 4), { s: [sr * 0.2, sr * 0.45, sr * 0.45], ry: -side, at: [at[0] + sr * 0.3 * Math.cos(side), at[1], at[2] + sr * 0.3 * Math.sin(side)] }), '#d9a596'));
    }
  }
  return mergeGeometries(skin);
}

// ---------------------------------------------------------------- the kraken's motion

const TENTACLES = [
  { base: [-0.63, -0.04], yaw: -1.2, s: 1.15, curl: [-0.05, -0.3, -0.45, -0.6, -0.8], twist: 0.18, ph: 0.0 },
  { base: [-0.5, -0.11], yaw: -1.6, s: 1.0, curl: [-0.08, -0.3, -0.5, -0.65, -0.8], twist: -0.2, ph: 1.7 },
  { base: [-0.56, 0.06], yaw: -1.0, s: 1.15, curl: [-0.04, -0.15, -0.25, -0.4, -0.75], twist: 0.12, ph: 3.1, plug: true },
  { base: [-0.4, 0.0], yaw: -1.9, s: 0.9, curl: [-0.12, -0.35, -0.55, -0.7, -0.9], twist: 0.25, ph: 4.4 }
];
const SEG_LEN = [0.085, 0.075, 0.065, 0.055, 0.05];
const SEG_R = [0.04, 0.033, 0.026, 0.019, 0.012, 0];
const NSEG = SEG_LEN.length;
const WR = (TAU * 4) / LOOP;
const WS = (TAU * 2) / LOOP;

function tentacleRot(tn, k, t) {
  const f = k / (NSEG - 1);
  const a = tn.curl[k] + (0.08 + 0.22 * f) * Math.sin(WR * t + tn.ph + k * 0.7);
  // The twist grows toward the tip, so the curl winds out of its plane: a spiral.
  const sway = tn.twist * (0.4 + f) + 0.1 * Math.sin(WS * t + tn.ph * 1.3 + k * 0.6);
  const parts = [quat([0, 0, 1], a), quat([1, 0, 0], sway)];
  if (k === 0) parts.unshift(quat([0, 1, 0], tn.yaw + 0.15 * Math.sin(WS * t + tn.ph)));
  return quatMul(...parts);
}

// ---------------------------------------------------------------- sound

function sound() {
  const SR = SAMPLE_RATE;
  const out = audioTrack(LOOP);
  const len = out.length;
  const rain = audioTrack(LOOP);
  const r1 = noise(11);
  for (let i = 0; i < len; i += 1) rain[i] = r1();
  lowpass(rain, 1300);
  lowpass(rain, 1800);
  normalize(rain, 0.16);
  for (let i = 0; i < len; i += 1) out[i] += rain[i] * (0.85 + 0.15 * Math.sin((TAU * 2 * i) / len));

  // Thunder: low noise, a soft crack and a long roll, just after each flash.
  LIGHTNING.forEach((at, k) => {
    const seconds = 3.6;
    const buf = new Float32Array(Math.round(seconds * SR));
    const r = noise(31 + k);
    for (let i = 0; i < buf.length; i += 1) buf[i] = r();
    lowpass(buf, 160);
    lowpass(buf, 120);
    normalize(buf, 1);
    const env = (t) => (t < 0.06 ? t / 0.06 : 1) * Math.exp(-t / 1.25) * (0.55 + 0.45 * Math.sin(TAU * 0.9 * t + k) ** 2) * (t > seconds - 0.4 ? (seconds - t) / 0.4 : 1);
    add(out, at + 0.35, seconds, (t) => buf[Math.min(buf.length - 1, Math.floor(t * SR))], (t) => 0.62 * env(t));
  });

  // Creaks of a wet paper boat climbing waves: low, rough, short.
  for (const [at, gain] of [
    [1.0, 0.07],
    [3.1, 0.06],
    [5.0, 0.07],
    [7.2, 0.06],
    [SWAMP - 0.15, 0.1],
    [11.1, 0.06],
    [13.0, 0.07],
    [15.1, 0.06]
  ]) {
    add(
      out,
      at,
      0.4,
      (t) => Math.sin(TAU * (150 * t + 40 * t * t)) * (0.5 + 0.5 * Math.sin(TAU * 26 * t)) ** 3,
      (t) => gain * swell(0.4)(t)
    );
  }
  // A drip plink as each drop lands.
  for (const at of DRIPS) {
    const hit = at + DRIP_FORM + DRIP_FALL;
    add(out, hit, 0.35, (t) => Math.sin(TAU * (700 * t + 1400 * t * t)), (t) => 0.16 * pluck(0.002, 0.06)(t));
    add(out, hit, 0.3, (t) => Math.sin(TAU * 260 * t), (t) => 0.05 * pluck(0.004, 0.08)(t));
  }
  // One faint rubber-duck squeak after the second thunder.
  const squeak = (t) => {
    const f = 950 + 300 * Math.sin(Math.PI * clamp(t / 0.24)) + 25 * Math.sin(TAU * 30 * t);
    return Math.sin(TAU * f * t) + 0.25 * Math.sin(TAU * 2 * f * t);
  };
  add(out, 14.7, 0.24, squeak, (t) => 0.05 * swell(0.24)(t));
  return toWav(normalize(out, 0.7));
}

const DRIPS = [1.2, 5.2, 9.2, 13.2];
const DRIP_FORM = 0.6;
const DRIP_FALL = 0.17;
const NOZZLE = [-0.801 + 0.118, RIM + 0.047, 0];

// ---------------------------------------------------------------- the scene

export async function build() {
  const glb = new Glb();
  glb.provenance({
    holoim: {
      authored: 'synthetic',
      author: meta.submittedBy,
      title: meta.name,
      scale: 'true size',
      loopSeconds: LOOP,
      facts: { tubLengthM: 1.65, tubWidthM: 0.78, rimHeightM: RIM, duckLengthM: 0.11, paperBoatLengthM: 0.16 }
    }
  });
  const random = rng(20261110);
  const root = glb.node({ name: 'SeaInTheBathtub', rotation: quat([0, 1, 0], YAW) });
  const M = {
    paint: glb.material({ name: 'Painted', unlit: true, doubleSided: true }),
    enamel: glb.material({ name: 'Enamel', roughness: 0.32, doubleSided: true }),
    solid: glb.material({ name: 'Matte', roughness: 0.85, doubleSided: true }),
    brass: glb.material({ name: 'Brass', roughness: 0.4, metallic: 0.25, doubleSided: true }),
    skin: glb.material({ name: 'KrakenSkin', roughness: 0.45, doubleSided: true }),
    beam: glb.material({ name: 'Beam', color: '#ffe48f', opacity: 0.42, unlit: true, doubleSided: true }),
    glow: glb.material({ name: 'LampGlow', color: '#ffc46a', opacity: 0.32, unlit: true }),
    lantern: glb.material({ name: 'LanternGlow', color: '#ffc350', opacity: 0.45, unlit: true }),
    pool: glb.material({ name: 'LanternPool', color: '#ffae3d', opacity: 0.3, unlit: true }),
    flashGlow: glb.material({ name: 'BoltGlow', color: '#cfcaff', opacity: 0.45, unlit: true, doubleSided: true })
  };
  const unlitMaterials = new Set([M.paint, M.beam, M.glow, M.lantern, M.pool, M.flashGlow]);
  const mesh = (name, geometry, material) => glb.mesh(name, compact(geometry, unlitMaterials.has(material)), material);
  const staticNode = (name, geometry, material) => glb.node({ name, mesh: mesh(name, geometry, material), parent: root });
  const warnings = [];

  // --- Static: floor, tub, feet, taps, stool, mat, slippers, sea floor plane, foam.
  staticNode('floor-tiles', floorGeometry(), M.paint);
  staticNode('tub-enamel', prep(tubGeometry()), M.enamel);
  const feet = [];
  for (const sx of [1, -1]) for (const sz of [1, -1]) feet.push(footGeometry(-0.06 + sx * 0.5, sz * 0.19));
  staticNode('tub-feet', mergeGeometries(feet), M.brass);
  staticNode('tub-taps', tapsGeometry(), M.enamel);
  staticNode('sea-plane', prep(waterGeometry()), M.paint);
  staticNode('sea-foam', foamPiles(random), M.paint);

  const room = [];
  // Low wooden stool with a folded towel and a bar of soap.
  const stoolAt = [0.93, 0.36];
  const stoolYaw = 0.35;
  const onStool = (g) => xf(g, { ry: stoolYaw, at: [stoolAt[0], 0, stoolAt[1]] });
  room.push(onStool(prep(xf(new BoxGeometry(0.3, 0.028, 0.22), { at: [0, 0.255, 0] }), '#a8714a')));
  for (const [lx, lz] of [
    [0.12, 0.085],
    [-0.12, 0.085],
    [0.12, -0.085],
    [-0.12, -0.085]
  ]) {
    room.push(onStool(prep(taperTube([[lx * 0.85, 0.245, lz * 0.85], [lx, TOP, lz]], 0.014, 0.011, 8, 2), '#8e5d3b')));
  }
  room.push(onStool(prep(xf(new BoxGeometry(0.25, 0.032, 0.18), { at: [0.01, 0.285, 0] }), '#e48f7a')));
  room.push(onStool(prep(xf(new BoxGeometry(0.235, 0.03, 0.17), { at: [0.005, 0.316, 0.004] }), '#ee9f88')));
  room.push(onStool(prep(xf(new BoxGeometry(0.252, 0.012, 0.035), { at: [0.01, 0.302, 0.05] }), '#f6e6cf')));
  room.push(onStool(prep(xf(new SphereGeometry(1, 16, 10), { s: [0.045, 0.017, 0.03], at: [0.02, 0.344, -0.01] }), '#d8c6ef')));
  // Bath mat and a pair of very small slippers.
  const mat = new CylinderGeometry(1, 1, 1, 48, 1);
  {
    const pos = mat.attributes.position;
    for (let i = 0; i < pos.count; i += 1) {
      const a = Math.atan2(pos.getZ(i), pos.getX(i));
      const r = Math.hypot(pos.getX(i), pos.getZ(i));
      const [x, z] = outline(a, { rx: 0.32, rz: 0.17, cx: 0 }, r);
      pos.setXYZ(i, x, pos.getY(i), z);
    }
  }
  room.push(prep(xf(mat, { s: [1, 0.014, 1], at: [-0.12, TOP + 0.007, 0.565] }), (x, y, z) => (Math.hypot((x + 0.12) / 0.32, (z - 0.565) / 0.17) > 0.84 ? col('#7fa9b8') : col('#a9cdd6'))));
  for (const [sx, sz, sa] of [
    [0.06, 0.53, 0.25],
    [0.12, 0.6, 0.1]
  ]) {
    const slipper = [
      xf(new SphereGeometry(1, 16, 8), { s: [0.066, 0.008, 0.028], at: [0, 0.008, 0] }),
      xf(new SphereGeometry(1, 16, 10, 0, TAU, 0, Math.PI / 2), { s: [0.04, 0.03, 0.03], at: [0.025, 0.012, 0] }),
      xf(new SphereGeometry(0.013, 10, 8), { at: [0.05, 0.036, 0] })
    ].map((g, k) => prep(g, k === 2 ? '#fff4f0' : '#ef9fb0'));
    room.push(xf(mergeGeometries(slipper), { ry: sa + Math.PI / 2, at: [sx, TOP + 0.014, sz] }));
  }
  staticNode('room', mergeGeometries(room), M.solid);

  // --- The swell: crest pieces whose phase is set by where they sit.
  const crestShapes = [0, 1, 2, 3, 4, 5].map((k) => mesh(`sea-crest-${k}`, crestGeometry(10 + k * 7), M.paint));
  const crestVerts = [0, 1, 2, 3, 4, 5].map((k) => crestGeometry(10 + k * 7).attributes.position);
  const boatHome = [-0.02, 0.1];
  const duckHome = [0.38, -0.07];
  let crests = 0;
  const v = new Vector3();
  const q = new Quaternion();
  const fits = (shape, x, z, scale, pos, rot) => {
    const verts = crestVerts[shape];
    for (let s = 0; s < 24; s += 1) {
      const t = (s / 24) * (LOOP / 8);
      const [px, py, pz] = pos(t);
      q.set(...rot(t));
      for (let i = 0; i < verts.count; i += 1) {
        v.fromBufferAttribute(verts, i).multiply(new Vector3(...scale)).applyQuaternion(q);
        if (!insideTub(px + v.x, py + v.y, pz + v.z, 0.005)) return false;
      }
    }
    return true;
  };
  for (let ix = 0; ix < 18; ix += 1) {
    for (let iz = 0; iz < 4; iz += 1) {
      let x = -0.7 + ix * 0.066 + (random() - 0.5) * 0.03;
      let z = -0.225 + iz * 0.15 + (random() - 0.5) * 0.04 + (ix % 2) * 0.05 - 0.025;
      let sx = 0.11 + 0.03 * random();
      let sz = 0.15 + 0.04 * random();
      const shape = Math.floor(random() * 6);
      const lift = 0.85 + 0.3 * random();
      if (x > 0.47) continue;
      if (Math.hypot((x - boatHome[0]) / 0.17, (z - boatHome[1]) / 0.11) < 1) continue;
      if (Math.hypot((x - duckHome[0]) / 0.09, (z - duckHome[1]) / 0.08) < 1) continue;
      // Nothing may poke through the enamel: test every vertex over one wave period,
      // and pull a piece in from the wall (smaller, nearer the middle) until it fits.
      let placed = null;
      for (let attempt = 0; attempt < 8 && !placed; attempt += 1) {
        const px = x;
        const pz = z;
        const amp = stormAmp(px) * lift;
        const pos = (t) => [px, PLANE - 0.02 - amp * (1 - crest(phaseAt(px, pz, t))), pz];
        const rot = (t) => {
          const p = phaseAt(px, pz, t);
          return quatMul(quat([0, 0, 1], -0.2 * Math.cos(p) * (amp / 0.075)), quat([1, 0, 0], 0.04 * Math.sin(p + pz * 5)));
        };
        const scale = [sx, amp, sz];
        if (fits(shape, px, pz, scale, pos, rot)) placed = { pos, rot, scale };
        sx *= 0.92;
        sz *= 0.86;
        z *= 0.9;
        x *= 0.97;
      }
      if (!placed || crests >= 70) continue;
      const node = glb.node({ name: `sea-crest-${crests}`, mesh: crestShapes[shape], translation: placed.pos(0), rotation: placed.rot(0), scale: placed.scale, parent: root });
      glb.animate(node, 'translation', TIMES, vecKeys(placed.pos));
      glb.animate(node, 'rotation', TIMES, quatKeys(placed.rot));
      crests += 1;
    }
  }

  // --- The paper boat: heave, pitch and roll on the same swell; nearly swamped at t = 9.
  const boatX = (t) => boatHome[0] + 0.03 * Math.sin((TAU * t) / LOOP);
  const boatZ = (t) => boatHome[1] + 0.035 * Math.sin((TAU * 2 * t) / LOOP + 0.8);
  const swamp = (t) => bump(t, SWAMP, 0.32);
  const boat = glb.node({ name: 'paper-boat', translation: [boatHome[0], PLANE, boatHome[1]], parent: root });
  glb.animate(boat, 'translation', TIMES, vecKeys((t) => [boatX(t), seaY(boatX(t), boatZ(t), t) - 0.034 * swamp(t), boatZ(t)]));
  glb.animate(
    boat,
    'rotation',
    TIMES,
    quatKeys((t) => {
      const x = boatX(t);
      const z = boatZ(t);
      const pitch = Math.atan(seaSlope(x, z, t)) * 0.9 + 0.35 * swamp(t);
      const roll = 0.12 * Math.sin(WW * t * 0.5 + 0.4) + 0.3 * swamp(t);
      return quatMul(quat([0, 1, 0], 0.08 * Math.sin((TAU * t) / LOOP)), quat([0, 0, 1], pitch), quat([1, 0, 0], roll));
    })
  );
  glb.node({ name: 'paper-boat-hull', mesh: mesh('paper-boat-hull', boatGeometry(), M.paint), parent: boat });
  const lanternAt = [0.0, 0.19, 0];
  glb.node({ name: 'paper-boat-lantern', mesh: mesh('paper-boat-lantern', prep(xf(new SphereGeometry(0.018, 14, 10), { s: [1, 1.2, 1] }), '#ffd770'), M.paint), translation: lanternAt, parent: boat });
  glb.node({ name: 'paper-boat-lantern-glow', mesh: mesh('paper-boat-lantern-glow', new SphereGeometry(0.06, 18, 12), M.lantern), translation: lanternAt, parent: boat });
  glb.node({ name: 'paper-boat-pool', mesh: mesh('paper-boat-pool', new CylinderGeometry(0.19, 0.19, 0.001, 40), M.pool), translation: [0, 0.004, 0], parent: boat });
  glb.node({ name: 'paper-boat-pool-core', mesh: mesh('paper-boat-pool-core', new CylinderGeometry(0.1, 0.1, 0.001, 32), M.pool), translation: [0, 0.007, 0], parent: boat });
  // Spray over the boat as it ships the big wave.
  const sprayAt = [boatX(SWAMP), seaY(boatX(SWAMP), boatZ(SWAMP), SWAMP), boatZ(SWAMP)];
  const sprayParts = [];
  for (let k = 0; k < 9; k += 1) {
    const a = (k / 9) * TAU + random();
    const r = 0.05 + 0.04 * random();
    sprayParts.push(xf(new IcosahedronGeometry(1, 1), { s: [0.022, 0.03 + 0.03 * random(), 0.022], at: [r * Math.cos(a) - 0.04, 0.02 + 0.03 * random(), r * Math.sin(a)] }));
  }
  const spray = glb.node({ name: 'sea-spray', mesh: mesh('sea-spray', mergeGeometries(sprayParts.map((g) => prep(g, '#eef7f5'))), M.paint), translation: sprayAt, scale: HIDDEN, parent: root });
  glb.animate(spray, 'scale', TIMES, vecKeys((t) => {
    const k = bump(t, SWAMP + 0.05, 0.22);
    return k < 0.03 ? HIDDEN : [k, k * (0.6 + 0.8 * k), k];
  }));

  // --- The rubber duck: true size, unbothered, slowly turning at the calm end.
  const duck = glb.node({ name: 'rubber-duck', translation: [duckHome[0], PLANE, duckHome[1]], parent: root });
  glb.animate(duck, 'translation', TIMES, vecKeys((t) => [duckHome[0], seaY(duckHome[0], duckHome[1], t) - 0.012, duckHome[1]]));
  glb.animate(duck, 'rotation', TIMES, quatKeys((t) => quatMul(quat([0, 1, 0], 2.4 - (TAU * t) / LOOP), quat([0, 0, 1], Math.atan(seaSlope(duckHome[0], duckHome[1], t)) * 0.7))));
  glb.node({ name: 'rubber-duck-body', mesh: mesh('rubber-duck-body', duckGeometry(), M.solid), parent: duck });

  // --- The kraken: four tentacles of five jointed, curving segments; one holds the plug on its chain.
  const segMeshes = SEG_LEN.map((len, k) => mesh(`kraken-seg-${k}`, tentacleSegment(len, SEG_R[k], SEG_R[k + 1], k === NSEG - 1), M.skin));
  const chrome = '#d6dade';
  const plugMesh = mesh(
    'kraken-plug',
    mergeGeometries([
      prep(xf(new CylinderGeometry(0.032, 0.026, 0.022, 20), { at: [0, 0, 0] }), '#232326'),
      prep(xf(new TorusGeometry(0.009, 0.003, 6, 12), { ry: Math.PI / 2, at: [0, 0.018, 0] }), chrome),
      ...[0, 1, 2, 3, 4, 5].map((k) => prep(xf(new TorusGeometry(0.011, 0.0032, 6, 12), { ry: k % 2 ? Math.PI / 2 : 0, at: [0, -0.024 - k * 0.017, 0] }), chrome))
    ]),
    M.enamel
  );
  const checker = new Object3D();
  TENTACLES.forEach((tn, n) => {
    const y0 = PLANE - 0.05;
    let parent = root;
    const chain = [];
    let probeParent = checker;
    for (let k = 0; k < NSEG; k += 1) {
      const translation = k === 0 ? [tn.base[0], y0, tn.base[1]] : [-Math.sin(0.18) * SEG_LEN[k - 1] * 0.5, SEG_LEN[k - 1], 0];
      const node = glb.node({ name: `kraken-${n}-${k}`, mesh: segMeshes[k], translation, rotation: tentacleRot(tn, k, 0), scale: k === 0 ? [tn.s, tn.s, tn.s] : undefined, parent });
      glb.animate(node, 'rotation', TIMES, quatKeys((t) => tentacleRot(tn, k, t)));
      const probe = new Object3D();
      probe.position.set(...translation);
      if (k === 0) probe.scale.setScalar(tn.s);
      probeParent.add(probe);
      chain.push(probe);
      probeParent = probe;
      parent = node;
      if (k === NSEG - 1 && tn.plug) {
        // The plug hangs from the curled tip, its chain dangling below it.
        glb.node({ name: `kraken-${n}-plug`, mesh: plugMesh, translation: [-0.012, SEG_LEN[k] * 0.85, 0], rotation: quat([0, 0, 1], 0.9), parent: node });
      }
    }
    for (let s = 0; s < 64; s += 1) {
      const t = (s / 64) * LOOP;
      chain.forEach((probe, k) => probe.quaternion.set(...tentacleRot(tn, k, t)));
      checker.updateMatrixWorld(true);
      for (let k = 0; k < NSEG; k += 1) {
        for (const f of [0, 0.5, 1]) {
          for (const side of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const r = SEG_R[k] + (SEG_R[k + 1] - SEG_R[k]) * f;
            const p = new Vector3(side[0] * r - Math.sin(0.18 * f) * SEG_LEN[k] * 0.5 * f, SEG_LEN[k] * f, side[1] * r).applyMatrix4(chain[k].matrixWorld);
            if (!insideTub(p.x, p.y, p.z, 0.004)) warnings.push(`kraken ${n} seg ${k} pokes at t=${t.toFixed(2)}`);
          }
        }
      }
      if (tn.plug) {
        // The plug and its chain (about 12 cm below the tip) must stay inside too.
        for (const dy of [0, -0.06, -0.12]) {
          const p = new Vector3(0, SEG_LEN[NSEG - 1] + dy * 0.6, dy * 0.0).applyMatrix4(chain[NSEG - 1].matrixWorld);
          if (!insideTub(p.x, p.y, p.z, 0.04)) warnings.push(`kraken ${n} plug pokes at t=${t.toFixed(2)}`);
        }
      }
    }
  });

  // --- The lighthouse: lamp room on the tap tower and a beam that sweeps round twice.
  const lamp = [-0.801, RIM + 0.152, 0];
  glb.node({ name: 'lighthouse-lamp', mesh: mesh('lighthouse-lamp', prep(new CylinderGeometry(0.019, 0.019, 0.032, 16), '#ffe2a0'), M.paint), translation: lamp, parent: root });
  glb.node({ name: 'lighthouse-glow', mesh: mesh('lighthouse-glow', new SphereGeometry(0.05, 18, 12), M.glow), translation: lamp, parent: root });
  const BEAM = 0.85;
  const beamGeometry = new ConeGeometry(0.07, BEAM, 20, 1, true);
  beamGeometry.rotateZ(Math.PI / 2);
  beamGeometry.translate(BEAM / 2, 0, 0);
  beamGeometry.rotateZ(-0.07);
  const beam = glb.node({ name: 'lighthouse-beam', mesh: mesh('lighthouse-beam', beamGeometry, M.beam), translation: lamp, parent: root });
  glb.animate(beam, 'rotation', TIMES, quatKeys((t) => quat([0, 1, 0], -(TAU * 2 * t) / LOOP)));

  // --- The drip from the spout every 4 s, and its ring.
  const drop = glb.node({ name: 'spout-drip', mesh: mesh('spout-drip', prep(xf(new SphereGeometry(0.009, 10, 8), { s: [1, 1.35, 1] }), '#cfe8ec'), M.paint), translation: NOZZLE, scale: HIDDEN, parent: root });
  const dripPhase = (t) => {
    for (const at of DRIPS) if (t >= at && t < at + DRIP_FORM + DRIP_FALL) return t - at;
    return -1;
  };
  glb.animate(drop, 'translation', TIMES, vecKeys((t) => {
    const s = dripPhase(t);
    if (s < DRIP_FORM) return [...NOZZLE];
    const f = s - DRIP_FORM;
    return [NOZZLE[0], NOZZLE[1] - 0.5 * 9.8 * f * f, NOZZLE[2]];
  }));
  glb.animate(drop, 'scale', TIMES, vecKeys((t) => {
    const s = dripPhase(t);
    if (s < 0) return HIDDEN;
    const k = Math.min(1, 0.3 + s / DRIP_FORM);
    return [k, k, k];
  }));
  const ringGeometry = prep(xf(new TorusGeometry(0.035, 0.0035, 6, 32), { rx: Math.PI / 2 }), '#cfe8ec');
  const ring = glb.node({ name: 'spout-ring', mesh: mesh('spout-ring', ringGeometry, M.paint), translation: [NOZZLE[0], PLANE + 0.003, 0], scale: HIDDEN, parent: root });
  glb.animate(ring, 'scale', TIMES, vecKeys((t) => {
    for (const at of DRIPS) {
      const s = t - (at + DRIP_FORM + DRIP_FALL);
      if (s >= 0 && s < 0.9) {
        const k = 0.3 + 1.6 * (s / 0.9);
        return [k, 1, k];
      }
    }
    return HIDDEN;
  }));

  // --- The thundercloud under the shower head, with rain and two strikes.
  const cloudShape = cloudPuffs(random);
  const cloud = glb.node({ name: 'storm-cloud', parent: root });
  glb.animate(cloud, 'translation', TIMES, vecKeys((t) => [0.012 * Math.sin((TAU * t) / LOOP), 0.01 * Math.sin((TAU * 2 * t) / LOOP), 0]));
  const { C } = cloudShape;
  const cloudColor = (x, y, z) => {
    const h = smooth(C[1] - 0.15, C[1] + 0.14, y);
    const n = fbm3(x * 7, y * 7, z * 7, { octaves: 3, seed: 90 });
    return mix('#1b1f2c', '#5d6577', h * 0.8 + 0.3 * (n - 0.5));
  };
  glb.node({ name: 'storm-cloud-body', mesh: mesh('storm-cloud-body', cloudGeometry(cloudShape, cloudColor), M.paint), parent: cloud });
  const strikes = [
    { top: [-0.44, C[1] - 0.12, 0.05], end: [-0.3, PLANE + 0.01, 0.13], seed: 5 },
    { top: [-0.08, C[1] - 0.12, -0.07], end: [0.1, PLANE + 0.01, -0.15], seed: 9 }
  ];
  strikes.forEach((st, k) => {
    const at = LIGHTNING[k];
    const times = [0, at, at + 0.1, at + 0.16, at + 0.32, LOOP];
    const values = [...HIDDEN, ...ONE, ...HIDDEN, ...ONE, ...HIDDEN, ...HIDDEN];
    const core = boltGeometry(st.top, st.end, st.seed, 0.014);
    for (const p of core.points) if (!insideTub(p[0], p[1], p[2], 0.01)) warnings.push(`bolt ${k} point outside the tub`);
    const halo = boltGeometry(st.top, st.end, st.seed, 0.045);
    const group = glb.node({ name: `lightning-${k}`, scale: HIDDEN, parent: root });
    glb.node({ name: `lightning-${k}-core`, mesh: mesh(`lightning-${k}-core`, core.geometry, M.paint), parent: group });
    glb.node({ name: `lightning-${k}-glow`, mesh: mesh(`lightning-${k}-glow`, halo.geometry, M.flashGlow), parent: group });
    const splash = prep(xf(new CylinderGeometry(0.06, 0.06, 0.002, 24), { at: [st.end[0], PLANE + 0.012, st.end[2]] }), '#e9e6ff');
    glb.node({ name: `lightning-${k}-splash`, mesh: mesh(`lightning-${k}-splash`, splash, M.paint), parent: group });
    glb.animate(group, 'scale', times, values, 'STEP');
    // The cloud lit from inside at the same instant: a brighter skin over it.
    const flashColor = (x, y, z) => {
      const d = Math.hypot(x - st.top[0], (y - st.top[1]) * 1.6, z - st.top[2]);
      return mix('#6f6c9a', '#fbf8ff', Math.exp(-((d / 0.26) ** 2)));
    };
    const flashGeometry = cloudGeometry(cloudShape, flashColor);
    flashGeometry.translate(-C[0], -C[1], -C[2]);
    flashGeometry.scale(1.012, 1.012, 1.012);
    flashGeometry.translate(C[0], C[1], C[2]);
    const flash = glb.node({ name: `storm-cloud-flash-${k}`, mesh: mesh(`storm-cloud-flash-${k}`, flashGeometry, M.paint), scale: HIDDEN, parent: cloud });
    glb.animate(flash, 'scale', times, values, 'STEP');
  });
  const rain = glb.node({ name: 'storm-rain', mesh: mesh('storm-rain', rainGeometry(random), M.paint), parent: root });
  {
    const times = [];
    const values = [];
    const n = Math.round(LOOP / RAIN_P);
    for (let k = 0; k < n; k += 1) {
      times.push(k * RAIN_P, (k + 1) * RAIN_P - 0.002);
      values.push(0, 0, 0, 0, -RAIN_S * (1 - 0.002 / RAIN_P), 0);
    }
    times.push(LOOP);
    values.push(0, 0, 0);
    glb.animate(rain, 'translation', times, values);
  }

  // Hard checks: nothing through the enamel, and a sea of 40 to 70 crest pieces.
  if (warnings.length) throw new Error(`${warnings.length} parts poke through the enamel, first: ${warnings.slice(0, 3).join('; ')}`);
  if (crests < 40 || crests > 70) throw new Error(`${crests} crest pieces; the sea wants 40 to 70`);
  glb.json.asset.extras.holoim.crestPieces = crests;
  glb.audio(sound());
  return glb;
}

// Middle of the bounds and the feed's first-view direction (yaw 18°, pitch 16°).
const MID = [0, 0.86, 0];
const FEED = [0.297, 0.276, 0.914];
const at = (dir, d) => MID.map((m, i) => m + dir[i] * d);
const dirOf = (yawDeg, pitchDeg) => {
  const y = (yawDeg * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  return [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)];
};

export const tiles = [
  { label: 'feed', cam: at(FEED, 3.9), look: MID, t: 2.0 },
  { label: 'into the tub, 45°', cam: at(dirOf(5, 45), 2.6), look: MID, t: 6.0 },
  { label: 'boat close 1.6 m', cam: at(dirOf(12, 40), 1.6), look: MID, t: 3.0 },
  { label: 'kraken close 1.6 m', cam: at(dirOf(-30, 20), 1.6), look: MID, t: 7.0 },
  { label: 'lighthouse end', cam: at(dirOf(-80, 22), 2.4), look: MID, t: 0.3 },
  { label: 'lightning 4.05', cam: at(FEED, 3.9), look: MID, t: 4.05 },
  { label: 'lightning 11.55', cam: at(dirOf(-20, 25), 3.0), look: MID, t: 11.55 },
  { label: 'swamped t=9', cam: at(dirOf(20, 50), 1.6), look: MID, t: 9.0 },
  { label: 'top', cam: [0.0, 3.3, 0.02], look: [0, 0.5, 0], t: 12.0 }
];
