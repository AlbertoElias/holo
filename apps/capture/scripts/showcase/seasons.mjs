import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { add, lowpass, noise, normalize, toWav, track, SAMPLE_RATE } from './lib/audio.mjs';
import { Glb, sample } from './lib/glb.mjs';
import { fbm3, noise3, quat, quatMul, rng } from './lib/parts.mjs';
import { T } from './lib/tokens.mjs';

// "Walk around the year": one young apple tree at true size, standing in all
// four seasons at once. Which season you see depends on where you stand:
// spring faces the first view, summer the right, autumn the back, winter the
// left. A red scarf carries the story round: on a branch by the apple basket
// in autumn, round a snowman's neck in winter, on the wet ground where he
// stood in spring, and gone in summer, where a swing hangs with nobody on it.

export const meta = {
  slug: 'walk-around-the-year',
  name: 'Walk around the year',
  submittedBy: 'Claude (agent-authored)'
};

const LOOP = 20;
const TAU = Math.PI * 2;
const HIDDEN = [1e-4, 1e-4, 1e-4];
const DEG = Math.PI / 180;

const Y0 = 0.09; // the slab's top
const SLAB_R = 1.8;
const UP = new Vector3(0, 1, 0);

// Seasons by yaw around the trunk (0 = +Z, 90° = +X), each a quarter.
const SPRING = 0;
const SUMMER = 1;
const AUTUMN = 2;
const WINTER = 3;
const CENTERS = [18, 108, 198, 288].map((d) => d * DEG);
const BAND = 11 * DEG; // half-width of the soft border between quarters

const col = (hex) => new Color(hex);
const mix = (a, b, t) => (a instanceof Color ? a.clone() : col(a)).lerp(b instanceof Color ? b : col(b), Math.min(1, Math.max(0, t)));
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const wrap = (a) => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
const frac = (x) => x - Math.floor(x);
const yawOf = (x, z) => Math.atan2(x, z);
const around = (yawDeg, r, y = 0) => new Vector3(Math.sin(yawDeg * DEG) * r, y, Math.cos(yawDeg * DEG) * r);

/** The season border wanders a little, so quarters meet like weather, not like pie slices. */
function jitterYaw(yaw, r) {
  return yaw + 0.42 * (fbm3(Math.cos(yaw) * 1.6 + 4, r * 1.3, Math.sin(yaw) * 1.6, { octaves: 3, seed: 61 }) - 0.5);
}

/** Weights of the four seasons at a yaw, summing to 1. */
function weights(yaw) {
  const w = CENTERS.map((c) => smooth(Math.PI / 4 + BAND, Math.PI / 4 - BAND, Math.abs(wrap(yaw - c))));
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  return w.map((v) => v / sum);
}

/** One season for a thing at this yaw; at a border the choice is dithered by `r` in [0, 1). */
function pick(yaw, r) {
  const w = weights(yaw);
  let acc = 0;
  for (let i = 0; i < 4; i += 1) {
    acc += w[i];
    if (r < acc) return i;
  }
  return 3;
}

// ---------------------------------------------------------------- painted light
// No lights reach the file, so every vertex carries the light of its quarter:
// cool bright morning, warm gold afternoon, low amber evening, blue dusk.

const norm = (x, y, z) => new Vector3(x, y, z).normalize();
const LIGHTS = [
  { tint: col('#f2f7ff'), dir: norm(0.1, 0.85, 0.5), amb: 0.66, k: 0.48 },
  { tint: col('#ffd890'), dir: norm(0.75, 0.55, -0.1), amb: 0.62, k: 0.6 },
  { tint: col('#ffa060'), dir: norm(-0.15, 0.28, -0.95), amb: 0.5, k: 0.72 },
  { tint: col('#86a2ea'), dir: norm(-0.85, 0.45, 0.25), amb: 0.66, k: 0.2 }
];

function paint(base, x, z, nx, ny, nz, { two = false, accent = 0, w } = {}) {
  const ws = w ?? weights(jitterYaw(yawOf(x + nx * 0.35, z + nz * 0.35), Math.hypot(x, z)));
  const out = new Color(0, 0, 0);
  for (let i = 0; i < 4; i += 1) {
    if (ws[i] < 1e-4) continue;
    const L = LIGHTS[i];
    let lam = nx * L.dir.x + ny * L.dir.y + nz * L.dir.z;
    lam = two ? Math.abs(lam) * 0.8 : Math.max(0, lam);
    const k = (L.amb + L.k * lam + 0.1 * Math.max(0, ny)) * ws[i];
    out.r += base.r * L.tint.r * k;
    out.g += base.g * L.tint.g * k;
    out.b += base.b * L.tint.b * k;
  }
  if (accent) out.lerp(base, accent);
  return out;
}

/** Keeps position only, indexes, and bakes painted vertex colors. `base` is a hex or fn(x, y, z) -> Color. */
function finish(geometry, base, { lit = true, two = false, accent = 0, ao, w } = {}) {
  let g = geometry;
  for (const key of Object.keys(g.attributes)) if (key !== 'position') g.deleteAttribute(key);
  g.clearGroups();
  if (!g.index) g = mergeVertices(g, 1e-5);
  g.computeVertexNormals();
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const out = new Float32Array(pos.count * 3);
  const fixed = typeof base === 'function' ? null : col(base);
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const b = fixed ?? base(x, y, z);
    let c = lit ? paint(b, x, z, nor.getX(i), nor.getY(i), nor.getZ(i), { two, accent, w }) : b.clone();
    if (ao) c = c.multiplyScalar(ao(x, y, z));
    out[i * 3] = c.r;
    out[i * 3 + 1] = c.g;
    out[i * 3 + 2] = c.b;
  }
  g.deleteAttribute('normal');
  g.setAttribute('color', new BufferAttribute(out, 3));
  return g;
}

/** Triangles with colors already painted. */
class Soup {
  constructor() {
    this.p = [];
    this.c = [];
    this.i = [];
  }
  v(p, c) {
    this.p.push(p.x, p.y, p.z);
    this.c.push(c.r, c.g, c.b);
    return this.p.length / 3 - 1;
  }
  t(a, b, c) {
    this.i.push(a, b, c);
  }
  geometry() {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.p), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.c), 3));
    g.setIndex(this.i);
    return g;
  }
}

/** A tube along `points` whose radius runs from r0 to r1. */
function taper(points, r0, r1, { radial = 6, segs = 12 } = {}) {
  const curve = new CatmullRomCurve3(points);
  const g = new TubeGeometry(curve, segs, 1, radial, false);
  const pos = g.attributes.position;
  for (let i = 0; i <= segs; i += 1) {
    const u = i / segs;
    const center = curve.getPointAt(u);
    const r = r0 + (r1 - r0) * u;
    for (let j = 0; j <= radial; j += 1) {
      const k = i * (radial + 1) + j;
      pos.setXYZ(k, center.x + (pos.getX(k) - center.x) * r, center.y + (pos.getY(k) - center.y) * r, center.z + (pos.getZ(k) - center.z) * r);
    }
  }
  return g;
}

/** A flat band along a curve: `sideAt(u, tangent)` gives the width direction. */
function ribbon(soup, points, width, sideAt, colorAt, { samples = 28 } = {}) {
  const curve = new CatmullRomCurve3(points);
  let prev = null;
  for (let i = 0; i <= samples; i += 1) {
    const u = i / samples;
    const p = curve.getPointAt(u);
    const tan = curve.getTangentAt(u);
    const side = sideAt(u, tan).normalize();
    const n = new Vector3().crossVectors(tan, side).normalize();
    const w = typeof width === 'function' ? width(u) : width;
    const c = paint(colorAt(u), p.x, p.z, n.x, n.y, n.z, { two: true, accent: 0.35 });
    const a = soup.v(p.clone().addScaledVector(side, w / 2), c);
    const b = soup.v(p.clone().addScaledVector(side, -w / 2), c);
    if (prev) {
      soup.t(prev[0], prev[1], a);
      soup.t(prev[1], b, a);
    }
    prev = [a, b];
  }
}

const RED = col('#d0121e');
const CREAM = col('#f1e6cc');
/** The scarf's knit: red with two cream bands near each end. */
const scarfColor = (u) => {
  const e = Math.min(u, 1 - u);
  return (e > 0.05 && e < 0.075) || (e > 0.1 && e < 0.125) ? CREAM : RED;
};

// ---------------------------------------------------------------- the slab

function rimMul(theta) {
  const x = Math.cos(theta);
  const z = Math.sin(theta);
  let r = 1 + 0.08 * (fbm3(x * 1.4 + 3, z * 1.4, 0.5, { seed: 14 }) - 0.5) + 0.05 * (fbm3(x * 5 + 1, z * 5, 1.5, { seed: 19 }) - 0.5);
  r -= 0.045 * Math.max(0, noise3(x * 8 + 1, z * 8, 2, 27) - 0.6) / 0.4;
  return r;
}

/** Snow lies as a blanket on the winter quarter. */
function snowDepth(x, z) {
  const r = Math.hypot(x, z);
  const w = weights(jitterYaw(yawOf(x, z), r))[WINTER];
  const f = r / (SLAB_R * rimMul(Math.atan2(z, x)));
  return 0.05 * w * (0.55 + 0.45 * fbm3(x * 3, 0.2, z * 3, { seed: 33 })) * smooth(1.0, 0.86, f);
}

function groundY(x, z) {
  return Y0 + snowDepth(x, z) + 0.004 * (fbm3(x * 6, 1, z * 6, { seed: 5 }) - 0.5);
}

const GROUND = [
  (x, z) => mix('#5fa83a', '#3e2c1e', smooth(0.5, 0.62, fbm3(x * 2.6, 3, z * 2.6, { seed: 7 }))), // new grass and wet earth
  (x, z) => mix('#4d7f24', '#8a9636', fbm3(x * 3, 4, z * 3, { seed: 8 })), // deep summer grass
  (x, z) => mix('#7a4a22', '#a8642a', fbm3(x * 3, 5, z * 3, { seed: 9 })), // leaf-brown earth
  (x, z) => mix('#e6eefc', '#ffffff', fbm3(x * 4, 6, z * 4, { seed: 10 })) // snow
];

function slabGeometry() {
  const N = 240;
  const R = 30;
  const soup = new Soup();
  const rows = [];
  for (let k = 0; k <= R; k += 1) rows.push({ f: Math.max(0.001, k / R) ** 0.8 });
  const sideRows = 4;
  const index = [];
  for (const row of rows) {
    const line = [];
    for (let j = 0; j < N; j += 1) {
      const th = (j / N) * TAU;
      const rr = rimMul(th) * SLAB_R * row.f;
      const x = Math.cos(th) * rr;
      const z = Math.sin(th) * rr;
      const y = groundY(x, z) - 0.006 * smooth(0.94, 1, row.f);
      const w = weights(jitterYaw(yawOf(x, z), rr));
      let c = new Color(0, 0, 0);
      for (let i = 0; i < 4; i += 1) if (w[i] > 0) c.add(GROUND[i](x, z).multiplyScalar(w[i]));
      c = paint(c, x, z, 0, 1, 0, { w });
      c.lerp(col('#24160d'), smooth(0.93, 0.975, row.f));
      c.lerp(col(T.gold), smooth(0.982, 1, row.f));
      line.push(soup.v(new Vector3(x, y, z), c));
    }
    index.push(line);
  }
  for (let s = 1; s <= sideRows; s += 1) {
    const line = [];
    for (let j = 0; j < N; j += 1) {
      const th = (j / N) * TAU;
      const u = s / sideRows;
      const rr = rimMul(th) * SLAB_R * (1 - 0.025 * u);
      const x = Math.cos(th) * rr;
      const z = Math.sin(th) * rr;
      const yTop = groundY(x, z) - 0.006;
      const c = mix('#3a2a20', '#5a4232', fbm3(th * 6, u * 3, 1, { seed: 12 })).multiplyScalar(0.8 - 0.3 * u);
      line.push(soup.v(new Vector3(x, yTop * (1 - u), z), c));
    }
    index.push(line);
  }
  for (let k = 0; k < index.length - 1; k += 1) {
    for (let j = 0; j < N; j += 1) {
      const a = index[k][j];
      const b = index[k][(j + 1) % N];
      const c = index[k + 1][j];
      const d = index[k + 1][(j + 1) % N];
      soup.t(a, b, c);
      soup.t(b, d, c);
    }
  }
  const g = soup.geometry();
  // The burnt-gold rim line.
  const rim = [];
  for (let j = 0; j < 260; j += 1) {
    const th = (j / 260) * TAU;
    const rr = rimMul(th) * SLAB_R * 1.002;
    const x = Math.cos(th) * rr;
    const z = Math.sin(th) * rr;
    rim.push(new Vector3(x, groundY(x, z) - 0.005, z));
  }
  const ember = finish(new TubeGeometry(new CatmullRomCurve3(rim, true), 520, 0.007, 4, true), T.gold, { lit: false });
  return [g, ember];
}

// ---------------------------------------------------------------- the tree

const MAX_DEPTH = 3;
const BEND = [0.05, 0.035, 0.0, -0.03];

function dirFrom(yawDeg, elevDeg) {
  const y = yawDeg * DEG;
  const e = elevDeg * DEG;
  return new Vector3(Math.sin(y) * Math.cos(e), Math.sin(e), Math.cos(y) * Math.cos(e));
}

function grow(out, { start, dir, len, r0, depth, group, random, bend, kidsAt = 0.35 }) {
  const steps = depth === 0 ? 6 : 4;
  const pts = [start.clone()];
  const d = dir.clone().normalize();
  const p = start.clone();
  for (let s = 1; s <= steps; s += 1) {
    const b = bend ?? BEND[depth];
    d.add(new Vector3((random() - 0.5) * 0.28, (random() - 0.5) * 0.12 + b, (random() - 0.5) * 0.28)).normalize();
    p.addScaledVector(d, len / steps);
    pts.push(p.clone());
  }
  const r1 = r0 * (depth >= MAX_DEPTH ? 0.4 : 0.55);
  const branch = { pts, r0, r1, depth, group };
  out.branches.push(branch);
  if (depth >= MAX_DEPTH) {
    out.tips.push({ p: p.clone(), d: d.clone(), group });
    return branch;
  }
  const curve = new CatmullRomCurve3(pts);
  const kids = depth === 0 ? 3 : 2 + (random() < 0.45 ? 1 : 0);
  for (let k = 0; k < kids; k += 1) {
    const f = Math.min(0.97, kidsAt + ((1 - kidsAt) * (k + 0.3 + random() * 0.6)) / kids);
    const at = curve.getPointAt(f);
    const tan = curve.getTangentAt(f);
    const perp = new Vector3().crossVectors(tan, UP);
    if (perp.lengthSq() < 1e-4) perp.set(1, 0, 0);
    perp.normalize();
    const perp2 = new Vector3().crossVectors(perp, tan).normalize();
    if (perp2.y < 0) perp2.negate();
    const az = (k / kids) * TAU + random() * 1.4;
    const side = perp.clone().multiplyScalar(Math.cos(az)).addScaledVector(perp2, Math.sin(az));
    if (side.y < -0.2) side.y = -side.y * 0.4;
    side.normalize();
    const a = (28 + random() * 26) * DEG;
    const cd = tan.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a));
    cd.y += 0.12;
    grow(out, { start: at, dir: cd, len: len * (0.56 + random() * 0.14), r0: (r0 + (r1 - r0) * f) * 0.72, depth: depth + 1, group, random });
  }
  return branch;
}

function buildTree(random) {
  const out = { branches: [], tips: [], groups: [] };
  const trunkTop = new Vector3(0.03, 1.28, 0.0);
  const trunk = [new Vector3(0, Y0 - 0.01, 0), new Vector3(0.02, 0.45, 0.01), new Vector3(-0.005, 0.85, 0.03), trunkTop.clone()];
  // Scaffold limbs: yaw, height on trunk, elevation, length. C carries the swing, E the scarf, G the robin.
  const limbs = [
    { id: 'a', yaw: 24, h: 1.12, el: 30, len: 0.95 },
    { id: 'b', yaw: 72, h: 1.26, el: 30, len: 0.9 },
    { id: 'c', yaw: 112, h: 1.4, el: 10, len: 0.92, bend: 0.01, kidsAt: 0.5 },
    { id: 'd', yaw: 158, h: 1.2, el: 32, len: 0.9 },
    { id: 'e', yaw: 202, h: 0.96, el: 12, len: 1.05, bend: 0.025, kidsAt: 0.6 },
    { id: 'f', yaw: 246, h: 1.22, el: 30, len: 0.92 },
    { id: 'g', yaw: 292, h: 1.08, el: 24, len: 1.0, kidsAt: 0.5 },
    { id: 'h', yaw: 338, h: 1.3, el: 34, len: 0.88 }
  ];
  const trunkCurve = new CatmullRomCurve3(trunk);
  for (const limb of limbs) {
    const start = trunkCurve.getPointAt(Math.min(1, (limb.h - Y0) / (trunkTop.y - Y0)));
    const group = { id: limb.id, pivot: start.clone(), yaw: limb.yaw };
    out.groups.push(group);
    group.limb = grow(out, { start, dir: dirFrom(limb.yaw, limb.el), len: limb.len, r0: 0.075, depth: 0, group, random, bend: limb.bend, kidsAt: limb.kidsAt });
  }
  // The leader and the upper limbs, one group swaying from the top of the trunk.
  const leaderGroup = { id: 'top', pivot: trunkTop.clone(), yaw: 0 };
  out.groups.push(leaderGroup);
  const leaderPts = [trunkTop.clone(), new Vector3(0.0, 1.75, 0.04), new Vector3(-0.03, 2.25, 0.02), new Vector3(0.0, 2.55, 0.05)];
  out.branches.push({ pts: leaderPts, r0: 0.085, r1: 0.022, depth: 0, group: leaderGroup });
  const leaderCurve = new CatmullRomCurve3(leaderPts);
  const upper = [
    { yaw: 0, h: 0.22, el: 42, len: 0.78 },
    { yaw: 60, h: 0.4, el: 44, len: 0.72 },
    { yaw: 125, h: 0.15, el: 38, len: 0.8 },
    { yaw: 185, h: 0.32, el: 42, len: 0.78 },
    { yaw: 240, h: 0.5, el: 46, len: 0.66 },
    { yaw: 300, h: 0.25, el: 40, len: 0.78 },
    { yaw: 30, h: 0.7, el: 50, len: 0.42 },
    { yaw: 150, h: 0.66, el: 50, len: 0.42 },
    { yaw: 270, h: 0.75, el: 52, len: 0.38 }
  ];
  for (const u of upper) {
    const start = leaderCurve.getPointAt(u.h);
    grow(out, { start, dir: dirFrom(u.yaw, u.el), len: u.len, r0: 0.05 * (1 - u.h * 0.5), depth: 1, group: leaderGroup, random });
  }
  return { ...out, trunk, trunkCurve };
}

const BARK = (x, y, z) => mix('#3e3128', '#625244', fbm3(x * 9, y * 9, z * 9, { seed: 4 }));
const BARK_WINTER = (x, y, z) => mix('#2a2420', '#3f3530', fbm3(x * 9, y * 9, z * 9, { seed: 4 }));
const barkAt = (x, y, z) => {
  const w = weights(yawOf(x, z))[WINTER];
  return BARK(x, y, z).lerp(BARK_WINTER(x, y, z), w);
};

/** A lumpy round mass of leaves or blossom. */
function blob(center, r, squash, seed, colorAt, w) {
  let g = new IcosahedronGeometry(1, 1);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g, 1e-5);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const k = 0.78 + 0.44 * noise3(x * 1.9 + seed, y * 1.9, z * 1.9 - seed, seed);
    pos.setXYZ(i, center.x + x * r * k, center.y + y * r * squash * k, center.z + z * r * k);
  }
  const ao = (x, y, z) => {
    const rho = Math.hypot(x, z);
    return (0.62 + 0.38 * smooth(-r, r, y - center.y)) * (0.7 + 0.3 * smooth(0.3, 1.3, rho));
  };
  return finish(g, colorAt, { ao, w });
}

/** Leaf cards scattered over a blob's skin, for a ragged edge. */
function cards(soup, center, r, count, size, colorAt, random, w) {
  for (let k = 0; k < count; k += 1) {
    const u = new Vector3(random() * 2 - 1, random() * 1.6 - 0.6, random() * 2 - 1).normalize();
    const p = center.clone().addScaledVector(u, r * (0.85 + random() * 0.35));
    const a = new Vector3().crossVectors(u, new Vector3(random() - 0.5, 1, random() - 0.5)).normalize();
    const b = new Vector3().crossVectors(u, a).normalize();
    const l = size * (0.8 + random() * 0.4);
    const c = paint(colorAt(random()), p.x, p.z, u.x, u.y, u.z, { two: true, w });
    const tip = p.clone().addScaledVector(a, l);
    const mid = p.clone().addScaledVector(a, l * 0.5);
    const i0 = soup.v(p, c);
    const i1 = soup.v(mid.clone().addScaledVector(b, l * 0.28), c);
    const i2 = soup.v(tip, c);
    const i3 = soup.v(mid.clone().addScaledVector(b, -l * 0.28), c);
    soup.t(i0, i1, i2);
    soup.t(i0, i2, i3);
  }
}

function apple(center, r, base, blush, w) {
  const g = new SphereGeometry(r, 9, 7);
  g.translate(center.x, center.y, center.z);
  return finish(g, (x, y) => mix(base, blush, smooth(-r, r, y - center.y) * 0.3), { accent: 0.6, w });
}

const SPRING_BLOSSOM = (n) => mix('#fff6f8', '#f6b3c8', n * 0.9);
const SPRING_LEAF = (n) => mix('#8fd04c', '#b8e070', n);
const SUMMER_LEAF = (n) => mix('#1f5a1e', '#3f8a2c', n);
const AUTUMN_LEAF = [(n) => mix('#e88a14', '#f6b228', n), (n) => mix('#b4321a', '#d4501e', n), (n) => mix('#f0c22a', '#ffdc5a', n)];

function foliage(tree, random) {
  const byGroup = new Map(tree.groups.map((g) => [g, { geos: [], soup: new Soup() }]));
  const sites = [];
  for (const tip of tree.tips) sites.push({ p: tip.p, group: tip.group, tip: true });
  for (const b of tree.branches) {
    if (b.depth < 2) continue;
    const c = new CatmullRomCurve3(b.pts);
    sites.push({ p: c.getPointAt(0.5), group: b.group, tip: false });
  }
  for (const site of sites) {
    const { p, group } = site;
    const bucket = byGroup.get(group);
    const yaw = jitterYaw(yawOf(p.x, p.z), Math.hypot(p.x, p.z));
    const season = pick(yaw, random());
    const seed = random() * 50;
    const w = [0, 0, 0, 0];
    w[season] = 1;
    if (season === SPRING) {
      const r = 0.1 + random() * 0.05;
      const tone = random();
      bucket.geos.push(blob(p, r, 0.85, seed, (x, y, z) => SPRING_BLOSSOM(tone * 0.6 + 0.4 * noise3(x * 30, y * 30, z * 30, 3)), w));
      for (let k = 0; k < 2; k += 1) {
        const q = p.clone().add(new Vector3(random() - 0.5, random() * 0.6 - 0.2, random() - 0.5).multiplyScalar(r * 1.6));
        bucket.geos.push(blob(q, r * 0.6, 0.85, seed + k + 1, (x, y, z) => SPRING_BLOSSOM(0.2 + 0.6 * noise3(x * 30, y * 30, z * 30, 5)), w));
      }
      cards(bucket.soup, p, r * 1.1, 7, 0.06, SPRING_LEAF, random, w);
    } else if (season === SUMMER) {
      const r = 0.18 + random() * 0.07;
      bucket.geos.push(blob(p, r, 0.8, seed, (x, y, z) => SUMMER_LEAF(0.25 + 0.6 * noise3(x * 12, y * 12, z * 12, 6)), w));
      cards(bucket.soup, p, r, 12, 0.07, SUMMER_LEAF, random, w);
      if (random() < 0.4) {
        const a = p.clone().add(new Vector3((random() - 0.5) * r, -r * 0.75, (random() - 0.5) * r));
        bucket.geos.push(apple(a, 0.032, '#9fb83a', '#d0562a', w));
      }
    } else if (season === AUTUMN) {
      const hue = AUTUMN_LEAF[Math.floor(random() * 3)];
      if (random() < 0.62) {
        const r = 0.12 + random() * 0.06;
        bucket.geos.push(blob(p, r, 0.8, seed, (x, y, z) => hue(0.2 + 0.7 * noise3(x * 14, y * 14, z * 14, 7)), w));
        cards(bucket.soup, p, r, 8, 0.075, hue, random, w);
      } else {
        cards(bucket.soup, p, 0.1, 4, 0.075, hue, random, w);
      }
      if (random() < 0.32) {
        const a = p.clone().add(new Vector3((random() - 0.5) * 0.12, -0.13, (random() - 0.5) * 0.12));
        bucket.geos.push(apple(a, 0.042, '#a80a14', '#e8a03a', w));
      }
    }
  }
  return byGroup;
}

// ---------------------------------------------------------------- small figures

function snowman(base, facing) {
  const f = facing.clone().normalize();
  const s = new Vector3().crossVectors(UP, f).normalize();
  const geos = [];
  const snow = (x, y, z) => mix('#e8f0ff', '#ffffff', noise3(x * 20, y * 20, z * 20, 2));
  const ball = (r, y) => {
    const g = new SphereGeometry(r, 16, 12);
    g.scale(1, 0.94, 1);
    g.translate(base.x, base.y + y, base.z);
    geos.push(finish(g, snow, { accent: 0.15 }));
    return base.clone().add(new Vector3(0, y, 0));
  };
  ball(0.22, 0.17);
  const mid = ball(0.155, 0.48);
  const head = ball(0.11, 0.71);
  const coal = (p, r) => {
    const g = new IcosahedronGeometry(r, 0);
    g.translate(p.x, p.y, p.z);
    geos.push(finish(g, '#1a1a1e', { lit: false }));
  };
  for (const side of [-1, 1]) coal(head.clone().addScaledVector(f, 0.095).addScaledVector(s, side * 0.04).add(new Vector3(0, 0.03, 0)), 0.02);
  for (let k = 0; k < 3; k += 1) coal(mid.clone().addScaledVector(f, 0.15 - k * 0.006).add(new Vector3(0, 0.07 - k * 0.07, 0)), 0.018);
  // Carrot nose, pointing at the tree.
  const nose = new ConeGeometry(0.022, 0.13, 10);
  nose.translate(0, 0.065, 0);
  nose.rotateX(Math.PI / 2);
  nose.rotateY(Math.atan2(f.x, f.z));
  nose.translate(head.x + f.x * 0.1, head.y, head.z + f.z * 0.1);
  geos.push(finish(nose, '#f07a1a', { accent: 0.45 }));
  // Stick arms.
  for (const side of [-1, 1]) {
    const a = mid.clone().addScaledVector(s, side * 0.14).add(new Vector3(0, 0.04, 0));
    const b = a.clone().addScaledVector(s, side * 0.2).add(new Vector3(0, 0.12, 0)).addScaledVector(f, 0.05);
    const c = b.clone().addScaledVector(s, side * 0.1).add(new Vector3(0, 0.1, 0));
    geos.push(finish(taper([a, b, c], 0.012, 0.006, { radial: 5, segs: 6 }), '#4a3424'));
  }
  // The scarf: round the neck, one end down his back toward whoever is walking up.
  const neck = new TorusGeometry(0.1, 0.034, 8, 22);
  neck.rotateX(Math.PI / 2);
  neck.scale(1, 1.1, 1);
  neck.translate(base.x, base.y + 0.615, base.z);
  geos.push(finish(neck, RED, { accent: 0.4 }));
  const soup = new Soup();
  const knot = mid.clone().addScaledVector(f, -0.08).addScaledVector(s, 0.06).add(new Vector3(0, 0.13, 0));
  const tail = [
    knot,
    knot.clone().addScaledVector(f, -0.07).add(new Vector3(0, -0.06, 0)),
    knot.clone().addScaledVector(f, -0.12).addScaledVector(s, 0.03).add(new Vector3(0, -0.2, 0)),
    knot.clone().addScaledVector(f, -0.14).addScaledVector(s, 0.06).add(new Vector3(0, -0.34, 0))
  ];
  ribbon(soup, tail, 0.09, () => s.clone(), (u) => scarfColor(0.5 + u * 0.5));
  const tail2 = [
    knot.clone().addScaledVector(s, -0.02),
    knot.clone().addScaledVector(f, -0.05).addScaledVector(s, -0.05).add(new Vector3(0, -0.07, 0)),
    knot.clone().addScaledVector(f, -0.07).addScaledVector(s, -0.08).add(new Vector3(0, -0.22, 0))
  ];
  ribbon(soup, tail2, 0.085, () => s.clone(), (u) => scarfColor(0.5 + u * 0.45));
  geos.push(soup.geometry());
  for (const g of geos) {
    g.translate(-base.x, -base.y, -base.z);
    g.scale(1.15, 1.15, 1.15);
    g.translate(base.x, base.y, base.z);
  }
  return geos;
}

/** Where the snowman stood: wet earth, a carrot, two coals, the scarf, and snowdrops through it. */
function remains(base, facing, random) {
  const f = facing.clone().normalize();
  const s = new Vector3().crossVectors(UP, f).normalize();
  const geos = [];
  const soup = new Soup();
  // Wet patch: dark earth, darker and shinier at the middle.
  const rings = 8;
  const N = 36;
  const center = soup.v(new Vector3(base.x, Y0 + 0.006, base.z), paint(col('#20160f'), base.x, base.z, 0, 1, 0));
  let prev = null;
  for (let k = 1; k <= rings; k += 1) {
    const line = [];
    for (let j = 0; j < N; j += 1) {
      const th = (j / N) * TAU;
      const rr = 0.34 * (k / rings) * (0.85 + 0.3 * noise3(Math.cos(th) * 2, Math.sin(th) * 2, 1, 9));
      const x = base.x + Math.cos(th) * rr;
      const z = base.z + Math.sin(th) * rr * 0.9;
      const t = k / rings;
      let c = mix('#2e2216', '#4a3622', t);
      // A sheen of standing water where the light catches it.
      c.lerp(col('#a8c4e0'), 0.35 * smooth(0.55, 0.85, noise3(x * 9, 1, z * 9, 4)) * (1 - t));
      c = paint(c, x, z, 0, 1, 0);
      if (k === rings) c = paint(GROUND[SPRING](x, z), x, z, 0, 1, 0).lerp(c, 0.4);
      line.push(soup.v(new Vector3(x, Y0 + 0.006 - 0.002 * t, z), c));
    }
    for (let j = 0; j < N; j += 1) {
      if (!prev) soup.t(center, line[(j + 1) % N], line[j]);
      else {
        soup.t(prev[j], prev[(j + 1) % N], line[j]);
        soup.t(prev[(j + 1) % N], line[(j + 1) % N], line[j]);
      }
    }
    prev = line;
  }
  // The scarf, fallen in a loose loop.
  const at = (a, b, y = 0) => base.clone().addScaledVector(f, a).addScaledVector(s, b).setY(Y0 + 0.014 + y);
  ribbon(
    soup,
    [at(-0.2, -0.26), at(-0.12, -0.12, 0.01), at(-0.02, -0.02, 0.02), at(0.05, 0.1, 0.012), at(-0.04, 0.2, 0.008), at(-0.16, 0.18), at(-0.24, 0.3)],
    0.1,
    (u, tan) => new Vector3().crossVectors(UP, tan),
    scarfColor,
    { samples: 40 }
  );
  geos.push(soup.geometry());
  // Carrot where the head fell, still pointing at the tree; the two coal eyes beside it.
  const carrot = new ConeGeometry(0.024, 0.14, 10);
  carrot.translate(0, 0.07, 0);
  carrot.rotateX(Math.PI / 2);
  carrot.rotateY(Math.atan2(f.x, f.z) + 0.35);
  const cp = at(0.14, -0.06, 0.012);
  carrot.translate(cp.x, cp.y, cp.z);
  geos.push(finish(carrot, '#f2801c', { accent: 0.5 }));
  for (const [a, b] of [[0.1, -0.16], [0.2, 0.06]]) {
    const g = new IcosahedronGeometry(0.026, 0);
    g.scale(1, 0.7, 1);
    const p = at(a, b, 0.012);
    g.translate(p.x, p.y, p.z);
    geos.push(finish(g, '#141416', { lit: false }));
  }
  // Snowdrops coming up through the wet ground and the scarf.
  const drops = [[-0.06, -0.08], [0.02, 0.05], [-0.1, 0.12], [0.06, -0.2], [-0.2, 0.0], [0.12, 0.18], [-0.02, -0.24], [-0.26, 0.2]];
  for (const [a, b] of drops) {
    const foot = at(a, b, -0.01);
    const h = 0.12 + random() * 0.06;
    const lean = new Vector3(random() - 0.5, 0, random() - 0.5).normalize();
    const top = foot.clone().add(new Vector3(0, h, 0)).addScaledVector(lean, 0.02);
    const hook = top.clone().addScaledVector(lean, 0.035).add(new Vector3(0, -0.012, 0));
    geos.push(finish(taper([foot, foot.clone().add(new Vector3(0, h * 0.6, 0)), top, hook], 0.005, 0.004, { radial: 4, segs: 6 }), '#5a8a3a', { accent: 0.2 }));
    const bell = new SphereGeometry(0.02, 8, 6);
    bell.scale(0.85, 1.35, 0.85);
    bell.translate(hook.x, hook.y - 0.026, hook.z);
    geos.push(finish(bell, '#ffffff', { accent: 0.55 }));
    for (const side of [-1, 1]) {
      const leaf = soup.v(foot, paint(col('#4f8a46'), foot.x, foot.z, 0, 0, 1, { two: true }));
      const s2 = new Vector3(lean.z, 0, -lean.x).multiplyScalar(side);
      const lt = foot.clone().add(new Vector3(0, h * 0.7, 0)).addScaledVector(s2, 0.03);
      const l1 = soup.v(lt, paint(col('#6fa860'), lt.x, lt.z, 0, 0, 1, { two: true }));
      const l2 = soup.v(foot.clone().addScaledVector(s2, 0.012).add(new Vector3(0, 0.02, 0)), paint(col('#4f8a46'), foot.x, foot.z, 0, 0, 1, { two: true }));
      soup.t(leaf, l1, l2);
    }
  }
  return geos;
}

function basket(base, random) {
  const geos = [];
  const body = new CylinderGeometry(0.17, 0.13, 0.16, 18, 6, true);
  body.translate(base.x, Y0 + 0.08, base.z);
  geos.push(finish(body, (x, y, z) => {
    const band = Math.floor((y - Y0) / 0.0267) % 2 === 0;
    const weave = Math.sin(Math.atan2(z - base.z, x - base.x) * 18 + (band ? 0 : Math.PI)) > 0;
    return col(weave ? '#a8743a' : '#7a5028');
  }));
  const bottom = new CylinderGeometry(0.13, 0.13, 0.01, 18);
  bottom.translate(base.x, Y0 + 0.005, base.z);
  geos.push(finish(bottom, '#6a4422'));
  const rim = new TorusGeometry(0.17, 0.014, 6, 24);
  rim.rotateX(Math.PI / 2);
  rim.translate(base.x, Y0 + 0.16, base.z);
  geos.push(finish(rim, '#8a5c2c'));
  const handle = new TorusGeometry(0.165, 0.012, 6, 20, Math.PI);
  handle.rotateY(0.6);
  handle.translate(base.x, Y0 + 0.16, base.z);
  geos.push(finish(handle, '#8a5c2c'));
  const heap = [[0, 0.19, 0], [0.08, 0.17, 0.03], [-0.07, 0.17, 0.05], [0.02, 0.17, -0.08], [-0.05, 0.17, -0.06], [0.07, 0.17, -0.06], [0.0, 0.25, 0.01], [-0.02, 0.17, 0.09]];
  for (const [x, y, z] of heap) geos.push(apple(new Vector3(base.x + x, Y0 + y - 0.005 + random() * 0.01, base.z + z), 0.044, '#a00812', '#d88a2a', [0, 0, 1, 0]));
  return geos;
}

function robinGeometry() {
  // Facing +Z, feet at the origin.
  const geos = [];
  const part = (g, color, at, sc) => {
    if (sc) g.scale(...sc);
    g.translate(...at);
    geos.push(finish(g, color, { accent: 0.45 }));
  };
  part(new SphereGeometry(1, 12, 9), '#6a4a30', [0, 0.06, -0.005], [0.042, 0.04, 0.062]);
  part(new SphereGeometry(1, 10, 8), '#ee5a1e', [0, 0.058, 0.03], [0.036, 0.034, 0.036]);
  part(new SphereGeometry(1, 8, 6), '#efe2cc', [0, 0.04, 0.012], [0.03, 0.022, 0.034]);
  part(new SphereGeometry(0.03, 10, 8), '#6a4a30', [0, 0.1, 0.04]);
  part(new SphereGeometry(0.02, 8, 6), '#ee5a1e', [0, 0.092, 0.058]);
  const beak = new ConeGeometry(0.007, 0.022, 6);
  beak.rotateX(Math.PI / 2);
  part(beak, '#2a2018', [0, 0.1, 0.076]);
  const tail = new ConeGeometry(0.022, 0.07, 4);
  tail.rotateX(-Math.PI / 2 - 0.5);
  part(tail, '#55392a', [0, 0.075, -0.075], [1, 0.4, 1]);
  for (const x of [-0.012, 0.012]) part(new CylinderGeometry(0.003, 0.003, 0.025, 4), '#3a2a20', [x, 0.012, 0.0]);
  return mergeGeometries(geos);
}

function wingGeometry(color, side) {
  // Hinged on the body axis (local Z), spreading along -X for side -1, +X for +1.
  const soup = new Soup();
  const c0 = paint(col(color), 1.2, 0.4, 0, 1, 0, { accent: 0.6 });
  const c1 = c0.clone().multiplyScalar(0.55);
  const pts = [
    [0, 0.012],
    [0.03, 0.04],
    [0.062, 0.03],
    [0.058, 0.0],
    [0.045, -0.025],
    [0.02, -0.036],
    [0, -0.014]
  ];
  const ids = pts.map(([x, z], i) => soup.v(new Vector3(x * side, 0, z), i === 2 || i === 3 ? c1 : c0));
  for (let i = 1; i < ids.length - 1; i += 1) soup.t(ids[0], ids[i], ids[i + 1]);
  return soup.geometry();
}

// ---------------------------------------------------------------- the ground's plants

function groundCover(random, keepOut) {
  const soup = new Soup();
  const geos = [];
  const blocked = (x, z) => keepOut.some(([cx, cz, r]) => Math.hypot(x - cx, z - cz) < r);
  const blade = (foot, h, lean, w, c0, c1) => {
    const n = new Vector3(-lean.z, 0, lean.x).normalize();
    const tip = foot.clone().add(new Vector3(lean.x * h * 0.5, h, lean.z * h * 0.5));
    const a = soup.v(foot.clone().addScaledVector(n, w), c0);
    const b = soup.v(foot.clone().addScaledVector(n, -w), c0);
    const t = soup.v(tip, c1);
    soup.t(a, b, t);
  };
  const flower = (p, r, petal, heart) => {
    const ci = soup.v(p.clone().add(new Vector3(0, 0.002, 0)), heart);
    const ring = [];
    for (let k = 0; k < 10; k += 1) {
      const th = (k / 10) * TAU;
      const rr = k % 2 === 0 ? r : r * 0.45;
      ring.push(soup.v(p.clone().add(new Vector3(Math.cos(th) * rr, 0, Math.sin(th) * rr)), petal));
    }
    for (let k = 0; k < 10; k += 1) soup.t(ci, ring[k], ring[(k + 1) % 10]);
  };
  const leafOnGround = (p, size, color, rot) => {
    const a = new Vector3(Math.cos(rot), 0, Math.sin(rot));
    const b = new Vector3(-a.z, 0, a.x);
    const lift = new Vector3(0, 0.004, 0);
    const i0 = soup.v(p.clone().add(lift), color);
    const i1 = soup.v(p.clone().addScaledVector(a, size * 0.5).addScaledVector(b, size * 0.3).add(lift), color);
    const i2 = soup.v(p.clone().addScaledVector(a, size).add(new Vector3(0, 0.012, 0)), color.clone().multiplyScalar(0.85));
    const i3 = soup.v(p.clone().addScaledVector(a, size * 0.5).addScaledVector(b, -size * 0.3).add(lift), color);
    soup.t(i0, i1, i2);
    soup.t(i0, i2, i3);
  };
  const count = 5200;
  for (let n = 0; n < count; n += 1) {
    const th = random() * TAU;
    const rr = Math.sqrt(0.05 + random() * 0.95) * SLAB_R * 0.93;
    const x = Math.cos(th) * rr;
    const z = Math.sin(th) * rr;
    if (rr < 0.22 || rr > SLAB_R * rimMul(th) * 0.95 || blocked(x, z)) continue;
    const yaw = jitterYaw(yawOf(x, z), rr);
    const season = pick(yaw, random());
    const w = weights(yaw);
    const y = groundY(x, z);
    const foot = new Vector3(x, y - 0.004, z);
    const lean = new Vector3(0.5 + random() * 0.4, 0, (random() - 0.5) * 0.6);
    if (season === SPRING) {
      for (let k = 0; k < 3; k += 1) {
        const f = foot.clone().add(new Vector3((random() - 0.5) * 0.04, 0, (random() - 0.5) * 0.04));
        blade(f, 0.06 + random() * 0.07, lean, 0.006, paint(col('#3f7a26'), x, z, 0, 1, 0, { w }), paint(col('#a4e05a'), x, z, 0, 1, 0, { w }));
      }
      if (random() < 0.16) {
        const daisy = random() < 0.6;
        flower(foot.clone().add(new Vector3(0, 0.05 + random() * 0.04, 0)), 0.022, paint(col(daisy ? '#ffffff' : '#ffd21e'), x, z, 0, 1, 0, { w, accent: 0.5 }), paint(col('#f2b81a'), x, z, 0, 1, 0, { w }));
      }
    } else if (season === SUMMER) {
      for (let k = 0; k < 4; k += 1) {
        const f = foot.clone().add(new Vector3((random() - 0.5) * 0.05, 0, (random() - 0.5) * 0.05));
        const h = 0.2 + random() * 0.26;
        blade(f, h, lean, 0.008, paint(col('#2f5a18'), x, z, 0, 1, 0, { w }), paint(col(random() < 0.4 ? '#d8c062' : '#7aa83a'), x, z, 0, 1, 0, { w }));
      }
    } else if (season === AUTUMN) {
      if (random() < 0.3) blade(foot, 0.05 + random() * 0.05, lean, 0.006, paint(col('#5a4a26'), x, z, 0, 1, 0, { w }), paint(col('#a8904a'), x, z, 0, 1, 0, { w }));
      if (random() < 0.85) {
        const hue = AUTUMN_LEAF[Math.floor(random() * 3)](random()).multiplyScalar(0.8 + random() * 0.2);
        leafOnGround(foot.clone().add(new Vector3(0, 0.004, 0)), 0.06 + random() * 0.04, paint(hue, x, z, 0, 1, 0, { w }), random() * TAU);
        if (random() < 0.5) leafOnGround(foot.clone().add(new Vector3(0.03, 0.006, 0.02)), 0.06, paint(mix('#6a3a1a', '#9a5a22', random()), x, z, 0, 1, 0, { w }), random() * TAU);
      }
    } else if (random() < 0.05) {
      blade(foot, 0.08 + random() * 0.05, lean, 0.004, paint(col('#6a5a3a'), x, z, 0, 1, 0, { w }), paint(col('#a89a7a'), x, z, 0, 1, 0, { w }));
    }
  }
  geos.push(soup.geometry());
  return geos;
}

// ---------------------------------------------------------------- falling things

/**
 * One shared fall: the faller drops `height` in `cycles` whole falls per loop,
 * shrinks to nothing as it lands, and jumps back up while hidden.
 */
function fallTrack({ height, cycles, phase, fps = 10, drift, spin }) {
  const period = LOOP / cycles;
  const jumps = [];
  for (let m = 1; m <= cycles; m += 1) jumps.push((m - phase) * period);
  const times = [];
  const N = Math.round(LOOP * fps);
  for (let i = 0; i <= N; i += 1) {
    const t = (i / N) * LOOP;
    if (jumps.some((j) => Math.abs(t - j) < 0.01)) continue;
    times.push(t);
  }
  for (const j of jumps) times.push(j - 0.002, j + 0.002);
  times.sort((a, b) => a - b);
  const translation = [];
  const rotation = [];
  const scale = [];
  for (const t of times) {
    const u = frac(t / period + phase);
    const y = height * Math.max(0, 1 - u / 0.93);
    const [dx, dz] = drift(u);
    translation.push(dx, y, dz);
    rotation.push(...spin(u));
    const s = u < 0.03 ? Math.max(1e-4, u / 0.03) : u > 0.95 ? Math.max(1e-4, (1 - u) / 0.05) : 1;
    scale.push(s, s, s);
  }
  return { times, translation, rotation, scale };
}

function fallers(glb, root, mesh, { prefix, count, tracks, place, random }) {
  for (let i = 0; i < count; i += 1) {
    const tr = tracks[i % tracks.length];
    const { at, meshIndex } = place(i, tr);
    const parent = glb.node({ name: `${prefix}-${i + 1}`, translation: [at.x, at.y, at.z], rotation: quat([0, 1, 0], random() * TAU), parent: root });
    const node = glb.node({ name: `${prefix}-${i + 1}-fall`, mesh: mesh[meshIndex % mesh.length], parent, scale: HIDDEN });
    glb.animate(node, 'translation', tr.times, tr.translation);
    glb.animate(node, 'rotation', tr.times, tr.rotation);
    glb.animate(node, 'scale', tr.times, tr.scale);
  }
}

// ---------------------------------------------------------------- build

export async function build() {
  const glb = new Glb();
  glb.provenance({
    holoim: {
      authored: 'synthetic',
      author: meta.submittedBy,
      title: meta.name,
      scale: 'true size',
      seasons: { spring: 'yaw 18°', summer: 'yaw 108°', autumn: 'yaw 198°', winter: 'yaw 288°' }
    }
  });
  const random = rng(20261110);
  const paintMat = glb.material({ name: 'PaintedLight', unlit: true, doubleSided: true });
  const root = glb.node({ name: 'WalkAroundTheYear' });

  // Story places: the snowman and what is left of him stand the same distance out.
  const STORY_R = 1.18;
  const snowBase = around(288, STORY_R);
  snowBase.y = groundY(snowBase.x, snowBase.z) - 0.02;
  const remainsBase = around(18, STORY_R, Y0);
  const basketBase = around(214, 1.02, Y0);
  const tree = buildTree(random);

  // ---- static: slab, ground cover, trunk, snowman, remains, basket, windfalls
  const statics = [];
  statics.push(...slabGeometry());
  // The swing has worn a bare patch under its seat.
  const limbC = tree.groups.find((g) => g.id === 'c');
  const swing = swingPlace(limbC.limb);
  const keepOut = [
    [snowBase.x, snowBase.z, 0.3],
    [remainsBase.x, remainsBase.z, 0.36],
    [basketBase.x, basketBase.z, 0.22],
    [swing.seat.x, swing.seat.z, 0.28]
  ];
  statics.push(...groundCover(random, keepOut));
  {
    const worn = new Soup();
    const N = 24;
    const c0 = worn.v(new Vector3(swing.seat.x, Y0 + 0.003, swing.seat.z), paint(col('#6a4a2c'), swing.seat.x, swing.seat.z, 0, 1, 0));
    const ring = [];
    for (let j = 0; j < N; j += 1) {
      const th = (j / N) * TAU;
      const x = swing.seat.x + Math.cos(th) * 0.3 * (0.8 + 0.3 * noise3(th, 1, 2, 3));
      const z = swing.seat.z + Math.sin(th) * 0.22;
      ring.push(worn.v(new Vector3(x, Y0 + 0.002, z), paint(col('#5a7a2c'), x, z, 0, 1, 0)));
    }
    for (let j = 0; j < N; j += 1) worn.t(c0, ring[(j + 1) % N], ring[j]);
    statics.push(worn.geometry());
  }
  statics.push(finish(taper(tree.trunk, 0.135, 0.09, { radial: 10, segs: 14 }), barkAt));
  {
    const flare = new CylinderGeometry(0.12, 0.2, 0.22, 12, 2, true);
    flare.translate(0, Y0 + 0.08, 0);
    statics.push(finish(flare, barkAt));
  }
  statics.push(...snowman(snowBase, snowBase.clone().negate().setY(0)));
  statics.push(...remains(remainsBase, remainsBase.clone().negate().setY(0), random));
  statics.push(...basket(basketBase, random));
  for (const [yaw, r] of [[188, 0.7], [205, 1.32], [222, 0.82], [176, 1.15], [230, 1.3], [196, 1.0]]) {
    const p = around(yaw, r, Y0 + 0.036);
    statics.push(apple(p, 0.042, '#a00812', '#d8902a', [0, 0, 1, 0]));
  }
  glb.node({ name: 'year-ground', mesh: glb.mesh('year-ground', mergeGeometries(statics), paintMat), parent: root });

  // ---- the tree's limbs, each group swaying from its base in one shared wind
  const leaves = foliage(tree, random);
  const groupNodes = new Map();
  const windTracks = [0, 1.7, 3.6].map((phase, k) =>
    sample(LOOP, 8, (t) => {
      const a = (1.4 + 0.3 * k) * DEG * (0.65 * Math.sin((TAU * 2 * t) / LOOP + phase) + 0.35 * Math.sin((TAU * 5 * t) / LOOP + phase * 2));
      return quat([0.2, 0, 1], -a);
    })
  );
  tree.groups.forEach((group, gi) => {
    const geos = [];
    for (const b of tree.branches) {
      if (b.group !== group) continue;
      const radial = [7, 6, 5, 4][b.depth];
      const segs = [12, 8, 6, 4][b.depth];
      geos.push(finish(taper(b.pts, b.r0, b.r1, { radial, segs }), barkAt));
      // Snow lying along the top of the winter side's branches.
      const mid = b.pts[Math.floor(b.pts.length / 2)];
      const season = pick(jitterYaw(yawOf(mid.x, mid.z), Math.hypot(mid.x, mid.z)), random());
      const dir = b.pts[b.pts.length - 1].clone().sub(b.pts[0]).normalize();
      if (season === WINTER && Math.abs(dir.y) < 0.82) {
        const up = (r) => b.pts.map((p, i) => p.clone().add(new Vector3(0, r(i / (b.pts.length - 1)) * 0.85, 0)));
        const rAt = (u) => b.r0 + (b.r1 - b.r0) * u;
        const pts = up(rAt);
        geos.push(finish(taper(pts, Math.max(0.011, b.r0 * 0.8), Math.max(0.007, b.r1 * 0.8), { radial: 5, segs: segs }), '#f4f8ff', { accent: 0.25 }));
      }
    }
    const bucket = leaves.get(group);
    geos.push(...bucket.geos);
    if (bucket.soup.i.length) geos.push(bucket.soup.geometry());
    if (group.id === 'e') geos.push(scarfOnBranch(group.limb));
    const merged = mergeGeometries(geos);
    merged.translate(-group.pivot.x, -group.pivot.y, -group.pivot.z);
    const node = glb.node({ name: `year-limb-${group.id}`, mesh: glb.mesh(`year-limb-${group.id}`, merged, paintMat), translation: group.pivot.toArray(), parent: root });
    const wt = windTracks[gi % windTracks.length];
    glb.animate(node, 'rotation', wt.times, wt.values);
    groupNodes.set(group.id, node);
  });

  // ---- the swing, still moving a little with nobody on it
  {
    const pivot = swing.top.clone().sub(limbC.pivot);
    const base = quat([0, 1, 0], Math.atan2(swing.axis.x, swing.axis.z) - Math.PI / 2);
    const hang = glb.node({ name: 'swing-hang', translation: pivot.toArray(), rotation: base, parent: groupNodes.get('c') });
    const L = swing.top.y - swing.seat.y;
    const geos = [];
    for (const x of [-0.19, 0.19]) {
      const rope = new CylinderGeometry(0.009, 0.009, L, 5);
      rope.translate(x, -L / 2, 0);
      geos.push(finish(rope, '#d8c49a', { accent: 0.3 }));
      const loop = new TorusGeometry(0.022, 0.008, 4, 8);
      loop.rotateY(Math.PI / 2);
      loop.translate(x, 0.012, 0);
      geos.push(finish(loop, '#d8c49a'));
    }
    const seat = new CylinderGeometry(1, 1, 1, 4, 1);
    seat.rotateY(Math.PI / 4);
    seat.scale(0.36, 0.035, 0.12);
    seat.translate(0, -L, 0);
    geos.push(finish(seat, '#8a5a32', { accent: 0.2 }));
    const swingNode = glb.node({ name: 'swing', mesh: glb.mesh('swing', mergeGeometries(geos), paintMat), parent: hang });
    const sway = sample(LOOP, 15, (t) => {
      const amp = (4.2 + 1.6 * Math.sin((TAU * t) / LOOP + 0.8)) * DEG;
      return quat([1, 0, 0], amp * Math.sin((TAU * 9 * t) / LOOP));
    });
    glb.animate(swingNode, 'rotation', sway.times, sway.values);
  }

  // ---- the robin on a winter branch: turns, hops once, turns back
  {
    const limbG = tree.groups.find((g) => g.id === 'g');
    const curve = new CatmullRomCurve3(limbG.limb.pts);
    const u = 0.82;
    const p = curve.getPointAt(u);
    const r = limbG.limb.r0 + (limbG.limb.r1 - limbG.limb.r0) * u;
    const perch = p.clone().add(new Vector3(0, r * 0.95 + 0.012, 0)).sub(limbG.pivot);
    const out = around(300, 1);
    const perchNode = glb.node({ name: 'robin-perch', translation: perch.toArray(), rotation: quat([0, 1, 0], Math.atan2(out.x, out.z)), parent: groupNodes.get('g') });
    const bird = glb.node({ name: 'robin', mesh: glb.mesh('robin', robinGeometry(), paintMat), parent: perchNode, scale: [1.3, 1.3, 1.3] });
    const keys = [
      [0, 0, 0],
      [13.4, 0, 0],
      [13.6, 0, 55],
      [16.5, 0, 55],
      [16.62, 0.04, 20],
      [16.7, 0.055, -10],
      [16.78, 0.04, -30],
      [16.9, 0, -40],
      [19.0, 0, -40],
      [19.25, 0, 0],
      [LOOP, 0, 0]
    ];
    glb.animate(bird, 'translation', keys.map((k) => k[0]), keys.flatMap((k) => [0, k[1], 0]));
    glb.animate(bird, 'rotation', keys.map((k) => k[0]), keys.flatMap((k) => quat([0, 1, 0], k[2] * DEG)));
  }

  // ---- butterflies wandering the summer side
  {
    const colors = ['#ffd21e', '#ffffff', '#ff8a1e'];
    const flaps = [0, 0.9].map((phase) => {
      const s = sample(LOOP, 20, (t) => [0.25 + 0.75 * Math.sin((TAU * 50 * t) / LOOP + phase)]);
      return {
        times: s.times,
        left: s.values.flatMap((a) => quat([0, 0, 1], -a)),
        right: s.values.flatMap((a) => quat([0, 0, 1], a))
      };
    });
    colors.forEach((color, i) => {
      const c = around(100 + i * 14, 1.15 + i * 0.12, 0.75 + i * 0.12);
      const p1 = i * 1.7;
      const path = (t) => {
        const w = (TAU * t) / LOOP;
        return [
          c.x + 0.32 * Math.sin(2 * w + p1) + 0.1 * Math.sin(5 * w + i),
          c.y + 0.22 * Math.sin(3 * w + p1 * 0.5) + 0.05 * Math.sin(11 * w + i),
          c.z + 0.34 * Math.sin(3 * w + p1 + 1.1) + 0.08 * Math.sin(7 * w)
        ];
      };
      const move = sample(LOOP, 12, path);
      const turn = sample(LOOP, 12, (t) => {
        const a = path(t);
        const b = path(t + 0.08);
        return quat([0, 1, 0], Math.atan2(b[0] - a[0], b[2] - a[2]));
      });
      const body = glb.node({ name: `butterfly-${i + 1}`, translation: move.values.slice(0, 3), parent: root });
      glb.animate(body, 'translation', move.times, move.values);
      glb.animate(body, 'rotation', turn.times, turn.values);
      const flap = flaps[i % 2];
      const left = glb.node({ name: `butterfly-${i + 1}-wl`, mesh: glb.mesh(`butterfly-${i + 1}-wl`, wingGeometry(color, -1), paintMat), parent: body });
      const right = glb.node({ name: `butterfly-${i + 1}-wr`, mesh: glb.mesh(`butterfly-${i + 1}-wr`, wingGeometry(color, 1), paintMat), parent: body });
      glb.animate(left, 'rotation', flap.times, flap.left);
      glb.animate(right, 'rotation', flap.times, flap.right);
    });
  }

  // ---- falling things: petals in spring, leaves in autumn, snow in winter
  {
    const card = (size, color, w = 0.6) => {
      const soup = new Soup();
      const c = new Color(color);
      const a = soup.v(new Vector3(0, 0, -size / 2), c);
      const b = soup.v(new Vector3(size * w * 0.5, 0, 0), c);
      const d = soup.v(new Vector3(0, 0, size / 2), c.clone().multiplyScalar(0.8));
      const e = soup.v(new Vector3(-size * w * 0.5, 0, 0), c);
      soup.t(a, b, d);
      soup.t(a, d, e);
      return soup.geometry();
    };
    const petalMeshes = ['#fff0f4', '#f8c4d4'].map((c, i) => glb.mesh(`petal-${i}`, card(0.036, paint(col(c), 0.4, 1.2, 0, 1, 0, { accent: 0.4 }), 0.8), paintMat));
    const leafMeshes = AUTUMN_LEAF.map((h, i) => glb.mesh(`leaf-${i}`, card(0.075, paint(h(0.5), -0.4, -1.2, 0, 1, 0, { accent: 0.4 }), 0.55), paintMat));
    const flake = new IcosahedronGeometry(0.014, 0);
    const snowMesh = glb.mesh('snowflake', finish(flake, '#ffffff', { lit: false }), paintMat);

    const petalTracks = [0, 1, 2, 3, 4, 5].map((k) => {
      const height = 1.35 + 0.15 * (k % 3);
      return fallTrack({
        height,
        cycles: 3,
        phase: 0.08 + k / 6.3,
        drift: (u) => [0.25 * u + 0.06 * Math.sin(TAU * 3 * u + k), 0.08 * Math.sin(TAU * 2 * u + k * 2)],
        spin: (u) => quatMul(quat([0, 1, 0], TAU * 2 * u + k), quat([1, 0, 0.3], 0.9 * Math.sin(TAU * 4 * u)))
      });
    });
    fallers(glb, root, petalMeshes, {
      prefix: 'petal',
      count: 70,
      tracks: petalTracks,
      random,
      place: (i, tr) => {
        const yaw = 18 + (random() - 0.5) * 70;
        const r = 0.35 + random() * 0.95;
        const top = tr.translation[1];
        return { at: around(yaw, r, Y0 + 2.3 - top + (random() - 0.5) * 0.1), meshIndex: i };
      }
    });
    const leafTracks = [0, 1, 2, 3, 4, 5].map((k) =>
      fallTrack({
        height: 1.3 + 0.12 * (k % 3),
        cycles: 2,
        phase: 0.05 + k / 6.2,
        drift: (u) => [0.13 * Math.cos(TAU * 2 * u + k) - 0.13 * Math.cos(k), 0.13 * Math.sin(TAU * 2 * u + k) - 0.13 * Math.sin(k)],
        spin: (u) => quatMul(quat([0, 1, 0], TAU * 2 * u + k), quat([1, 0, 0], 0.6 + 0.5 * Math.sin(TAU * 3 * u)), quat([0, 0, 1], TAU * 3 * u))
      })
    );
    fallers(glb, root, leafMeshes, {
      prefix: 'leaf',
      count: 44,
      tracks: leafTracks,
      random,
      place: (i, tr) => {
        const yaw = 198 + (random() - 0.5) * 70;
        const r = 0.4 + random() * 0.9;
        return { at: around(yaw, r, Y0 + 2.15 - tr.translation[1]), meshIndex: i };
      }
    });
    const snowTracks = [0, 1, 2, 3, 4, 5, 6, 7].map((k) =>
      fallTrack({
        height: 2.85,
        cycles: 2,
        phase: 0.04 + k / 8.3,
        drift: (u) => [0.05 * Math.sin(TAU * 3 * u + k), 0.05 * Math.cos(TAU * 2 * u + k * 1.3)],
        spin: (u) => quat([0.3, 1, 0.2], TAU * u)
      })
    );
    fallers(glb, root, [snowMesh], {
      prefix: 'snow',
      count: 120,
      tracks: snowTracks,
      random,
      place: () => {
        const yaw = 288 + (random() - 0.5) * 74;
        const r = 0.2 + Math.sqrt(random()) * 1.45;
        const p = around(yaw, r, 0);
        p.y = groundY(p.x, p.z) - 0.005;
        return { at: p, meshIndex: 0 };
      }
    });
  }

  glb.audio(sound());
  return glb;
}

/** Where the swing's ropes meet the summer bough, and where its seat hangs. */
function swingPlace(limb) {
  const curve = new CatmullRomCurve3(limb.pts);
  let best = 0.5;
  for (let u = 0.3; u <= 0.95; u += 0.01) {
    const p = curve.getPointAt(u);
    if (Math.hypot(p.x, p.z) < 0.82) best = u;
  }
  const p = curve.getPointAt(best);
  const tan = curve.getTangentAt(best);
  const r = limb.r0 + (limb.r1 - limb.r0) * best;
  const axis = new Vector3(tan.x, 0, tan.z).normalize();
  const top = p.clone().add(new Vector3(0, -r * 0.9, 0));
  const seat = new Vector3(top.x, Y0 + 0.46, top.z);
  return { top, seat, axis };
}

/** The scarf hung over the autumn limb, both ends down. */
function scarfOnBranch(limb) {
  const curve = new CatmullRomCurve3(limb.pts);
  let best = 0.5;
  for (let u = 0.2; u <= 0.9; u += 0.01) if (Math.hypot(curve.getPointAt(u).x, curve.getPointAt(u).z) < 0.62) best = u;
  const p = curve.getPointAt(best);
  const tan = curve.getTangentAt(best);
  const r = limb.r0 + (limb.r1 - limb.r0) * best;
  const a = new Vector3(tan.x, 0, tan.z).normalize();
  const s = new Vector3().crossVectors(UP, a).normalize();
  const o = (side, down) => p.clone().addScaledVector(s, side).add(new Vector3(0, r + 0.012 - down, 0));
  const pts = [o(0.06, 0.62), o(0.065, 0.45), o(0.06, 0.2), o(0.045, 0.04), o(0, -0.005), o(-0.045, 0.04), o(-0.06, 0.2), o(-0.065, 0.38), o(-0.07, 0.48)];
  const soup = new Soup();
  ribbon(soup, pts, (u) => 0.1 + 0.015 * Math.sin(u * Math.PI), () => a.clone(), scarfColor, { samples: 48 });
  return soup.geometry();
}

// ---------------------------------------------------------------- sound

function sound() {
  const out = track(LOOP);
  const N = out.length;
  // Wind: low-passed noise, cross-faded over the seam, breathing twice a loop.
  {
    const F = Math.round(2 * SAMPLE_RATE);
    const raw = new Float32Array(N + F);
    const r = noise(17);
    for (let i = 0; i < raw.length; i += 1) raw[i] = r();
    lowpass(raw, 300);
    lowpass(raw, 380);
    for (let i = 0; i < N; i += 1) {
      let s = raw[i];
      if (i < F) {
        const a = i / F;
        s = raw[i] * Math.sin((a * Math.PI) / 2) + raw[N + i] * Math.cos((a * Math.PI) / 2);
      }
      const t = i / SAMPLE_RATE;
      out[i] += s * 0.5 * (0.7 + 0.3 * Math.sin((TAU * 2 * t) / LOOP + 1));
    }
  }
  // A plucked bell, one phrase per season.
  const bell = (hz) => (t) => Math.sin(TAU * hz * t) + 0.3 * Math.sin(TAU * hz * 2 * t) * Math.exp(-t * 2.5) + 0.08 * Math.sin(TAU * hz * 3.01 * t) * Math.exp(-t * 6);
  const note = (at, hz, gain, decay = 0.9) => add(out, at, 4, bell(hz), (t) => gain * (t < 0.005 ? t / 0.005 : Math.exp(-t / decay)));
  const D3 = 146.83;
  const A3 = 220.0;
  const D4 = 293.66;
  const FS4 = 369.99;
  const A4 = 440.0;
  const B4 = 493.88;
  const D5 = 587.33;
  const E5 = 659.25;
  // Spring: bright and rising.
  note(0.3, A4, 0.12, 0.7);
  note(0.9, B4, 0.11, 0.7);
  note(1.5, D5, 0.11, 0.7);
  note(2.3, E5, 0.1, 1.1);
  // Summer: full, with a low root under it.
  note(5.2, D3, 0.1, 1.6);
  note(5.2, D4, 0.12, 1.2);
  note(5.9, FS4, 0.11, 1.0);
  note(6.6, A4, 0.11, 1.0);
  note(7.6, FS4, 0.1, 1.3);
  // Autumn: falling.
  note(10.2, E5, 0.1, 0.9);
  note(10.9, D5, 0.1, 0.9);
  note(11.6, B4, 0.1, 0.9);
  note(12.4, A4, 0.1, 1.0);
  note(13.3, FS4, 0.1, 1.4);
  // Winter: sparse, ringing long into spring.
  note(15.6, D4, 0.1, 1.8);
  note(18.0, A3, 0.09, 2.2);
  // The robin, as it hops.
  const chirp = (at, f0, f1, len, gain) =>
    add(out, at, len, (t) => Math.sin(TAU * (f0 * t + ((f1 - f0) * t * t) / (2 * len))), (t) => gain * Math.sin((Math.PI * t) / len) ** 2);
  chirp(16.35, 2300, 2900, 0.09, 0.05);
  chirp(16.5, 2800, 2400, 0.08, 0.045);
  chirp(16.95, 2500, 3100, 0.1, 0.04);
  chirp(17.12, 3000, 2600, 0.14, 0.035);
  lowpass(out, 5000);
  return toWav(normalize(out, 0.5));
}

// ---------------------------------------------------------------- tiles

const MID = [0.04, 1.49, -0.02];
const orbit = (yawDeg, pitchDeg, d) => [
  MID[0] + Math.sin(yawDeg * DEG) * Math.cos(pitchDeg * DEG) * d,
  MID[1] + Math.sin(pitchDeg * DEG) * d,
  MID[2] + Math.cos(yawDeg * DEG) * Math.cos(pitchDeg * DEG) * d
];
const SNOW_AT = around(288, 1.18, 0.45);
const REMAINS_AT = around(18, 1.18, 0.1);
export const tiles = [
  { label: 'feed', cam: orbit(18, 16, 7.0), look: MID, t: 2 },
  { label: 'spring 18°', cam: orbit(18, 12, 6.2), look: MID, t: 5 },
  { label: 'summer 108°', cam: orbit(108, 12, 6.2), look: MID, t: 8 },
  { label: 'autumn 198°', cam: orbit(198, 12, 6.2), look: MID, t: 11 },
  { label: 'winter 288°', cam: orbit(288, 12, 6.2), look: MID, t: 16.7 },
  { label: 'snowman', cam: around(318, 2.6, 1.2).toArray(), look: SNOW_AT.toArray(), t: 4, fov: 40 },
  { label: 'spring remains', cam: around(40, 2.7, 1.25).toArray(), look: REMAINS_AT.toArray(), t: 10, fov: 40 },
  { label: 'top: the year', cam: [0, 9.5, 1.6], look: [0, 0.5, 0], t: 14 },
  { label: 'autumn close', cam: around(225, 2.9, 1.3).toArray(), look: around(205, 0.6, 0.6).toArray(), t: 17, fov: 40 }
];
