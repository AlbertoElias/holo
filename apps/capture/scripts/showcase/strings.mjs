import { Buffer } from 'node:buffer';
import process from 'node:process';
import { crc32, deflateSync } from 'node:zlib';

import {
  BoxGeometry,
  BufferGeometry,
  CatmullRomCurve3,
  ConeGeometry,
  Euler,
  ExtrudeGeometry,
  Float32BufferAttribute,
  LatheGeometry,
  Matrix4,
  Object3D,
  Path,
  Quaternion,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  TubeGeometry,
  Vector2,
  Vector3
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { SAMPLE_RATE, add, lowpass, noise, normalize, pluck, sine, toWav, track } from './lib/audio.mjs';
import { Glb, linear } from './lib/glb.mjs';
import { fbm3, noise3, rng } from './lib/parts.mjs';
import { T } from './lib/tokens.mjs';

// "Who holds the strings": from the front, a marionette theatre with a puppet
// dancing in its lit opening, working a tinier puppet on a tinier stage. From
// the side, the life-size puppeteer behind the backdrop, a figure of light.
// From above, the puppeteer's own strings, rising to a bar in a giant hand cut
// off by the torn edge of the hologram. One gesture passes down the chain, a
// moment later at each level; in the middle of the loop every one of them
// stops and looks up at whoever holds it.

export const meta = {
  slug: 'who-holds-the-strings',
  name: 'Who holds the strings',
  submittedBy: 'Claude (agent-authored)'
};

const LOOP = 16;
const FPS = 30;
const DELAY = 0.3; // seconds between one level and the next

const FLOOR = 0.05; // top of the slab
const STAGE = 1.0; // stage floor, the proscenium sill
const WALL_Z0 = 0.33; // back face of the theatre's front wall
const WALL_Z1 = 0.38; // its painted front face
const STAGE_BACK = -0.12;
const STAGE_HALF = 0.5;
const BACKDROP_Z = STAGE_BACK + 0.005;
const BACKDROP_TOP = 1.66;
const BACKDROP_HALF = 0.45;
// The front wall, y above the floor. `k` scales the painted bands.
const BIG = { hw: 0.8, rectTop: 2.3, crestTop: 2.58, ox: 0.38, sill: STAGE - FLOOR, top: 1.63, k: 1 };
// The toy theatre on the stage, y above the stage.
const TINY = { hw: 0.1, rectTop: 0.245, crestTop: 0.285, ox: 0.066, sill: 0.02, top: 0.215, k: 0.25, depth: 0.075, thick: 0.012 };

const S1 = 1.0; // the puppeteer, 1.70 m
const S2 = 0.3; // the marionette, about 55 cm with its hat
const S3 = S2 * 0.31; // the tiny one
const S4 = S3 * 0.31; // the bar the tiny one holds, for nobody
const BRIDGE_H = 0.44;
// Where a holder's hand holds its bar, in its own rig units at rest.
const GRIP = [-0.2, 1.45, 0.48];
const L2_AT = [0.02, STAGE, 0.1];
const L2_YAW = -0.9;
const L1_AT = [L2_AT[0] - GRIP[0] * S1, FLOOR + BRIDGE_H + 0.01, L2_AT[2] - GRIP[2] * S1];
const L3_AT = (() => {
  const c = Math.cos(L2_YAW);
  const s = Math.sin(L2_YAW);
  const x = GRIP[0] * S2;
  const z = GRIP[2] * S2;
  return [L2_AT[0] + x * c + z * s, STAGE + TINY.sill, L2_AT[2] - x * s + z * c];
})();
const TINY_FRONT = L3_AT[2] + 0.045;
const HAND_AT = [L1_AT[0], 2.92, L1_AT[2] + 0.22];

const GOLD = T.gold;
const GLOW = T.glow;
const HIGHLIGHT = T.highlight;

const TAU = Math.PI * 2;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mixc = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const lin = (hex) => linear(hex);
const wrap = (t) => ((t % LOOP) + LOOP) % LOOP;
const eul = (x, y, z, order = 'YXZ') => new Quaternion().setFromEuler(new Euler(x, y, z, order));

// ---------------------------------------------------------------------------
// The gesture: one set of channels, eased between keys, then passed through a
// soft spring so limbs overshoot and settle like wood on a string. Every level
// reads the same functions, each DELAY seconds after the level above it.

function ease(keys) {
  return (t) => {
    t = wrap(t);
    let i = 0;
    while (i < keys.length - 2 && t > keys[i + 1][0]) i += 1;
    const [t0, v0] = keys[i];
    const [t1, v1] = keys[i + 1];
    const x = clamp((t - t0) / (t1 - t0 || 1));
    return v0 + (v1 - v0) * x * x * x * (x * (x * 6 - 15) + 10);
  };
}

function springy(fn, hz = 2.3, zeta = 0.38) {
  const rate = 240;
  const n = LOOP * rate;
  const w = TAU * hz;
  const table = new Float64Array(n + 1);
  let x = fn(0);
  let v = 0;
  for (let pass = 0; pass < 3; pass += 1) {
    for (let i = 0; i < n; i += 1) {
      if (pass === 2) table[i] = x;
      const a = w * w * (fn(i / rate) - x) - 2 * zeta * w * v;
      v += a / rate;
      x += v / rate;
    }
  }
  table[n] = table[0];
  return (t) => {
    const f = wrap(t) * rate;
    const i = Math.min(n - 1, Math.floor(f));
    return table[i] + (table[i + 1] - table[i]) * (f - i);
  };
}

const ch = (keys, hz, zeta) => springy(ease(keys), hz, zeta);

// Seconds of the loop: 0-6 a small dance, 6-9 a bow, 9-13 the look up, 13-16
// the strings twitch, heads drop, and they are pulled back to the first pose.
const C = {
  lFwd: ch([[0, -0.12], [0.5, -0.12], [1.2, -2.25], [1.9, -2.25], [2.4, -0.1], [3.2, -0.1], [3.6, -1.5], [4.4, -1.4], [4.75, -0.4], [5.0, -1.2], [5.3, -0.4], [5.9, -0.12], [6.2, -0.12], [7.2, 0.35], [7.9, 0.35], [8.7, -0.12], [9.6, -0.12], [10.8, 0.12], [12.8, 0.12], [13.0, -0.12], [13.1, -0.3], [13.22, -0.1], [13.4, -0.25], [13.55, -0.12], [14.0, 0.05], [15.0, 0.05], [15.7, -0.12], [16, -0.12]]),
  lSide: ch([[0, 0.12], [0.5, 0.12], [0.85, 0.75], [1.2, 0.3], [1.9, 0.3], [2.15, 0.7], [2.4, 0.15], [3.2, 0.2], [3.6, 0.45], [4.4, 0.4], [4.75, 0.3], [5.0, 0.55], [5.3, 0.4], [5.9, 0.12], [6.2, 0.12], [7.2, 0.55], [7.9, 0.55], [8.7, 0.12], [13.0, 0.12], [13.1, 0.55], [13.22, 0.2], [13.4, 0.45], [13.55, 0.12], [14.0, 0.04], [15.0, 0.04], [15.7, 0.12], [16, 0.12]]),
  lElbow: ch([[0, 0.25], [0.5, 0.25], [1.2, 0.15], [1.9, 0.15], [2.4, 0.15], [3.6, 0.15], [4.4, 0.15], [4.75, 0.6], [5.0, 0.3], [5.9, 0.25], [6.2, 0.25], [7.2, 0.35], [7.9, 0.35], [8.7, 0.25], [9.6, 0.25], [10.8, 0.08], [12.8, 0.08], [13.0, 0.25], [14.0, 0.05], [15.0, 0.05], [15.7, 0.25], [16, 0.25]]),
  barLift: ch([[0, 0], [1.9, 0], [2.5, 0.18], [3.1, 0.18], [3.6, 0], [4.75, 0], [5.0, 0.08], [5.3, 0], [6.2, 0], [7.2, -0.05], [7.9, -0.05], [8.7, 0], [9.6, 0], [11.0, 0.03], [12.8, 0.03], [13.1, 0.06], [13.2, 0], [13.4, 0.05], [13.55, 0], [13.8, -0.05], [15.0, -0.05], [15.7, 0], [16, 0]]),
  barFwd: ch([[0, 0], [1.9, 0], [2.5, -0.14], [3.1, -0.14], [3.6, 0], [6.2, 0], [7.2, 0.04], [7.9, 0.04], [8.7, 0], [16, 0]]),
  barRoll: ch([[0, 0], [0.5, 0], [1.1, 0.35], [1.9, 0.35], [2.4, -0.35], [3.1, -0.35], [3.6, 0], [13.0, 0], [13.1, 0.2], [13.22, -0.15], [13.4, 0.12], [13.55, 0], [16, 0]]),
  barPitch: ch([[0, 0], [6.2, 0], [7.2, 0.35], [7.9, 0.35], [8.7, 0], [9.6, 0], [11.0, -0.25], [12.8, -0.25], [13.6, 0], [13.8, 0.12], [15.0, 0.12], [15.7, 0], [16, 0]]),
  barYaw: ch([[0, 0], [3.2, 0], [3.6, -0.35], [4.0, 0.25], [4.4, 0], [16, 0]]),
  turn: ch([[0, 0], [3.2, 0], [3.65, -0.55], [4.05, 0.3], [4.45, 0], [16, 0]]),
  sway: ch([[0, 0], [0.5, 0], [1.2, 0.07], [1.9, 0.07], [2.4, -0.07], [3.1, -0.07], [3.5, 0], [16, 0]]),
  crouch: ch([[0, 0], [4.4, 0], [4.75, 0.38], [4.95, 0], [5.15, 0], [5.3, 0.32], [5.9, 0], [13.6, 0], [14.1, 0.18], [15.0, 0.18], [15.7, 0], [16, 0]], 3.2, 0.6),
  hop: ch([[0, 0], [4.8, 0], [5.02, 0.08], [5.25, 0], [16, 0]], 4, 0.7),
  kick: ch([[0, 0], [3.2, 0], [3.65, 0.28], [4.05, 0], [16, 0]]),
  bow: ch([[0, 0], [6.2, 0], [7.3, 0.85], [7.9, 0.85], [8.8, 0], [16, 0]], 2.0, 0.5),
  look: ch([[0, 0], [9.6, 0], [11.1, 1.0], [12.8, 1.0], [13.6, 0.85], [14.1, -0.5], [15.0, -0.5], [15.7, 0], [16, 0]], 2.0, 0.55),
  slump: ch([[0, 0], [13.6, 0], [14.1, 0.25], [15.0, 0.25], [15.7, 0], [16, 0]]),
  tilt: ch([[0, 0], [0.5, 0], [1.2, 0.18], [1.9, 0.18], [2.4, -0.18], [3.1, -0.18], [3.5, 0], [9.6, 0], [11.1, 0.1], [12.8, 0.1], [13.6, 0], [14.1, 0.2], [15.0, 0.2], [15.7, 0], [16, 0]])
};

function gesture(t) {
  const g = {};
  for (const [name, fn] of Object.entries(C)) g[name] = fn(t);
  return g;
}

/** A bar's tilt, read from its holder's gesture: the cause the level below answers. */
const barTilt = (g) => eul(g.barPitch, g.barYaw, g.barRoll);

// ---------------------------------------------------------------------------
// Geometry helpers. Everything static is merged per material; every piece
// carries position, normal and a linear vertex colour.

function colorize(g, rgb) {
  const count = g.attributes.position.count;
  const data = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) data.set(rgb, i * 3);
  g.setAttribute('color', new Float32BufferAttribute(data, 3));
  return g;
}

function prep(g, hex) {
  let geo = g.index ? g.toNonIndexed() : g;
  if (geo.attributes.uv) geo.deleteAttribute('uv');
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (hex !== undefined) colorize(geo, typeof hex === 'string' ? lin(hex) : hex);
  return geo;
}

/** Shares identical vertices so the file stores each once. */
const compact = (g) => mergeVertices(g, 1e-6);

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

  /** A (rows x cols) grid of `fn(i, j) -> { p, c }`, each quad facing `up(p)`. */
  grid(rows, cols, fn, up) {
    const pts = [];
    for (let i = 0; i <= rows; i += 1) {
      const row = [];
      for (let j = 0; j <= cols; j += 1) row.push(fn(i, j));
      pts.push(row);
    }
    for (let i = 0; i < rows; i += 1) {
      for (let j = 0; j < cols; j += 1) {
        const a = pts[i][j];
        const b = pts[i][j + 1];
        const c = pts[i + 1][j + 1];
        const d = pts[i + 1][j];
        const m = [0, 1, 2].map((k) => (a.p[k] + b.p[k] + c.p[k] + d.p[k]) / 4);
        this.quad(a.p, b.p, c.p, d.p, a.c, b.c, c.c, d.c, up(m));
      }
    }
  }

  /** Smooth by default: shared corners merge and normals average (the winding keeps the facing). */
  geometry(flat = false) {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.c, 3));
    if (flat) {
      g.setAttribute('normal', new Float32BufferAttribute(this.n, 3));
      return g;
    }
    const merged = mergeVertices(g, 1e-6);
    merged.computeVertexNormals();
    return merged.toNonIndexed();
  }
}

function box(x0, x1, y0, y1, z0, z1) {
  const g = new BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

/** A box from a to b (centre line), `w` x `h` across. */
function beam(a, b, w, h = w) {
  const A = new Vector3(...a);
  const B = new Vector3(...b);
  const g = new BoxGeometry(w, A.distanceTo(B), h);
  g.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), B.clone().sub(A).normalize()));
  g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
  return g;
}

function ell(rx, ry, rz, c = [0, 0, 0], ws = 18, hs = 12) {
  const g = new SphereGeometry(1, ws, hs);
  g.scale(rx, ry, rz);
  g.translate(...c);
  return g;
}

/** A tapered capsule from a (radius ra) to b (radius rb), squashed sx / sz across. */
function limb(a, b, ra, rb, sx = 1, sz = 1, radial = 14) {
  const A = new Vector3(...a);
  const B = new Vector3(...b);
  const L = A.distanceTo(B);
  const pts = [];
  const cap = 5;
  for (let i = 0; i <= cap; i += 1) {
    const ang = -Math.PI / 2 + (i / cap) * (Math.PI / 2);
    pts.push(new Vector2(Math.max(1e-4, ra * Math.cos(ang)), ra * Math.sin(ang)));
  }
  for (let i = 1; i <= 3; i += 1) {
    const f = i / 4;
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

// ---------------------------------------------------------------------------
// Painted textures: a tiny PNG writer (node's zlib), so the theatre's face and
// its backdrop can be painted procedurally.

function png(width, height, fn) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x += 1) {
      // fn gets u, v in [0, 1] with v = 1 at the top, and returns sRGB 0..1.
      const c = fn((x + 0.5) / width, 1 - (y + 0.5) / height);
      for (let k = 0; k < 3; k += 1) raw[y * stride + 1 + x * 3 + k] = Math.round(clamp(c[k]) * 255);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const srgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const P = {
  oxblood: srgb('#6b1b1d'),
  oxDark: srgb('#45100f'),
  gilt: srgb('#d4a64e'),
  giltDark: srgb('#7a5520'),
  cream: srgb('#eadcbc'),
  ochre: srgb('#d48a2c'),
  diamondA: srgb('#2a1416'),
  diamondB: srgb('#a12b25')
};

const crestY = (L, x) => L.rectTop + (L.crestTop - L.rectTop) * Math.max(0, 1 - (x / L.hw) ** 2) ** 0.6;

/** The front wall's paint at (x, y) meters of that wall's own frame. */
function facadeColor(L, x, y) {
  const k = L.k;
  const grain = fbm3(x * 3, y * 40, 0.5, { octaves: 3, seed: 3 });
  let c = mixc(P.oxDark, P.oxblood, 0.55 + 0.45 * grain);
  // Outer gilt line, inset from the edge.
  const edge = Math.min(x + L.hw, L.hw - x, y, crestY(L, x) - y);
  if (edge > 0.03 * k && edge < 0.045 * k) c = P.gilt;
  // The proscenium frame: gilt, a dark line, then cream.
  const out = Math.max(Math.abs(x) - L.ox, y - L.top, L.sill - y);
  if (out >= 0 && out < 0.05 * k) c = mixc(P.gilt, P.giltDark, 0.25 * (out / (0.05 * k)));
  else if (out >= 0.05 * k && out < 0.06 * k) c = P.giltDark;
  else if (out >= 0.06 * k && out < 0.1 * k) c = mixc(P.cream, P.gilt, 0.15 * grain);
  // Painted columns either side.
  const inner = L.ox + 0.12 * k;
  const outer = L.hw - 0.06 * k;
  const cw = (outer - inner) / 2 - 0.01 * k;
  if (cw > 0.02) {
    const cx = (inner + outer) / 2;
    const dx = Math.abs(Math.abs(x) - cx);
    const y0 = 0.1 * k;
    const y1 = L.rectTop - 0.12 * k;
    if (dx < cw && y > y0 && y < y1) {
      c = mixc(P.cream, srgb('#cdb98f'), Math.abs(Math.sin((dx / cw) * Math.PI * 2.5)) * 0.6);
      if (y < y0 + 0.06 * k || y > y1 - 0.08 * k) c = P.gilt;
      if (Math.abs(y - (y1 - 0.08 * k)) < 0.008 * k || Math.abs(y - (y0 + 0.06 * k)) < 0.008 * k) c = P.giltDark;
    }
  }
  // Harlequin panel under the sill.
  const py0 = 0.14 * k;
  const py1 = L.sill - 0.14 * k;
  if (py1 - py0 > 0.1 && Math.abs(x) < L.ox && y > py0 && y < py1) {
    const u = x / (0.095 * k);
    const v = (y - py0) / (0.125 * k);
    const cell = (Math.floor(u + v) + Math.floor(u - v)) & 1;
    c = cell ? P.diamondA : P.diamondB;
    if (Math.abs(x) > L.ox - 0.015 * k || y < py0 + 0.015 * k || y > py1 - 0.015 * k) c = P.gilt;
  }
  // A sunburst over the opening.
  const sy = L.top + 0.1 * k;
  const R = crestY(L, 0) - sy - 0.07 * k;
  const r = Math.hypot(x, y - sy);
  if (y > sy && r < R) {
    const a = Math.atan2(y - sy, x);
    c = Math.floor((a / Math.PI) * 14) & 1 ? P.ochre : mixc(P.oxblood, P.ochre, 0.25);
    if (r > R - 0.012 * k) c = P.gilt;
    if (r < 0.1 * k) c = r > 0.088 * k ? P.giltDark : mixc(P.gilt, srgb('#fff0c0'), 1 - r / (0.1 * k));
  }
  return c;
}

function facadePng(L, width) {
  const h = L.crestTop;
  const height = Math.round((width * h) / (2 * L.hw));
  return png(width, height, (u, v) => facadeColor(L, (u * 2 - 1) * L.hw, v * h));
}

/** The painted backdrop: dusk, a crescent moon, stars, hills, footlight glow at its foot. */
function backdropPng() {
  const random = rng(77);
  const stars = [];
  for (let i = 0; i < 46; i += 1) stars.push([random(), 0.5 + random() * 0.5, 0.004 + random() * 0.005]);
  return png(512, 352, (u, v) => {
    let c = mixc(srgb('#e7a06c'), srgb('#1f2b5a'), smooth(0.2, 0.95, v));
    for (const [sx, sy, sr] of stars) {
      const d = Math.hypot((u - sx) * 1.45, v - sy);
      if (d < sr) c = mixc(c, srgb('#fff4d6'), 1 - d / sr);
    }
    const moon = Math.hypot((u - 0.74) * 1.45, v - 0.73);
    const bite = Math.hypot((u - 0.765) * 1.45, v - 0.755);
    if (moon < 0.095 && bite > 0.085) c = srgb('#f6e7bd');
    const h1 = 0.33 + 0.06 * Math.sin(u * 7 + 1) + 0.025 * Math.sin(u * 19 + 2);
    const h2 = 0.19 + 0.05 * Math.sin(u * 4.6 + 3) + 0.02 * Math.sin(u * 13);
    if (v < h1) c = srgb('#36584a');
    if (v < h2) c = srgb('#203a31');
    // A little house on the far hill, one lit window.
    const hx = 0.27;
    const hy = 0.33 + 0.06 * Math.sin(hx * 7 + 1) + 0.025 * Math.sin(hx * 19 + 2);
    if (Math.abs(u - hx) < 0.03 && v > hy - 0.02 && v < hy + 0.04) c = srgb('#1a2622');
    if (v > hy + 0.04 && v < hy + 0.075 - Math.abs(u - hx) * 1.2) c = srgb('#1a2622');
    if (Math.abs(u - hx) < 0.008 && Math.abs(v - (hy + 0.015)) < 0.01) c = srgb('#ffd27a');
    const glow = Math.exp(-v / 0.2) * (1 - 0.6 * (2 * u - 1) ** 2);
    c = mixc(c, srgb('#ffb877'), 0.55 * glow);
    return c;
  });
}

/** Front wall shape with the opening as a hole, in the wall's own frame. */
function facadeShape(L) {
  const shape = new Shape();
  shape.moveTo(-L.hw, 0);
  shape.lineTo(L.hw, 0);
  shape.lineTo(L.hw, L.rectTop);
  for (let i = 1; i < 40; i += 1) {
    const x = L.hw - (i / 40) * 2 * L.hw;
    shape.lineTo(x, crestY(L, x));
  }
  shape.lineTo(-L.hw, L.rectTop);
  shape.lineTo(-L.hw, 0);
  const hole = new Path();
  hole.moveTo(-L.ox, L.sill);
  hole.lineTo(-L.ox, L.top);
  hole.lineTo(L.ox, L.top);
  hole.lineTo(L.ox, L.sill);
  hole.lineTo(-L.ox, L.sill);
  shape.holes.push(hole);
  return shape;
}

function facadeFace(L) {
  const g = new ShapeGeometry(facadeShape(L), 8);
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i += 1) uv.setXY(i, (pos.getX(i) + L.hw) / (2 * L.hw), pos.getY(i) / L.crestTop);
  return g;
}

function facadeBody(L, depth) {
  const g = new ExtrudeGeometry(facadeShape(L), { depth, bevelEnabled: false, curveSegments: 8 });
  return g;
}

/** Drawn curtains either side of an opening and a scalloped valance, in the wall's frame. */
function curtains(paint, L, z, scale) {
  const red = lin('#a3192a');
  const deep = lin('#4a0810');
  const fringe = lin('#d9a94a');
  const tieY = L.sill + (L.top - L.sill) * 0.36;
  const reach = 0.16 * scale;
  for (const sgn of [-1, 1]) {
    const inner = (y) => {
      const into = y > tieY ? 0.03 + 0.05 * smooth(tieY, L.top, y) : 0.03 + 0.035 * smooth(tieY, L.sill, y);
      return L.ox - into * scale;
    };
    paint.grid(
      22,
      18,
      (i, j) => {
        const y = L.sill + ((L.top + 0.03 * scale - L.sill) * i) / 22;
        const xi = inner(y);
        const x = xi + ((L.ox + reach - xi) * j) / 18;
        const phase = ((x - xi) / (0.032 * scale)) * TAU;
        const amp = (0.008 + 0.006 * Math.exp(-(((y - tieY) / (0.08 * scale)) ** 2))) * scale;
        const shade = 0.5 + 0.5 * Math.cos(phase);
        return { p: [sgn * x, y, z - amp * (1 - Math.cos(phase))], c: mixc(deep, red, 0.35 + 0.65 * shade) };
      },
      () => [0, 0, 1]
    );
  }
  // Valance.
  paint.grid(
    6,
    60,
    (i, j) => {
      const x = -L.ox - 0.03 * scale + ((2 * L.ox + 0.06 * scale) * j) / 60;
      const bottom = L.top - (0.032 + 0.022 * Math.abs(Math.sin((Math.PI * x) / (0.095 * scale)))) * scale;
      const y = bottom + ((L.top + 0.03 * scale - bottom) * i) / 6;
      const phase = (x / (0.095 * scale)) * TAU;
      const c = i === 0 ? fringe : mixc(deep, red, 0.55 + 0.45 * Math.cos(phase));
      return { p: [x, y, z + 0.004 * scale - 0.004 * scale * Math.cos(phase)], c };
    },
    () => [0, 0, 1]
  );
  return tieY;
}

// ---------------------------------------------------------------------------
// The figures. Joint nodes carry their segment; the rest pose stands facing
// +Z with arms hanging. Lengths are those of a 1.70 m adult, scaled per level.

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

/** The puppeteer: a faceless mannequin of light (door.mjs), right hand closed on its bar. */
function mannequinParts() {
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
    spine: [ell(0.122, 0.13, 0.09, [0, 0.07, 0.006])],
    chest: [
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
    wristR: [ell(0.037, 0.052, 0.046, [0, -0.056, 0.004]), ell(0.016, 0.03, 0.016, [0.01, -0.05, 0.038])],
    hipL: L.hip,
    kneeL: L.knee,
    ankleL: L.ankle,
    hipR: R.hip,
    kneeR: R.knee,
    ankleR: R.ankle
  };
}

/** The marionette: carved and painted wood, ball joints, a red coat, a tall red hat. */
function marionetteParts() {
  const wood = '#e2bf93';
  const coat = '#b5262b';
  const trousers = '#2b3d6e';
  const white = '#f1ebdf';
  const shoe = '#1e1a1c';
  const gilt = '#d9a94a';
  const c = (g, hex) => prep(g, hex);
  const side = () => ({
    shoulder: [c(ell(0.06, 0.06, 0.06, [0, -0.01, 0]), wood), c(limb([0, -0.03, 0], [0, -0.26, 0], 0.055, 0.045), coat), c(ell(0.05, 0.03, 0.05, [0, -0.26, 0]), gilt)],
    elbow: [c(ell(0.04, 0.04, 0.04), wood), c(limb([0, -0.03, 0], [0, -0.23, 0], 0.034, 0.028), wood)],
    hand: [c(ell(0.04, 0.075, 0.05, [0, -0.065, 0.012]), white)],
    hip: [c(ell(0.06, 0.06, 0.06), wood), c(limb([0, -0.03, 0], [0, -0.38, 0], 0.068, 0.05), trousers)],
    knee: [c(ell(0.048, 0.048, 0.048), wood), c(limb([0, -0.03, 0], [0, -0.38, 0], 0.046, 0.036), white)],
    ankle: [c(ell(0.05, 0.045, 0.12, [0, -0.03, 0.05]), shoe), c(ell(0.025, 0.025, 0.025, [0, -0.01, 0.165]), gilt)]
  });
  const L = side();
  const R = side();
  return {
    pelvis: [c(ell(0.14, 0.11, 0.1, [0, -0.03, 0]), trousers)],
    spine: [c(ell(0.125, 0.12, 0.09, [0, 0.07, 0]), coat), c(ell(0.135, 0.025, 0.1, [0, 0.0, 0]), gilt)],
    chest: [
      c(ell(0.16, 0.17, 0.105, [0, 0.09, 0.008]), coat),
      c(ell(0.14, 0.04, 0.115, [0, 0.235, 0]), white),
      ...[0.03, 0.09, 0.15].map((y) => c(ell(0.02, 0.02, 0.012, [0, y, 0.112]), gilt))
    ],
    neck: [c(limb([0, -0.01, 0], [0, 0.07, 0], 0.035, 0.035), wood)],
    head: [
      c(ell(0.1, 0.115, 0.1, [0, 0.075, 0.01]), wood),
      c(ell(0.026, 0.026, 0.03, [0, 0.06, 0.11]), '#c4483c'),
      c(ell(0.017, 0.017, 0.01, [0.04, 0.095, 0.098]), shoe),
      c(ell(0.017, 0.017, 0.01, [-0.04, 0.095, 0.098]), shoe),
      c(new ConeGeometry(0.102, 0.36, 18, 1).translate(0, 0.33, -0.01), coat),
      c(ell(0.11, 0.025, 0.11, [0, 0.155, -0.005]), gilt),
      c(ell(0.04, 0.04, 0.04, [0, 0.52, -0.01]), gilt)
    ],
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

class Rig {
  constructor({ s, at, yaw, parts }) {
    this.s = s;
    this.yaw = yaw;
    this.root = new Object3D();
    this.root.position.set(...at);
    this.root.quaternion.copy(eul(0, yaw, 0));
    this.j = {};
    for (const [name, parent, offset] of SKELETON) {
      const o = new Object3D();
      o.position.set(...offset.map((v) => v * s));
      (parent ? this.j[parent] : this.root).add(o);
      this.j[name] = o;
    }
    this.geo = {};
    for (const [name, list] of Object.entries(parts)) {
      const g = mergeGeometries(list.map((p) => prep(p, p.attributes.color ? undefined : '#ffffff')));
      g.scale(s, s, s);
      this.geo[name] = compact(g);
    }
    this.root.updateMatrixWorld(true);
  }

  toWorld(local) {
    this.root.updateMatrixWorld(true);
    return this.root.localToWorld(new Vector3(...local.map((v) => v * this.s)));
  }

  dirToWorld(local) {
    return new Vector3(...local).applyQuaternion(this.root.quaternion).normalize();
  }

  point(joint, offset = [0, 0, 0]) {
    return this.j[joint].localToWorld(new Vector3(...offset.map((v) => v * this.s)));
  }

  /** Visits every mesh vertex in world space. */
  eachVertex(fn) {
    const v = new Vector3();
    for (const [name, g] of Object.entries(this.geo)) {
      const obj = this.j[name];
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i += 3) {
        v.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
        fn(v, name);
      }
    }
  }
}

const _basis = new Matrix4();
/** Two-bone IK (door.mjs): upper / lower joints, end at the lower's child; sign +1 bends like an elbow. */
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

/** Where a holder's bar is, in its rig units, for a gesture. */
const gripLocal = (g) => [GRIP[0], GRIP[1] + g.barLift, GRIP[2] + g.barFwd];

/** Poses a rig from the shared gesture; the right hand holds its bar by IK. */
function applyGesture(rig, g) {
  const { j } = rig;
  const drop = 0.835 * (1 - Math.cos(g.crouch));
  j.pelvis.position.set(0, (0.96 + g.hop - drop - 0.02 * g.slump) * rig.s, -0.12 * g.bow * rig.s);
  j.pelvis.quaternion.copy(eul(0.45 * g.bow, g.turn, g.sway));
  j.spine.quaternion.copy(eul(0.3 * g.bow + 0.1 * g.slump, -0.25 * g.turn, -0.5 * g.sway));
  j.chest.quaternion.copy(eul(0.25 * g.bow + 0.15 * g.slump - 0.12 * Math.max(g.look, 0), 0, -0.3 * g.sway));
  j.neck.quaternion.copy(eul(0.12 * g.bow - 0.4 * g.look, 0, 0.4 * g.tilt));
  j.head.quaternion.copy(eul(0.12 * g.bow - 0.6 * g.look, 0, 0.6 * g.tilt));
  const pb = 0.45 * g.bow;
  j.hipL.quaternion.copy(eul(-pb - g.crouch - 0.6 * g.kick, 0, 0.03 - g.sway));
  j.hipR.quaternion.copy(eul(-pb - g.crouch, 0, -0.03 - g.sway));
  j.kneeL.quaternion.copy(eul(2 * g.crouch + 3 * g.kick, 0, 0));
  j.kneeR.quaternion.copy(eul(2 * g.crouch, 0, 0));
  const point = 3 * g.hop;
  j.ankleL.quaternion.copy(eul(-g.crouch - 2.1 * g.kick + point, 0, 0));
  j.ankleR.quaternion.copy(eul(-g.crouch + point, 0, 0));
  j.shoulderL.quaternion.copy(eul(g.lFwd - 0.8 * g.bow - 0.2 * g.slump, 0, g.lSide, 'XYZ'));
  j.elbowL.quaternion.copy(eul(-g.lElbow, 0, 0, 'XYZ'));
  j.wristL.quaternion.copy(eul(0.15, 0, 0, 'XYZ'));
  rig.root.updateMatrixWorld(true);

  const grip = gripLocal(g);
  const target = rig.toWorld([grip[0], grip[1] + 0.06, grip[2] - 0.01]);
  twoBone(j.shoulderR, j.elbowR, j.wristR.position.length(), target, rig.dirToWorld([-1, -0.45, -0.25]), 1);
  const elbowQ = j.elbowR.getWorldQuaternion(new Quaternion());
  j.wristR.quaternion.copy(elbowQ.invert().multiply(rig.root.quaternion.clone()));
  rig.root.updateMatrixWorld(true);
  return target;
}

function sampleRig(rig, delay, count, extra) {
  const frames = [];
  for (let i = 0; i <= count; i += 1) {
    const t = (i / count) * LOOP;
    const g = gesture(t - delay);
    const target = applyGesture(rig, g);
    const f = { g, q: {}, pelvis: rig.j.pelvis.position.toArray(), wristGap: rig.point('wristR').distanceTo(target) };
    for (const [name] of SKELETON) f.q[name] = rig.j[name].quaternion.toArray();
    extra(f, rig, g);
    frames.push(f);
  }
  return frames;
}

/** A continuous quaternion track from a list of [x, y, z, w]. */
function quatTrack(list) {
  const values = [];
  let prev = null;
  for (let q of list) {
    if (prev && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0) q = q.map((v) => -v);
    values.push(...q);
    prev = q;
  }
  return values;
}

function writeRig(glb, rig, frames, { name, material, times, parent }) {
  const root = glb.node({ name, translation: rig.root.position.toArray(), rotation: rig.root.quaternion.toArray(), parent });
  const nodes = {};
  for (const [joint, par, offset] of SKELETON) {
    nodes[joint] = glb.node({
      name: `${name}-${joint}`,
      mesh: rig.geo[joint] ? glb.mesh(`${name}-${joint}`, rig.geo[joint], material) : undefined,
      translation: joint === 'pelvis' ? frames[0].pelvis : offset.map((v) => v * rig.s),
      rotation: frames[0].q[joint],
      parent: par ? nodes[par] : root
    });
  }
  for (const [joint] of SKELETON) glb.animate(nodes[joint], 'rotation', times, quatTrack(frames.map((f) => f.q[joint])));
  glb.animate(nodes.pelvis, 'translation', times, frames.flatMap((f) => f.pelvis));
}

// ---------------------------------------------------------------------------
// Control bars, the giant hand, strings.

function barGeometry(half, stickBack, stickFront, thick) {
  const wood = '#8a5a34';
  const parts = [prep(box(-half, half, -thick / 2, thick / 2, -thick / 2, thick / 2), wood), prep(box(-thick / 2, thick / 2, -thick / 2 + thick * 0.6, thick / 2 + thick * 0.6, stickBack, stickFront), '#9c6a3e')];
  for (const x of [-half, half]) parts.push(prep(ell(thick * 0.8, thick * 0.8, thick * 0.8, [x, 0, 0], 8, 6), '#d9a94a'));
  return mergeGeometries(parts);
}

/** Torn displacement along a loop parameter (radians). */
function torn(theta, seed) {
  const x = Math.cos(theta);
  const z = Math.sin(theta);
  return (fbm3(x * 1.6 + 2, z * 1.6, seed, { octaves: 3, seed }) - 0.5) * 2 + 0.35 * (noise3(x * 9, z * 9, seed, seed + 4) - 0.5) * 2;
}

/** The giant hand gripping a bar along X at its origin, palm down, forearm rising back to a torn cut. */
function giantHand() {
  const parts = [];
  parts.push(ell(0.19, 0.07, 0.17, [0, 0.13, -0.17]).rotateX(0).translate(0, 0, 0));
  parts.push(limb([0, 0.15, -0.26], [0, 0.2, -0.34], 0.085, 0.085, 1.3, 0.8));
  const fingers = [
    [-0.135, 0.94],
    [-0.045, 1.0],
    [0.045, 0.96],
    [0.13, 0.82]
  ];
  for (const [x, f] of fingers) {
    const K = [x, 0.09, -0.075];
    const A = [x, 0.08 * f, 0.055 * f];
    const B = [x, -0.035 * f, 0.07 * f];
    const Cp = [x, -0.068 * f, -0.005];
    parts.push(ell(0.044, 0.04, 0.044, K));
    parts.push(limb(K, A, 0.039, 0.035));
    parts.push(limb(A, B, 0.034, 0.031));
    parts.push(limb(B, Cp, 0.03, 0.026));
  }
  parts.push(limb([-0.17, 0.11, -0.2], [-0.205, 0.03, -0.11], 0.05, 0.043));
  parts.push(limb([-0.205, 0.03, -0.11], [-0.16, -0.045, -0.03], 0.042, 0.033));
  // The forearm stub, open at its end, torn.
  const P0 = new Vector3(0, 0.19, -0.32);
  const P1 = new Vector3(0, 0.3, -0.49);
  const d = P1.clone().sub(P0).normalize();
  const e1 = new Vector3(1, 0, 0);
  const e2 = new Vector3().crossVectors(d, e1).normalize();
  const N = 40;
  const ring = [];
  const stub = new Paint();
  const white = [1, 1, 1];
  const at = (theta, a) => {
    const rx = 0.098;
    const rz = 0.078;
    const jag = a >= 1 ? 0.035 * torn(theta, 5) : 0;
    const axial = P0.clone().lerp(P1, Math.min(a, 1)).addScaledVector(d, jag);
    return axial.addScaledVector(e1, rx * Math.cos(theta)).addScaledVector(e2, rz * Math.sin(theta));
  };
  for (let j = 0; j < N; j += 1) ring.push(at((j / N) * TAU, 1));
  stub.grid(
    5,
    N,
    (i, j) => ({ p: at((j / N) * TAU, i / 5).toArray(), c: white }),
    (m) => {
      const v = new Vector3(...m);
      const axial = P0.clone().addScaledVector(d, v.clone().sub(P0).dot(d));
      return v.sub(axial).toArray();
    }
  );
  parts.push(stub.geometry());
  const hand = mergeGeometries(parts.map((p) => prep(p, p.attributes.color ? undefined : '#ffffff')));

  // The cut face: char at the middle, burnt gold at the edge.
  const cut = new Paint();
  const centre = P1.clone().addScaledVector(d, -0.01);
  const char = lin('#2a1810');
  for (let j = 0; j < N; j += 1) {
    const a = ring[j];
    const b = ring[(j + 1) % N];
    const ia = centre.clone().lerp(a, 0.82);
    const ib = centre.clone().lerp(b, 0.82);
    cut.tri(centre.toArray(), ia.toArray(), ib.toArray(), char, mixc(char, lin(GLOW), 0.4), mixc(char, lin(GLOW), 0.4), d.toArray());
    cut.quad(ia.toArray(), a.toArray(), b.toArray(), ib.toArray(), mixc(char, lin(GLOW), 0.4), lin(GOLD), lin(GOLD), mixc(char, lin(GLOW), 0.4), d.toArray());
  }
  const rim = prep(new TubeGeometry(new CatmullRomCurve3(ring, true), 120, 0.007, 5, true), GOLD);
  return { hand, cut: mergeGeometries([cut.geometry(), rim]) };
}

// ---------------------------------------------------------------------------
// The set: slab, theatre, stage, bridge, toy theatre.

function slabGeometry() {
  const RX = 1.0;
  const RZ = 0.82;
  const CZ = -0.04;
  const outline = (theta) => {
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const n = 3.2;
    const r0 = 1 / ((Math.abs(c) / RX) ** n + (Math.abs(s) / RZ) ** n) ** (1 / n);
    let r = r0 * (1 + 0.06 * torn(theta, 2) * 0.6);
    r -= 0.05 * Math.max(0, noise3(c * 6 + 1, s * 6, 3, 21) - 0.6) / 0.4;
    return [r * c, CZ + r * s];
  };
  const paint = new Paint();
  const N = 160;
  const R = 16;
  const plank = 0.115;
  const boardColor = (x, z) => {
    const row = Math.floor((z + 5) / plank);
    const seamZ = (z + 5) / plank - row;
    const joint = (x + 5 + (row % 3) * 0.37) / 1.1;
    const seamX = joint - Math.floor(joint);
    const tone = noise3(row * 1.7, Math.floor(joint) * 2.3, 1, 9);
    let c = mixc(lin('#6b4528'), lin('#9a6a3e'), 0.3 + 0.5 * tone);
    c = mixc(c, lin('#4a2e1a'), 0.4 * fbm3(x * 2, z * 40, 1, { octaves: 3, seed: 4 }));
    if (seamZ < 0.05 || seamX < 0.012) c = lin('#2a180e');
    return c;
  };
  paint.grid(
    R,
    N,
    (i, j) => {
      const theta = (j / N) * TAU;
      const [ox, oz] = outline(theta);
      const f = Math.max(0.002, i / R);
      const x = ox * f;
      const z = CZ + (oz - CZ) * f;
      let c = boardColor(x, z);
      // Footlight spill on the boards in front of the opening.
      const spill = Math.exp(-((x / 0.42) ** 2) - (((z - 0.5) / 0.2) ** 2)) * smooth(0.36, 0.42, z);
      c = mixc(c, lin('#e8a45c'), 0.45 * spill);
      c = mixc(c, lin('#24140b'), smooth(0.9, 0.97, f));
      c = mixc(c, lin(GOLD), smooth(0.985, 1, f));
      return { p: [x, FLOOR, z], c };
    },
    () => [0, 1, 0]
  );
  paint.grid(
    3,
    N,
    (i, j) => {
      const theta = (j / N) * TAU;
      const [ox, oz] = outline(theta);
      const inset = 1 - 0.03 * (i / 3);
      return { p: [ox * inset, FLOOR - (FLOOR * i) / 3, CZ + (oz - CZ) * inset], c: mixc(lin('#3a2416'), lin('#160c07'), i / 3) };
    },
    (m) => [m[0], 0, m[2] - CZ]
  );
  paint.grid(
    1,
    N,
    (i, j) => {
      const theta = (j / N) * TAU;
      const [ox, oz] = outline(theta);
      const f = i === 0 ? 0.97 : 0.001;
      return { p: [ox * f, 0, CZ + (oz - CZ) * f], c: lin('#160c07') };
    },
    () => [0, -1, 0]
  );
  const ring = [];
  for (let j = 0; j < 260; j += 1) {
    const [x, z] = outline((j / 260) * TAU);
    ring.push(new Vector3(x * 1.002, FLOOR + 0.002, CZ + (z - CZ) * 1.002));
  }
  const rim = new TubeGeometry(new CatmullRomCurve3(ring, true), 520, 0.006, 5, true);
  return { slab: paint.geometry(), rim };
}

function stageFloor() {
  const paint = new Paint();
  const z0 = STAGE_BACK;
  const z1 = WALL_Z0;
  paint.grid(
    12,
    24,
    (i, j) => {
      const x = -STAGE_HALF + (2 * STAGE_HALF * j) / 24;
      const z = z0 + ((z1 - z0) * i) / 12;
      const row = Math.floor((x + 5) / 0.08);
      const seam = (x + 5) / 0.08 - row < 0.07;
      const base = seam ? lin('#1d120a') : mixc(lin('#4a2f1b'), lin('#6a4527'), noise3(row * 1.3, 0, 2, 5));
      const glow = Math.exp(-(((z - z1) / 0.32) ** 2)) * Math.exp(-((x / 0.45) ** 2));
      return { p: [x, STAGE, z], c: mixc(base.map((v) => v * (0.5 + 1.2 * glow)), lin('#ffb36b'), 0.25 * glow) };
    },
    () => [0, 1, 0]
  );
  return paint.geometry();
}

function tinyStageFloor() {
  const paint = new Paint();
  const x0 = L3_AT[0];
  const zf = TINY_FRONT - TINY.thick;
  const zb = TINY_FRONT - TINY.depth;
  paint.grid(
    4,
    8,
    (i, j) => {
      const x = x0 - TINY.ox - 0.01 + ((2 * TINY.ox + 0.02) * j) / 8;
      const z = zb + ((zf - zb) * i) / 4;
      const glow = Math.exp(-(((z - zf) / 0.04) ** 2));
      return { p: [x, STAGE + TINY.sill, z], c: mixc(lin('#4a2f1b'), lin('#ffb36b'), 0.5 * glow) };
    },
    () => [0, 1, 0]
  );
  return paint.geometry();
}

// ---------------------------------------------------------------------------
// Sound: a music-box waltz for the dance, wooden clacks on footfalls and the
// bow, one held note for the looking up, then clacks as the heads drop.

const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const hz = (name) => {
  const m = /^([A-G])(#?)(\d)$/.exec(name);
  const semis = NOTE[m[1]] + (m[2] ? 1 : 0) + (Number(m[3]) + 1) * 12;
  return 440 * 2 ** ((semis - 69) / 12);
};

function sound() {
  const out = track(LOOP);
  const random = rng(31);
  const tine = (f) => {
    const det = 1 + (random() - 0.5) * 0.008;
    return (t) => {
      const a = TAU * f * det * t;
      return Math.sin(a) + 0.5 * Math.sin(a * 1.004) + 0.16 * Math.sin(a * 2) * Math.exp(-t * 5) + 0.05 * Math.sin(a * 3) * Math.exp(-t * 11);
    };
  };
  const note = (at, name, gain, decay = 0.8) => add(out, at, decay * 4, tine(hz(name)), (t) => gain * pluck(0.003, decay)(t));
  const B = 1 / 3;
  const melody = [
    [0, 'E5'], [1, 'G5'], [2, 'G5'],
    [3, 'F5'], [4, 'D5'], [5, 'B4'],
    [6, 'C5'], [7, 'E5'], [8, 'G5'],
    [9, 'A5'], [10, 'G5'], [11, 'F5'],
    [12, 'E5'], [13, 'D5'], [14, 'F5'],
    [15, 'E5'], [16, 'C5']
  ];
  for (const [b, n] of melody) note(b * B, n, 0.16);
  const bars = [
    ['C4', 'E4', 'G4'],
    ['G3', 'B3', 'F4'],
    ['C4', 'E4', 'G4'],
    ['F3', 'A3', 'C4'],
    ['G3', 'B3', 'D4'],
    ['C4', 'E4', 'G4']
  ];
  bars.forEach(([bass, a, b], i) => {
    note(i, bass, 0.12, 1.0);
    for (const k of [1, 2]) {
      note(i + k * B, a, 0.05, 0.5);
      note(i + k * B, b, 0.05, 0.5);
    }
  });
  // The bow: slower, down and up again.
  for (const [at, n, g] of [[6.3, 'G4', 0.13], [6.8, 'F4', 0.12], [7.3, 'E4', 0.14], [7.3, 'C4', 0.1], [8.3, 'G4', 0.11], [8.8, 'C5', 0.12]]) note(at, n, g, 0.9);
  // The look up: one note, held, very soft.
  note(9.4, 'E5', 0.12, 1.2);
  add(out, 9.4, 3.9, (t) => Math.sin(TAU * hz('E5') * t + 0.0012 * Math.sin(TAU * 4.5 * t) * 600) + 0.08 * Math.sin(TAU * 2 * hz('E5') * t), (t) => 0.045 * smooth(0, 0.8, t) * (1 - smooth(3.0, 3.9, t)));
  // Pick-up back into the waltz.
  note(15.33, 'G4', 0.11);
  note(15.67, 'B4', 0.12);

  // Wooden clacks: the marionette's, then the tiny one's, a level later each.
  const clicks = noise(9);
  const clackWave = (pitch) => {
    const buf = new Float32Array(Math.round(0.08 * SAMPLE_RATE));
    for (let i = 0; i < buf.length; i += 1) buf[i] = clicks();
    lowpass(buf, 2200);
    return (t) => {
      const i = Math.min(buf.length - 1, Math.floor(t * SAMPLE_RATE));
      return 1.6 * buf[i] + Math.sin(TAU * pitch * t) * 0.8 + 0.5 * Math.sin(TAU * pitch * 0.27 * t);
    };
  };
  const clack = (at, level, gain) => {
    const pitch = level === 2 ? 820 : 1350;
    const g = level === 2 ? gain : gain * 0.6;
    add(out, at + DELAY * level, 0.08, clackWave(pitch), (t) => g * pluck(0.001, 0.016)(t));
  };
  for (const level of [2, 3]) {
    for (const at of [0.0, 1.0, 2.0, 3.0]) clack(at + 0.02, level, 0.05);
    clack(5.25, level, 0.16);
    clack(5.4, level, 0.07);
    clack(7.3, level, 0.12);
    clack(8.75, level, 0.07);
    for (const at of [13.1, 13.22, 13.4]) clack(at, level, 0.09);
    clack(14.05, level, 0.14);
    clack(14.15, level, 0.08);
  }
  // The puppeteer's own landing, a soft thud on the bridge.
  add(out, 5.25 + DELAY, 0.3, sine(70), (t) => 0.12 * pluck(0.004, 0.06)(t));
  return toWav(normalize(out, 0.6));
}

// ---------------------------------------------------------------------------

export async function build() {
  const glb = new Glb();
  glb.provenance({
    holoim: {
      authored: 'synthetic',
      author: meta.submittedBy,
      title: meta.name,
      levels: ['a hand above', 'the puppeteer, 1.70 m', 'the marionette, about 55 cm', 'the tiny marionette, about 17 cm'],
      delaySeconds: DELAY
    }
  });
  const scene = glb.node({ name: 'WhoHoldsTheStrings' });
  const count = LOOP * FPS;
  const times = [];
  for (let i = 0; i <= count; i += 1) times.push((i / count) * LOOP);

  // ---- materials
  const M = {
    wood: glb.material({ name: 'Wood', roughness: 0.82 }),
    painted: glb.material({ name: 'Painted', unlit: true }),
    light: glb.material({ name: 'FigureOfLight', color: T.identity[3], emissive: T.identity[5], emissiveStrength: 0.6, roughness: 0.4 }),
    puppet: glb.material({ name: 'PaintedWood', roughness: 0.55, emissive: '#2a1206' }),
    string: glb.material({ name: 'String', color: '#f4ecd8', unlit: true }),
    bulb: glb.material({ name: 'Footlight', color: GLOW, emissive: HIGHLIGHT, emissiveStrength: 1.6 })
  };
  const facadeTex = glb.texture(facadePng(BIG, 512));
  const tinyTex = glb.texture(facadePng(TINY, 160));
  const backTex = glb.texture(backdropPng());
  const facadeMat = glb.material({ name: 'TheatreFace', texture: facadeTex, roughness: 0.7, emissive: '#1a0806' });
  const tinyMat = glb.material({ name: 'ToyTheatreFace', texture: tinyTex, roughness: 0.7, emissive: '#1a0806' });
  const backMat = glb.material({ name: 'Backdrop', texture: backTex, unlit: true });

  const lit = [];
  const unlit = [];

  // ---- the slab
  const { slab, rim } = slabGeometry();
  lit.push(slab);
  unlit.push(prep(rim, GOLD));

  // ---- the theatre's front wall: painted face, wooden body, battens and braces behind.
  const face = facadeFace(BIG);
  face.translate(0, FLOOR, WALL_Z1 + 0.001);
  glb.node({ name: 'TheatreFace', mesh: glb.mesh('TheatreFace', face, facadeMat), parent: scene });
  const body = facadeBody(BIG, WALL_Z1 - WALL_Z0);
  body.translate(0, FLOOR, WALL_Z0);
  lit.push(prep(body, '#3d2414'));
  const batten = '#7a5634';
  for (const x of [-0.76, -0.45, 0.45, 0.76]) lit.push(prep(box(x - 0.03, x + 0.03, FLOOR, FLOOR + BIG.rectTop - 0.03, WALL_Z0 - 0.03, WALL_Z0), batten));
  for (const y of [0.45, 1.85]) lit.push(prep(box(-0.76, 0.76, FLOOR + y, FLOOR + y + 0.06, WALL_Z0 - 0.028, WALL_Z0), batten));
  for (const x of [-0.6, 0.6]) {
    lit.push(prep(beam([x, FLOOR + 1.55, WALL_Z0 - 0.03], [x, FLOOR + 0.02, WALL_Z0 - 0.62], 0.05, 0.03), batten));
    lit.push(prep(box(x - 0.06, x + 0.06, FLOOR, FLOOR + 0.04, WALL_Z0 - 0.7, WALL_Z0 - 0.55), '#5a3d26'));
  }
  // Curtains and valance hang just behind the wall's face.
  const drapes = new Paint();
  const tieY = curtains(drapes, BIG, WALL_Z0 - 0.012, 1);
  const drapeGeo = drapes.geometry();
  drapeGeo.translate(0, FLOOR, 0);
  lit.push(drapeGeo);
  for (const sgn of [-1, 1]) lit.push(prep(ell(0.03, 0.018, 0.018, [sgn * (BIG.ox - 0.03), FLOOR + tieY, WALL_Z0 - 0.004]), '#d9a94a'));

  // ---- the stage: a black cabinet, a glowing floor, footlights, the backdrop.
  lit.push(prep(box(-STAGE_HALF, STAGE_HALF, FLOOR, STAGE - 0.002, STAGE_BACK, WALL_Z0), '#1f1814'));
  unlit.push(stageFloor());
  lit.push(prep(box(-0.34, 0.34, STAGE, STAGE + 0.016, WALL_Z0 - 0.045, WALL_Z0 - 0.012), '#c9973f'));
  const bulbs = [];
  for (let i = 0; i < 7; i += 1) bulbs.push(prep(ell(0.009, 0.008, 0.009, [-0.3 + i * 0.1, STAGE + 0.022, WALL_Z0 - 0.03], 10, 8), '#ffffff'));
  glb.node({ name: 'Footlights', mesh: glb.mesh('Footlights', mergeGeometries(bulbs), M.bulb), parent: scene });
  {
    // Only the front face carries the paint.
    const g = new ShapeGeometry(new Shape([new Vector2(-BACKDROP_HALF, STAGE), new Vector2(BACKDROP_HALF, STAGE), new Vector2(BACKDROP_HALF, BACKDROP_TOP), new Vector2(-BACKDROP_HALF, BACKDROP_TOP)]));
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i += 1) uv.setXY(i, (pos.getX(i) + BACKDROP_HALF) / (2 * BACKDROP_HALF), (pos.getY(i) - STAGE) / (BACKDROP_TOP - STAGE));
    g.translate(0, 0, BACKDROP_Z + 0.006);
    glb.node({ name: 'Backdrop', mesh: glb.mesh('Backdrop', g, backMat), parent: scene });
  }
  lit.push(prep(box(-BACKDROP_HALF, BACKDROP_HALF, STAGE, BACKDROP_TOP, BACKDROP_Z - 0.004, BACKDROP_Z + 0.005), '#cfc2a4'));
  for (const x of [-BACKDROP_HALF + 0.02, 0, BACKDROP_HALF - 0.02]) lit.push(prep(box(x - 0.02, x + 0.02, FLOOR, BACKDROP_TOP, BACKDROP_Z - 0.03, BACKDROP_Z - 0.004), batten));
  lit.push(prep(box(-BACKDROP_HALF, BACKDROP_HALF, BACKDROP_TOP - 0.04, BACKDROP_TOP, BACKDROP_Z - 0.03, BACKDROP_Z - 0.004), batten));

  // ---- the bridge the puppeteer stands on.
  const bx = L1_AT[0];
  lit.push(prep(box(bx - 0.42, bx + 0.42, FLOOR, FLOOR + BRIDGE_H, -0.8, -0.2), '#5e4029'));
  for (let i = 0; i < 6; i += 1) lit.push(prep(box(bx - 0.42, bx + 0.42, FLOOR + BRIDGE_H, FLOOR + BRIDGE_H + 0.004, -0.8 + i * 0.1 + 0.003, -0.8 + i * 0.1 + 0.097), i % 2 ? '#7a5634' : '#6c4a2d'));
  lit.push(prep(box(bx - 0.25, bx + 0.25, FLOOR, FLOOR + BRIDGE_H / 2, -0.95, -0.8), '#5e4029'));

  // ---- the toy theatre on the stage, a smaller copy of the big one.
  {
    const tx = L3_AT[0];
    const tface = facadeFace(TINY);
    tface.translate(tx, STAGE, TINY_FRONT + 0.0006);
    glb.node({ name: 'ToyTheatreFace', mesh: glb.mesh('ToyTheatreFace', tface, tinyMat), parent: scene });
    const tbody = facadeBody(TINY, TINY.thick);
    tbody.translate(tx, STAGE, TINY_FRONT - TINY.thick);
    lit.push(prep(tbody, '#3d2414'));
    const td = new Paint();
    curtains(td, TINY, -0.003, TINY.k);
    const tdg = td.geometry();
    tdg.translate(tx, STAGE, TINY_FRONT - TINY.thick);
    lit.push(tdg);
    lit.push(prep(box(tx - TINY.ox - 0.01, tx + TINY.ox + 0.01, STAGE, STAGE + TINY.sill - 0.001, TINY_FRONT - TINY.depth, TINY_FRONT - TINY.thick), '#1f1814'));
    unlit.push(tinyStageFloor());
    const g = new ShapeGeometry(new Shape([new Vector2(-1, 0), new Vector2(1, 0), new Vector2(1, 1), new Vector2(-1, 1)]));
    g.scale(TINY.ox + 0.01, TINY.top - TINY.sill + 0.02, 1);
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i += 1) uv.setXY(i, (pos.getX(i) / (TINY.ox + 0.01) + 1) / 2, pos.getY(i) / (TINY.top - TINY.sill + 0.02));
    g.translate(tx, STAGE + TINY.sill, TINY_FRONT - TINY.depth + 0.002);
    glb.node({ name: 'ToyBackdrop', mesh: glb.mesh('ToyBackdrop', g, backMat), parent: scene });
    lit.push(prep(box(tx - TINY.ox - 0.01, tx + TINY.ox + 0.01, STAGE + TINY.sill, STAGE + TINY.top + 0.02, TINY_FRONT - TINY.depth - 0.003, TINY_FRONT - TINY.depth + 0.001), '#cfc2a4'));
    lit.push(prep(box(tx - 0.07, tx + 0.07, STAGE + TINY.sill, STAGE + TINY.sill + 0.004, TINY_FRONT - TINY.thick - 0.012, TINY_FRONT - TINY.thick - 0.002), '#e8b860'));
  }

  // ---- the figures
  const L1 = new Rig({ s: S1, at: L1_AT, yaw: 0, parts: mannequinParts() });
  const L2 = new Rig({ s: S2, at: L2_AT, yaw: L2_YAW, parts: marionetteParts() });
  const L3 = new Rig({ s: S3, at: L3_AT, yaw: 0, parts: marionetteParts() });
  const rigs = [null, L1, L2, L3];
  const barSize = [null, S2, S3, S4];

  // Bars: level 0 is the giant hand's; level k (1..3) is in rig k's right hand.
  const barState = (k, g, rig) => {
    let pos;
    if (k === 0) pos = new Vector3(HAND_AT[0], HAND_AT[1] + 0.6 * g.barLift, HAND_AT[2] + 0.6 * g.barFwd);
    else pos = rig.toWorld(gripLocal(g));
    const yaw = k === 0 ? 0 : k === 1 ? L2_YAW : 0;
    const q = eul(0, yaw, 0).multiply(barTilt(g));
    return { pos, q };
  };
  const barPoint = (state, local) => new Vector3(...local).applyQuaternion(state.q).add(state.pos);

  // Attachments: [bar local point (in bar units), joint, joint offset (rig units)].
  const puppetStrings = (u) => [
    [[0.4 * u, 0, 0], 'wristL', [0, -0.07, 0.012]],
    [[-0.4 * u, 0, 0], 'wristR', [0, -0.07, 0.012]],
    [[0.16 * u, 0, 0.1 * u], 'head', [0.1, 0.08, 0]],
    [[-0.16 * u, 0, 0.1 * u], 'head', [-0.1, 0.08, 0]],
    [[0, 0, -0.33 * u], 'chest', [0, 0.17, -0.1]],
    [[0.1 * u, 0, 0.33 * u], 'kneeL', [0, -0.02, 0.05]],
    [[-0.1 * u, 0, 0.33 * u], 'kneeR', [0, -0.02, 0.05]]
  ];
  const handStrings = [
    [[0.55, -0.02, 0], 'wristL', [0, -0.07, 0]],
    [[-0.55, -0.02, 0], 'wristR', [0, -0.07, 0]],
    [[0.32, -0.02, 0], 'elbowL', [0, 0, 0]],
    [[-0.32, -0.02, 0], 'elbowR', [0, 0, 0]],
    [[0, -0.02, -0.2], 'head', [0, 0.175, 0.01]]
  ];
  const stringSets = [
    { upper: 0, lower: 1, list: handStrings, width: 0.006 },
    { upper: 1, lower: 2, list: puppetStrings(S2), width: 0.004 },
    { upper: 2, lower: 3, list: puppetStrings(S3), width: 0.0022 }
  ];

  const bars = [0, 1, 2, 3].map(() => []);
  const ends = stringSets.map((set) => set.list.map(() => []));
  const diag = { wristGap: [0, 0, 0, 0], floorMin: [Infinity, Infinity, Infinity, Infinity], backdropIntrusion: 0, stringLen: [Infinity, -Infinity] };
  // Level 0 has no rig: sample its bar on its own.
  for (let i = 0; i <= count; i += 1) bars[0].push(barState(0, gesture((i / count) * LOOP), null));

  const frames = [null];
  for (const k of [1, 2, 3]) {
    const rig = rigs[k];
    frames[k] = sampleRig(rig, DELAY * k, count, (f, r, g) => {
      bars[k].push(barState(k, g, r));
      const i = bars[k].length - 1;
      stringSets.forEach((set, si) => {
        if (set.lower !== k) return;
        set.list.forEach(([local, joint, offset], li) => {
          const a = barPoint(bars[set.upper][i], local);
          const b = r.point(joint, offset);
          ends[si][li].push([a, b]);
        });
      });
      if (i % 5 === 0) {
        r.eachVertex((v, part) => {
          diag.floorMin[k] = Math.min(diag.floorMin[k], v.y - r.root.position.y);
          if (k === 1 && v.z > BACKDROP_Z - 0.035 && v.y < BACKDROP_TOP + 0.01 && Math.abs(v.x) < BACKDROP_HALF + 0.03) {
            const d = v.z - (BACKDROP_Z - 0.035);
            if (d > diag.backdropIntrusion) diag.backdropIntrusion = +d.toFixed(3);
            if (d > 0.005) (diag.intrusions ??= new Set()).add(`${part}@${((i / count) * LOOP).toFixed(1)}`);
          }
        });
      }
      diag.wristGap[k] = Math.max(diag.wristGap[k], f.wristGap);
    });
  }

  const marionetteWood = M.puppet;
  writeRig(glb, L1, frames[1], { name: 'fig-puppeteer', material: M.light, times, parent: scene });
  writeRig(glb, L2, frames[2], { name: 'fig-marionette', material: marionetteWood, times, parent: scene });
  writeRig(glb, L3, frames[3], { name: 'fig-tiny', material: marionetteWood, times, parent: scene });

  // Bars.
  const { hand, cut } = giantHand();
  for (const k of [0, 1, 2, 3]) {
    const geo =
      k === 0
        ? barGeometry(0.55, -0.26, 0.06, 0.045)
        : barGeometry(0.4 * barSize[k], -0.33 * barSize[k], 0.36 * barSize[k], Math.max(0.004, 0.04 * barSize[k]));
    const list = bars[k];
    const node = glb.node({ name: `bar-${k}`, mesh: glb.mesh(`bar-${k}`, geo, M.wood), translation: list[0].pos.toArray(), rotation: list[0].q.toArray(), parent: scene });
    glb.animate(node, 'translation', times, list.flatMap((b) => b.pos.toArray()));
    glb.animate(node, 'rotation', times, quatTrack(list.map((b) => b.q.toArray())));
    if (k === 0) {
      glb.node({ name: 'hand-above', mesh: glb.mesh('hand-above', compact(hand), M.light), parent: node });
      glb.node({ name: 'hand-above-cut', mesh: glb.mesh('hand-above-cut', cut, M.painted), parent: node });
    }
  }

  // Strings: a unit box re-posed every key between its two moving ends.
  const up = new Vector3(0, 1, 0);
  stringSets.forEach((set, si) => {
    const unit = new BoxGeometry(set.width, 1, set.width);
    unit.deleteAttribute('uv');
    const mesh = glb.mesh(`string-${si}`, unit, M.string);
    set.list.forEach((_, li) => {
      const tr = [];
      const rot = [];
      const sc = [];
      for (const [a, b] of ends[si][li]) {
        const d = a.clone().sub(b);
        const len = d.length();
        diag.stringLen = [Math.min(diag.stringLen[0], len), Math.max(diag.stringLen[1], len)];
        tr.push(...a.clone().add(b).multiplyScalar(0.5).toArray());
        rot.push(new Quaternion().setFromUnitVectors(up, d.normalize()).toArray());
        sc.push(1, len, 1);
      }
      const node = glb.node({ name: `string-${si}-${li}`, mesh, translation: tr.slice(0, 3), rotation: rot[0], scale: sc.slice(0, 3), parent: scene });
      glb.animate(node, 'translation', times, tr);
      glb.animate(node, 'rotation', times, quatTrack(rot));
      glb.animate(node, 'scale', times, sc);
    });
  });

  glb.node({ name: 'Set', mesh: glb.mesh('Set', compact(mergeGeometries(lit)), M.wood), parent: scene });
  glb.node({ name: 'SetPainted', mesh: glb.mesh('SetPainted', compact(mergeGeometries(unlit.map((g) => prep(g)).map((g) => (g.deleteAttribute('normal'), g)))), M.painted), parent: scene });

  diag.intrusions = [...(diag.intrusions ?? [])].slice(0, 30);
  diag.L1 = L1_AT.map((v) => +v.toFixed(3));
  diag.L3 = L3_AT.map((v) => +v.toFixed(3));
  diag.wristGap = diag.wristGap.map((v) => +v.toFixed(3));
  diag.floorMin = diag.floorMin.map((v) => +v.toFixed(3));
  process.stderr.write(`strings diagnostics ${JSON.stringify(diag)}\n`);

  glb.audio(sound());
  return glb;
}

const MID = [0, 1.65, -0.05];
const at = (dir, d) => MID.map((m, i) => +(m + dir[i] * d).toFixed(3));
const yawPitch = (yaw, pitch) => {
  const y = (yaw * Math.PI) / 180;
  const p = (pitch * Math.PI) / 180;
  return [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)];
};

export const tiles = [
  { label: 'feed', cam: at([0.297, 0.276, 0.914], 5.0), look: MID, t: 1.5 },
  { label: 'close, stage', cam: at(yawPitch(10, -4), 1.6), look: MID, t: 2.8 },
  { label: 'right side, the bow', cam: at(yawPitch(90, 12), 5.0), look: MID, t: 7.6 },
  { label: 'back', cam: at(yawPitch(180, 12), 5.0), look: MID, t: 1.5 },
  { label: 'back-side, high', cam: at(yawPitch(135, 50), 5.0), look: MID, t: 2.6 },
  { label: 'looking up', cam: at(yawPitch(118, 20), 4.2), look: MID, t: 11.5 },
  { label: 'top', view: 'top', t: 5.0 },
  { label: 'feed, looking up', cam: at([0.297, 0.276, 0.914], 5.0), look: MID, t: 11 },
  { label: 'close, looking up', cam: at(yawPitch(10, -4), 1.6), look: MID, t: 11.2 }
];
