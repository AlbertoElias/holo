import {
  BufferGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  ConeGeometry,
  Euler,
  Float32BufferAttribute,
  LatheGeometry,
  Matrix4,
  Object3D,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
  Uint32BufferAttribute,
  Vector2,
  Vector3
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { add, lowpass, noise, normalize, pluck, sine, toWav, track } from './lib/audio.mjs';
import { renderLabels } from './lib/browser.mjs';
import { Glb, sample } from './lib/glb.mjs';
import { addLabel, fbm3, noise3, quat } from './lib/parts.mjs';
import { T } from './lib/tokens.mjs';

// "Three hearts": a blue whale's heart, a person's and a hummingbird's, each
// at its true size and beating at its true rate, in one room. The whale's
// heart is as tall as the person standing with a palm on it, and beats four
// times a minute; the person's beats 64 times; the bird's, 1,200. The loop is
// 30 s: two whale beats, 32 human beats, 600 hummingbird beats. Nothing is
// rescaled, in size or in time.

export const meta = {
  slug: 'three-hearts',
  name: 'Three hearts',
  submittedBy: 'Claude (agent-authored)'
};

const LOOP = 30;
const FPS = 20;
const FAST = 80; // keys per second for the human and hummingbird tracks
const HIDDEN = [1e-4, 1e-4, 1e-4];
const WHALE_BEATS = [3, 18]; // ventricles squeeze at these moments (4 a minute)
const HUMAN_PERIOD = 60 / 64; // 0.9375 s
const BIRD_HZ = 20; // 1,200 a minute

const GOLD = T.gold;
const GLOW = T.glow;

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const col = (hex) => new Color(hex);
const mixC = (a, b, t) => col(a).lerp(col(b), clamp(t));

// ---------------------------------------------------------------------------
// The whale's heart, modelled as signed distance fields in heart space
// (meters; y up from the apex, +x the heart's left, +z its front) and meshed
// with surface nets. Ventricles, atria and great vessels are separate meshes
// so each can squeeze on its own node.

const SLAB_Y = 0.07; // slab top
const HOLLOW = 0.045; // depth of the hollow the apex rests in
const HX = -0.4;
const HZ = -0.04;
const HY = SLAB_Y - HOLLOW - 0.008;

function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Ellipsoid that narrows below its centre toward a blunt point (an egg). */
function sdEgg(x, y, z, c, r, taper = 0) {
  const dy = y - c[1];
  const k = dy < 0 ? 1 - taper * Math.min(1, -dy / r[1]) ** 1.3 : 1;
  const ax = r[0] * k;
  const az = r[2] * k;
  const px = (x - c[0]) / ax;
  const py = dy / r[1];
  const pz = (z - c[2]) / az;
  const k0 = Math.sqrt(px * px + py * py + pz * pz);
  const k1 = Math.sqrt((px * px) / (ax * ax) + (py * py) / (r[1] * r[1]) + (pz * pz) / (az * az));
  return (k0 * (k0 - 1)) / k1;
}

/** A tube along a smooth curve; radius r0 -> r1; optional flat cut with an open lumen at the end. */
function tube(points, r0, r1 = r0, { cut = false, count = 24 } = {}) {
  const curve = new CatmullRomCurve3(points.map((p) => new Vector3(...p)));
  const pts = curve.getSpacedPoints(count).map((v) => [v.x, v.y, v.z]);
  const cum = [0];
  for (let i = 1; i < pts.length; i += 1) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  const total = cum[cum.length - 1];
  const end = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  const tl = Math.hypot(end[0] - prev[0], end[1] - prev[1], end[2] - prev[2]);
  const tEnd = [(end[0] - prev[0]) / tl, (end[1] - prev[1]) / tl, (end[2] - prev[2]) / tl];
  const pad = Math.max(r0, r1) + 0.05;
  const lo = [0, 1, 2].map((d) => Math.min(...pts.map((p) => p[d])) - pad);
  const hi = [0, 1, 2].map((d) => Math.max(...pts.map((p) => p[d])) + pad);
  return { curve, pts, cum, total, r0, r1, cut, end, tEnd, lo, hi };
}

function sdTube(tb, x, y, z) {
  const ox = Math.max(tb.lo[0] - x, x - tb.hi[0], 0);
  const oy = Math.max(tb.lo[1] - y, y - tb.hi[1], 0);
  const oz = Math.max(tb.lo[2] - z, z - tb.hi[2], 0);
  if (ox > 0 || oy > 0 || oz > 0) return Math.hypot(ox, oy, oz) + 0.04;
  let best = Infinity;
  const { pts, cum, total } = tb;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    const bx = b[0] - a[0];
    const by = b[1] - a[1];
    const bz = b[2] - a[2];
    const px = x - a[0];
    const py = y - a[1];
    const pz = z - a[2];
    const l2 = bx * bx + by * by + bz * bz;
    const h = clamp((px * bx + py * by + pz * bz) / l2);
    const d = Math.hypot(px - bx * h, py - by * h, pz - bz * h);
    const f = (cum[i] + (cum[i + 1] - cum[i]) * h) / total;
    const r = tb.r0 + (tb.r1 - tb.r0) * f;
    best = Math.min(best, d - r);
  }
  if (tb.cut) {
    const [ex, ey, ez] = tb.end;
    const [tx, ty, tz] = tb.tEnd;
    const along = (x - ex) * tx + (y - ey) * ty + (z - ez) * tz;
    best = Math.max(best, along);
    // The open lumen of a cut vessel: a bore 5 cm deep.
    const rx = x - ex - tx * along;
    const ry = y - ey - ty * along;
    const rz = z - ez - tz * along;
    const bore = Math.max(Math.hypot(rx, ry, rz) - tb.r1 * 0.66, -(along + 0.05));
    best = Math.max(best, -bore);
  }
  return best;
}

/** Distance from a point to a tube's centre line, and how far along it (0..1). */
function nearAxis(tb, x, y, z) {
  let best = Infinity;
  for (let i = 0; i < tb.pts.length - 1; i += 1) {
    const a = tb.pts[i];
    const b = tb.pts[i + 1];
    const bx = b[0] - a[0];
    const by = b[1] - a[1];
    const bz = b[2] - a[2];
    const h = clamp(((x - a[0]) * bx + (y - a[1]) * by + (z - a[2]) * bz) / (bx * bx + by * by + bz * bz));
    best = Math.min(best, Math.hypot(x - a[0] - bx * h, y - a[1] - by * h, z - a[2] - bz * h));
  }
  return best;
}

// Ventricles: the left one long and conical, making the apex; the right one
// wrapped over its front-right, ending short of the apex.
const LV = { c: [0.13, 0.5, -0.06], r: [0.37, 0.49, 0.38], taper: 0.55 };
const RV = { c: [-0.15, 0.6, 0.1], r: [0.37, 0.39, 0.34], taper: 0.5 };
const ventBase = (x, y, z) => {
  const d = smin(sdEgg(x, y, z, LV.c, LV.r, LV.taper), sdEgg(x, y, z, RV.c, RV.r, RV.taper), 0.035);
  // The base is where the atria sit: flatten the top.
  return Math.max(d, y - 0.93);
};

/** A point on the ventricles' surface at height y, in the direction theta (0 = +x, 90 deg = front). */
function onVentricles(thetaDeg, y) {
  const th = (thetaDeg * Math.PI) / 180;
  const cx = 0.03 + 0.1 * (1 - y / 0.95);
  const dx = Math.cos(th);
  const dz = Math.sin(th);
  let lo = 0;
  let hi = 0.9;
  for (let i = 0; i < 40; i += 1) {
    const m = (lo + hi) / 2;
    if (ventBase(cx + dx * m, y, -0.02 + dz * m) < 0) lo = m;
    else hi = m;
  }
  return [cx + dx * lo, y, -0.02 + dz * lo, dx, dz];
}

/** Coronary path over the surface, raised by `lift` along the outward horizontal. */
function surfacePath(keys, lift) {
  return keys.map(([th, y]) => {
    const [x, yy, z, dx, dz] = onVentricles(th, y);
    return [x + dx * lift, yy, z + dz * lift];
  });
}

const CORONARY_ARTERIES = [
  tube(surfacePath([[92, 0.86], [70, 0.7], [56, 0.5], [40, 0.3], [18, 0.12], [0, 0.06]], 0.006), 0.024, 0.012, { count: 30 }), // LAD
  tube(surfacePath([[95, 0.84], [130, 0.83], [170, 0.8], [215, 0.8], [255, 0.8]], 0.006), 0.024, 0.02, { count: 30 }), // right coronary
  tube(surfacePath([[255, 0.8], [262, 0.6], [272, 0.4], [290, 0.2]], 0.006), 0.018, 0.01), // posterior descending
  tube(surfacePath([[82, 0.85], [45, 0.84], [10, 0.83], [-30, 0.82], [-70, 0.8]], 0.006), 0.022, 0.016, { count: 30 }), // circumflex
  tube(surfacePath([[62, 0.6], [40, 0.52], [22, 0.4], [10, 0.3]], 0.006), 0.015, 0.009), // diagonal
  tube(surfacePath([[50, 0.42], [30, 0.33], [18, 0.22]], 0.006), 0.013, 0.008), // second diagonal
  tube(surfacePath([[-12, 0.83], [-18, 0.65], [-22, 0.45], [-15, 0.3]], 0.006), 0.016, 0.009), // obtuse marginal
  tube(surfacePath([[175, 0.8], [172, 0.62], [168, 0.45]], 0.006), 0.015, 0.009) // acute marginal
];
const CORONARY_VEINS = [
  tube(surfacePath([[80, 0.84], [62, 0.68], [48, 0.5], [32, 0.3]], 0.004), 0.017, 0.011), // great cardiac vein
  tube(surfacePath([[-40, 0.86], [-90, 0.86], [-120, 0.85], [-150, 0.84]], 0.004), 0.022, 0.024) // coronary sinus
];
// Pale fat padding the grooves.
const FAT = [
  tube(surfacePath([[100, 0.84], [150, 0.83], [200, 0.82], [260, 0.82], [300, 0.83], [340, 0.84], [20, 0.85], [70, 0.86]], -0.02), 0.05, 0.05, { count: 40 }),
  tube(surfacePath([[90, 0.84], [70, 0.68], [56, 0.5], [44, 0.36]], -0.02), 0.045, 0.02),
  tube(surfacePath([[255, 0.8], [264, 0.6], [272, 0.45]], -0.02), 0.04, 0.02)
];

const ventricles = (x, y, z) => {
  let d = ventBase(x, y, z);
  for (const f of FAT) d = smin(d, sdTube(f, x, y, z), 0.04);
  for (const v of CORONARY_ARTERIES) d = smin(d, sdTube(v, x, y, z), 0.012);
  for (const v of CORONARY_VEINS) d = smin(d, sdTube(v, x, y, z), 0.012);
  return d;
};

const ATRIA_PARTS = [
  { c: [-0.36, 0.93, -0.04], r: [0.25, 0.21, 0.27] }, // right atrium
  { c: [0.1, 0.98, -0.3], r: [0.33, 0.19, 0.2] }, // left atrium
  { c: [-0.22, 0.98, 0.25], r: [0.18, 0.08, 0.12] }, // right auricle
  { c: [0.43, 0.96, 0.1], r: [0.15, 0.07, 0.14] } // left auricle
];
const atria = (x, y, z) => {
  let d = Infinity;
  for (const p of ATRIA_PARTS) d = smin(d, sdEgg(x, y, z, p.c, p.r), 0.1);
  // Thin-walled and creased, unlike the smooth ventricles.
  return d + 0.014 * (fbm3(x * 14, y * 22, z * 14, { octaves: 2, seed: 71 }) - 0.5);
};

const AORTA = tube([[0, 0.8, 0.0], [-0.04, 1.08, 0.04], [-0.02, 1.27, 0.0], [0.08, 1.37, -0.1], [0.24, 1.36, -0.25], [0.36, 1.25, -0.38], [0.41, 1.05, -0.46], [0.42, 0.84, -0.48]], 0.115, 0.105, { cut: true, count: 40 });
const BRANCHES = [
  tube([[-0.01, 1.32, -0.02], [-0.04, 1.42, -0.0], [-0.06, 1.5, 0.01]], 0.055, 0.05, { cut: true, count: 8 }), // brachiocephalic
  tube([[0.12, 1.38, -0.14], [0.13, 1.46, -0.15], [0.14, 1.53, -0.15]], 0.042, 0.04, { cut: true, count: 8 }), // left common carotid
  tube([[0.24, 1.36, -0.25], [0.27, 1.44, -0.27], [0.3, 1.5, -0.28]], 0.045, 0.042, { cut: true, count: 8 }) // left subclavian
];
const PULMONARY = tube([[-0.06, 0.82, 0.3], [-0.01, 1.04, 0.29], [0.1, 1.16, 0.15]], 0.1, 0.095, { count: 16 });
const PULMONARY_L = tube([[0.1, 1.16, 0.15], [0.27, 1.19, 0.03], [0.4, 1.17, -0.06]], 0.08, 0.075, { cut: true, count: 12 });
const PULMONARY_R = tube([[0.1, 1.16, 0.15], [-0.02, 1.16, -0.1], [-0.12, 1.15, -0.2]], 0.075, 0.07, { cut: true, count: 12 });
const SVC = tube([[-0.38, 1.05, -0.05], [-0.39, 1.22, -0.06], [-0.4, 1.36, -0.07]], 0.09, 0.088, { cut: true, count: 8 });
const IVC = tube([[-0.36, 0.86, -0.16], [-0.37, 0.76, -0.25], [-0.38, 0.7, -0.33]], 0.09, 0.088, { cut: true, count: 8 });
const PULM_VEINS = [
  tube([[-0.06, 1.04, -0.36], [-0.12, 1.06, -0.48], [-0.15, 1.07, -0.56]], 0.045, 0.042, { cut: true, count: 6 }),
  tube([[-0.04, 0.93, -0.38], [-0.09, 0.9, -0.5], [-0.11, 0.88, -0.57]], 0.042, 0.04, { cut: true, count: 6 })
];
const ARTERIES = [AORTA, ...BRANCHES, PULMONARY, PULMONARY_L, PULMONARY_R];
const VEINS = [SVC, IVC, ...PULM_VEINS];
const vessels = (x, y, z) => {
  let d = Infinity;
  for (const v of ARTERIES) d = smin(d, sdTube(v, x, y, z), 0.03);
  for (const v of VEINS) d = Math.min(d, sdTube(v, x, y, z));
  return d;
};

// ---------------------------------------------------------------------------
// Surface nets: a closed SDF to an indexed, smooth-shaded mesh.

function surfaceNets(f, lo, hi, h, { normals = true } = {}) {
  const n = [0, 1, 2].map((d) => Math.ceil((hi[d] - lo[d]) / h) + 1);
  const [nx, ny, nz] = n;
  const v = new Float32Array(nx * ny * nz);
  const at = (i, j, k) => i + nx * (j + ny * k);
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) v[at(i, j, k)] = f(lo[0] + i * h, lo[1] + j * h, lo[2] + k * h);
    }
  }
  const cx = nx - 1;
  const cy = ny - 1;
  const cellAt = (i, j, k) => i + cx * (j + cy * k);
  const cell = new Int32Array(cx * cy * (nz - 1)).fill(-1);
  const pos = [];
  const corners = [];
  for (let c = 0; c < 8; c += 1) corners.push([c & 1, (c >> 1) & 1, (c >> 2) & 1]);
  const edges = [];
  for (let a = 0; a < 8; a += 1) for (let b = a + 1; b < 8; b += 1) if ([1, 2, 4].includes(a ^ b)) edges.push([a, b]);
  const vals = new Float32Array(8);
  for (let k = 0; k < nz - 1; k += 1) {
    for (let j = 0; j < ny - 1; j += 1) {
      for (let i = 0; i < nx - 1; i += 1) {
        let mask = 0;
        for (let c = 0; c < 8; c += 1) {
          vals[c] = v[at(i + corners[c][0], j + corners[c][1], k + corners[c][2])];
          if (vals[c] < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let count = 0;
        for (const [a, b] of edges) {
          if ((vals[a] < 0) === (vals[b] < 0)) continue;
          const t = vals[a] / (vals[a] - vals[b]);
          sx += corners[a][0] + (corners[b][0] - corners[a][0]) * t;
          sy += corners[a][1] + (corners[b][1] - corners[a][1]) * t;
          sz += corners[a][2] + (corners[b][2] - corners[a][2]) * t;
          count += 1;
        }
        cell[cellAt(i, j, k)] = pos.length / 3;
        pos.push(lo[0] + (i + sx / count) * h, lo[1] + (j + sy / count) * h, lo[2] + (k + sz / count) * h);
      }
    }
  }
  const index = [];
  // Split each quad along whichever diagonal keeps both triangles facing out.
  const facing = (a, b, c, axis, sign) => {
    const ax = pos[b * 3] - pos[a * 3];
    const ay = pos[b * 3 + 1] - pos[a * 3 + 1];
    const az = pos[b * 3 + 2] - pos[a * 3 + 2];
    const bx = pos[c * 3] - pos[a * 3];
    const by = pos[c * 3 + 1] - pos[a * 3 + 1];
    const bz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const n = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
    return (sign * n[axis]) / (Math.hypot(...n) || 1);
  };
  const quad = (a, b, c, d, flip, axis) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    const sign = flip ? -1 : 1;
    if (flip) [b, d] = [d, b];
    const ac = Math.min(facing(a, b, c, axis, sign), facing(a, c, d, axis, sign));
    const bd = Math.min(facing(a, b, d, axis, sign), facing(b, c, d, axis, sign));
    if (ac >= bd) index.push(a, b, c, a, c, d);
    else index.push(a, b, d, b, c, d);
  };
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const inside = v[at(i, j, k)] < 0;
        if (i < nx - 1 && j > 0 && k > 0 && j < ny - 1 && k < nz - 1 && inside !== v[at(i + 1, j, k)] < 0) {
          quad(cell[cellAt(i, j - 1, k - 1)], cell[cellAt(i, j, k - 1)], cell[cellAt(i, j, k)], cell[cellAt(i, j - 1, k)], !inside, 0);
        }
        if (j < ny - 1 && i > 0 && k > 0 && i < nx - 1 && k < nz - 1 && inside !== v[at(i, j + 1, k)] < 0) {
          quad(cell[cellAt(i - 1, j, k - 1)], cell[cellAt(i - 1, j, k)], cell[cellAt(i, j, k)], cell[cellAt(i, j, k - 1)], !inside, 1);
        }
        if (k < nz - 1 && i > 0 && j > 0 && i < nx - 1 && j < ny - 1 && inside !== v[at(i, j, k + 1)] < 0) {
          quad(cell[cellAt(i - 1, j - 1, k)], cell[cellAt(i, j - 1, k)], cell[cellAt(i, j, k)], cell[cellAt(i - 1, j, k)], !inside, 2);
        }
      }
    }
  }
  // Pull each vertex onto the true surface, and take normals from the field.
  const e = h * 0.25;
  const grad = (x, y, z) => {
    const g = [f(x + e, y, z) - f(x - e, y, z), f(x, y + e, z) - f(x, y - e, z), f(x, y, z + e) - f(x, y, z - e)];
    const l = Math.hypot(...g) || 1;
    return g.map((c) => c / l);
  };
  const nor = [];
  for (let p = 0; p < pos.length; p += 3) {
    for (let it = 0; it < 1; it += 1) {
      const d = f(pos[p], pos[p + 1], pos[p + 2]);
      const g = grad(pos[p], pos[p + 1], pos[p + 2]);
      const step = clamp(d, -h * 0.2, h * 0.2);
      pos[p] -= g[0] * step;
      pos[p + 1] -= g[1] * step;
      pos[p + 2] -= g[2] * step;
    }
    if (normals) nor.push(...grad(pos[p], pos[p + 1], pos[p + 2]));
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
  if (normals) geometry.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  geometry.setIndex(new Uint32BufferAttribute(index, 1));
  return geometry;
}

function paint(geometry, fn) {
  const p = geometry.attributes.position;
  const c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i += 1) {
    const color = fn(p.getX(i), p.getY(i), p.getZ(i));
    c.set([color.r, color.g, color.b], i * 3);
  }
  geometry.setAttribute('color', new Float32BufferAttribute(c, 3));
  return geometry;
}

function muscle(x, y, z, deep, bright) {
  const n = fbm3(x * 6, y * 6, z * 6, { seed: 3 });
  const streak = fbm3(x * 3 + y * 9, y * 2, z * 3 - y * 9, { seed: 8 });
  const c = mixC(deep, bright, n * 1.3 - 0.15);
  c.lerp(col('#4a1a12'), smooth(0.55, 0.75, streak) * 0.5);
  return c;
}

function ventricleColor(x, y, z) {
  let dA = Infinity;
  for (const v of CORONARY_ARTERIES) dA = Math.min(dA, sdTube(v, x, y, z));
  let dV = Infinity;
  for (const v of CORONARY_VEINS) dV = Math.min(dV, sdTube(v, x, y, z));
  let dF = Infinity;
  for (const v of FAT) dF = Math.min(dF, nearAxis(v, x, y, z));
  const lumps = fbm3(x * 9, y * 9, z * 9, { seed: 13 });
  const fat = smooth(0.11, 0.045, dF + (lumps - 0.5) * 0.05);
  const c = muscle(x, y, z, '#5a1214', '#8f2d27');
  c.lerp(mixC('#c9a868', '#ead7a4', lumps), fat * 0.92);
  c.lerp(mixC('#9a3530', '#b44a44', lumps), smooth(0.016, 0.0, dA));
  return c.lerp(mixC('#3a1e3c', '#54304e', lumps), smooth(0.016, 0.0, dV));
}

function atriaColor(x, y, z) {
  const c = muscle(x, y, z, '#45161e', '#6c2a2e');
  const fat = smooth(0.84, 0.8, y) * fbm3(x * 7, y * 7, z * 7, { seed: 21 });
  return c.lerp(col('#d7bd84'), smooth(0.45, 0.7, fat));
}

function vesselColor(x, y, z) {
  let best = Infinity;
  let which = null;
  for (const v of [...ARTERIES, ...VEINS]) {
    const d = sdTube(v, x, y, z);
    if (d < best) {
      best = d;
      which = v;
    }
  }
  const n = fbm3(x * 8, y * 8, z * 8, { seed: 31 });
  if (which.cut) {
    const [ex, ey, ez] = which.end;
    const [tx, ty, tz] = which.tEnd;
    const along = (x - ex) * tx + (y - ey) * ty + (z - ez) * tz;
    const rx = x - ex - tx * along;
    const ry = y - ey - ty * along;
    const rz = z - ez - tz * along;
    const radial = Math.hypot(rx, ry, rz);
    if (along > -0.052 && radial < which.r1 * 0.69) return mixC('#2a0608', '#4a0e10', smooth(-0.05, 0, along));
    if (along > -0.006) return mixC('#e8c4b4', '#f4d8c8', n); // the cut wall
  }
  if (VEINS.includes(which)) return mixC('#3e2240', '#5a3656', n);
  const c = mixC('#c08a82', '#dcb0a4', n);
  return c.lerp(col('#d9bd84'), smooth(0.6, 0.75, fbm3(x * 5, y * 5, z * 5, { seed: 33 })) * 0.6);
}

// ---------------------------------------------------------------------------
// The slab: a torn, gold-rimmed piece of dark sea floor with a shallow hollow
// where the apex rests.

const SX = -0.02;
const SZ = 0.0;
const RX = 1.22;
const RZ = 0.9;
const APEX = [HX + 0.13, HZ - 0.06];
const HOLLOW_R = 0.24;

function rimMul(theta) {
  const x = Math.cos(theta);
  const z = Math.sin(theta);
  let r = 1 + 0.12 * (fbm3(x * 1.4 + 3, z * 1.4, 0.5, { seed: 44 }) - 0.5) + 0.06 * (fbm3(x * 5 + 1, z * 5, 1.5, { seed: 49 }) - 0.5);
  r -= 0.05 * (Math.max(0, noise3(x * 7 + 1, z * 7, 2, 57) - 0.62) / 0.38);
  return r;
}

const hollowAt = (r) => HOLLOW * Math.exp(-(r * r) / (2 * HOLLOW_R * HOLLOW_R));
function topY(x, z) {
  return SLAB_Y + 0.004 * (fbm3(x * 5 + 2, z * 5, 0.3, { seed: 42 }) - 0.5) * 2 - hollowAt(Math.hypot(x - APEX[0], z - APEX[1]));
}

function slabGeometry() {
  const N = 180;
  const rows = [];
  for (let k = 0; k <= 40; k += 1) rows.push({ f: Math.max(0.002, k / 40) });
  for (let m = 1; m <= 5; m += 1) rows.push({ s: m / 5 });
  const pos = [];
  const cols = [];
  for (const row of rows) {
    for (let jj = 0; jj < N; jj += 1) {
      const theta = (jj / N) * Math.PI * 2;
      const rr = rimMul(theta);
      if (row.f !== undefined) {
        const x = SX + row.f * RX * rr * Math.cos(theta);
        const z = SZ + row.f * RZ * rr * Math.sin(theta);
        const y = topY(x, z) - 0.006 * smooth(0.9, 1, row.f);
        const nn = fbm3(x * 7, 0, z * 7, { seed: 8 });
        const c = mixC('#2b5560', '#3a6870', nn);
        c.lerp(col('#4a7a78'), smooth(0.6, 0.8, fbm3(x * 2.5, 1, z * 2.5, { seed: 10 })) * 0.5);
        c.lerp(col('#1c3a42'), smooth(0.35, 0.05, Math.hypot(x - APEX[0], z - APEX[1])) * 0.6);
        c.lerp(col('#2a1d18'), smooth(0.9, 0.955, row.f));
        c.lerp(col(GOLD), smooth(0.972, 1, row.f));
        pos.push(x, y, z);
        cols.push(c.r, c.g, c.b);
      } else {
        const shrink = 1 - 0.03 * row.s;
        const x = SX + RX * rr * shrink * Math.cos(theta);
        const z = SZ + RZ * rr * shrink * Math.sin(theta);
        const yTop = topY(SX + RX * rr * Math.cos(theta), SZ + RZ * rr * Math.sin(theta)) - 0.006;
        const y = yTop * (1 - row.s);
        const c = row.s < 0.25 ? mixC(GOLD, '#6a4a2a', row.s * 4) : mixC('#1a2b31', '#2a3e46', fbm3(theta * 4, y * 40, 1, { seed: 6 }));
        pos.push(x, y, z);
        cols.push(c.r, c.g, c.b);
      }
    }
  }
  const index = [];
  for (let i = 0; i < rows.length - 1; i += 1) {
    for (let jj = 0; jj < N; jj += 1) {
      const a = i * N + jj;
      const b = i * N + ((jj + 1) % N);
      const c = (i + 1) * N + ((jj + 1) % N);
      const d = (i + 1) * N + jj;
      // Rings grow outward then the side goes down: keep faces outward / upward.
      index.push(a, b, c, a, c, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(cols, 3));
  g.setIndex(index);
  return g;
}

// ---------------------------------------------------------------------------
// The whale's beat: atria, then ventricles, then a slow recoil; stillness between.

function beatCurve(t, rise0, rise1, fall0, fall1) {
  let v = 0;
  for (const tb of WHALE_BEATS) v += smooth(tb + rise0, tb + rise1, t) * (1 - smooth(tb + fall0, tb + fall1, t));
  return v;
}
const atriaSqueeze = (t) => beatCurve(t, -0.5, -0.15, -0.1, 1.4);
const ventSqueeze = (t) => beatCurve(t, -0.05, 0.45, 0.6, 2.6);
const vesselSwell = (t) => beatCurve(t, 0.05, 0.5, 0.6, 2.4);
const ventScale = (t) => {
  const c = ventSqueeze(t);
  return [1 - 0.035 * c, 1 - 0.05 * c, 1 - 0.035 * c];
};
const atriaScale = (t) => {
  const a = atriaSqueeze(t);
  return [1 - 0.05 * a, 1 - 0.065 * a, 1 - 0.05 * a];
};
const vesselScale = (t) => {
  const d = 1 + 0.015 * vesselSwell(t);
  return [d, d, d];
};
const V_PIVOT = [0.02, 0.92, -0.02];
const A_PIVOT = [-0.05, 1.0, -0.1];
const S_PIVOT = [0.0, 0.85, 0.0];

// ---------------------------------------------------------------------------
// The person: a faceless jointed mannequin of light (as in door.mjs), 1.70 m.

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

// The chest: opaque light like the limbs, with one opening over the heart.
const CHEST_C = [0, 0.085, 0.012];
const CHEST_R = [0.152, 0.165, 0.104];
const HEART_SEAT = [0.03, 0.075, 0.05];
const OPEN_DIR = new Vector3(0.28, -0.08, 1).normalize();
const OPEN_COS = Math.cos((42 * Math.PI) / 180);

/** An ellipsoid shell with a round opening around OPEN_DIR (cos of its half angle `cosLimit`), built in polar rings about that axis so the edge is clean. */
function openShell(c, r, k, cosLimit) {
  const a0 = Math.acos(cosLimit);
  const rings = 40;
  const around = 72;
  const axis = OPEN_DIR;
  const u = new Vector3(0, 1, 0).cross(axis).normalize();
  const w = axis.clone().cross(u);
  const pos = [];
  for (let i = 0; i <= rings; i += 1) {
    const a = a0 + ((Math.PI - a0) * i) / rings;
    for (let j = 0; j < around; j += 1) {
      const phi = (j / around) * Math.PI * 2;
      const d = axis.clone().multiplyScalar(Math.cos(a)).add(u.clone().multiplyScalar(Math.sin(a) * Math.cos(phi))).add(w.clone().multiplyScalar(Math.sin(a) * Math.sin(phi)));
      pos.push(c[0] + d.x * r[0] * k, c[1] + d.y * r[1] * k, c[2] + d.z * r[2] * k);
    }
  }
  const index = [];
  for (let i = 0; i < rings; i += 1) {
    for (let j = 0; j < around; j += 1) {
      const a = i * around + j;
      const b = i * around + ((j + 1) % around);
      const cc = (i + 1) * around + ((j + 1) % around);
      const d = (i + 1) * around + j;
      index.push(a, b, cc, a, cc, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  // Faces must point out: flip if the first ring's normal points inward.
  const n0 = new Vector3().fromBufferAttribute(g.attributes.normal, around * rings);
  const p0 = new Vector3().fromBufferAttribute(g.attributes.position, around * rings).sub(new Vector3(...c));
  if (n0.dot(p0) < 0) {
    for (let i = 0; i < index.length; i += 3) [index[i + 1], index[i + 2]] = [index[i + 2], index[i + 1]];
    g.setIndex(index);
    g.computeVertexNormals();
  }
  return g;
}

function figureParts() {
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
  return {
    pelvis: [ell(0.152, 0.11, 0.1, [0, -0.03, 0]), ell(0.14, 0.085, 0.09, [0, -0.055, -0.03])],
    spine: [ell(0.122, 0.1, 0.09, [0, 0.06, 0.006])],
    chestBreath: [openShell(CHEST_C, CHEST_R, 1, OPEN_COS)],
    neck: [limb([0, 0.055, 0], [0, 0.09, 0.006], 0.05, 0.045)],
    head: [ell(0.079, 0.113, 0.096, [0, 0.062, 0.014]), ell(0.058, 0.055, 0.066, [0, 0.008, 0.036])],
    shoulderL: L.shoulder,
    elbowL: L.elbow,
    wristL: L.hand,
    shoulderR: R.shoulder,
    elbowR: R.elbow,
    wristR: R.hand,
    hipL: L.hip,
    kneeL: L.knee,
    ankleL: L.ankle,
    hipR: R.hip,
    kneeR: R.knee,
    ankleR: R.ankle
  };
}

function mergedParts(list) {
  return mergeGeometries(list.map((p) => (p.attributes.uv ? p.deleteAttribute('uv') : p)));
}

class Rig {
  constructor({ x0, z0, yaw }) {
    this.root = new Object3D();
    this.root.position.set(x0, 0, z0);
    this.root.quaternion.fromArray(quat([0, 1, 0], yaw));
    this.j = {};
    for (const [name, parent, offset] of SKELETON) {
      const o = new Object3D();
      o.position.set(...offset);
      (parent ? this.j[parent] : this.root).add(o);
      this.j[name] = o;
    }
    this.breath = new Object3D();
    this.j.chest.add(this.breath);
    this.geo = {};
    for (const [name, list] of Object.entries(figureParts())) this.geo[name] = mergedParts(list);
    this.root.updateMatrixWorld(true);
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
/** Two-bone IK (from door.mjs): sign +1 bends like an elbow, -1 like a knee. */
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

/** Orients a joint so its -Y runs along `along` and its X along `across` (world). */
function aimJoint(joint, along, across) {
  const Y = along.clone().negate().normalize();
  const X = across.clone().sub(Y.clone().multiplyScalar(across.dot(Y))).normalize();
  const Z = new Vector3().crossVectors(X, Y);
  _basis.makeBasis(X, Y, Z);
  const q = new Quaternion().setFromRotationMatrix(_basis);
  const parentQ = joint.parent.getWorldQuaternion(new Quaternion());
  joint.quaternion.copy(parentQ.invert().multiply(q));
  joint.updateMatrixWorld(true);
}

// ---------------------------------------------------------------------------
// The performance.

const PALM_Y = 0.84; // heart space
const PALM_THETA = 4;
const [px0, , pz0, pdx, pdz] = onVentricles(PALM_THETA, PALM_Y);
const PALM_LOCAL = [px0, PALM_Y, pz0];
const PALM_N = new Vector3(pdx, 0, pdz).normalize();

const heartToWorld = (p) => new Vector3(p[0] + HX, p[1] + HY, p[2] + HZ);
const palmWorld = (t) => {
  const s = ventScale(t);
  const p = PALM_LOCAL.map((v, i) => V_PIVOT[i] + (v - V_PIVOT[i]) * s[i]);
  return heartToWorld(p);
};

/** 0 -> 1 just after each whale beat, back to 0 well before the next. */
const headTip = (t) => {
  let v = 0;
  for (const tb of WHALE_BEATS) v += smooth(tb + 0.7, tb + 2.6, t) * (1 - smooth(tb + 6.5, tb + 11, t));
  return v;
};
const LEFT_HAND = [0.9, 0.25, 0.32];
const breath = (t) => Math.sin((2 * Math.PI * t) / 5);

function posePerson(rig, t) {
  const { j } = rig;
  const tip = headTip(t);
  const b = breath(t);
  j.pelvis.position.set(0, 0.955 + 0.002 * b, 0);
  j.pelvis.quaternion.copy(eul(0, 0.05, 0));
  j.spine.quaternion.copy(eul(0.04, -0.04, 0.02));
  j.chest.quaternion.copy(eul(0.05 + 0.006 * b, -0.14, 0.03));
  j.neck.quaternion.copy(eul(0.12 + 0.03 * tip, -0.22 - 0.04 * tip, 0.02 + 0.06 * tip));
  j.head.quaternion.copy(eul(0.2 + 0.08 * tip, -0.25 - 0.06 * tip, 0.03 + 0.1 * tip));
  rig.breath.scale.set(1 + 0.012 * b, 1 + 0.008 * b, 1 + 0.018 * b);
  rig.root.updateMatrixWorld(true);

  const rootQ = rig.root.quaternion;
  const feet = { L: [0.11, ANKLE_H, -0.04, 0.12], R: [-0.1, ANKLE_H, 0.1, -0.18] };
  for (const sideName of ['L', 'R']) {
    const [fx, fy, fz, yaw] = feet[sideName];
    const target = rig.toWorld([fx, fy, fz]);
    const pole = rig.dirToWorld([sideName === 'L' ? 0.12 : -0.12, 0, 1]);
    twoBone(j[`hip${sideName}`], j[`knee${sideName}`], j[`ankle${sideName}`].position.length(), target, pole, -1);
    const desired = rootQ.clone().multiply(eul(0, yaw, 0));
    const kneeQ = j[`knee${sideName}`].getWorldQuaternion(new Quaternion());
    j[`ankle${sideName}`].quaternion.copy(kneeQ.invert().multiply(desired));
  }

  // Right palm flat on the heart, riding it as it beats.
  const palm = palmWorld(t);
  const shoulderR = j.shoulderR.getWorldPosition(new Vector3());
  const reach = palm.clone().sub(shoulderR);
  const handDir = reach.clone().sub(PALM_N.clone().multiplyScalar(reach.dot(PALM_N))).normalize();
  const wristR = palm.clone().sub(handDir.clone().multiplyScalar(0.085)).add(PALM_N.clone().multiplyScalar(0.016));
  twoBone(j.shoulderR, j.elbowR, j.wristR.position.length(), wristR, rig.dirToWorld([-0.6, -0.7, -0.3]), 1);
  aimJoint(j.wristR, handDir, PALM_N);

  // Left hand half raised, palm up, offered to the hummingbird.
  const wristL = rig.toWorld([0.47, 1.17, 0.12]);
  twoBone(j.shoulderL, j.elbowL, j.wristL.position.length(), wristL, rig.dirToWorld([0.7, -0.6, -0.2]), 1);
  aimJoint(j.wristL, rig.dirToWorld(LEFT_HAND), new Vector3(0, 1, 0));
  rig.root.updateMatrixWorld(true);
}

function writeFigure(glb, rig, frames, { name, materials, times }) {
  const root = glb.node({ name, translation: rig.root.position.toArray(), rotation: rig.root.quaternion.toArray() });
  const nodes = {};
  const meshFor = (part) => glb.mesh(`${name}-${part}`, rig.geo[part], materials[part] ?? materials.body);
  for (const [joint, parent, offset] of SKELETON) {
    nodes[joint] = glb.node({
      name: `${name}-${joint}`,
      mesh: rig.geo[joint] ? meshFor(joint) : undefined,
      translation: joint === 'pelvis' ? frames[0].pelvis : offset,
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
    let moves = false;
    for (const f of frames) {
      let q = f.q[joint];
      if (prev && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0) q = q.map((v) => -v);
      if (prev && Math.abs(prev[0] - q[0]) + Math.abs(prev[1] - q[1]) + Math.abs(prev[2] - q[2]) > 1e-6) moves = true;
      values.push(...q);
      prev = q;
    }
    if (moves) glb.animate(nodes[joint], 'rotation', times, values);
  }
  glb.animate(nodes.pelvis, 'translation', times, frames.flatMap((f) => f.pelvis));
  glb.animate(nodes.chestBreath, 'scale', times, frames.flatMap((f) => f.breath));
  return nodes;
}

// ---------------------------------------------------------------------------
// Sound: the three tempos, quiet.

function sound() {
  const out = track(LOOP);
  // The whale: a deep soft double thump (45 Hz with a 125 Hz partial small
  // speakers can carry), with a long tail.
  const thump = (hz, partial) => (t) => {
    const ph = 2 * Math.PI * (hz * t + hz * 0.35 * 0.06 * (1 - Math.exp(-t / 0.06)));
    return Math.sin(ph) + 0.12 * Math.sin(2 * ph) + 0.55 * Math.sin(2 * Math.PI * partial * t) * Math.exp(-t / 0.18);
  };
  for (const tb of WHALE_BEATS) {
    add(out, tb, 4, thump(45, 125), (t) => 1.0 * pluck(0.035, 0.75)(t));
    add(out, tb + 0.62, 4, thump(52, 140), (t) => 0.6 * pluck(0.03, 0.6)(t));
  }
  // The person: a soft lub-dub, 32 a loop.
  const small = (hz) => (t) => Math.sin(2 * Math.PI * hz * t) + 0.3 * Math.sin(2 * Math.PI * hz * 2 * t);
  for (let k = 0; k < 32; k += 1) {
    const tk = k * HUMAN_PERIOD;
    add(out, tk, 0.35, small(68), (t) => 0.2 * pluck(0.008, 0.06)(t));
    add(out, tk + 0.3, 0.3, small(82), (t) => 0.13 * pluck(0.006, 0.045)(t));
  }
  // The hummingbird: a faint purr of 20 ticks a second over a low wing hum.
  const ticks = track(LOOP);
  const random = noise(11);
  for (let k = 0; k < LOOP * BIRD_HZ; k += 1) {
    add(ticks, k / BIRD_HZ, 0.02, () => random(), (t) => pluck(0.001, 0.004)(t));
  }
  lowpass(ticks, 900);
  lowpass(ticks, 1200);
  let peak = 0;
  for (const v of ticks) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < out.length; i += 1) out[i] += (ticks[i] / peak) * 0.035;
  add(out, 0, LOOP, (t) => (0.03 * sine(52)(t) + 0.012 * sine(104)(t)) * (0.8 + 0.2 * sine(1 / 6)(t)));
  return toWav(normalize(out, 0.7));
}

// ---------------------------------------------------------------------------

export async function build() {
  const labels = await renderLabels([
    { id: 'whale', text: 'Blue whale\n4 beats a minute', font: 'ui', size: 30, color: T.text, letterSpacing: 0.02 },
    { id: 'human', text: 'Human\n64 beats a minute', font: 'ui', size: 30, color: T.text, letterSpacing: 0.02 },
    { id: 'bird', text: 'Hummingbird\n1,200 beats a minute', font: 'ui', size: 30, color: T.text, letterSpacing: 0.02 },
    { id: 'true', text: 'All three at true size and true tempo.', font: 'ui', size: 24, color: T.textMuted, letterSpacing: 0.03 }
  ]);

  const glb = new Glb();
  glb.provenance({
    holoim: {
      authored: 'synthetic',
      author: meta.submittedBy,
      title: meta.name,
      scale: '1:1',
      facts: {
        blueWhaleHeart: { lengthM: 1.5, widthM: 1.2, depthM: 1.2, massKg: 180, bpm: 4, source: 'Royal Ontario Museum specimen; Goldbogen et al. 2019 (4-8 bpm on dives, as low as 2)' },
        humanHeart: { lengthM: 0.12, massG: 300, bpm: 64 },
        hummingbird: { bodyLengthM: 0.09, heartM: 0.006, bpm: 1200 },
        loopSeconds: LOOP
      }
    }
  });

  const times = sample(LOOP, FPS, () => [0]).times;
  const fast = sample(LOOP, FAST, () => [0]).times;
  const scene = glb.node({ name: 'ThreeHearts' });

  // ---- slab and floor words
  const painted = glb.material({ name: 'Painted', color: '#ffffff', unlit: true });
  glb.node({ name: 'Slab', mesh: glb.mesh('Slab', slabGeometry(), painted), parent: scene });

  // ---- the whale's heart
  const wet = glb.material({ name: 'HeartWall', color: '#ffffff', roughness: 0.32, emissive: '#2a0a08' });
  const heartRoot = glb.node({ name: 'WhaleHeart', translation: [HX, HY, HZ], parent: scene });
  const part = (name, f, lo, hi, h, colorFn, pivot, scaleFn) => {
    const g = paint(surfaceNets(f, lo, hi, h), colorFn);
    g.translate(-pivot[0], -pivot[1], -pivot[2]);
    const node = glb.node({ name, mesh: glb.mesh(name, g, wet), translation: pivot, parent: heartRoot });
    glb.animate(node, 'scale', times, sample(LOOP, FPS, scaleFn).values);
  };
  part('WhaleVentricles', ventricles, [-0.62, -0.03, -0.55], [0.62, 0.97, 0.55], 0.0165, ventricleColor, V_PIVOT, ventScale);
  part('WhaleAtria', atria, [-0.66, 0.7, -0.56], [0.62, 1.28, 0.42], 0.018, atriaColor, A_PIVOT, atriaScale);
  part('WhaleVessels', vessels, [-0.55, 0.6, -0.66], [0.6, 1.58, 0.45], 0.0155, vesselColor, S_PIVOT, vesselScale);

  // ---- the beat's light: rings riding the aorta, its cut branches and the pulmonary trunk
  const ringInk = glb.material({ name: 'PulseLight', color: GLOW, unlit: true });
  const ring = (name, path, radius, t0, t1, beyond = 0.12) => {
    const pts = path.pts.map((p) => new Vector3(...p));
    const end = pts[pts.length - 1];
    const tEnd = new Vector3(...path.tEnd);
    if (path.cut) pts.push(end.clone().add(tEnd.clone().multiplyScalar(beyond)));
    const curve = new CatmullRomCurve3(pts);
    const outAt = path.cut ? 1 - beyond / curve.getLength() : 2;
    const g = new TorusGeometry(radius + 0.014, 0.019, 8, 40);
    const node = glb.node({ name, mesh: glb.mesh(name, g, ringInk), translation: path.pts[0], scale: HIDDEN, parent: heartRoot });
    const z = new Vector3(0, 0, 1);
    const at = (t) => {
      let best = null;
      for (const b of WHALE_BEATS) {
        const u = (t - (b + t0)) / (t1 - t0);
        if (u >= -0.05 && u <= 1.05) best = clamp(u);
      }
      return best;
    };
    const tr = sample(LOOP, FPS, (t) => {
      const u = at(t);
      return (u === null ? curve.getPointAt(0) : curve.getPointAt(u)).toArray();
    });
    let prev = null;
    const rot = sample(LOOP, FPS, (t) => {
      const u = at(t) ?? 0;
      let q = new Quaternion().setFromUnitVectors(z, curve.getTangentAt(u)).toArray();
      if (prev && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0) q = q.map((v) => -v);
      prev = q;
      return q;
    });
    const sc = sample(LOOP, FPS, (t) => {
      const u = at(t);
      if (u === null) return HIDDEN;
      const k = Math.max(1e-4, smooth(0, 0.08, u) * (1 - smooth(Math.min(outAt, 0.92), 1, u)));
      return [k, k, k];
    });
    glb.animate(node, 'translation', times, tr.values);
    glb.animate(node, 'rotation', times, rot.values);
    glb.animate(node, 'scale', times, sc.values);
  };
  ring('PulseAorta', AORTA, 0.115, 0.05, 1.6);
  ring('PulseBrachiocephalic', BRANCHES[0], 0.055, 0.3, 0.75);
  ring('PulseCarotid', BRANCHES[1], 0.042, 0.42, 0.85);
  ring('PulseSubclavian', BRANCHES[2], 0.045, 0.55, 1.0);
  ring('PulsePulmonary', tube([...PULMONARY.pts.filter((_, i) => i % 4 === 0), ...PULMONARY_L.pts.slice(4).filter((_, i) => i % 4 === 0), PULMONARY_L.end], 0.1, 0.08, { cut: true }), 0.1, 0.05, 1.0);

  // A wide slow ring of light across the slab from under the heart.
  const waveInk = glb.material({ name: 'FloorWave', color: GLOW, opacity: 0.6, unlit: true });
  const wave = new RingGeometry(0.585, 0.615, 120, 1);
  wave.rotateX(-Math.PI / 2);
  const waveNode = glb.node({ name: 'FloorWave', mesh: glb.mesh('FloorWave', wave, waveInk), translation: [APEX[0], SLAB_Y, APEX[1]], scale: HIDDEN, parent: scene });
  const waveR = (t) => {
    for (const tb of WHALE_BEATS) {
      const u = (t - tb - 0.1) / 3.6;
      if (u >= 0 && u <= 1) return 0.32 + (0.74 - 0.32) * (1 - (1 - u) ** 2);
    }
    return null;
  };
  glb.animate(waveNode, 'scale', times, sample(LOOP, FPS, (t) => {
    const r = waveR(t);
    return r === null ? HIDDEN : [r / 0.6, 1, r / 0.6];
  }).values);
  glb.animate(waveNode, 'translation', times, sample(LOOP, FPS, (t) => {
    const r = waveR(t) ?? 0.5;
    return [APEX[0], SLAB_Y - hollowAt(r) + 0.005, APEX[1]];
  }).values);

  // ---- the person
  const PERSON_YAW = Math.atan2(-0.38, 0.92);
  const rig = new Rig({ x0: 0, z0: 0, yaw: PERSON_YAW });
  // Stand them beside the heart, an arm's length from the palm.
  const palm0 = palmWorld(0);
  rig.root.position.set(palm0.x + PALM_N.x * 0.42, 0, palm0.z + PALM_N.z * 0.42 + 0.08);
  rig.root.updateMatrixWorld(true);
  const frames = [];
  for (const t of times) {
    posePerson(rig, t);
    const f = { t, q: {}, pelvis: rig.j.pelvis.position.toArray(), breath: rig.breath.scale.toArray() };
    for (const [name] of SKELETON) f.q[name] = rig.j[name].quaternion.toArray();
    frames.push(f);
  }
  posePerson(rig, 0);
  const body = glb.material({ name: 'Person', color: T.identity[3], emissive: T.identity[5], emissiveStrength: 0.55, roughness: 0.4 });
  const fig = writeFigure(glb, rig, frames, { name: 'fig', materials: { body }, times });
  // Inside the opening: a warm cavity, brightest just behind the heart (painted, opaque).
  const cavity = paint(openShell(CHEST_C, CHEST_R, 0.9, Math.cos((37 * Math.PI) / 180)), (x, y, z) => {
    const d = Math.hypot(x - HEART_SEAT[0], y - HEART_SEAT[1], (z - HEART_SEAT[2]) * 0.6);
    return mixC('#e06438', '#5a1a10', smooth(0.03, 0.16, d));
  });
  const cavityInk = glb.material({ name: 'ChestCavity', color: '#ffffff', unlit: true, doubleSided: true });
  glb.node({ name: 'fig-chestCavity', mesh: glb.mesh('ChestCavity', cavity, cavityInk), parent: fig.chestBreath });

  // The person's own heart, true size (12 cm), glowing through the chest.
  const human = surfaceNets((x, y, z) => Math.min(ventBase(x, y, z), atria(x, y, z), vessels(x, y, z)), [-0.7, -0.05, -0.62], [0.66, 1.6, 0.5], 0.03);
  // Unlit, so the shading is painted: lit from above-front, vessels paler, atria deeper.
  {
    const P = human.attributes.position;
    const N = human.attributes.normal;
    const light = new Vector3(0.3, 0.7, 0.65).normalize();
    const c = new Float32Array(P.count * 3);
    for (let i = 0; i < P.count; i += 1) {
      const x = P.getX(i);
      const y = P.getY(i);
      const z = P.getZ(i);
      const dv = ventBase(x, y, z);
      const da = atria(x, y, z);
      const ds = vessels(x, y, z);
      const base = ds < Math.min(dv, da) ? col('#ffd0b8') : da < dv ? col('#ff5a40') : col('#ff8456');
      const shade = 0.5 + 0.6 * Math.max(0, N.getX(i) * light.x + N.getY(i) * light.y + N.getZ(i) * light.z);
      base.multiplyScalar(shade);
      c.set([Math.min(1, base.r), Math.min(1, base.g), Math.min(1, base.b)], i * 3);
    }
    human.setAttribute('color', new Float32BufferAttribute(c, 3));
    human.deleteAttribute('normal');
  }
  human.translate(-0.0, -0.75, 0.0);
  const HS = 0.12 / 1.55;
  human.scale(HS, HS, HS);
  const humanInk = glb.material({ name: 'HumanHeart', color: '#ffffff', unlit: true });
  const heartSeat = glb.node({ name: 'fig-heartSeat', translation: HEART_SEAT, rotation: quat([0, 0, 1], 0.35), parent: fig.chest });
  const humanHeart = glb.node({ name: 'HumanHeart', mesh: glb.mesh('HumanHeart', human, humanInk), parent: heartSeat });
  const lubDub = (t) => {
    const u = ((t % HUMAN_PERIOD) + HUMAN_PERIOD) % HUMAN_PERIOD;
    const bump = (c, w) => Math.exp(-(((u - c) / w) ** 2)) + Math.exp(-(((u - c - HUMAN_PERIOD) / w) ** 2));
    return bump(0.05, 0.05) + 0.6 * bump(0.33, 0.045);
  };
  glb.animate(humanHeart, 'scale', fast, sample(LOOP, FAST, (t) => {
    const k = lubDub(t);
    return [1 + 0.1 * k, 1 + 0.08 * k, 1 + 0.1 * k];
  }).values);

  // ---- the hummingbird, hovering over the offered hand
  const wrist = rig.j.wristL.getWorldPosition(new Vector3());
  const handDir = rig.dirToWorld(LEFT_HAND);
  const birdAt = wrist.clone().add(handDir.clone().multiplyScalar(0.2)).add(new Vector3(0, 0.1, 0));
  const face = rig.j.head.getWorldPosition(new Vector3());
  const look = face.clone().sub(birdAt);
  const birdYaw = Math.atan2(look.x, look.z);
  const bird = glb.node({ name: 'Hummingbird', translation: birdAt.toArray(), rotation: quat([0, 1, 0], birdYaw), parent: scene });
  const drift = sample(LOOP, FPS, (t) => [
    birdAt.x + 0.012 * Math.sin((2 * Math.PI * t) / 7.5) + 0.004 * Math.sin((2 * Math.PI * t) / 2),
    birdAt.y + 0.01 * Math.sin((2 * Math.PI * t) / 3) + 0.004 * Math.sin((2 * Math.PI * t) / 1.25),
    birdAt.z + 0.01 * Math.sin((2 * Math.PI * t) / 10 + 1)
  ]);
  glb.animate(bird, 'translation', times, drift.values);
  const turn = sample(LOOP, FPS, (t) => quat([0, 1, 0], birdYaw + 0.12 * Math.sin((2 * Math.PI * t) / 15)));
  glb.animate(bird, 'rotation', times, turn.values);

  const feather = glb.material({ name: 'Feather', color: '#ffffff', roughness: 0.35, emissive: '#0a1a12' });
  const birdBody = mergeGeometries([
    paint(ell(0.016, 0.017, 0.03, [0, 0, 0], 16, 12), (x, y) => (y > 0.002 ? mixC('#1f7a4a', '#3aa868', 0.5) : mixC('#d8d4c8', '#c4c0b0', 0.5))),
    paint(ell(0.009, 0.006, 0.026, [0, -0.004, -0.036], 10, 8), () => col('#24543c')) // tail
  ].map((g) => (g.deleteAttribute('uv'), g)));
  glb.node({ name: 'BirdBody', mesh: glb.mesh('BirdBody', birdBody, feather), rotation: quat([1, 0, 0], -0.5), parent: bird });
  const headNode = glb.node({ name: 'BirdHead', translation: [0, 0.018, 0.022], parent: bird });
  const headGeo = mergeGeometries([
    paint(ell(0.011, 0.011, 0.012, [0, 0, 0], 14, 10), (x, y) => (y > -0.003 ? col('#2a8a52') : col('#b8203c'))),
    paint(new ConeGeometry(0.0022, 0.022, 6).rotateX(Math.PI / 2).translate(0, 0, 0.021), () => col('#151515'))
  ].map((g) => (g.attributes.uv ? g.deleteAttribute('uv') : null, g)));
  glb.node({ name: 'BirdHeadMesh', mesh: glb.mesh('BirdHeadMesh', headGeo, feather), parent: headNode });
  // Head turns: quick glances, holds between.
  const glances = [[0, 0], [2.2, 0], [2.35, 0.45], [5.0, 0.45], [5.15, -0.2], [9.3, -0.2], [9.45, 0.15], [13.6, 0.15], [13.75, -0.4], [17.2, -0.4], [17.35, 0.1], [22.0, 0.1], [22.15, 0.5], [25.6, 0.5], [25.75, 0], [30, 0]];
  const headTimes = glances.map((g) => g[0]);
  glb.animate(headNode, 'rotation', headTimes, glances.flatMap((g) => quat([0, 1, 0], g[1])));

  // Wings: two blurred fans that shimmer.
  const wingInk = glb.material({ name: 'WingBlur', color: '#dff2ff', opacity: 0.34, unlit: true, doubleSided: true });
  const fan = new CircleGeometry(0.058, 20, Math.PI * 0.18, Math.PI * 0.64);
  fan.deleteAttribute('uv');
  const shimmer = sample(LOOP, FAST, (t) => {
    const k = 0.93 + 0.07 * Math.sin(2 * Math.PI * 20 * t) * Math.cos(2 * Math.PI * 3 * t);
    return [k, 1 + 0.06 * Math.sin(2 * Math.PI * 13 * t), 1];
  }).values;
  for (const side of [1, -1]) {
    const wing = glb.node({ name: side > 0 ? 'WingLeftFan' : 'WingRightFan', translation: [side * 0.012, 0.012, 0.004], rotation: quat([0, 0, 1], side > 0 ? -0.35 : Math.PI + 0.35), parent: bird });
    glb.node({ name: `${side > 0 ? 'WingLeft' : 'WingRight'}Blur`, mesh: glb.mesh('WingBlur', fan, wingInk), rotation: quat([1, 0, 0], Math.PI / 2 - 0.25), parent: wing });
    glb.animate(wing, 'scale', fast, shimmer);
  }
  // Its heart: a bright speck at the breast, flickering 20 times a second.
  const speckInk = glb.material({ name: 'BirdHeart', color: '#ff7a5a', unlit: true });
  const speckGlowInk = glb.material({ name: 'BirdHeartGlow', color: '#ffb08a', opacity: 0.4, unlit: true });
  const speck = glb.node({ name: 'BirdHeart', translation: [0, -0.006, 0.031], parent: bird });
  glb.node({ name: 'BirdHeartSpeck', mesh: glb.mesh('BirdHeartSpeck', new SphereGeometry(0.005, 10, 8), speckInk), parent: speck });
  glb.node({ name: 'BirdHeartHalo', mesh: glb.mesh('BirdHeartHalo', new SphereGeometry(0.013, 12, 8), speckGlowInk), parent: speck });
  glb.animate(speck, 'scale', fast, sample(LOOP, FAST, (t) => {
    const on = Math.floor(t * BIRD_HZ * 2 + 1e-6) % 2 === 0;
    return on ? [1.3, 1.3, 1.3] : [0.55, 0.55, 0.55];
  }).values, 'STEP');

  // ---- floor words
  const tilt = quat([1, 0, 0], (-62 * Math.PI) / 180);
  const M = 0.0018;
  addLabel(glb, labels.whale, { name: 'WhaleLabel', metersPerPx: M, translation: [HX - 0.12, SLAB_Y + 0.001, 0.44], rotation: tilt, parent: scene });
  addLabel(glb, labels.human, { name: 'HumanLabel', metersPerPx: M, translation: [0.12, SLAB_Y + 0.001, 0.56], rotation: tilt, parent: scene });
  addLabel(glb, labels.bird, { name: 'BirdLabel', metersPerPx: M, translation: [0.74, SLAB_Y + 0.001, 0.36], rotation: tilt, parent: scene });
  addLabel(glb, labels.true, { name: 'TrueLabel', metersPerPx: M, translation: [-0.2, SLAB_Y + 0.001, 0.73], rotation: tilt, parent: scene });

  glb.audio(sound());
  return glb;
}

const MID = [-0.02, 0.86, 0.0];
const feedCam = (d) => [MID[0] + 0.297 * d, MID[1] + 0.276 * d, MID[2] + 0.914 * d];
const closeCam = (dir) => {
  const l = Math.hypot(...dir);
  return dir.map((v, i) => MID[i] + (v / l) * 1.6);
};

export const tiles = [
  { label: 'feed', cam: feedCam(4.2), look: MID, t: 3.3 },
  { label: 'feed, between beats', cam: feedCam(4.2), look: MID, t: 11 },
  { label: 'palm on heart', cam: [1.9, 1.3, -0.9], look: [0.0, 0.95, -0.05], t: 4.0 },
  { label: 'chest heart + bird, 1.6 m', cam: closeCam([0.5, 0.25, 0.85]), look: [0.7, 1.22, 0.32], t: 0.05 },
  { label: 'whale heart front', cam: [-0.4, 1.0, 2.4], look: [-0.4, 0.8, 0], t: 3.6 },
  { label: 'back', view: 'back', t: 18.4 },
  { label: 'top', view: 'top', t: 5 }
];
