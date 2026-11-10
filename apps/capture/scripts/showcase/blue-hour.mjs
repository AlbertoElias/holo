import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  CatmullRomCurve3,
  Color,
  ConeGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  IcosahedronGeometry,
  Path,
  Shape,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { add, lowpass, noise, normalize, sine, toWav, track, SAMPLE_RATE } from './lib/audio.mjs';
import { Glb, sample } from './lib/glb.mjs';
import { fbm3, noise3, quat, rng } from './lib/parts.mjs';
import { T as TOKEN } from './lib/tokens.mjs';

// "Blue hour": a snow globe without the globe. A torn slice of ground about
// 1.1 m across, a miniature at about 1:12, holding a small planted cottage at
// dusk. Each side hides something the others cannot show: a reader through
// the round front window, a cat asleep on the woodpile at the back, the
// garden and its lamps at the door side, a sleeper under the skylight seen
// only from above, and the house's lit roots seen only from below.

export const meta = {
  slug: 'blue-hour',
  name: 'Blue hour',
  submittedBy: 'Claude (agent-authored)'
};

/** Scale of the whole piece over its 1:12 model: 1.5 shows it at 1:8. */
const SHOWN = 1.5;

const LOOP = 14;
const FPS = 12;
const TAU = Math.PI * 2;
const HIDDEN = [1e-4, 1e-4, 1e-4];

// The slab.
const Y0 = 0.3; // garden level
const YB = 0.15; // bottom of the cut sides
const RX = 0.56;
const RZ = 0.42;

// The cottage, in its own frame: origin on the garden at the house centre.
const HX = -0.04;
const HZ = -0.06;
const WX = 0.21;
const WZ = 0.16;
const T = 0.014; // wall thickness
const EAVE = 0.19;
const RA = 0.225; // roof half-depth at the eave
const RB = 0.2; // roof rise
const RXH = 0.255; // roof half-length
const WIN = { x: -0.02, y: 0.1, r: 0.072 };
const SKY = { x: 0.05, r: 0.07 };
const LAMP = [0.005, 0.138, -0.085]; // the reading lamp's bulb, house frame

// Palette.
const P = {
  ground: TOKEN.groundMid,
  groundDeep: TOKEN.groundTop,
  amber: TOKEN.horizon,
  gold: TOKEN.gold,
  glow: TOKEN.glow,
  highlight: TOKEN.highlight,
  cream: TOKEN.text,
  blue1: TOKEN.identity[3],
  blue2: TOKEN.identity[5],
  blue3: TOKEN.identity[4],
  green: TOKEN.identity[2],
  olive: TOKEN.identity[0]
};

const col = (hex) => new Color(hex);
const mix = (a, b, t) => col(a).lerp(col(b), Math.min(1, Math.max(0, t)));
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const frac = (x) => x - Math.floor(x);

// ---------------------------------------------------------------- geometry

const KEEP = new Set(['position', 'normal', 'color']);

/**
 * Normalises a geometry for merging: non-indexed, position / normal / color
 * only. `color` is a hex, a Color, or fn(x, y, z, nx, ny, nz) -> Color; with
 * `perFace` the function is evaluated at each triangle's centroid. Without a
 * color the geometry's own color attribute is kept.
 */
function prep(geometry, color, { perFace = false, alpha } = {}) {
  let g = geometry.index ? geometry.toNonIndexed() : geometry;
  if (!g.attributes.normal) g.computeVertexNormals();
  for (const key of Object.keys(g.attributes)) if (!KEEP.has(key)) g.deleteAttribute(key);
  g.clearGroups();
  g.morphAttributes = {};
  if (color === undefined && !g.attributes.color) color = '#ffffff';
  if (color !== undefined) {
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    const size = alpha === undefined ? 3 : 4;
    const out = new Float32Array(pos.count * size);
    const fixed = typeof color === 'function' ? null : col(color);
    for (let i = 0; i < pos.count; i += 1) {
      let c = fixed;
      if (!c) {
        if (perFace) {
          const f = i - (i % 3);
          const cx = (pos.getX(f) + pos.getX(f + 1) + pos.getX(f + 2)) / 3;
          const cy = (pos.getY(f) + pos.getY(f + 1) + pos.getY(f + 2)) / 3;
          const cz = (pos.getZ(f) + pos.getZ(f + 1) + pos.getZ(f + 2)) / 3;
          c = color(cx, cy, cz, nor.getX(i), nor.getY(i), nor.getZ(i));
        } else {
          c = color(pos.getX(i), pos.getY(i), pos.getZ(i), nor.getX(i), nor.getY(i), nor.getZ(i));
        }
      }
      out[i * size] = c.r;
      out[i * size + 1] = c.g;
      out[i * size + 2] = c.b;
      if (size === 4) out[i * size + 3] = typeof alpha === 'function' ? alpha(pos.getX(i), pos.getY(i), pos.getZ(i)) : alpha;
    }
    g.setAttribute('color', new BufferAttribute(out, size));
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

/** A (rows+1) x (cols+1) grid from fn(i, j) -> { p:[x,y,z], c:Color }, oriented so normals agree with `outward(p)`. */
function grid(rows, cols, fn, outward) {
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
      const b = a + 1;
      const c = a + cols + 1;
      const d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  g.setIndex(index);
  g.computeVertexNormals();
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  let agree = 0;
  for (let i = 0; i < pos.count; i += 1) {
    const o = outward(pos.getX(i), pos.getY(i), pos.getZ(i));
    agree += nor.getX(i) * o[0] + nor.getY(i) * o[1] + nor.getZ(i) * o[2];
  }
  if (agree < 0) {
    for (let k = 0; k < index.length; k += 3) [index[k + 1], index[k + 2]] = [index[k + 2], index[k + 1]];
    g.setIndex(index);
    g.computeVertexNormals();
  }
  return g;
}

/** A tube along `points` whose radius runs from r0 to r1 (ease sets the curve of the taper). */
function taper(points, r0, r1, { radial = 6, segs = 24, ease = 1 } = {}) {
  const curve = new CatmullRomCurve3(points.map((p) => new Vector3(...p)));
  const g = new TubeGeometry(curve, segs, 1, radial, false);
  const pos = g.attributes.position;
  for (let i = 0; i <= segs; i += 1) {
    const u = i / segs;
    const center = curve.getPointAt(u);
    const r = r0 + (r1 - r0) * u ** ease;
    for (let j = 0; j <= radial; j += 1) {
      const k = i * (radial + 1) + j;
      pos.setXYZ(k, center.x + (pos.getX(k) - center.x) * r, center.y + (pos.getY(k) - center.y) * r, center.z + (pos.getZ(k) - center.z) * r);
    }
  }
  g.computeVertexNormals();
  return { g, curve };
}

/** Lamp-painted color for unlit interiors: base shaded by direction and distance to `lamp`. */
function lamplit(base, lamp, { amb = 0.3, gain = 1.15, reach = 0.12, tint = '#ffd29a' } = {}) {
  const b = col(base);
  const warm = col(tint);
  return (x, y, z, nx, ny, nz) => {
    const dx = lamp[0] - x;
    const dy = lamp[1] - y;
    const dz = lamp[2] - z;
    const d = Math.hypot(dx, dy, dz) || 1e-6;
    const lambert = Math.max(0, (nx * dx + ny * dy + nz * dz) / d);
    const fall = 1 / (1 + (d / reach) ** 2);
    const k = amb + gain * fall * (0.35 + 0.65 * lambert);
    return new Color(Math.min(1, b.r * warm.r * k), Math.min(1, b.g * warm.g * k), Math.min(1, b.b * warm.b * k));
  };
}

// ---------------------------------------------------------------- the slab

function rimMul(theta) {
  const x = Math.cos(theta);
  const z = Math.sin(theta);
  let r = 1 + 0.15 * (fbm3(x * 1.4 + 3, z * 1.4, 0.5, { seed: 4 }) - 0.5) + 0.07 * (fbm3(x * 5 + 1, z * 5, 1.5, { seed: 9 }) - 0.5);
  // Torn bites, like burnt paper.
  r -= 0.06 * Math.max(0, noise3(x * 7 + 1, z * 7, 2, 17) - 0.62) / 0.38;
  return r;
}

function topY(x, z) {
  return Y0 + 0.007 * (fbm3(x * 5 + 2, z * 5, 0.3, { seed: 2 }) - 0.5) * 2;
}

/** Inside the garden's ellipse (fraction of the rim). */
function rimFrac(x, z) {
  const theta = Math.atan2(z, x);
  return Math.hypot(x / RX, z / RZ) / rimMul(theta);
}

function sideAt(theta, s) {
  // s: 0 at the rim, 1 at the bottom of the cut side.
  const rr = rimMul(theta) * (1 - 0.13 * s ** 1.4) + 0.012 * (fbm3(Math.cos(theta) * 6, s * 4, Math.sin(theta) * 6, { seed: 31 }) - 0.5);
  const yTop = topY(RX * rimMul(theta) * Math.cos(theta), RZ * rimMul(theta) * Math.sin(theta)) - 0.008;
  return [RX * rr * Math.cos(theta), yTop + (YB - yTop) * s, RZ * rr * Math.sin(theta)];
}

function strata(y, theta) {
  const d = (Y0 - y) / (Y0 - YB) + 0.06 * (fbm3(Math.cos(theta) * 4, y * 30, Math.sin(theta) * 4, { seed: 12 }) - 0.5);
  if (d < 0.04) return mix(P.amber, P.gold, 0.6);
  if (d < 0.14) return mix('#5a4438', '#6d5244', fbm3(theta * 3, y * 60, 1, { seed: 3 }));
  if (d < 0.36) return mix('#a8714c', '#b98258', fbm3(theta * 5, y * 40, 2, { seed: 5 }));
  if (d < 0.47) return mix('#e0a878', '#f0c08a', 0.4);
  if (d < 0.74) return mix('#6e5444', '#806250', fbm3(theta * 4, y * 50, 3, { seed: 6 }));
  return mix('#7488a0', '#90a4ba', fbm3(theta * 8, y * 30, 4, { seed: 7 }));
}

function slabGeometry() {
  const N = 140;
  const R = 20; // top rings
  const M = 10; // side rows
  const Q = 9; // underside rings
  const rows = [];
  for (let k = 0; k <= R; k += 1) rows.push({ kind: 'top', f: Math.max(0.002, k / R) });
  rows.push({ kind: 'side', s: 0 });
  for (let m = 1; m <= M; m += 1) rows.push({ kind: 'side', s: m / M });
  rows.push({ kind: 'under', g: 1 });
  for (let q = 1; q <= Q; q += 1) rows.push({ kind: 'under', g: Math.max(0.002, 1 - q / Q) });

  const fn = (i, j) => {
    const theta = (j / N) * TAU;
    const row = rows[i];
    const rr = rimMul(theta);
    if (row.kind === 'top') {
      const x = row.f * RX * rr * Math.cos(theta);
      const z = row.f * RZ * rr * Math.sin(theta);
      const y = topY(x, z) - 0.008 * smooth(0.86, 1, row.f);
      const n = fbm3(x * 9, 0, z * 9, { seed: 8 });
      let c = mix('#1d4a46', '#2c6352', n);
      c.lerp(col('#3b7458'), smooth(0.6, 0.8, fbm3(x * 3, 1, z * 3, { seed: 10 })) * 0.6);
      // Burnt-paper edge: char, then an ember line.
      c.lerp(col('#2a1d18'), smooth(0.9, 0.96, row.f));
      c.lerp(col(P.gold), smooth(0.975, 1, row.f));
      return { p: [x, y, z], c };
    }
    if (row.kind === 'side') {
      const p = sideAt(theta, row.s);
      return { p, c: strata(p[1], theta) };
    }
    const bottom = sideAt(theta, 1);
    const g = row.g;
    const bump = 0.012 * (fbm3(Math.cos(theta) * 3 * g, g * 2, Math.sin(theta) * 3 * g, { seed: 41 }) - 0.5);
    const y = YB - 0.075 * (1 - g * g) ** 0.7 + bump;
    const p = [bottom[0] * g, y, bottom[2] * g];
    const c = mix('#262327', '#3a4650', fbm3(p[0] * 8, p[1] * 8, p[2] * 8, { seed: 42 }));
    return { p, c };
  };
  return grid(rows.length - 1, N, fn, (x, y, z) => [x, y - 0.22, z]);
}

function rimOutline(count = 220, lift = -0.004) {
  const points = [];
  for (let j = 0; j < count; j += 1) {
    const theta = (j / count) * TAU;
    const rr = rimMul(theta) * 1.003;
    const x = RX * rr * Math.cos(theta);
    const z = RZ * rr * Math.sin(theta);
    points.push(new Vector3(x, topY(x, z) - 0.008 + lift, z));
  }
  return points;
}

// ---------------------------------------------------------------- scene

export async function build() {
  const glb = new Glb();
  glb.provenance({
    holoim: { authored: 'synthetic', author: meta.submittedBy, title: meta.name, scale: 'miniature, about 1:8' }
  });
  // Modelled at 1:12, shown at 1:8: the flat-screen portal comes no closer than
  // 1.6 m, and at 1:12 the reader in the window was too small to find from there.
  const root = glb.node({ name: 'BlueHour', scale: [SHOWN, SHOWN, SHOWN] });
  const random = rng(20261109);

  const M = {
    solid: glb.material({ name: 'Dusk', roughness: 0.92, doubleSided: true }),
    painted: glb.material({ name: 'Lamplit', unlit: true, doubleSided: true }),
    brass: glb.material({ name: 'Brass', color: P.gold, metallic: 0.75, roughness: 0.35, emissive: P.amber, emissiveStrength: 0.45 }),
    bulb: glb.material({ name: 'Bulb', color: P.highlight, emissive: P.highlight, emissiveStrength: 4 }),
    ember: glb.material({ name: 'Ember', color: P.gold, emissive: P.glow, emissiveStrength: 3 }),
    fly: glb.material({ name: 'Firefly', color: '#f6ffc2', emissive: '#e9f58a', emissiveStrength: 4 }),
    spill: glb.material({ name: 'Spill', unlit: true, blend: true }),
    smoke: glb.material({ name: 'Smoke', color: '#c9d6e6', opacity: 0.38, roughness: 1 })
  };
  const groups = { solid: [], painted: [], brass: [], bulb: [], ember: [], spill: [] };
  const put = (group, g, color, options) => groups[group].push(prep(g, color, options));
  const H = (x, y, z) => [HX + x, Y0 + y, HZ + z]; // house frame to world

  // ---- slab, rim, roots
  put('solid', slabGeometry());
  {
    const curve = new CatmullRomCurve3(rimOutline(), true);
    put('ember', new TubeGeometry(curve, 440, 0.0045, 5, true), P.gold);
  }

  const rootLights = [];
  {
    const rootColor = (x, y, z) => mix('#8f6b4c', '#c9a27a', fbm3(x * 20, y * 20, z * 20, { seed: 51 }));
    // Hanging roots from the belly.
    const hang = [
      [0.0, 0.0, 0.0, 0.0],
      [0.14, 0.05, 0.9, 0.06],
      [-0.16, -0.02, 2.1, 0.08],
      [0.06, -0.15, 3.6, 0.05],
      [-0.05, 0.14, 4.6, 0.07],
      [0.27, -0.06, 5.5, 0.09],
      [-0.28, 0.06, 1.4, 0.1]
    ];
    hang.forEach(([x, z, a, spread], k) => {
      random(); // one draw kept so the roots after it keep the shapes they were tuned with
      const y0 = YB - 0.06 * (1 - Math.hypot(x / RX, z / RZ) ** 2);
      const pts = [];
      for (let s = 0; s <= 5; s += 1) {
        const u = s / 5;
        pts.push([
          x + Math.cos(a) * spread * u + 0.015 * Math.sin(u * 6 + k),
          y0 + 0.01 - (y0 - 0.002 - (k === 0 ? 0 : 0.012 * random())) * u ** 0.9,
          z + Math.sin(a) * spread * u + 0.015 * Math.cos(u * 5 + k)
        ]);
      }
      const { g, curve } = taper(pts, 0.012, 0.0012, { radial: 7, segs: 28, ease: 0.8 });
      put('solid', g, rootColor);
      [0.3, 0.55, 0.8].forEach((u) => rootLights.push({ p: curve.getPointAt(u).toArray(), u, root: k }));
      // A side branch.
      const b = curve.getPointAt(0.4);
      const bp = [b.toArray(), [b.x + 0.04 * Math.cos(a + 1.2), b.y - 0.03, b.z + 0.04 * Math.sin(a + 1.2)], [b.x + 0.07 * Math.cos(a + 1.5), b.y - 0.045, b.z + 0.07 * Math.sin(a + 1.5)]];
      put('solid', taper(bp, 0.0055, 0.0008, { radial: 5, segs: 12 }).g, rootColor);
    });
    // Roots that show through the cut sides, running down the face and out below.
    [0.1, 0.55, 1.0, 1.45, 1.9, 2.3, 2.75, 3.2, 3.55, 4.0, 4.35, 4.75, 5.15, 5.6].forEach((theta, k) => {
      const pts = [];
      for (let s = 0; s <= 6; s += 1) {
        const u = s / 6;
        const th = theta + 0.05 * Math.sin(u * 5 + k);
        const p = sideAt(th, 0.12 + 0.88 * u);
        const outX = Math.cos(th) * 0.011;
        const outZ = Math.sin(th) * 0.011;
        pts.push([p[0] + outX, p[1], p[2] + outZ]);
      }
      const b = sideAt(theta, 1);
      pts.push([b[0] * 0.93, YB - 0.04, b[2] * 0.93], [b[0] * 0.86, YB - 0.075 - 0.02 * random(), b[2] * 0.86]);
      const { g, curve } = taper(pts, 0.009, 0.0014, { radial: 6, segs: 34 });
      put('solid', g, rootColor);
      [0.25, 0.55, 0.85].forEach((u) => rootLights.push({ p: curve.getPointAt(u).toArray(), u, root: 10 + k }));
    });
  }

  // ---- ground dressing helpers
  const inHouse = (x, z, pad = 0) => Math.abs(x - HX) < RXH + pad && Math.abs(z - HZ) < RA + pad;
  const keepOut = [];
  const blocked = (x, z) => inHouse(x, z, 0.01) || keepOut.some(([cx, cz, r]) => Math.hypot(x - cx, z - cz) < r);

  const tuft = (x, z, scale = 1, base = '#2f6b55', y = topY(x, z)) => {
    const blades = 3 + Math.floor(random() * 3);
    for (let b = 0; b < blades; b += 1) {
      const h = (0.014 + 0.014 * random()) * scale;
      const g = new ConeGeometry(0.0022 * scale, h, 3, 1, true);
      g.translate(0, h / 2, 0);
      xf(g, { rz: (random() - 0.5) * 0.7, rx: (random() - 0.5) * 0.7, at: [x + (random() - 0.5) * 0.008, y - 0.001, z + (random() - 0.5) * 0.008] });
      put('solid', g, mix(base, P.olive, random() * 0.45));
    }
  };
  const flower = (x, z, color, y = topY(x, z), h = 0.016 + 0.01 * random()) => {
    const stem = new CylinderGeometry(0.0007, 0.0009, h, 3, 1, true);
    stem.translate(x, y + h / 2, z);
    put('solid', stem, '#3c7a52');
    put('solid', xf(new IcosahedronGeometry(0.0042, 0), { at: [x, y + h, z] }), color);
  };

  // ---- the cottage
  {
    const wallTop = EAVE + RB * Math.sqrt(1 - (WZ / RA) ** 2);
    const wallCool = (x, y, z) => mix('#9fb0c6', '#b8c3d3', fbm3(x * 14, y * 14, z * 14, { seed: 61 })).lerp(col('#6f8299'), smooth(0.05, 0, y - Y0) * 0.5);

    // Front wall with the big round window.
    const front = new Shape();
    front.moveTo(-WX, 0);
    front.lineTo(WX, 0);
    front.lineTo(WX, wallTop);
    front.lineTo(-WX, wallTop);
    front.lineTo(-WX, 0);
    const hole = new Path();
    hole.absarc(WIN.x, WIN.y, WIN.r, 0, TAU, true);
    front.holes.push(hole);
    put('solid', xf(new ExtrudeGeometry(front, { depth: T, bevelEnabled: false, curveSegments: 56 }), { at: H(0, 0, WZ - T) }), wallCool);
    put('solid', xf(new BoxGeometry(2 * WX, wallTop, T), { at: H(0, wallTop / 2, -WZ + T / 2) }), wallCool);
    // Gable ends follow the roof's curve.
    const gable = new Shape();
    gable.moveTo(-WZ, 0);
    gable.lineTo(WZ, 0);
    for (let i = 0; i <= 24; i += 1) {
      const z = WZ - (2 * WZ * i) / 24;
      gable.lineTo(z, EAVE + (RB - 0.006) * Math.sqrt(1 - (z / RA) ** 2));
    }
    gable.lineTo(-WZ, 0);
    for (const side of [-1, 1]) {
      const g = new ExtrudeGeometry(gable, { depth: T, bevelEnabled: false });
      g.rotateY(Math.PI / 2);
      g.translate(...H(side > 0 ? WX - T : -WX, 0, 0));
      put('solid', g, wallCool);
    }
    // Stone plinth and walnut corner posts.
    for (const [w, d, x, z] of [[2 * WX + 0.012, 0.012, 0, WZ], [2 * WX + 0.012, 0.012, 0, -WZ], [0.012, 2 * WZ, WX, 0], [0.012, 2 * WZ, -WX, 0]]) {
      put('solid', xf(new BoxGeometry(w, 0.026, d), { at: H(x, 0.008, z) }), (px, py, pz) => mix('#4f5d6c', '#6d7b8a', noise3(px * 90, py * 90, pz * 90, 5)));
    }
    for (const [x, z] of [[-WX, -WZ], [WX, -WZ], [-WX, WZ], [WX, WZ]]) {
      put('solid', xf(new CylinderGeometry(0.014, 0.017, 0.3, 10), { at: H(x, 0.15, z) }), '#4b3830');
    }
    // A walnut lintel band under the eave.
    put('solid', xf(new BoxGeometry(2 * WX + 0.02, 0.012, 0.01), { at: H(0, EAVE - 0.004, WZ + 0.004) }), '#4b3830');

    // The window: walnut surround, brass rim, Art Nouveau whiplash curls.
    const wc = H(WIN.x, WIN.y, WZ + 0.003);
    put('solid', xf(new TorusGeometry(WIN.r + 0.008, 0.008, 8, 64), { at: wc }), '#4b3830');
    put('brass', xf(new TorusGeometry(WIN.r, 0.005, 8, 64), { at: [wc[0], wc[1], wc[2] + 0.004] }));
    for (const s of [-1, 1]) {
      const pts = [];
      for (let i = 0; i <= 14; i += 1) {
        const u = i / 14;
        const a = -Math.PI / 2 + s * (0.5 + u * 1.9);
        const r = WIN.r + 0.018 + 0.03 * Math.sin(u * Math.PI) ;
        pts.push([wc[0] + Math.cos(a) * r * (s > 0 ? 1 : 1), wc[1] + Math.sin(a) * r - 0.004, wc[2] + 0.004]);
      }
      // Curl the end inward.
      const end = pts[pts.length - 1];
      pts.push([end[0] - s * 0.012, end[1] + 0.006, end[2]], [end[0] - s * 0.016, end[1] - 0.004, end[2]]);
      put('brass', taper(pts, 0.0028, 0.0016, { radial: 5, segs: 40 }).g);
    }

    // The door on the garden end: round-topped walnut, brass rim, a lit porthole.
    const door = new Shape();
    const DW = 0.042;
    door.moveTo(-DW, 0);
    door.lineTo(DW, 0);
    door.lineTo(DW, 0.105);
    door.absarc(0, 0.105, DW, 0, Math.PI, false);
    door.lineTo(-DW, 0);
    const doorZ = 0.04;
    const dg = new ExtrudeGeometry(door, { depth: 0.008, bevelEnabled: false, curveSegments: 24 });
    dg.rotateY(Math.PI / 2);
    dg.translate(...H(WX - 0.002, 0.004, doorZ));
    put('solid', dg, (x, y, z) => mix('#3f2c26', '#5a4034', 0.5 + 0.5 * Math.sin((z - HZ - doorZ) * 260)));
    const frame = [];
    for (let i = 0; i <= 30; i += 1) {
      const a = Math.PI - (i / 30) * Math.PI;
      frame.push([WX + 0.008, 0.11 + Math.sin(a) * (DW + 0.006), doorZ + Math.cos(a) * (DW + 0.006)]);
    }
    const frameAll = [[WX + 0.008, 0.004, doorZ - DW - 0.006], ...frame.map((p) => p), [WX + 0.008, 0.004, doorZ + DW + 0.006]].reverse();
    put('brass', taper(frameAll.map(([x, y, z]) => H(x, y, z)), 0.0035, 0.0035, { radial: 5, segs: 60 }).g);
    put('painted', xf(new CylinderGeometry(0.014, 0.014, 0.004, 20), { rz: Math.PI / 2, at: H(WX + 0.008, 0.112, doorZ) }), (x, y, z) => mix(P.highlight, P.glow, Math.hypot(y - Y0 - 0.112, z - HZ - doorZ) / 0.014));
    put('brass', xf(new TorusGeometry(0.0145, 0.0025, 6, 24), { ry: Math.PI / 2, at: H(WX + 0.011, 0.112, doorZ) }));
    put('brass', xf(new SphereGeometry(0.004, 8, 6), { at: H(WX + 0.013, 0.06, doorZ - 0.028) }));
    // The door lantern.
    put('solid', xf(new BoxGeometry(0.02, 0.003, 0.003), { at: H(WX + 0.01, 0.155, doorZ - 0.07) }), '#2d2422');
    put('brass', xf(new CylinderGeometry(0.008, 0.01, 0.004, 8), { at: H(WX + 0.02, 0.163, doorZ - 0.07) }));
    put('bulb', xf(new SphereGeometry(0.0085, 12, 8), { s: [1, 1.3, 1], at: H(WX + 0.02, 0.148, doorZ - 0.07) }));
    // A stone step and boots by the door.
    put('solid', xf(new CylinderGeometry(0.035, 0.038, 0.008, 12), { s: [0.7, 1, 1], at: H(WX + 0.028, 0.002, doorZ) }), '#6c7d8f');
    for (const [dz, rot] of [[0.072, 0.1], [0.092, -0.15]]) {
      const bx = WX + 0.018;
      const bz = doorZ + dz;
      put('solid', xf(new CylinderGeometry(0.0055, 0.006, 0.024, 10), { at: H(bx, 0.012, bz) }), '#3f8a63');
      put('solid', xf(new CapsuleGeometry(0.005, 0.008, 4, 8), { rz: Math.PI / 2, ry: rot, at: H(bx + 0.006, 0.004, bz) }), '#2f6f50');
    }

    // Fake (painted) windows on the back wall and the left gable.
    const paintedWindow = (center, normalAxis, r) => {
      const g = new CylinderGeometry(r, r, 0.004, 28);
      if (normalAxis === 'z') g.rotateX(Math.PI / 2);
      else g.rotateZ(Math.PI / 2);
      g.translate(...center);
      put('painted', g, (x, y, z) => mix(P.highlight, '#e0904a', Math.hypot(x - center[0], y - center[1], z - center[2]) / r));
      const cross = normalAxis === 'z' ? [new BoxGeometry(2 * r, 0.003, 0.004), new BoxGeometry(0.003, 2 * r, 0.004)] : [new BoxGeometry(0.004, 2 * r, 0.003), new BoxGeometry(0.004, 0.003, 2 * r)];
      cross.forEach((c) => put('solid', c.translate(...center), '#4b3830'));
      const ring = new TorusGeometry(r + 0.002, 0.004, 6, 32);
      if (normalAxis === 'x') ring.rotateY(Math.PI / 2);
      put('brass', ring.translate(...center));
    };
    paintedWindow(H(0.15, 0.12, -WZ - 0.003), 'z', 0.03);
    paintedWindow(H(-WX - 0.003, 0.25, 0.0), 'x', 0.032);
    paintedWindow(H(-WX - 0.003, 0.1, 0.06), 'x', 0.026);

    // ---- the planted roof: turf outside, walnut inside, a round skylight.
    const skyY = (z) => EAVE + RB * Math.sqrt(Math.max(0, 1 - (z / RA) ** 2));
    const NXR = 72;
    const NPR = 56;
    const roofSurface = (shrink, colorFn) =>
      grid(
        NXR,
        NPR,
        (i, j) => {
          const x = -RXH + (2 * RXH * i) / NXR;
          const phi = (j / NPR) * Math.PI;
          const bump = shrink > 0 ? 0 : 0.006 * (fbm3(x * 25, phi * 4, 0, { seed: 71 }) - 0.5) + 0.004 * Math.sin(phi * 9 + x * 30) * 0;
          const droop = 0.012 * (Math.abs(x) / RXH) ** 4; // soft ends
          const a = RA - shrink + bump;
          const b = RB - shrink + bump - droop;
          const p = [x, EAVE + b * Math.sin(phi) - (shrink > 0 ? 0 : 0.0), a * Math.cos(phi)];
          return { p: H(...p), c: colorFn(x, phi) };
        },
        (x, y, z) => (shrink > 0 ? [0, -(y - Y0 - EAVE), -(z - HZ)] : [0, y - Y0 - EAVE, z - HZ])
      );
    const turfColor = (x, phi) => {
      const n = fbm3(x * 18, phi * 5, 0.5, { seed: 72 });
      const c = mix('#24604d', '#3f8a63', n);
      c.lerp(col(P.olive), smooth(0.62, 0.8, fbm3(x * 9, phi * 3, 3, { seed: 73 })) * 0.55);
      c.lerp(col('#1d4a40'), smooth(0.35, 0, Math.min(phi, Math.PI - phi)) * 0.6);
      return c;
    };
    const cutSkylight = (g) => {
      // Drop triangles whose centroid falls inside the skylight.
      const pos = g.attributes.position;
      const keep = [];
      const index = g.index.array;
      for (let k = 0; k < index.length; k += 3) {
        let cx = 0;
        let cz = 0;
        for (let m = 0; m < 3; m += 1) {
          cx += pos.getX(index[k + m]) / 3;
          cz += pos.getZ(index[k + m]) / 3;
        }
        const cy = (pos.getY(index[k]) + pos.getY(index[k + 1]) + pos.getY(index[k + 2])) / 3;
        if (Math.hypot(cx - (HX + SKY.x), cz - HZ) < SKY.r + 0.001 && cy > Y0 + EAVE + 0.1) continue;
        keep.push(index[k], index[k + 1], index[k + 2]);
      }
      g.setIndex(keep);
      return g;
    };
    put('solid', cutSkylight(roofSurface(0, turfColor)));
    put('solid', cutSkylight(roofSurface(0.012, () => col('#4b3830'))));
    // Eave trims hide the turf's thickness.
    put('solid', xf(new CylinderGeometry(0.009, 0.009, 2 * RXH, 8), { rz: Math.PI / 2, at: H(0, EAVE, RA - 0.006) }), '#3b2b26');
    put('solid', xf(new CylinderGeometry(0.009, 0.009, 2 * RXH, 8), { rz: Math.PI / 2, at: H(0, EAVE, -RA + 0.006) }), '#3b2b26');
    for (const s of [-1, 1]) {
      const pts = [];
      for (let i = 0; i <= 28; i += 1) {
        const phi = (i / 28) * Math.PI;
        const b = RB - 0.006 - 0.012;
        pts.push(H(s * RXH, EAVE + b * Math.sin(phi), (RA - 0.006) * Math.cos(phi)));
      }
      put('solid', taper(pts, 0.01, 0.01, { radial: 6, segs: 56 }).g, (x, y) => mix('#2a5a48', '#3b2b26', smooth(EAVE + 0.15, EAVE + 0.05, y - Y0)));
    }
    // Moss drips along the front eave.
    for (let i = 0; i < 26; i += 1) {
      const x = -RXH + 0.01 + (2 * RXH - 0.02) * random();
      for (const zs of [1, -1]) {
        const len = 0.008 + 0.022 * random();
        const g = new ConeGeometry(0.004 + 0.003 * random(), len, 4, 1, true);
        g.rotateX(Math.PI);
        put('solid', g.translate(...H(x, EAVE - len / 2, zs * (RA - 0.002))), mix('#2a6a50', P.olive, random() * 0.5));
      }
    }
    // Skylight: brass ring and a walnut well.
    {
      const ring = new TorusGeometry(SKY.r + 0.004, 0.008, 8, 56);
      ring.rotateX(Math.PI / 2);
      const pos = ring.attributes.position;
      for (let i = 0; i < pos.count; i += 1) pos.setY(i, pos.getY(i) + skyY(pos.getZ(i)) + 0.003);
      ring.computeVertexNormals();
      ring.translate(HX + SKY.x, Y0, HZ);
      put('brass', ring);
      const well = new CylinderGeometry(SKY.r + 0.002, SKY.r + 0.002, 0.03, 40, 1, true);
      well.translate(HX + SKY.x, Y0 + EAVE + RB - 0.012, HZ);
      put('solid', well, '#4b3830');
    }
    // Roof garden: grasses, flowers and a small shrub.
    for (let i = 0; i < 70; i += 1) {
      const x = -RXH + 0.02 + (2 * RXH - 0.04) * random();
      const phi = 0.25 + (Math.PI - 0.5) * random();
      const z = RA * Math.cos(phi);
      if (Math.hypot(x - SKY.x, z) < SKY.r + 0.02) continue;
      if (Math.hypot(x + 0.11, z + 0.07) < 0.035) continue; // chimney
      const y = EAVE + RB * Math.sin(phi);
      const [wx, wy, wz] = H(x, y, z);
      if (i % 4 === 0) flower(wx, wz, [P.cream, P.gold, P.blue1][i % 3], wy - 0.002, 0.012);
      else tuft(wx, wz, 0.8, '#2f7a58', wy - 0.002);
    }
    {
      const [sx, sy, sz] = H(0.17, skyY(0.06) - 0.005, 0.06);
      put('solid', taper([[sx, sy, sz], [sx + 0.004, sy + 0.03, sz], [sx - 0.004, sy + 0.05, sz + 0.004]], 0.004, 0.002, { segs: 10 }).g, '#4b3830');
      for (let i = 0; i < 7; i += 1) {
        const a = (i / 7) * TAU;
        put('solid', xf(new IcosahedronGeometry(0.018 + 0.006 * random(), 1), { s: [1, 0.8, 1], at: [sx + 0.016 * Math.cos(a), sy + 0.055 + 0.012 * random(), sz + 0.016 * Math.sin(a)] }), mix('#2f7a58', P.green, random() * 0.6));
      }
    }

    // Chimney: a rounded stone stack with a terracotta pot.
    {
      const [cx, , cz] = H(-0.11, 0, -0.07);
      const stack = new CylinderGeometry(0.02, 0.025, 0.2, 14, 6);
      stack.translate(cx, Y0 + 0.37, cz);
      put('solid', stack, (x, y, z) => mix('#55606d', '#7d8996', noise3(x * 120, y * 60, z * 120, 9)));
      put('solid', xf(new CylinderGeometry(0.026, 0.024, 0.012, 14), { at: [cx, Y0 + 0.474, cz] }), '#3f4752');
      put('solid', xf(new CylinderGeometry(0.012, 0.015, 0.024, 12, 1, true), { at: [cx, Y0 + 0.49, cz] }), '#a8603f');
    }

    // ---- interior: lined in lamp-painted color so it reads lit.
    const lampW = H(...LAMP);
    const lit = (base, options) => lamplit(base, lampW, options);
    const IX = WX - T - 0.001;
    const IZ = WZ - T - 0.001;
    const ICEIL = EAVE;
    put('painted', xf(new BoxGeometry(2 * IX, 0.002, 2 * IZ, 16, 1, 12), { at: H(0, 0.003, 0) }), (x, y, z, nx, ny, nz) =>
      lit(Math.floor((x - HX) * 90) % 2 === 0 ? '#8a5a3c' : '#7a4c33', { amb: 0.25, gain: 1.4 })(x, y, z, nx, ny, nz)
    );
    put('painted', xf(new BoxGeometry(2 * IX, ICEIL, 0.002, 16, 10, 1), { at: H(0, ICEIL / 2, -IZ) }), lit('#f2d6ad', { gain: 1.5 }));
    put('painted', xf(new BoxGeometry(0.002, ICEIL, 2 * IZ, 1, 10, 12), { at: H(-IX, ICEIL / 2, 0) }), lit('#efcfa2', { gain: 1.5 }));
    put('painted', xf(new BoxGeometry(0.002, ICEIL, 2 * IZ, 1, 10, 12), { at: H(IX, ICEIL / 2, 0) }), lit('#efcfa2', { gain: 1.5 }));
    put('painted', xf(new BoxGeometry(2 * IX, 0.002, 2 * IZ, 16, 1, 12), { at: H(0, ICEIL, 0) }), lit('#6e4a36', { gain: 1.2 }));
    for (const bz of [-0.08, 0.0, 0.08]) put('painted', xf(new BoxGeometry(2 * IX, 0.01, 0.012), { at: H(0, ICEIL - 0.006, bz) }), lit('#4f3427', { gain: 1.3 }));
    // Rug.
    put('painted', xf(new CylinderGeometry(1, 1, 0.002, 40, 1), { s: [0.085, 1, 0.065], at: H(-0.035, 0.005, -0.015) }), (x, y, z, nx, ny, nz) => {
      const r = Math.hypot((x - HX + 0.035) / 0.085, (z - HZ + 0.015) / 0.065);
      return lit(r > 0.82 ? '#d9a441' : r > 0.62 ? '#9c3d33' : r > 0.45 ? '#e8c27a' : '#a8483a', { gain: 1.4 })(x, y, z, nx, ny, nz);
    });
    // Reading lamp: brass stand, glowing shade.
    put('brass', xf(new CylinderGeometry(0.012, 0.014, 0.004, 16), { at: H(LAMP[0], 0.004, LAMP[2]) }));
    put('brass', xf(new CylinderGeometry(0.0018, 0.0018, 0.13, 6), { at: H(LAMP[0], 0.07, LAMP[2]) }));
    put('ember', xf(new CylinderGeometry(0.013, 0.027, 0.026, 20, 1, true), { at: H(LAMP[0], LAMP[1] + 0.008, LAMP[2]) }));
    put('bulb', xf(new SphereGeometry(0.007, 10, 8), { at: H(LAMP[0], LAMP[1] - 0.002, LAMP[2]) }));
    // Shelf with books and a plant, on the back wall.
    put('painted', xf(new BoxGeometry(0.11, 0.005, 0.022), { at: H(0.075, 0.128, -IZ + 0.012) }), lit('#5a3a2a', { gain: 1.4 }));
    {
      let bx = 0.024;
      const bookColors = ['#9c3d33', '#2f6f73', '#d9a441', '#4a5a8a', '#7a4c33', '#e8d8b8', '#5f7a3a'];
      for (let i = 0; i < 9; i += 1) {
        const w = 0.006 + 0.004 * random();
        const h = 0.022 + 0.012 * random();
        put('painted', xf(new BoxGeometry(w, h, 0.017), { rz: i === 6 ? 0.25 : 0, at: H(bx + w / 2, 0.1305 + h / 2, -IZ + 0.012) }), lit(bookColors[i % bookColors.length], { gain: 1.5 }));
        bx += w + 0.0008;
        if (i === 6) bx += 0.006;
      }
      put('painted', xf(new CylinderGeometry(0.008, 0.006, 0.014, 10), { at: H(0.115, 0.1375, -IZ + 0.012) }), lit('#c0603a', { gain: 1.4 }));
      for (let i = 0; i < 5; i += 1) put('painted', xf(new IcosahedronGeometry(0.008, 0), { at: H(0.115 + (random() - 0.5) * 0.014, 0.152 + random() * 0.01, -IZ + 0.012 + (random() - 0.5) * 0.01) }), lit('#4f8a4a', { gain: 1.4 }));
    }
    // Side table with a mug.
    {
      const tx = -0.005;
      const tz = 0.045;
      put('painted', xf(new CylinderGeometry(0.016, 0.016, 0.004, 18), { at: H(tx, 0.05, tz) }), lit('#5a3a2a', { gain: 1.5 }));
      put('painted', xf(new CylinderGeometry(0.0025, 0.004, 0.048, 8), { at: H(tx, 0.025, tz) }), lit('#4a2f22', { gain: 1.4 }));
      put('painted', xf(new CylinderGeometry(0.0055, 0.005, 0.01, 12), { at: H(tx + 0.003, 0.057, tz) }), lit('#3f6fa8', { gain: 1.6 }));
      put('painted', xf(new TorusGeometry(0.003, 0.001, 5, 10), { at: H(tx + 0.0095, 0.057, tz) }), lit('#3f6fa8', { gain: 1.6 }));
    }

    // ---- the loft under the skylight: a sleeper under a quilt.
    const nightlight = H(SKY.x - 0.09, EAVE + 0.04, 0.05);
    const loftLit = (base, gain = 0.9) => lamplit(base, nightlight, { amb: 0.38, gain, reach: 0.14, tint: '#ffd9a8' });
    put('painted', xf(new BoxGeometry(2 * IX, 0.002, 2 * IZ, 16, 1, 12), { at: H(0, EAVE + 0.004, 0) }), (x, y, z, nx, ny, nz) =>
      loftLit(Math.floor((z - HZ) * 80) % 2 === 0 ? '#8a5a3c' : '#7a4c33')(x, y, z, nx, ny, nz)
    );
    const BX = SKY.x + 0.03;
    const BL = 0.17;
    const BWd = 0.1;
    put('painted', xf(new BoxGeometry(BL, 0.02, BWd), { at: H(BX, EAVE + 0.015, 0) }), loftLit('#5a3a2a'));
    put('painted', xf(new BoxGeometry(0.008, 0.05, BWd + 0.006), { at: H(BX - BL / 2, EAVE + 0.03, 0) }), loftLit('#4a2f22'));
    put('painted', xf(new BoxGeometry(BL - 0.01, 0.012, BWd - 0.008), { at: H(BX, EAVE + 0.031, 0) }), loftLit('#f2e6d0'));
    put('painted', xf(new CapsuleGeometry(0.014, 0.05, 4, 10), { rx: Math.PI / 2, s: [1, 1, 0.45], at: H(BX - BL / 2 + 0.024, EAVE + 0.041, 0) }), loftLit(TOKEN.text, 1.0));
    put('painted', xf(new SphereGeometry(0.0135, 14, 10), { at: H(BX - BL / 2 + 0.03, EAVE + 0.052, 0) }), loftLit('#e8b48a', 1.1));
    put('painted', xf(new SphereGeometry(0.0145, 14, 10), { s: [1, 0.8, 1.05], at: H(BX - BL / 2 + 0.024, EAVE + 0.052, 0) }), loftLit('#5a3524', 1.0));
    put('painted', xf(new SphereGeometry(0.0025, 6, 4), { at: H(BX - BL / 2 + 0.035, EAVE + 0.065, 0) }), loftLit('#d99a74', 1.1));
    // Bedside candle (the nightlight).
    put('painted', xf(new BoxGeometry(0.02, 0.025, 0.02), { at: H(SKY.x - 0.09, EAVE + 0.016, 0.05) }), loftLit('#5a3a2a', 1.2));
    put('painted', xf(new CylinderGeometry(0.004, 0.004, 0.012, 8), { at: H(SKY.x - 0.09, EAVE + 0.035, 0.05) }), loftLit(TOKEN.text, 1.2));
    put('bulb', xf(new SphereGeometry(0.003, 8, 6), { s: [1, 1.6, 1], at: H(SKY.x - 0.09, EAVE + 0.044, 0.05) }));
    // A rag rug beside the bed.
    put('painted', xf(new CylinderGeometry(1, 1, 0.002, 30), { s: [0.04, 1, 0.03], at: H(BX, EAVE + 0.006, 0.08) }), loftLit('#3f6fa8'));

    // Quilt: patchwork that rises and falls.
    {
      const QL = BL - 0.058;
      const quiltGeo = new BoxGeometry(QL, 0.01, BWd + 0.004, 14, 1, 10);
      const pos = quiltGeo.attributes.position;
      for (let i = 0; i < pos.count; i += 1) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        const top = pos.getY(i) > 0;
        const body = Math.exp(-((z / 0.024) ** 2)) * (x < QL * 0.25 ? 1 : 0.7);
        const drape = -0.012 * smooth(BWd * 0.42, BWd * 0.52, Math.abs(z));
        pos.setY(i, (top ? 0.005 + 0.014 * body : -0.005) + drape + 0.005);
      }
      quiltGeo.computeVertexNormals();
      const patches = ['#9c3d33', '#d9a441', '#3f6fa8', '#e8d8b8', '#4f8a4a', '#c0603a'];
      const qx = BX + 0.024;
      const qn = H(qx, EAVE + 0.036, 0);
      const quiltLit = loftLit('#ffffff', 1.0);
      const geo = prep(quiltGeo, (x, y, z, nx, ny, nz) => {
        const cell = Math.floor((x + 1) / 0.022) * 7 + Math.floor((z + 1) / 0.022) * 3;
        const base = col(patches[cell % patches.length]);
        const l = quiltLit(x + qn[0], y + qn[1], z + qn[2], nx, ny, nz);
        return new Color(base.r * l.r, base.g * l.g, base.b * l.b);
      }, { perFace: true });
      const quilt = glb.node({ name: 'Quilt', mesh: glb.mesh('Quilt', geo, M.painted), translation: qn, parent: root });
      const breath = sample(LOOP, FPS, (t) => {
        const b = 0.5 - 0.5 * Math.cos((TAU * 3 * t) / LOOP);
        return [1, 1 + 0.22 * b, 1 + 0.03 * b];
      });
      glb.animate(quilt, 'scale', breath.times, breath.values);
    }

    // ---- the reader, in a wingback chair beside the lamp.
    {
      const RP = H(-0.075, 0, -0.025);
      const RY = -0.62; // turns the reader from +X toward the window
      const toLocal = (w) => {
        const v = new Vector3(w[0] - RP[0], w[1] - RP[1], w[2] - RP[2]);
        v.applyAxisAngle(new Vector3(0, 1, 0), -RY);
        return v.toArray();
      };
      const lampL = toLocal(lampW);
      const rl = (base, gain = 1.6) => lamplit(base, lampL, { amb: 0.32, gain, reach: 0.11 });
      const parts = [];
      const add2 = (g, base, gain) => parts.push(prep(g, rl(base, gain)));
      const velvet = '#a8443a';
      add2(xf(new BoxGeometry(0.058, 0.022, 0.066), { at: [0.002, 0.035, 0] }), velvet);
      add2(xf(new CapsuleGeometry(0.018, 0.06, 4, 10), { s: [0.55, 1, 1.9], at: [-0.03, 0.08, 0] }), velvet);
      for (const s of [-1, 1]) {
        add2(xf(new CapsuleGeometry(0.0095, 0.045, 4, 8), { rz: Math.PI / 2, at: [0.004, 0.056, s * 0.034] }), velvet);
        add2(xf(new BoxGeometry(0.014, 0.05, 0.012), { ry: s * 0.2, at: [-0.024, 0.098, s * 0.033] }), velvet);
        for (const lx of [-0.022, 0.026]) add2(xf(new CylinderGeometry(0.0025, 0.002, 0.024, 6), { at: [lx, 0.012, s * 0.028] }), '#4a2f22');
      }
      // Person: knitted mustard sweater, dark trousers, socks.
      const sweater = '#d9a441';
      add2(xf(new CapsuleGeometry(0.0145, 0.026, 4, 10), { rz: 0.28, s: [1, 1, 1.15], at: [-0.009, 0.078, 0] }), sweater);
      add2(xf(new SphereGeometry(0.0145, 16, 12), { at: [-0.015, 0.117, 0] }), '#e8b48a');
      add2(xf(new SphereGeometry(0.0155, 16, 12), { s: [1, 0.95, 1.02], at: [-0.02, 0.12, 0] }), '#4a2c1e');
      add2(xf(new SphereGeometry(0.0075, 10, 8), { at: [-0.031, 0.132, 0] }), '#4a2c1e');
      add2(xf(new SphereGeometry(0.0028, 6, 4), { at: [-0.0005, 0.116, 0] }), '#e0a37a'); // nose
      for (const s of [-1, 1]) {
        add2(xf(new CapsuleGeometry(0.008, 0.026, 4, 8), { rz: Math.PI / 2, at: [0.016, 0.054, s * 0.009] }), '#3a3f55');
        add2(xf(new CapsuleGeometry(0.0068, 0.026, 4, 8), { at: [0.033, 0.033, s * 0.009] }), '#3a3f55');
        add2(xf(new CapsuleGeometry(0.0055, 0.008, 4, 8), { rz: Math.PI / 2, at: [0.04, 0.008, s * 0.009] }), '#e8d8b8');
        // Arms reach forward to hold the book.
        add2(xf(new CapsuleGeometry(0.0055, 0.022, 4, 8), { rz: 0.3, rx: s * 0.2, at: [-0.004, 0.085, s * 0.019] }), sweater);
        add2(xf(new CapsuleGeometry(0.005, 0.02, 4, 8), { rz: 1.25, rx: s * -0.4, at: [0.012, 0.081, s * 0.013] }), sweater);
      }
      const readerNode = glb.node({ name: 'Reader', translation: RP, rotation: quat([0, 1, 0], RY), parent: root });
      glb.node({ name: 'ReaderBody', mesh: glb.mesh('ReaderBody', mergeGeometries(parts), M.painted), parent: readerNode });

      // The book: spine toward the reader, pages in a shallow V.
      const BP = [0.03, 0.09, 0];
      const BT = -0.75;
      const book = glb.node({ name: 'Book', translation: BP, rotation: quat([0, 0, 1], BT), parent: readerNode });
      const lampB = (() => {
        const v = new Vector3(lampL[0] - BP[0], lampL[1] - BP[1], lampL[2] - BP[2]).applyAxisAngle(new Vector3(0, 0, 1), -BT);
        return v.toArray();
      })();
      const bl = (base, gain = 1.7) => lamplit(base, lampB, { amb: 0.4, gain, reach: 0.11 });
      const B0 = 0.3;
      const PW = 0.019;
      const PH = 0.027;
      const half = (beta, color, thick, offset = 0) => {
        const g = new BoxGeometry(thick, PH, PW);
        g.translate(-offset, 0, PW / 2);
        g.rotateY(beta);
        return prep(g, bl(color));
      };
      const bookParts = [half(B0, '#fff3dc', 0.003, 0), half(Math.PI - B0, '#fff3dc', 0.003, 0), half(B0, '#9c3d33', 0.0012, -0.002), half(Math.PI - B0, '#9c3d33', 0.0012, -0.002)];
      bookParts.push(prep(xf(new CylinderGeometry(0.002, 0.002, PH, 6), { at: [0.001, 0, 0] }), bl('#7a2f28')));
      glb.node({ name: 'BookBody', mesh: glb.mesh('BookBody', mergeGeometries(bookParts), M.painted), parent: book });
      const pageGeo = new BoxGeometry(0.0006, PH * 0.97, PW * 0.97);
      pageGeo.translate(-0.0022, 0, PW * 0.485);
      const page = glb.node({ name: 'Page', mesh: glb.mesh('Page', prep(pageGeo, bl('#fffaf0', 2.0)), M.painted), rotation: quat([0, 1, 0], B0), parent: book });
      // Two turns a loop; the page snaps home once it lies flush on the left stack.
      const turns = [4.2, 10.6];
      const pageKeys = sample(LOOP, 24, (t) => {
        let beta = B0;
        for (const t0 of turns) {
          const u = (t - t0) / 1.1;
          if (u > 0 && u < 1) beta = B0 - (Math.PI) * (0.5 - 0.5 * Math.cos(Math.PI * u));
        }
        return quat([0, 1, 0], beta);
      });
      glb.animate(page, 'rotation', pageKeys.times, pageKeys.values);
    }
  }

  // ---- outside: lean-to, woodpile and the sleeping cat (back)
  {
    const z0 = HZ - WZ; // back wall face
    const zf = z0 - 0.105;
    const x0 = -0.17;
    const x1 = 0.06;
    const walnut = '#4b3830';
    for (const x of [x0, x1]) put('solid', xf(new CylinderGeometry(0.006, 0.007, 0.15, 8), { at: [x, Y0 + 0.075, zf + 0.006] }), walnut);
    {
      // A curved lean-to roof, planted with moss.
      const roof = grid(10, 14, (i, j) => {
        const x = x0 - 0.02 + ((x1 - x0 + 0.04) * i) / 10;
        const u = j / 14;
        const z = z0 - u * 0.125;
        const y = Y0 + 0.19 - 0.045 * u ** 1.5 + 0.01 * Math.sin(Math.PI * u);
        return { p: [x, y, z], c: mix('#2a6a50', P.olive, fbm3(x * 30, z * 30, 0, { seed: 81 }) * 0.6) };
      }, () => [0, 1, 0]);
      put('solid', roof);
      put('solid', xf(new CylinderGeometry(0.005, 0.005, x1 - x0 + 0.04, 6), { rz: Math.PI / 2, at: [(x0 + x1) / 2, Y0 + 0.147, z0 - 0.125] }), walnut);
    }
    // Logs, stacked three rows.
    const logEnd = (x, y, z) => mix('#c49a6c', '#e8c590', fbm3(x * 200, y * 200, z * 200, { seed: 82 }));
    const R = 0.0115;
    const rows = [4, 3, 2];
    rows.forEach((n, row) => {
      for (let k = 0; k < n; k += 1) {
        const z = zf + 0.018 + (k + row * 0.5) * 2 * R * 0.98 * (0.07 / 0.07);
        const y = Y0 + R + row * R * 1.72;
        const len = 0.2 - 0.01 * random();
        const g = new CylinderGeometry(R * (0.9 + 0.2 * random()), R, len, 9);
        g.rotateZ(Math.PI / 2);
        g.translate((x0 + x1) / 2 + (random() - 0.5) * 0.01, y, z);
        put('solid', g, (px, py, pz, nx) => (Math.abs(nx) > 0.7 ? logEnd(px, py, pz) : mix('#3d2c25', '#5a4034', noise3(py * 300, pz * 300, px * 40, 3))));
      }
    });
    // Lantern hanging from the lean-to, beside the cat.
    const lx = x1 - 0.03;
    const lzz = zf + 0.02;
    put('solid', xf(new CylinderGeometry(0.0008, 0.0008, 0.03, 4), { at: [lx, Y0 + 0.133, lzz] }), '#2d2422');
    put('brass', xf(new ConeGeometry(0.009, 0.007, 8), { at: [lx, Y0 + 0.118, lzz] }));
    put('ember', xf(new SphereGeometry(0.0065, 10, 8), { s: [1, 1.25, 1], at: [lx, Y0 + 0.107, lzz] }));

    // The cat: a ginger loaf curled on the top row.
    const catTop = Y0 + R + 2 * R * 1.72 + R * 0.85;
    const CX = -0.035;
    const CZ = zf + 0.018 + 1.5 * 2 * R * 0.98;
    const catLamp = [lx, Y0 + 0.107, lzz];
    const fur = (x, y, z, nx, ny, nz) => {
      const stripe = 0.5 + 0.5 * Math.sin((x - CX) * 380 + 2 * noise3(x * 90, y * 90, z * 90, 4));
      const base = mix('#e0893a', '#a9531f', smooth(0.55, 0.85, stripe));
      const warm = lamplit('#ffffff', catLamp, { amb: 0.78, gain: 0.7, reach: 0.06, tint: '#ffe0b0' })(x, y, z, nx, ny, nz);
      return new Color(Math.min(1, base.r * warm.r), Math.min(1, base.g * warm.g), Math.min(1, base.b * warm.b));
    };
    const catParts = [];
    const cat = (g, c = fur) => catParts.push(prep(g, c));
    cat(xf(new SphereGeometry(1, 20, 14), { s: [0.034, 0.02, 0.024], at: [CX, catTop + 0.012, CZ] }));
    cat(xf(new SphereGeometry(0.0145, 16, 12), { s: [1, 0.9, 1], at: [CX + 0.03, catTop + 0.013, CZ - 0.009] }));
    // Muzzle and paws in cream.
    cat(xf(new SphereGeometry(0.0065, 10, 8), { s: [1, 0.75, 1], at: [CX + 0.036, catTop + 0.008, CZ - 0.019] }), '#f4e2c4');
    cat(xf(new SphereGeometry(0.006, 8, 6), { s: [1.6, 0.6, 1], at: [CX + 0.026, catTop + 0.002, CZ - 0.022] }), '#f4e2c4');
    // Closed eyes: two dark lids.
    for (const dx of [-0.004, 0.006]) cat(xf(new CapsuleGeometry(0.0011, 0.004, 2, 6), { rz: Math.PI / 2, ry: 0.5, at: [CX + 0.032 + dx, catTop + 0.017, CZ - 0.021 + dx * 0.4] }), '#2a1a14');
    // Left ear (static); the right ear twitches.
    const earGeo = () => {
      const g = new ConeGeometry(0.0065, 0.013, 4);
      g.translate(0, 0.0065, 0);
      return g;
    };
    cat(xf(earGeo(), { rz: 0.25, rx: -0.15, at: [CX + 0.024, catTop + 0.023, CZ - 0.004] }));
    // Tail: wraps round the front of the body.
    const tailPts = [];
    for (let i = 0; i <= 8; i += 1) {
      const a = -0.7 - (i / 8) * 2.1;
      tailPts.push([CX - 0.028 * Math.cos(a) * -1 + 0.0, catTop + 0.006 - 0.001 * i, CZ + 0.024 * Math.sin(-a) * 1.05]);
    }
    tailPts.reverse();
    const tail = taper(tailPts, 0.0055, 0.0045, { radial: 7, segs: 20 });
    cat(tail.g);
    glb.node({ name: 'Cat', mesh: glb.mesh('Cat', mergeGeometries(catParts), M.solid), parent: root });
    {
      const end = tail.curve.getPointAt(1);
      const dir = tail.curve.getTangentAt(1);
      const tip = taper([[0, 0, 0], [dir.x * 0.012, dir.y * 0.012 + 0.002, dir.z * 0.012], [dir.x * 0.02 + 0.002, 0.005, dir.z * 0.02]], 0.0046, 0.0028, { radial: 7, segs: 10 }).g;
      const tipGeo = prep(tip, (x, y, z, nx, ny, nz) => fur(x + end.x, y + end.y, z + end.z, nx, ny, nz));
      const tipNode = glb.node({ name: 'CatTailTip', mesh: glb.mesh('CatTailTip', tipGeo, M.solid), translation: end.toArray(), parent: root });
      const flicks = [2.6, 3.3, 9.1];
      const k = sample(LOOP, 24, (t) => {
        let a = 0;
        for (const t0 of flicks) {
          const u = (t - t0) / 0.5;
          if (u > 0 && u < 1) a += 0.7 * Math.sin(Math.PI * u) * Math.sin(TAU * u);
        }
        return quat([0, 1, 0], a);
      });
      glb.animate(tipNode, 'rotation', k.times, k.values);

      const earPos = [CX + 0.034, catTop + 0.022, CZ - 0.015];
      const earNode = glb.node({ name: 'CatEar', mesh: glb.mesh('CatEar', prep(earGeo(), (x, y, z, nx, ny, nz) => fur(x + earPos[0], y + earPos[1], z + earPos[2], nx, ny, nz)), M.solid), translation: earPos, parent: root });
      const twitch = sample(LOOP, 24, (t) => {
        let a = 0;
        for (const t0 of [6.2, 6.55]) {
          const u = (t - t0) / 0.22;
          if (u > 0 && u < 1) a += 0.45 * Math.sin(Math.PI * u);
        }
        return quatMulLocal(quat([1, 0, 0], -0.2 - a), quat([0, 0, 1], -0.25));
      });
      glb.animate(earNode, 'rotation', twitch.times, twitch.values);
    }
    keepOut.push([(x0 + x1) / 2, zf + 0.04, 0.13]);
  }

  // ---- the garden side (+X): beds, watering can, string lamps
  const stringBulbs = [];
  {
    const walnut = '#4b3830';
    const bed = (cx, cz, w, d, plant) => {
      const hgt = 0.032;
      for (const [bw, bd, ox, oz] of [[w, 0.008, 0, d / 2], [w, 0.008, 0, -d / 2], [0.008, d, w / 2, 0], [0.008, d, -w / 2, 0]]) {
        put('solid', xf(new BoxGeometry(bw, hgt, bd), { at: [cx + ox, Y0 + hgt / 2 - 0.004, cz + oz] }), (x, y) => mix('#4b3830', '#6b5040', 0.5 + 0.5 * Math.sin(y * 500)));
      }
      put('solid', xf(new BoxGeometry(w - 0.006, 0.004, d - 0.006), { at: [cx, Y0 + hgt - 0.008, cz] }), '#2b211d');
      for (let i = 0; i < 5; i += 1) {
        for (const row of [-1, 1]) {
          const x = cx - w / 2 + 0.018 + ((w - 0.036) * i) / 4;
          const z = cz + row * d * 0.22;
          if (plant === 'cabbage') {
            put('solid', xf(new IcosahedronGeometry(0.012, 1), { s: [1, 0.75, 1], at: [x, Y0 + hgt - 0.002, z] }), mix('#4fae82', P.green, random()));
          } else {
            tuft(x, z, 1.2, '#6f9a3a', Y0 + hgt - 0.006);
            put('solid', xf(new ConeGeometry(0.003, 0.006, 5), { rx: Math.PI, at: [x, Y0 + hgt - 0.004, z] }), '#e07a3a');
          }
        }
      }
      keepOut.push([cx, cz, Math.max(w, d) / 2 + 0.01]);
    };
    bed(0.34, -0.21, 0.14, 0.07, 'cabbage');
    bed(0.37, -0.07, 0.13, 0.065, 'carrot');

    // Watering can.
    {
      const [x, z] = [0.255, -0.13];
      const y = topY(x, z);
      put('solid', xf(new CylinderGeometry(0.012, 0.013, 0.022, 14), { at: [x, y + 0.011, z] }), '#5d8fb5');
      put('solid', taper([[x + 0.01, y + 0.008, z], [x + 0.022, y + 0.018, z], [x + 0.03, y + 0.03, z]], 0.0028, 0.002, { segs: 8 }).g, '#5d8fb5');
      put('brass', xf(new CylinderGeometry(0.004, 0.0025, 0.003, 8), { rz: -0.9, at: [x + 0.031, y + 0.031, z] }));
      put('solid', xf(new TorusGeometry(0.009, 0.0016, 5, 16, Math.PI), { at: [x - 0.002, y + 0.022, z] }), '#5d8fb5');
      keepOut.push([x, z, 0.02]);
    }

    // Stepping stones from the door to the front.
    const stones = [[0.215, -0.02], [0.235, 0.04], [0.255, 0.1], [0.265, 0.16], [0.275, 0.22], [0.285, 0.28]];
    for (const [x, z] of stones) {
      put('solid', xf(new CylinderGeometry(0.019, 0.021, 0.006, 9), { s: [1, 1, 0.8], ry: random() * 3, at: [x, topY(x, z) + 0.001, z] }), mix('#5f7286', '#7c8ea0', random()));
      keepOut.push([x, z, 0.022]);
    }

    // String lamps on poles.
    const poles = [[0.43, -0.16], [0.475, 0.0], [0.43, 0.15], [0.33, 0.26]];
    const PH = 0.13;
    for (const [x, z] of poles) {
      put('solid', xf(new CylinderGeometry(0.0025, 0.003, PH, 6), { at: [x, Y0 + PH / 2, z] }), walnut);
      put('brass', xf(new SphereGeometry(0.0035, 6, 4), { at: [x, Y0 + PH + 0.002, z] }));
      keepOut.push([x, z, 0.012]);
    }
    for (let k = 0; k < poles.length - 1; k += 1) {
      const [ax, az] = poles[k];
      const [bx, bz] = poles[k + 1];
      const pts = [];
      for (let i = 0; i <= 10; i += 1) {
        const u = i / 10;
        pts.push([ax + (bx - ax) * u, Y0 + PH - 0.028 * Math.sin(Math.PI * u), az + (bz - az) * u]);
      }
      put('solid', taper(pts, 0.0009, 0.0009, { radial: 4, segs: 20 }).g, '#2d2422');
      for (const u of [0.25, 0.5, 0.75]) stringBulbs.push([ax + (bx - ax) * u, Y0 + PH - 0.028 * Math.sin(Math.PI * u) - 0.007, az + (bz - az) * u]);
    }

    // A bench in the front garden, looking out.
    {
      const [x, z] = [0.15, 0.27];
      const y = topY(x, z);
      const ry = -0.5;
      const benchParts = [
        xf(new BoxGeometry(0.075, 0.005, 0.022), { at: [0, 0.03, 0] }),
        xf(new BoxGeometry(0.075, 0.018, 0.004), { rx: -0.2, at: [0, 0.048, -0.012] })
      ];
      for (const lx of [-0.03, 0.03]) for (const lz of [-0.008, 0.008]) benchParts.push(xf(new BoxGeometry(0.004, 0.03, 0.004), { at: [lx, 0.015, lz] }));
      for (const g of benchParts) put('solid', xf(g, { ry, at: [x, y, z] }), (px, py) => mix('#4b3830', '#6b5040', 0.5 + 0.5 * Math.sin(py * 700)));
      // A mug left on the bench.
      put('solid', xf(new CylinderGeometry(0.004, 0.0037, 0.008, 10), { at: [x + 0.02, y + 0.037, z - 0.005] }), '#e8d8b8');
      keepOut.push([x, z, 0.05]);
    }
  }

  // ---- the left side (-X): a tree that leans over the roof, vines, a pond
  {
    const [tx, tz] = [-0.37, -0.13];
    const ty = topY(tx, tz);
    const bark = (x, y, z) => mix('#3a2c28', '#5a463c', noise3(x * 200, y * 60, z * 200, 11));
    const trunk = taper([[tx, ty - 0.01, tz], [tx + 0.01, ty + 0.12, tz + 0.01], [tx + 0.04, ty + 0.25, tz + 0.0], [tx + 0.08, ty + 0.36, tz + 0.02], [tx + 0.12, ty + 0.42, tz + 0.03]], 0.024, 0.008, { radial: 9, segs: 30 });
    put('solid', trunk.g, bark);
    // Root flare.
    for (let i = 0; i < 5; i += 1) {
      const a = (i / 5) * TAU + 0.3;
      put('solid', taper([[tx, ty + 0.03, tz], [tx + 0.03 * Math.cos(a), ty + 0.004, tz + 0.03 * Math.sin(a)], [tx + 0.05 * Math.cos(a), ty - 0.004, tz + 0.05 * Math.sin(a)]], 0.012, 0.002, { segs: 8 }).g, bark);
    }
    const branches = [
      [[0.35, 0.03], [0.09, 0.07, -0.06]],
      [[0.55, 0.0], [-0.1, 0.09, 0.03]],
      [[0.75, 0.0], [0.05, 0.1, 0.09]],
      [[0.8, 0.0], [0.1, 0.03, -0.08]]
    ];
    const blobs = [];
    for (const [[u], [dx, dy, dz]] of branches) {
      const b = trunk.curve.getPointAt(u);
      const pts = [b.toArray(), [b.x + dx * 0.5, b.y + dy * 0.6, b.z + dz * 0.5], [b.x + dx, b.y + dy, b.z + dz]];
      put('solid', taper(pts, 0.009, 0.003, { segs: 10 }).g, bark);
      blobs.push(pts[2]);
    }
    blobs.push(trunk.curve.getPointAt(1).toArray(), trunk.curve.getPointAt(0.9).toArray());
    const leaf = (x, y, z) => {
      const c = mix('#2a6b52', '#3f8f6a', fbm3(x * 30, y * 30, z * 30, { seed: 91 }));
      c.lerp(col(P.olive), smooth(0.55, 0.75, fbm3(x * 15, y * 15, z * 15, { seed: 92 })) * 0.5);
      // The window's warmth catches the underside of the leaves a little.
      return c.lerp(col('#2b4f63'), smooth(Y0 + 0.5, Y0 + 0.3, y) * 0.0);
    };
    for (const [bx, by, bz] of blobs) {
      for (let i = 0; i < 6; i += 1) {
        const r = 0.032 + 0.02 * random();
        put('solid', xf(new IcosahedronGeometry(r, 1), { s: [1, 0.78, 1], at: [bx + (random() - 0.5) * 0.07, by + (random() - 0.2) * 0.04, bz + (random() - 0.5) * 0.07] }), leaf);
      }
    }
    keepOut.push([tx, tz, 0.07]);

    // Ivy climbing the left gable and front corner.
    const ivy = (pts) => {
      const { g, curve } = taper(pts, 0.0028, 0.0012, { segs: 24 });
      put('solid', g, '#3a5a3a');
      for (let i = 0; i < 16; i += 1) {
        const p = curve.getPointAt(0.05 + 0.9 * random());
        put('solid', xf(new IcosahedronGeometry(0.0075 + 0.003 * random(), 0), { s: [1, 1, 0.5], ry: random() * 3, at: [p.x + (random() - 0.5) * 0.01, p.y, p.z + (random() - 0.5) * 0.01] }), mix('#2f7a58', P.green, random() * 0.7));
      }
    };
    const lx = HX - WX - 0.006;
    ivy([[lx, Y0, HZ - 0.12], [lx - 0.002, Y0 + 0.08, HZ - 0.09], [lx, Y0 + 0.16, HZ - 0.12], [lx - 0.003, Y0 + 0.24, HZ - 0.08], [lx, Y0 + 0.3, HZ - 0.05]]);
    ivy([[HX - WX - 0.004, Y0, HZ + WZ + 0.006], [HX - WX + 0.02, Y0 + 0.07, HZ + WZ + 0.006], [HX - WX + 0.005, Y0 + 0.14, HZ + WZ + 0.007], [HX - WX + 0.035, Y0 + 0.18, HZ + WZ + 0.007]]);
    ivy([[HX + WX + 0.004, Y0, HZ - 0.13], [HX + WX + 0.006, Y0 + 0.09, HZ - 0.1], [HX + WX + 0.004, Y0 + 0.17, HZ - 0.14]]);

    // Pond: unlit, holding the sky and a fleck of window light.
    const [px, pz] = [-0.37, 0.15];
    const py = topY(px, pz) + 0.002;
    put('painted', xf(new CylinderGeometry(1, 1, 0.003, 36), { s: [0.08, 1, 0.055], at: [px, py, pz] }), (x, y, z) => {
      const r = Math.hypot((x - px) / 0.08, (z - pz) / 0.055);
      const c = mix(TOKEN.identity[5], '#2a5d86', r);
      return c.lerp(col(P.glow), Math.max(0, 1 - Math.hypot((x - px - 0.035) / 0.02, (z - pz + 0.02) / 0.012)) * 0.7);
    });
    for (let i = 0; i < 12; i += 1) {
      const a = (i / 12) * TAU;
      const rx = px + Math.cos(a) * 0.085;
      const rz = pz + Math.sin(a) * 0.06;
      put('solid', xf(new IcosahedronGeometry(0.009 + 0.006 * random(), 0), { s: [1, 0.55, 1], at: [rx, topY(rx, rz) + 0.002, rz] }), mix('#5a6878', '#7c8ea0', random()));
    }
    for (const [dx, dz] of [[-0.03, 0.01], [0.01, 0.025], [0.02, -0.015]]) {
      put('solid', xf(new CylinderGeometry(0.011, 0.011, 0.0015, 12, 1, false, 0.4, TAU - 0.8), { at: [px + dx, py + 0.002, pz + dz] }), '#3f8a63');
    }
    flower(px + 0.012, pz + 0.027, P.cream, py + 0.003, 0.004);
    // Bulrushes.
    for (let i = 0; i < 5; i += 1) {
      const x = px - 0.07 + i * 0.008;
      const z = pz - 0.02 + (random() - 0.5) * 0.02;
      const h = 0.05 + 0.02 * random();
      put('solid', xf(new CylinderGeometry(0.0008, 0.001, h, 3), { at: [x, py + h / 2, z] }), '#4f7a3a');
      put('solid', xf(new CapsuleGeometry(0.0022, 0.008, 2, 5), { at: [x, py + h - 0.004, z] }), '#5a3a2a');
    }
    keepOut.push([px, pz, 0.1]);

    // Rain barrel by the front-left corner.
    {
      const [bx, bz] = [HX - WX - 0.035, HZ + WZ - 0.03];
      put('solid', xf(new CylinderGeometry(0.022, 0.02, 0.05, 14), { at: [bx, Y0 + 0.025, bz] }), (x, y) => mix('#4b3830', '#6b5040', 0.5 + 0.5 * Math.sin(y * 300)));
      for (const hy of [0.012, 0.038]) put('brass', xf(new TorusGeometry(0.0215, 0.0015, 4, 20), { rx: Math.PI / 2, at: [bx, Y0 + hy, bz] }));
      put('painted', xf(new CylinderGeometry(0.019, 0.019, 0.002, 14), { at: [bx, Y0 + 0.047, bz] }), (x, y, z) => mix(TOKEN.identity[5], '#2a5d86', Math.hypot(x - bx, z - bz) / 0.019));
      keepOut.push([bx, bz, 0.03]);
    }
  }

  // ---- ground cover: grass and flowers wherever nothing else stands
  {
    const flowerColors = [P.cream, P.gold, P.blue1, P.cream, '#e8a0b0'];
    let placed = 0;
    for (let tries = 0; tries < 2400 && placed < 260; tries += 1) {
      const x = (random() * 2 - 1) * RX;
      const z = (random() * 2 - 1) * RZ;
      const f = rimFrac(x, z);
      if (f > 0.9 || blocked(x, z)) continue;
      // Flowers crowd the front garden; grass everywhere.
      if (z > HZ + RA && random() < 0.28) flower(x, z, flowerColors[placed % flowerColors.length]);
      else tuft(x, z, 0.8 + 0.5 * random());
      placed += 1;
    }
  }

  // ---- warm spill painted onto the dusk surfaces, then the merged meshes
  const spills = [
    { p: [HX + WIN.x, Y0 + 0.04, HZ + WZ + 0.06], r: 0.22, s: 0.75, dir: [0, 0, 1] },
    { p: H(WX + 0.04, 0.13, 0.04 - 0.07), r: 0.12, s: 0.6 },
    { p: [0.03, Y0 + 0.1, HZ - WZ - 0.08], r: 0.1, s: 0.55 },
    { p: [HX + 0.15, Y0 + 0.12, HZ - WZ - 0.03], r: 0.07, s: 0.35 },
    ...stringBulbs.map((p) => ({ p, r: 0.06, s: 0.3 }))
  ];
  const warm = col('#ffb56b');
  const paintSpill = (g) => {
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    const c = g.attributes.color;
    for (let i = 0; i < pos.count; i += 1) {
      let w = 0;
      for (const s of spills) {
        const dx = s.p[0] - pos.getX(i);
        const dy = s.p[1] - pos.getY(i);
        const dz = s.p[2] - pos.getZ(i);
        const d = Math.hypot(dx, dy, dz);
        if (d > s.r) continue;
        if (s.dir && -(dx * s.dir[0] + dy * s.dir[1] + dz * s.dir[2]) < -0.01) continue;
        const facing = Math.max(0.25, (nor.getX(i) * dx + nor.getY(i) * dy + nor.getZ(i) * dz) / (d || 1));
        w += s.s * (1 - d / s.r) ** 1.6 * facing;
      }
      w = Math.min(0.85, w);
      if (w <= 0) continue;
      c.setXYZ(i, c.getX(i) + (warm.r - c.getX(i)) * w, c.getY(i) + (warm.g - c.getY(i)) * w, c.getZ(i) + (warm.b - c.getZ(i)) * w);
    }
  };
  groups.solid.forEach(paintSpill);
  let lowest = Infinity;
  for (const [name, list] of Object.entries(groups)) {
    if (list.length === 0) continue;
    const merged = mergeVertices(mergeGeometries(list), 1e-5);
    merged.computeBoundingBox();
    lowest = Math.min(lowest, merged.boundingBox.min.y);
    glb.node({ name: `Static${name[0].toUpperCase()}${name.slice(1)}`, mesh: glb.mesh(name, merged, M[name]), parent: root });
  }
  // Stand the slab on its lowest root tip.
  glb.json.nodes[root].translation = [0, -lowest, 0];

  // ---- light pools on the ground (unlit, alpha falls off), breathing faintly
  const pool = (name, cx, cz, rx, rz, color, alpha, breath, phase) => {
    const c = col(color);
    const g = grid(8, 40, (i, j) => {
      const f = i / 8;
      const a = (j / 40) * TAU;
      const x = f * rx * Math.cos(a);
      const z = f * rz * Math.sin(a);
      return { p: [x, topY(cx + x, cz + z) + 0.005, z], c };
    }, () => [0, 1, 0]);
    const geo = prep(g, color, { alpha: (x, y, z) => alpha * (1 - Math.min(1, Math.hypot(x / rx, z / rz)) ** 2) ** 2 });
    const node = glb.node({ name, mesh: glb.mesh(name, geo, M.spill), translation: [cx, 0, cz], parent: root });
    const k = sample(LOOP, FPS, (t) => {
      const b = 1 + breath * Math.sin((TAU * 2 * t) / LOOP + phase) + breath * 0.4 * Math.sin((TAU * 5 * t) / LOOP + phase * 2);
      return [b, 1, b];
    });
    glb.animate(node, 'scale', k.times, k.values);
  };
  pool('WindowPool', HX + WIN.x, HZ + WZ + 0.11, 0.13, 0.1, TOKEN.glow, 0.55, 0.04, 0);
  pool('DoorPool', HX + WX + 0.05, HZ + 0.0, 0.07, 0.09, TOKEN.glow, 0.45, 0.05, 1.3);
  pool('LeanToPool', 0.03, HZ - WZ - 0.06, 0.08, 0.06, TOKEN.glow, 0.35, 0.05, 2.1);
  stringBulbs.forEach(([x, , z], i) => pool(`BulbPool${i + 1}`, x, z, 0.03, 0.03, TOKEN.gold, 0.32, 0.08, i * 0.9));

  // ---- string-lamp bulbs breathe
  const bulbMesh = glb.mesh('StringBulb', prep(xf(new SphereGeometry(0.0048, 10, 8), { s: [1, 1.25, 1] })), M.bulb);
  stringBulbs.forEach((p, i) => {
    const node = glb.node({ name: `StringBulb${i + 1}`, mesh: bulbMesh, translation: p, parent: root });
    const k = sample(LOOP, FPS, (t) => {
      const b = 1 + 0.12 * Math.sin((TAU * 3 * t) / LOOP + i * 1.7);
      return [b, b, b];
    });
    glb.animate(node, 'scale', k.times, k.values);
  });

  // ---- root lights pulse downward in sequence, as if the house breathes below
  const rootMesh = glb.mesh('RootLight', prep(new SphereGeometry(0.0055, 10, 8)), M.ember);
  rootLights.forEach(({ p, u, root: r }, i) => {
    const node = glb.node({ name: `RootLight${i + 1}`, mesh: rootMesh, translation: p, parent: root });
    const k = sample(LOOP, FPS, (t) => {
      const phase = frac((2 * t) / LOOP - u * 0.55 - (r % 7) * 0.07);
      const pulse = Math.exp(-(((phase - 0.5) / 0.09) ** 2));
      const s = 0.45 + 1.0 * pulse;
      return [s, s, s];
    });
    glb.animate(node, 'scale', k.times, k.values);
  });

  // ---- fireflies on slow closed paths over the garden
  const flyMesh = glb.mesh('Firefly', prep(new SphereGeometry(0.0055, 8, 6)), M.fly);
  const flyCenters = [
    [0.33, 0.1, 0.06], [0.42, 0.16, -0.1], [0.28, 0.2, 0.2], [0.18, 0.12, 0.3], [0.05, 0.16, 0.28], [-0.12, 0.1, 0.3],
    [-0.3, 0.14, 0.18], [-0.42, 0.22, 0.0], [0.38, 0.24, 0.12], [0.22, 0.09, -0.26], [-0.22, 0.2, -0.3], [0.1, 0.3, 0.24]
  ];
  flyCenters.forEach(([cx, cy, cz], i) => {
    const node = glb.node({ name: `Firefly${i + 1}`, mesh: flyMesh, translation: [cx, Y0 + cy, cz], parent: root });
    const k1 = 1 + (i % 2);
    const k2 = 2 + (i % 3);
    const ph = i * 1.31;
    const move = sample(LOOP, FPS, (t) => {
      const w = (TAU * t) / LOOP;
      return [cx + 0.05 * Math.sin(k1 * w + ph), Y0 + cy + 0.025 * Math.sin(k2 * w + ph * 0.7), cz + 0.04 * Math.cos(k1 * w + ph * 1.3)];
    });
    glb.animate(node, 'translation', move.times, move.values);
    const blink = sample(LOOP, FPS, (t) => {
      const b = Math.max(0, Math.sin((TAU * (3 + (i % 3)) * t) / LOOP + ph)) ** 5;
      const s = 0.2 + 1.0 * b;
      return [s, s, s];
    });
    glb.animate(node, 'scale', blink.times, blink.values);
  });

  // ---- chimney smoke: puffs rise, swell and thin away
  {
    const smokeMesh = glb.mesh('SmokePuff', prep(new IcosahedronGeometry(0.018, 1)), M.smoke);
    const [cx, , cz] = H(-0.11, 0, -0.07);
    const base = Y0 + 0.5;
    for (let i = 0; i < 5; i += 1) {
      const node = glb.node({ name: `Smoke${i + 1}`, mesh: smokeMesh, translation: [cx, base, cz], scale: HIDDEN, parent: root });
      const k = sample(LOOP, FPS, () => [0]);
      const tr = [];
      const sc = [];
      k.times.forEach((t) => {
        const u = frac((2 * t) / LOOP + i / 5);
        tr.push(cx + 0.07 * u ** 1.4 + 0.01 * Math.sin(u * 7 + i), base + 0.2 * u, cz + 0.015 * Math.sin(u * 5 + i * 2));
        const s = Math.max(1e-4, Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 0.8 * (0.5 + 1.1 * u));
        sc.push(s, s, s);
      });
      glb.animate(node, 'translation', k.times, tr);
      glb.animate(node, 'scale', k.times, sc);
    }
  }

  // ---- sparks lifting off the burnt rim
  {
    const sparkMesh = glb.mesh('Spark', prep(new SphereGeometry(0.0032, 6, 4)), M.ember);
    const outline = rimOutline(16, 0);
    for (let i = 0; i < 10; i += 1) {
      const p = outline[(i * 7 + 3) % outline.length];
      const node = glb.node({ name: `Spark${i + 1}`, mesh: sparkMesh, translation: p.toArray(), scale: HIDDEN, parent: root });
      const k = sample(LOOP, FPS, () => [0, 0, 0]);
      const tr = [];
      const sc = [];
      k.times.forEach((t) => {
        const u = frac((2 * t) / LOOP + i * 0.37);
        const live = u < 0.4 ? u / 0.4 : 0;
        const out = 1 + 0.06 * live;
        tr.push(p.x * out, p.y + 0.07 * live, p.z * out);
        const s = live > 0 ? Math.max(1e-4, Math.sin(Math.PI * live)) : 1e-4;
        sc.push(s, s, s);
      });
      glb.animate(node, 'translation', k.times, tr);
      glb.animate(node, 'scale', k.times, sc);
    }
  }

  glb.audio(sound());
  return glb;
}

function quatMulLocal(a, b) {
  // a * b for [x, y, z, w] quaternions.
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

// ---------------------------------------------------------------- sound

function sound() {
  const out = track(LOOP);
  const N = out.length;

  // Wind: low-passed noise, generated long and cross-faded over the seam.
  {
    const F = Math.round(1.5 * SAMPLE_RATE);
    const raw = new Float32Array(N + F);
    const r = noise(5);
    for (let i = 0; i < raw.length; i += 1) raw[i] = r();
    lowpass(raw, 260);
    lowpass(raw, 320);
    for (let i = 0; i < N; i += 1) {
      let s = raw[i];
      if (i < F) {
        const a = i / F;
        s = raw[i] * Math.sin((a * Math.PI) / 2) + raw[N + i] * Math.cos((a * Math.PI) / 2);
      }
      const t = i / SAMPLE_RATE;
      const gust = 0.7 + 0.3 * Math.sin((TAU * t) / LOOP) + 0.12 * Math.sin((TAU * 3 * t) / LOOP + 1);
      out[i] += s * 0.55 * gust;
    }
  }

  // Crickets: chirp trains of three to four pulses, two voices.
  const cricket = (hz, gap, pulses, gain, seed, offset) => {
    const r = rng(seed);
    for (let at = offset; at < LOOP; at += gap * (0.85 + 0.3 * r())) {
      if (r() < 0.12) continue;
      for (let p = 0; p < pulses; p += 1) {
        add(out, at + p * 0.034, 0.022, sine(hz * (1 + 0.004 * r())), (t) => gain * Math.sin((Math.PI * t) / 0.022) ** 2);
      }
    }
  };
  cricket(4300, 0.62, 3, 0.05, 3, 0.1);
  cricket(3700, 0.9, 4, 0.035, 8, 0.43);

  // Kalimba: a sparse phrase that comes home by the loop point.
  const tine = (hz) => (t) => Math.sin(TAU * hz * t) + 0.22 * Math.sin(TAU * hz * 5.9 * t) * Math.exp(-t * 9) + 0.12 * Math.sin(TAU * hz * 2 * t) * Math.exp(-t * 3);
  const note = (at, hz, gain) => add(out, at, 3.2, tine(hz), (t) => gain * (t < 0.004 ? t / 0.004 : Math.exp(-t / 0.75)));
  const D4 = 293.66;
  const E4 = 329.63;
  const FS4 = 369.99;
  const A4 = 440.0;
  const B4 = 493.88;
  const A3 = 220.0;
  const D5 = 587.33;
  note(0.6, A4, 0.16);
  note(1.7, FS4, 0.14);
  note(2.9, E4, 0.13);
  note(4.6, D4, 0.15);
  note(7.2, B4, 0.12);
  note(8.1, A4, 0.13);
  note(9.3, FS4, 0.12);
  note(10.8, E4, 0.11);
  note(12.0, D4, 0.14);
  note(12.0, A3, 0.08);
  note(12.9, D5, 0.05);

  return toWav(normalize(out, 0.5));
}

// ---------------------------------------------------------------- tiles

const W = (x, y, z) => [HX + x, Y0 + y, HZ + z];
const tilesAtModelScale = [
  { view: 'front', t: 2.0 },
  { view: 'quarter', t: 4.6 },
  { view: 'right', t: 6.0 },
  { view: 'back', t: 3.0 },
  { view: 'left', t: 8.0 },
  { view: 'top', t: 5.0 },
  { label: 'window', cam: W(WIN.x + 0.03, WIN.y + 0.03, WZ + 0.2), look: W(WIN.x - 0.02, WIN.y - 0.005, -0.03), t: 4.75, fov: 34 },
  { label: 'cat', cam: [0.06, Y0 + 0.13, HZ - WZ - 0.3], look: [-0.03, Y0 + 0.05, HZ - WZ - 0.08], t: 2.85, fov: 34 },
  { label: 'roots', cam: [0.55, 0.03, 0.85], look: [0, 0.16, 0], t: 1.0, fov: 50 },
  { label: 'skylight', cam: W(SKY.x + 0.002, RB + EAVE + 0.33, 0.012), look: W(SKY.x, EAVE, 0), t: 2.3, fov: 30 },
  { label: 'garden', cam: [0.75, Y0 + 0.2, 0.25], look: [0.3, Y0 + 0.05, -0.05], t: 7.0, fov: 40 },
  { label: 'cut side', cam: [-0.42, 0.2, 0.72], look: [-0.3, 0.17, 0.25], t: 3.5, fov: 40 }
];

export const tiles = tilesAtModelScale.map((tile) =>
  tile.cam ? { ...tile, cam: tile.cam.map((v) => v * SHOWN), look: tile.look.map((v) => v * SHOWN) } : tile
);
