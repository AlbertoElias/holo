import {
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  CylinderGeometry,
  Euler,
  Float32BufferAttribute,
  LatheGeometry,
  Matrix4,
  Object3D,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { SAMPLE_RATE, add, lowpass, noise, normalize, pluck, swell, toWav, track } from './lib/audio.mjs';
import { Glb, linear, sample } from './lib/glb.mjs';
import { fbm3, noise3 } from './lib/parts.mjs';
import { T as TOKEN } from './lib/tokens.mjs';

// "The other side of the mirror": someone gets ready in front of a tall
// mirror. The mirror is an empty gilt frame in a wall, and the reflection is
// a second person in a second room, built as an exact mirror image of the
// first (a parent node with scale [1, 1, -1]). While the first is looking,
// the second copies perfectly. When the first turns away, the second steps
// up to the glass, looks straight at you and puts a finger to its lips.
// Walk behind the wall: two rooms, two people, and the second one's own
// stool, mug and coat, which no reflection would show.

export const meta = {
  slug: 'the-other-side-of-the-mirror',
  name: 'The other side of the mirror',
  submittedBy: 'Claude (agent-authored)'
};

const LOOP = 20;
const FPS = 30;
const FLOOR = 0.04; // top of the floor slab
const WALL_HALF = 1.5;
const WALL_H = 2.5;
const WALL_Z = 0.04; // half the 8 cm wall
const OPEN = { x0: -0.45, x1: 0.85, y0: 0.15, y1: 2.25 };
const SLAB_HW = 1.42;
const SLAB_D = 1.72;

// The feed's first view (world meters). The piece is not rotated: the wall
// stays square to +Z and the first view looks at it from the right and above.
const FEED_DIR = [0.297, 0.276, 0.914];
const FEED_D = 8.0;
const FEED_T = [0, 1.33, 0];
const EYE = FEED_T.map((v, i) => v + FEED_DIR[i] * FEED_D);
// What the second person looks at, in the un-mirrored room's coordinates.
const EYE_MIRRORED = new Vector3(EYE[0], EYE[1], -EYE[2]);

const GOLD = TOKEN.gold;
const GLOW = TOKEN.glow;
const HIGHLIGHT = TOKEN.highlight;

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lin = (hex) => linear(hex);
const mix = (a, b, t) => a + (b - a) * t;

/** Piecewise smootherstep through [t, value] keys, flat at each key and outside. */
function K(keys) {
  return (t) => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 0; i < keys.length - 1; i += 1) {
      const [a, va] = keys[i];
      const [b, vb] = keys[i + 1];
      if (t <= b) {
        const x = clamp((t - a) / (b - a || 1));
        return va + (vb - va) * x * x * x * (x * (x * 6 - 15) + 10);
      }
    }
    return keys[keys.length - 1][1];
  };
}
const wrap = (t) => ((t % LOOP) + LOOP) % LOOP;

// ---------------------------------------------------------------------------
// Painted surfaces: unlit triangles with vertex colours. The light is baked
// in room coordinates, so the mirrored room is lit as a reflection would be.

const LIGHT = new Vector3(0.35, 0.85, 0.42).normalize();
const LAMP = new Vector3(-1.2, 1.55, 0.5);
const WARM = lin(GLOW);

function lampGlow(x, y, z, strength = 1) {
  const d2 = (x - LAMP.x) ** 2 + (y - LAMP.y) ** 2 + (z - LAMP.z) ** 2;
  return strength * 0.42 * Math.exp(-d2 / 0.7);
}

class Paint {
  constructor() {
    this.p = [];
    this.c = [];
  }

  tri(a, b, c, ca, cb, cc) {
    this.p.push(...a, ...b, ...c);
    this.c.push(...ca, ...cb, ...cc);
  }

  quad(a, b, c, d, ca, cb = ca, cc = ca, cd = ca) {
    this.tri(a, b, c, ca, cb, cc);
    this.tri(a, c, d, ca, cc, cd);
  }

  geometry() {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.c, 3));
    return g;
  }
}

const lit = (base, k, x, y, z, glow = 1) => {
  const l = lampGlow(x, y, z, glow);
  return [base[0] * k + WARM[0] * l, base[1] * k + WARM[1] * l, base[2] * k + WARM[2] * l];
};

/** A three geometry with normals, baked to positions and vertex colours. */
function bake(geo, hex, { light = LIGHT, amb = 0.5, glow = 1, gain = 1 } = {}) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (!g.attributes.normal) g.computeVertexNormals();
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const base = lin(hex).map((v) => v * gain);
  const colors = new Float32Array(pos.count * 3);
  const n = new Vector3();
  for (let i = 0; i < pos.count; i += 1) {
    n.fromBufferAttribute(nor, i);
    const k = amb + (1 - amb) * Math.max(0, n.dot(light));
    colors.set(lit(base, k, pos.getX(i), pos.getY(i), pos.getZ(i), glow), i * 3);
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(Array.from(pos.array), 3));
  out.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return out;
}

function box(x0, x1, y0, y1, z0, z1) {
  const g = new BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

function cyl(r0, r1, h, x, y, z, seg = 20, open = false) {
  const g = new CylinderGeometry(r0, r1, h, seg, 1, open);
  g.translate(x, y + h / 2, z);
  return g;
}

function sphere(r, x, y, z, sx = 1, sy = 1, sz = 1, ws = 16, hs = 12) {
  const g = new SphereGeometry(r, ws, hs);
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return g;
}

function hash(i, j = 0, seed = 0) {
  return noise3(i * 1.37 + 0.5, j * 2.11 + 0.5, seed * 0.73 + 0.5, 17 + seed);
}

/** Torn-paper displacement along an edge parameter `u` in meters. */
function tear(u, seed, big = 0.05) {
  return (
    big * (fbm3(u * 1.3, 0.5, seed * 1.7, { octaves: 3, seed }) - 0.5) * 2 +
    0.02 * (fbm3(u * 7, 2.5, seed, { octaves: 3, seed: seed + 5 }) - 0.5) * 2 +
    0.006 * (noise3(u * 33, 4.5, seed, seed + 9) - 0.5) * 2
  );
}

// ---------------------------------------------------------------------------
// One room (the front one, z > 0) and the front half of the wall. The back
// room and the back half of the wall are this same mesh, mirrored.

function wallPaper(x, y) {
  if (y < 0.15) return '#3b2820';
  if (y >= 0.9 && y < 0.95) return '#8a6040';
  if (y >= 2.4) return '#94724f';
  if (y < 0.9) {
    const groove = Math.abs((((x + 1.5) % 0.3) + 0.3) % 0.3) < 0.05;
    return groove ? '#3e2d25' : '#4c382e';
  }
  const stripe = Math.floor((x + 1.5) / 0.15) % 2;
  const dot = fbm3(x * 9, y * 9, 1.5, { octaves: 2, seed: 4 }) > 0.62;
  if (stripe) return dot ? '#8a6650' : '#7a5946';
  return dot ? '#7b5a48' : '#664839';
}

function wallHalf(paint) {
  const S = 0.05;
  const z = WALL_Z;
  for (let ix = 0; ix < 60; ix += 1) {
    for (let iy = 0; iy < 50; iy += 1) {
      const x0 = -WALL_HALF + ix * S;
      const y0 = iy * S;
      const cx = x0 + S / 2;
      const cy = y0 + S / 2;
      if (cx > OPEN.x0 && cx < OPEN.x1 && cy > OPEN.y0 && cy < OPEN.y1) continue;
      const base = lin(wallPaper(cx, cy));
      const c = (x, y) => lit(base, 1, x, y, z);
      quadUp(paint, [x0, y0, z], [x0 + S, y0, z], [x0 + S, y0 + S, z], [x0, y0 + S, z], c(x0, y0), c(x0 + S, y0), c(x0 + S, y0 + S), c(x0, y0 + S));
    }
  }
  const edge = lin('#4a362b');
  paint.quad([-WALL_HALF, WALL_H, 0], [WALL_HALF, WALL_H, 0], [WALL_HALF, WALL_H, z], [-WALL_HALF, WALL_H, z], edge.map((v) => v * 1.2));
  for (const sx of [-1, 1]) {
    const x = sx * WALL_HALF;
    paint.quad([x, 0, 0], [x, WALL_H, 0], [x, WALL_H, z], [x, 0, z], edge);
  }
}

function quadUp(paint, a, b, c, d, ca, cb, cc, cd) {
  paint.tri(a, b, c, ca, cb, cc);
  paint.tri(a, c, d, ca, cc, cd);
}

function frameHalf() {
  const parts = [];
  const { x0, x1, y0, y1 } = OPEN;
  const z = WALL_Z;
  const W = 0.125;
  // Jamb lining through the opening (this half of the wall's thickness).
  parts.push(box(x0 - 0.01, x0, y0, y1, 0, z + 0.001), box(x1, x1 + 0.01, y0, y1, 0, z + 0.001));
  parts.push(box(x0, x1, y1, y1 + 0.01, 0, z + 0.001), box(x0, x1, y0 - 0.01, y0, 0, z + 0.001));
  // Flat outer band, then a raised inner bead, then an outer lip.
  parts.push(box(x0 - W, x0, y0 - W, y1 + W, z, z + 0.03), box(x1, x1 + W, y0 - W, y1 + W, z, z + 0.03));
  parts.push(box(x0, x1, y1, y1 + W, z, z + 0.03), box(x0, x1, y0 - W, y0, z, z + 0.03));
  const bead = 0.045;
  parts.push(box(x0 - bead, x0, y0 - bead, y1 + bead, z, z + 0.06), box(x1, x1 + bead, y0 - bead, y1 + bead, z, z + 0.06));
  parts.push(box(x0, x1, y1, y1 + bead, z, z + 0.06), box(x0, x1, y0 - bead, y0, z, z + 0.06));
  const lip = 0.022;
  parts.push(box(x0 - W - lip, x0 - W, y0 - W - lip, y1 + W + lip, z, z + 0.045), box(x1 + W, x1 + W + lip, y0 - W - lip, y1 + W + lip, z, z + 0.045));
  parts.push(box(x0 - W, x1 + W, y1 + W, y1 + W + lip, z, z + 0.045), box(x0 - W, x1 + W, y0 - W - lip, y0 - W, z, z + 0.045));
  // Pearls along the band.
  const mid = W / 2 + bead / 2;
  for (let y = y0 + 0.08; y < y1 - 0.04; y += 0.12) {
    parts.push(sphere(0.017, x0 - mid, y, z + 0.035, 1, 1, 0.8, 10, 8), sphere(0.017, x1 + mid, y, z + 0.035, 1, 1, 0.8, 10, 8));
  }
  for (let x = x0 + 0.08; x < x1 - 0.04; x += 0.12) {
    parts.push(sphere(0.017, x, y1 + mid, z + 0.035, 1, 1, 0.8, 10, 8), sphere(0.017, x, y0 - mid, z + 0.035, 1, 1, 0.8, 10, 8));
  }
  // Corner rosettes.
  for (const cx of [x0 - mid, x1 + mid]) {
    for (const cy of [y0 - mid, y1 + mid]) parts.push(sphere(0.05, cx, cy, z + 0.04, 1, 1, 0.55, 16, 10));
  }
  // A crest over the top: a shell and two scrolls.
  const cx = (x0 + x1) / 2;
  const top = y1 + W + lip;
  parts.push(sphere(0.09, cx, top + 0.01, z + 0.04, 1.3, 0.85, 0.45, 18, 10));
  for (const s of [-1, 1]) {
    const scroll = new TorusGeometry(0.05, 0.014, 8, 20, Math.PI * 1.4);
    scroll.rotateZ(s > 0 ? -0.3 : Math.PI + 0.3 - Math.PI * 0.4);
    scroll.translate(cx + s * 0.17, top + 0.02, z + 0.035);
    parts.push(scroll);
    parts.push(sphere(0.03, cx + s * 0.3, top - 0.005, z + 0.03, 1.4, 0.7, 0.6, 12, 8));
  }
  return parts.map((g) => bake(g, GOLD, { amb: 0.42, gain: 0.82 }));
}

/** The slab's torn front edge, x increasing from -SLAB_HW to SLAB_HW. */
function slabOutline() {
  const N = 200;
  const pts = [];
  for (let i = 0; i <= N; i += 1) {
    const th = Math.PI * (1 - i / N);
    const c = Math.cos(th);
    const s = Math.sin(th);
    let x = SLAB_HW * Math.sign(c) * Math.abs(c) ** (2 / 3);
    let z = SLAB_D * Math.abs(s) ** (2 / 3);
    const nx = (Math.sign(x) * (Math.abs(x) / SLAB_HW) ** 2) / SLAB_HW;
    const nz = ((z / SLAB_D) ** 2) / SLAB_D;
    const len = Math.hypot(nx, nz) || 1;
    const d = tear(th * 2.6, 5) * Math.sqrt(s);
    x += (nx / len) * d;
    z += (nz / len) * d;
    x = clamp(x, -SLAB_HW, SLAB_HW);
    if (pts.length && x <= pts[pts.length - 1][0]) x = pts[pts.length - 1][0] + 1e-4;
    pts.push([x, Math.max(0, z), nx / len, nz / len]);
  }
  pts[0][1] = 0;
  pts[pts.length - 1][1] = 0;
  return pts;
}

function zEnd(outline, x) {
  for (let i = 0; i < outline.length - 1; i += 1) {
    const [xa, za] = outline[i];
    const [xb, zb] = outline[i + 1];
    if (x <= xb) return mix(za, zb, clamp((x - xa) / (xb - xa)));
  }
  return 0;
}

function floorAndRug(paint) {
  const outline = slabOutline();
  const y = FLOOR;
  const plank = ['#5e3d27', '#6a4630', '#523421', '#674229', '#5a3a25'].map(lin);
  const PW = 0.105;
  const strips = Math.ceil((2 * SLAB_HW) / PW);
  for (let k = 0; k < strips; k += 1) {
    const x0 = -SLAB_HW + k * PW;
    const x1 = Math.min(SLAB_HW, x0 + PW - 0.004);
    const za = zEnd(outline, x0);
    const zb = zEnd(outline, x1);
    const base = plank[Math.floor(hash(k, 3) * plank.length) % plank.length];
    const SEG = 12;
    for (let s = 0; s < SEG; s += 1) {
      const f0 = s / SEG;
      const f1 = (s + 1) / SEG;
      const shade = 0.92 + 0.16 * hash(k, s, 2);
      const c = (x, z) => lit(base.map((v) => v * shade), 1, x, y, z);
      const p = [
        [x0, y, za * f0],
        [x1, y, zb * f0],
        [x1, y, zb * f1],
        [x0, y, za * f1]
      ];
      paint.quad(...p, ...p.map((q) => c(q[0], q[2])));
    }
    // The seam between planks.
    const seam = lin('#2a1a10');
    paint.quad([x1, y, 0], [x1 + 0.004, y, 0], [x1 + 0.004, y, zb], [x1, y, zb], seam);
  }
  // Burnt-gold rim on the torn edge, and the scorched side below it.
  const rim = lin(GOLD);
  const edge = lin(HIGHLIGHT);
  const char = lin('#24140b');
  for (let i = 0; i < outline.length - 1; i += 1) {
    const [xa, za, nxa, nza] = outline[i];
    const [xb, zb, nxb, nzb] = outline[i + 1];
    const wa = 0.012 + 0.016 * fbm3(i * 0.09, 7.7, 1, { octaves: 2, seed: 3 });
    const wb = 0.012 + 0.016 * fbm3((i + 1) * 0.09, 7.7, 1, { octaves: 2, seed: 3 });
    const yr = y + 0.0015;
    paint.quad([xa - nxa * wa, yr, Math.max(0, za - nza * wa)], [xb - nxb * wb, yr, Math.max(0, zb - nzb * wb)], [xb, yr, zb], [xa, yr, za], rim.map((v) => v * 0.7), rim.map((v) => v * 0.7), edge, edge);
    paint.quad([xa, yr, za], [xb, yr, zb], [xb, 0, zb], [xa, 0, za], rim, rim, char, char);
  }
  // Rug in the middle of the room.
  const R = { x0: -0.75, z0: 0.38, nx: 31, nz: 21, s: 0.05 };
  const cx = R.x0 + (R.nx * R.s) / 2;
  const cz = R.z0 + (R.nz * R.s) / 2;
  for (let i = 0; i < R.nx; i += 1) {
    for (let j = 0; j < R.nz; j += 1) {
      const d = Math.min(i, R.nx - 1 - i, j, R.nz - 1 - j);
      const x = R.x0 + i * R.s;
      const z = R.z0 + j * R.s;
      const dm = Math.abs(x + R.s / 2 - cx) / 1.4 + Math.abs(z + R.s / 2 - cz);
      let hex = '#7a2a26';
      if (d === 0) hex = '#d9c8a0';
      else if (d <= 2) hex = '#283a5c';
      else if (d === 3) hex = '#cdb68a';
      else if (dm < 0.11) hex = '#283a5c';
      else if (dm < 0.24) hex = '#b0803a';
      else if (dm < 0.29) hex = '#cdb68a';
      const base = lin(hex);
      const yr = y + 0.005;
      const c = (px, pz) => lit(base, 1, px, yr, pz);
      const p = [
        [x, yr, z],
        [x + R.s, yr, z],
        [x + R.s, yr, z + R.s],
        [x, yr, z + R.s]
      ];
      paint.quad(...p, ...p.map((q) => c(q[0], q[2])));
    }
  }
}

function furniture() {
  const out = [];
  const wood = '#5b3a24';
  const darkWood = '#3e2718';
  const put = (g, hex, opts) => out.push(bake(g, hex, opts));

  // Chair at front-left, seat to the front, its back toward the mirror, a coat over the back.
  const C = { x: -0.62, z: 1.3 };
  const seatY = 0.46;
  put(box(C.x - 0.22, C.x + 0.22, seatY - 0.05, seatY, C.z - 0.21, C.z + 0.21), wood);
  for (const dx of [-0.19, 0.19]) {
    for (const dz of [-0.18, 0.18]) put(box(C.x + dx - 0.02, C.x + dx + 0.02, FLOOR, seatY - 0.05, C.z + dz - 0.02, C.z + dz + 0.02), darkWood);
    put(box(C.x + dx - 0.022, C.x + dx + 0.022, seatY, 0.98, C.z - 0.21, C.z - 0.17), darkWood);
  }
  put(box(C.x - 0.22, C.x + 0.22, 0.88, 0.97, C.z - 0.21, C.z - 0.17), wood);
  put(box(C.x - 0.2, C.x + 0.2, 0.66, 0.72, C.z - 0.205, C.z - 0.175), wood);
  const coat = '#8a3b2a';
  const bz = C.z - 0.19;
  put(cyl(0.045, 0.045, 0.5, 0, 0, 0, 16), coat);
  out[out.length - 1] = bake(cyl(0.045, 0.045, 0.5, 0, -0.25, 0, 16).rotateZ(Math.PI / 2).translate(C.x, 0.985, bz), coat);
  put(box(C.x - 0.24, C.x + 0.24, 0.5, 0.98, bz - 0.07, bz - 0.035), coat, { gain: 0.9 });
  put(box(C.x - 0.23, C.x + 0.23, 0.62, 0.98, bz + 0.035, bz + 0.065), coat);
  put(cyl(0.04, 0.034, 0.46, C.x + 0.2, 0.42, bz - 0.08, 12), coat, { gain: 0.85 });
  put(cyl(0.04, 0.034, 0.4, C.x - 0.21, 0.5, bz - 0.075, 12), coat, { gain: 0.8 });
  put(box(C.x - 0.03, C.x + 0.03, 0.72, 0.96, bz - 0.075, bz - 0.068), '#d9b46a');

  // Small round table with a clock, front-right.
  const Tb = { x: 0.85, z: 0.95 };
  put(cyl(0.16, 0.18, 0.03, Tb.x, FLOOR, Tb.z, 24), darkWood);
  put(cyl(0.03, 0.03, 0.56, Tb.x, FLOOR + 0.03, Tb.z, 12), darkWood);
  put(cyl(0.25, 0.25, 0.035, Tb.x, 0.62, Tb.z, 28), wood);
  const top = 0.655;
  const clockBody = box(-0.11, 0.11, 0, 0.17, -0.05, 0.05);
  clockBody.rotateY(-0.35).translate(Tb.x, top, Tb.z);
  put(clockBody, '#4a2e1c');
  const dome = new SphereGeometry(0.11, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.scale(1, 0.5, 0.45);
  dome.rotateY(-0.35).translate(Tb.x, top + 0.17, Tb.z);
  put(dome, '#4a2e1c');
  const face = new CylinderGeometry(0.065, 0.065, 0.012, 24);
  face.rotateX(Math.PI / 2).translate(0, 0.1, 0.053).rotateY(-0.35).translate(Tb.x, top, Tb.z);
  put(face, '#efe4c8', { amb: 0.8 });
  const bezel = new TorusGeometry(0.066, 0.008, 6, 24);
  bezel.translate(0, 0.1, 0.06).rotateY(-0.35).translate(Tb.x, top, Tb.z);
  put(bezel, GOLD);
  for (const [len, ang] of [[0.04, 2.1], [0.055, -0.95]]) {
    const hand = box(-0.004, 0.004, 0, len, 0, 0.004);
    hand.rotateZ(ang).translate(0, 0.1, 0.061).rotateY(-0.35).translate(Tb.x, top, Tb.z);
    put(hand, '#1c120c', { amb: 1 });
  }

  // Hat stand, back-right, with a scarf.
  const H = { x: 1.15, z: 0.35 };
  for (let k = 0; k < 3; k += 1) {
    const leg = box(0, 0.22, 0, 0.03, -0.015, 0.015);
    leg.rotateZ(0.12).rotateY((k * 2 * Math.PI) / 3 + 0.4).translate(H.x, FLOOR + 0.004, H.z);
    put(leg, darkWood);
  }
  put(cyl(0.018, 0.022, 1.68, H.x, FLOOR, H.z, 10), darkWood);
  put(sphere(0.035, H.x, FLOOR + 1.7, H.z), wood);
  for (let k = 0; k < 4; k += 1) {
    const hook = cyl(0.009, 0.009, 0.13, 0, 0, 0, 6);
    hook.rotateZ(0.9).rotateY((k * Math.PI) / 2 + 0.3).translate(H.x, 1.55, H.z);
    put(hook, GOLD);
  }
  put(box(H.x - 0.07, H.x + 0.07, 0.95, 1.55, H.z + 0.06, H.z + 0.09), '#5f7f52');
  put(box(H.x - 0.06, H.x + 0.06, 1.05, 1.52, H.z - 0.09, H.z - 0.06), '#5f7f52', { gain: 0.85 });

  // Floor lamp, back-left. Its shade is painted bright; the pool of light
  // on the floor and wall is in the vertex colours of both.
  put(cyl(0.15, 0.16, 0.03, LAMP.x, FLOOR, LAMP.z, 24), darkWood);
  put(cyl(0.014, 0.014, 1.42, LAMP.x, FLOOR + 0.03, LAMP.z, 8), GOLD, { gain: 0.6 });
  out.push(bake(cyl(0.13, 0.22, 0.27, LAMP.x, 1.44, LAMP.z, 28, true), '#ffd9a0', { amb: 1, glow: 0.3 }));
  out.push(bake(sphere(0.05, LAMP.x, 1.5, LAMP.z), HIGHLIGHT, { amb: 1, glow: 0 }));
  return out;
}

/** The back room's own things, in world coordinates: no reflection has these. */
function backstage() {
  const light = new Vector3(LIGHT.x, LIGHT.y, -LIGHT.z);
  const put = (g, hex, opts = {}) => bake(g, hex, { light, glow: 0, ...opts });
  const out = [];
  const S = { x: -1.08, z: -1.05 };
  out.push(put(cyl(0.16, 0.16, 0.04, S.x, 0.44, S.z, 24), '#6b4a30'));
  for (let k = 0; k < 3; k += 1) {
    const leg = cyl(0.016, 0.016, 0.42, 0, 0, 0, 8);
    leg.rotateX(0.08).rotateY((k * 2 * Math.PI) / 3).translate(S.x + 0.1 * Math.sin((k * 2 * Math.PI) / 3), FLOOR + 0.004, S.z + 0.1 * Math.cos((k * 2 * Math.PI) / 3));
    out.push(put(leg, '#3e2718'));
  }
  out.push(put(cyl(0.042, 0.038, 0.1, S.x + 0.02, 0.48, S.z, 18), '#e8ddc6'));
  const handle = new TorusGeometry(0.028, 0.008, 6, 14);
  handle.translate(S.x + 0.07, 0.535, S.z);
  out.push(put(handle, '#e8ddc6'));
  // A hook on the back of the wall, and a blue coat that is nobody else's.
  out.push(put(cyl(0.012, 0.012, 0.07, 0, 0, 0, 6).rotateX(Math.PI / 2).translate(-0.95, 1.78, -WALL_Z - 0.035), GOLD));
  out.push(put(sphere(0.17, -0.95, 1.62, -WALL_Z - 0.09, 1.1, 0.45, 0.45), '#3a4f6b'));
  const body = box(-0.17, 0.17, 0.9, 1.62, -WALL_Z - 0.13, -WALL_Z - 0.06);
  body.translate(-0.95, 0, 0);
  out.push(put(body, '#3a4f6b'));
  for (const s of [-1, 1]) out.push(put(cyl(0.04, 0.035, 0.6, -0.95 + s * 0.17, 0.98, -WALL_Z - 0.09, 10), '#33465f'));
  out.push(put(box(-0.96, -0.94, 0.95, 1.55, -WALL_Z - 0.136, -WALL_Z - 0.13), '#d9b46a', { amb: 1 }));
  return out;
}

// ---------------------------------------------------------------------------
// The figures: jointed mannequins of light (after door.mjs), with a brimmed
// hat so the viewer can read which way a faceless head is turned.

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
const HAT_AT = [0, 0.13, 0.012];

function ell(rx, ry, rz, c = [0, 0, 0], ws = 22, hs = 16) {
  const g = new SphereGeometry(1, ws, hs);
  g.scale(rx, ry, rz);
  g.translate(...c);
  return g;
}

/** A tapered capsule from a (radius ra) to b (radius rb), squashed sx / sz across. */
function limb(a, b, ra, rb, sx = 1, sz = 1, radial = 16) {
  const A = new Vector3(...a);
  const B = new Vector3(...b);
  const L = A.distanceTo(B);
  const pts = [];
  const cap = 5;
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

function figureParts() {
  const side = (sx) => ({
    shoulder: [ell(0.054, 0.054, 0.056, [0, -0.012, 0]), limb([0, -0.01, 0], [0, -0.3, 0], 0.048, 0.037)],
    elbow: [limb([0, 0, 0], [0, -0.25, 0], 0.039, 0.027, 0.8, 1.15)],
    hip: [limb([0, 0, 0], [0, -0.42, 0], 0.078, 0.05, 1, 1.05)],
    knee: [limb([0, 0, 0], [0, -0.415, 0], 0.052, 0.034), ell(0.047, 0.12, 0.052, [0, -0.13, -0.014])],
    ankle: [ell(0.037, 0.037, 0.04, [0, -0.004, -0.004]), limb([0, -0.03, -0.045], [0, -0.038, 0.16], 0.035, 0.027, 1.25, 1)],
    hand: [limb([sx * 0.007, -0.006, 0], [sx * 0.007, -0.16, 0.006], 0.026, 0.02, 0.62, 1.7), limb([sx * 0.011, -0.028, 0.03], [sx * 0.013, -0.085, 0.056], 0.014, 0.011)]
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
    wristR: R.hand,
    hipL: L.hip,
    kneeL: L.knee,
    ankleL: L.ankle,
    hipR: R.hip,
    kneeR: R.knee,
    ankleR: R.ankle
  };
}

/** A felt hat with a band and a deep front brim, in the hat node's frame. */
function hatGeometry(crownHex, bandHex) {
  const paint = (g, hex) => {
    const n = g.index ? g.toNonIndexed() : g;
    if (n.attributes.uv) n.deleteAttribute('uv');
    const c = lin(hex);
    const colors = new Float32Array(n.attributes.position.count * 3);
    for (let i = 0; i < n.attributes.position.count; i += 1) colors.set(c, i * 3);
    n.setAttribute('color', new Float32BufferAttribute(colors, 3));
    return n;
  };
  const crown = new CylinderGeometry(0.078, 0.092, 0.115, 28);
  crown.translate(0, 0.07, 0);
  const cap = ell(0.078, 0.022, 0.078, [0, 0.127, 0], 28, 8);
  const band = new CylinderGeometry(0.095, 0.096, 0.026, 28, 1, true);
  band.translate(0, 0.026, 0);
  const brim = new CylinderGeometry(1, 1, 0.014, 40);
  brim.scale(0.2, 1, 0.215);
  brim.translate(0, 0.008, 0.035);
  brim.rotateX(0.1);
  return mergeGeometries([paint(crown, crownHex), paint(cap, crownHex), paint(band, bandHex), paint(brim, crownHex)]);
}

class Rig {
  constructor() {
    this.root = new Object3D();
    this.root.position.set(0, FLOOR, 0);
    this.j = {};
    for (const [name, parent, offset] of SKELETON) {
      const o = new Object3D();
      o.position.set(...offset);
      (parent ? this.j[parent] : this.root).add(o);
      this.j[name] = o;
    }
    this.hat = new Object3D();
    this.hat.position.set(...HAT_AT);
    this.j.head.add(this.hat);
    this.geo = {};
    for (const [name, list] of Object.entries(figureParts())) {
      this.geo[name] = mergeGeometries(list.map((p) => (p.attributes.uv ? p.deleteAttribute('uv') : p)));
    }
    this.root.updateMatrixWorld(true);
  }

  extreme(name, axis, sign) {
    const obj = this.j[name];
    obj.updateWorldMatrix(true, false);
    const pos = this.geo[name].attributes.position;
    const v = new Vector3();
    let best = -Infinity;
    for (let i = 0; i < pos.count; i += 1) {
      v.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
      best = Math.max(best, sign * v[axis]);
    }
    return sign * best;
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
const basisQ = (X, Y, Z) => new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(X, Y, Z));

/** A point given in the body's frame (x left, z forward, y up from the floor). */
function bodyPoint(P, bx, by, bz) {
  const c = Math.cos(P.yaw);
  const s = Math.sin(P.yaw);
  return new Vector3(P.px + bx * c + bz * s, FLOOR + by, P.pz - bx * s + bz * c);
}
function bodyDir(P, bx, by, bz) {
  return bodyPoint(P, bx, by, bz).sub(bodyPoint(P, 0, 0, 0)).normalize();
}

function setWorldQ(obj, qWorld) {
  const parentQ = obj.parent.getWorldQuaternion(new Quaternion());
  obj.quaternion.copy(parentQ.invert().multiply(qWorld));
  obj.updateMatrixWorld(true);
}

function applyPose(rig, P) {
  const { j } = rig;
  j.pelvis.position.set(P.px, P.py, P.pz);
  j.pelvis.quaternion.copy(eul(P.pp, P.yaw, 0));
  j.spine.quaternion.copy(eul(P.sp, 0, 0));
  j.chest.quaternion.copy(eul(P.cp, P.cy, 0));
  j.neck.quaternion.copy(eul(P.np, P.hy * 0.3, 0));
  j.head.quaternion.copy(eul(P.hp, P.hy * 0.7, P.hr));
  rig.hat.quaternion.copy(eul(0, 0, P.hat));
  rig.root.updateMatrixWorld(true);

  if (P.lookW > 0) {
    const at = new Vector3(0, 0.07, 0.02).applyMatrix4(j.head.matrixWorld);
    const target = P.lookAt.clone();
    const Z = target.sub(at).normalize();
    const X = new Vector3(0, 1, 0).cross(Z).normalize();
    const Y = new Vector3().crossVectors(Z, X);
    const look = basisQ(X, Y, Z).multiply(eul(0, 0, P.hr));
    const now = j.head.getWorldQuaternion(new Quaternion());
    setWorldQ(j.head, now.slerp(look, P.lookW));
  }

  for (const side of ['L', 'R']) {
    const foot = P.feet[side];
    const target = new Vector3(foot.x, FLOOR + ANKLE_H + foot.lift, foot.z);
    const pole = new Vector3(Math.sin(foot.yaw), 0, Math.cos(foot.yaw));
    twoBone(j[`hip${side}`], j[`knee${side}`], j[`ankle${side}`].position.length(), target, pole, -1);
    setWorldQ(j[`ankle${side}`], eul(foot.lift * 3, foot.yaw, 0));
  }

  const headQ = () => j.head.getWorldQuaternion(new Quaternion());
  const headPoint = (x, y, z) => new Vector3(x, y, z).applyMatrix4(j.head.matrixWorld);
  const pointUp = () => headQ().multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI));
  const fwd = new Vector3(Math.sin(P.yaw), 0, Math.cos(P.yaw));
  const solve = (side, target, pole, handQ) => {
    const sh = j[`shoulder${side}`];
    const el = j[`elbow${side}`];
    const wr = j[`wrist${side}`];
    twoBone(sh, el, wr.position.length(), target, pole, 1);
    if (handQ) setWorldQ(wr, handQ);
  };
  const gestures = {
    L: [
      [P.hatL, () => solve('L', headPoint(0.14, 0.0 + P.tug, 0.07), bodyDir(P, 0.7, -1, -0.3), pointUp())],
      [P.coat, () => solve('L', new Vector3(-0.62 + 0.13 + P.slide, 1.03, 0.97), bodyDir(P, 0.8, -1, -0.2), basisQ(new Vector3(1, 0, 0), new Vector3(0, 0.6, -0.8), new Vector3(0, 0.8, 0.6)))],
      [P.shush, () => solve('L', headPoint(0.0, -0.085, 0.15), bodyDir(P, 0.9, -1, 0.25), pointUp())]
    ],
    R: [
      [P.hatR, () => solve('R', headPoint(-0.14, 0.0 + P.tug, 0.07), bodyDir(P, -0.7, -1, -0.3), pointUp())],
      [
        P.wave,
        () => {
          const Y = new Vector3(0, -1, 0);
          solve('R', bodyPoint(P, -0.34 + P.waveX, 1.5, 0.12), bodyDir(P, -0.8, -1, -0.2), basisQ(fwd.clone(), Y, new Vector3().crossVectors(fwd, Y)));
        }
      ],
      [P.coat, () => solve('R', new Vector3(-0.62 - 0.13 + P.slide, 1.03, 0.97), bodyDir(P, -0.8, -1, -0.2), basisQ(new Vector3(1, 0, 0), new Vector3(0, 0.6, -0.8), new Vector3(0, 0.8, 0.6)))],
      [
        P.palm,
        () => {
          // Palm flat on the glass at shoulder height, fingers up and a little out.
          const fingers = new Vector3(Math.sin(0.22), Math.cos(0.22), 0);
          const X = new Vector3(0, 0, 1);
          const Y = fingers.clone().negate();
          const handQ = basisQ(X, Y, new Vector3().crossVectors(X, Y));
          const palm = new Vector3(0.58, 1.52, 0.02);
          const target = palm.clone().addScaledVector(fingers, -0.075);
          for (let k = 0; k < 4; k += 1) {
            solve('R', target, new Vector3(0.7, -0.8, 0.5).normalize(), handQ);
            target.z += 0.004 - rig.extreme('wristR', 'z', -1);
          }
        }
      ]
    ]
  };
  for (const side of ['L', 'R']) {
    const sgn = side === 'L' ? 1 : -1;
    const sh = j[`shoulder${side}`];
    const el = j[`elbow${side}`];
    const wr = j[`wrist${side}`];
    sh.quaternion.copy(eul(-0.04 + 0.9 * (P.sp + P.cp) + 0.12 * P.sq, 0, sgn * (0.09 + 0.03 * P.sq), 'XYZ'));
    el.quaternion.copy(eul(-0.2, 0, 0, 'XYZ'));
    wr.quaternion.copy(eul(0, 0, sgn * 0.05, 'XYZ'));
    sh.updateMatrixWorld(true);
    for (const [w, run] of gestures[side]) {
      if (!(w > 1e-4)) continue;
      const cur = [sh.quaternion.clone(), el.quaternion.clone(), wr.quaternion.clone()];
      run();
      sh.quaternion.copy(cur[0].slerp(sh.quaternion, w));
      el.quaternion.copy(cur[1].slerp(el.quaternion, w));
      wr.quaternion.copy(cur[2].slerp(wr.quaternion, w));
      sh.updateMatrixWorld(true);
    }
  }
  rig.root.updateMatrixWorld(true);
}

// ---------------------------------------------------------------------------
// The performance (20 s). Everything is authored in the front room's
// coordinates; the second person is the same rig under the mirrored parent.

const PI = Math.PI;
const bodyA = {
  x: K([[0, 0], [6.6, 0], [7.7, -0.62], [11.5, -0.62], [12.4, 0], [20, 0]]),
  z: K([[0, 1.0], [2.3, 1.0], [2.9, 0.9], [5.8, 0.9], [6.4, 1.0], [6.6, 1.0], [7.7, 0.8], [11.5, 0.8], [12.4, 1.0], [20, 1.0]]),
  yaw: K([[0, PI], [6.0, PI], [7.0, 2 * PI], [11.5, 2 * PI], [12.4, PI], [20, PI]])
};
// The second person's own path: it stops turning, then steps up to the glass.
const bodyDiv = {
  x: K([[6.3, 0], [7.2, 0], [8.0, 0.12], [11.6, 0.12], [12.4, 0]]),
  z: K([[6.3, 1.0], [7.2, 1.0], [8.0, 0.42], [11.6, 0.42], [12.4, 1.0]]),
  yaw: () => PI
};
/** How far the second person has stopped copying: 0 outside 6.3 to 12.5 s. */
const diverge = (t) => smooth(6.3, 7.0, t) * (1 - smooth(11.6, 12.5, t));

const bodyOf = (who) => (t) => {
  t = wrap(t);
  const a = { x: bodyA.x(t), z: bodyA.z(t), yaw: bodyA.yaw(t) };
  if (who === 'A') return a;
  const w = diverge(t);
  if (w <= 0) return a;
  return { x: mix(a.x, bodyDiv.x(t), w), z: mix(a.z, bodyDiv.z(t), w), yaw: mix(a.yaw, bodyDiv.yaw(t), w) };
};

function feetOf(body, t) {
  const out = {};
  for (const [side, lag, sx] of [['L', 0.0, 0.1], ['R', 0.2, -0.1]]) {
    const b = body(t - lag);
    const before = body(t - lag - 0.14);
    const moving = Math.hypot(b.x - before.x, b.z - before.z) + 0.12 * Math.abs(b.yaw - before.yaw);
    const c = Math.cos(b.yaw);
    const s = Math.sin(b.yaw);
    out[side] = {
      x: b.x + sx * c + 0.02 * s,
      z: b.z - sx * s + 0.02 * c,
      yaw: b.yaw + sx * 0.8,
      lift: 0.07 * smooth(0.004, 0.05, moving)
    };
  }
  return out;
}

const upperA = {
  py: K([[0, 0.94], [7.7, 0.94], [8.2, 0.9], [11.0, 0.9], [11.6, 0.94], [20, 0.94]]),
  pp: K([[0, 0], [7.7, 0], [8.2, 0.16], [11.0, 0.16], [11.6, 0], [20, 0]]),
  sp: K([[0, 0.02], [2.3, 0.02], [2.9, 0.07], [5.7, 0.07], [6.2, 0.02], [7.7, 0.02], [8.2, 0.24], [11.0, 0.24], [11.6, 0.02], [12.6, 0.02], [13.4, -0.03], [17.6, -0.03], [18.4, 0.02], [20, 0.02]]),
  cp: K([[0, 0.02], [2.3, 0.02], [2.9, 0.12], [5.7, 0.12], [6.2, 0.02], [7.7, 0.02], [8.2, 0.34], [11.0, 0.34], [11.6, 0.02], [12.6, 0.02], [13.4, -0.07], [17.6, -0.07], [18.4, 0.02], [20, 0.02]]),
  hy: K([[0, 0], [2.4, 0], [2.85, 0.85], [3.6, 0.85], [4.1, -0.85], [4.7, -0.85], [5.1, 0], [20, 0]]),
  hp: K([[0, 0], [2.3, 0], [2.9, -0.1], [5.7, -0.1], [6.2, 0], [7.7, 0], [8.2, 0.35], [11.0, 0.35], [11.6, 0], [18.0, 0], [18.45, 0.3], [18.95, -0.02], [19.4, 0], [20, 0]]),
  hat: K([[0, 0], [0.6, 0.08], [1.2, -0.05], [1.8, 0], [14.6, 0], [15.6, 0.22], [18.6, 0.22], [19.4, 0], [20, 0]]),
  hatL: K([[0, 1], [1.8, 1], [2.4, 0], [19.2, 0], [20, 1]]),
  hatR: K([[0, 1], [1.8, 1], [2.4, 0], [14.0, 0], [14.6, 1], [16.2, 1], [16.9, 0], [19.2, 0], [20, 1]]),
  wave: K([[4.85, 0], [5.2, 1], [5.75, 1], [6.1, 0]]),
  coat: K([[7.7, 0], [8.3, 1], [10.9, 1], [11.4, 0]]),
  sq: K([[12.4, 0], [13.2, 1], [17.6, 1], [18.4, 0]])
};

function poseA(t) {
  t = wrap(t);
  const hat = upperA.hat(t);
  return {
    py: upperA.py(t),
    pp: upperA.pp(t),
    sp: upperA.sp(t),
    cp: upperA.cp(t),
    cy: 0,
    np: 0,
    hp: upperA.hp(t),
    hy: upperA.hy(t),
    hr: -0.5 * hat,
    hat,
    sq: upperA.sq(t),
    hatL: upperA.hatL(t),
    hatR: upperA.hatR(t),
    wave: upperA.wave(t),
    coat: upperA.coat(t),
    palm: 0,
    shush: 0,
    lookW: 0,
    lookEye: 0,
    tug: 0.012 * Math.sin((2 * PI * t) / 0.625),
    waveX: 0.07 * Math.sin(2 * PI * 2.5 * t),
    slide: 0.09 * Math.sin(2 * PI * 0.75 * (t - 8))
  };
}

const upperDiv = {
  droop: K([[6.3, 0], [6.5, 0], [7.1, 1], [7.4, 1], [7.9, 0.15], [20, 0.15]]),
  palm: K([[7.4, 0], [8.0, 1], [11.3, 1], [11.8, 0]]),
  lookW: K([[7.8, 0], [8.4, 1], [11.4, 1], [11.9, 0]]),
  lookEye: K([[8.9, 0], [9.4, 1], [20, 1]]),
  hr: K([[9.3, 0], [9.8, 0.16], [11.3, 0.16], [11.8, 0]]),
  cy: K([[8.9, 0], [9.5, -0.2], [11.3, -0.2], [11.8, 0]]),
  shush: K([[9.8, 0], [10.4, 1], [11.3, 1], [11.8, 0]])
};
const A_SEEN = new Vector3(-0.62, 1.1, -0.95); // the first person, as seen from the back room

function poseDiv(t, a) {
  const droop = upperDiv.droop(t);
  return {
    ...a,
    py: 0.94 - 0.02 * droop,
    pp: 0,
    sp: 0.03 + 0.05 * droop,
    cp: 0.02 + 0.12 * droop,
    cy: upperDiv.cy(t),
    hp: 0.22 * droop,
    hy: 0,
    hr: upperDiv.hr(t),
    hat: 0,
    sq: -droop,
    hatL: 0,
    hatR: 0,
    wave: 0,
    coat: 0,
    palm: upperDiv.palm(t),
    shush: upperDiv.shush(t),
    lookW: upperDiv.lookW(t),
    lookEye: upperDiv.lookEye(t)
  };
}

const NUMERIC = ['py', 'pp', 'sp', 'cp', 'cy', 'np', 'hp', 'hy', 'hr', 'hat', 'sq', 'hatL', 'hatR', 'wave', 'coat', 'palm', 'shush', 'lookW', 'lookEye', 'tug', 'waveX', 'slide'];

function pose(who, t) {
  t = wrap(t);
  const body = bodyOf(who);
  const b = body(t);
  let P = poseA(t);
  if (who === 'B') {
    const w = diverge(t);
    if (w > 0) {
      const d = poseDiv(t, P);
      const blended = {};
      for (const k of NUMERIC) blended[k] = mix(P[k], d[k], w);
      P = blended;
    }
  }
  P.px = b.x;
  P.pz = b.z;
  P.yaw = b.yaw;
  P.feet = feetOf(body, t);
  P.lookAt = A_SEEN.clone().lerp(EYE_MIRRORED, P.lookEye);
  return P;
}

function sampleFigure(rig, who) {
  const count = LOOP * FPS;
  const frames = [];
  for (let i = 0; i <= count; i += 1) {
    const t = (i / count) * LOOP;
    applyPose(rig, pose(who, t));
    const f = { q: {}, pelvis: rig.j.pelvis.position.toArray(), hat: rig.hat.quaternion.toArray() };
    for (const [name] of SKELETON) f.q[name] = rig.j[name].quaternion.toArray();
    frames.push(f);
  }
  return frames;
}

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

function writeFigure(glb, rig, frames, { name, material, hatMaterial, hatGeo, times, parent }) {
  const root = glb.node({ name, translation: rig.root.position.toArray(), parent });
  const nodes = {};
  for (const [joint, parentJoint, offset] of SKELETON) {
    nodes[joint] = glb.node({
      name: `${name}-${joint}`,
      mesh: glb.mesh(`${name}-${joint}`, rig.geo[joint], material),
      translation: joint === 'pelvis' ? frames[0].pelvis : offset,
      rotation: frames[0].q[joint],
      parent: parentJoint ? nodes[parentJoint] : root
    });
  }
  const hat = glb.node({ name: `${name}-hat`, mesh: glb.mesh(`${name}-hat`, hatGeo, hatMaterial), translation: HAT_AT, rotation: frames[0].hat, parent: nodes.head });
  for (const [joint] of SKELETON) glb.animate(nodes[joint], 'rotation', times, quatTrack(frames.map((f) => f.q[joint])));
  glb.animate(nodes.pelvis, 'translation', times, frames.flatMap((f) => f.pelvis));
  glb.animate(hat, 'rotation', times, quatTrack(frames.map((f) => f.hat)));
}

// ---------------------------------------------------------------------------
// Sound: a small music-box waltz while the first person preens; one held
// note while their back is turned, a soft double tap at the glass, a breathy
// "shh"; the waltz comes back as the reflection scrambles into place.

const NOTE = { G3: 196.0, C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, B4: 493.88, C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99 };

function sound() {
  const out = track(LOOP);
  const box = (hz) => (t) => Math.sin(2 * PI * hz * t) + 0.22 * Math.sin(2 * PI * hz * 2 * t) + 0.05 * Math.sin(2 * PI * hz * 3.01 * t);
  const note = (at, hz, gain, decay = 0.55) => add(out, at, decay * 5, box(hz), (t) => gain * pluck(0.003, decay)(t));
  const BAR = 1.2;
  const B = 0.4;
  const waltz = (start, bars) => {
    bars.forEach(([bass, chord, melody], i) => {
      const t0 = start + i * BAR;
      note(t0, bass, 0.2, 0.7);
      for (const beat of [1, 2]) for (const hz of chord) note(t0 + beat * B, hz, 0.06, 0.3);
      for (const [beat, hz] of melody) note(t0 + beat * B, hz, 0.3, 0.6);
    });
  };
  const Cc = [NOTE.E4, NOTE.G4];
  const Gc = [NOTE.D4, NOTE.F4];
  waltz(0, [
    [NOTE.C4, Cc, [[0, NOTE.E5], [2, NOTE.G5]]],
    [NOTE.G3, Gc, [[0, NOTE.F5], [1, NOTE.E5], [2, NOTE.D5]]],
    [NOTE.C4, Cc, [[0, NOTE.C5], [2, NOTE.E5]]],
    [NOTE.G3, Gc, [[0, NOTE.D5]]],
    [NOTE.G3, Gc, [[0, NOTE.G5], [1, NOTE.F5], [2, NOTE.D5]]]
  ]);
  // The turn: one last note, then a single held tone while the back is turned.
  note(6.0, NOTE.C5, 0.22, 0.8);
  add(out, 6.5, 5.2, (t) => Math.sin(2 * PI * NOTE.E5 * t) * (1 + 0.04 * Math.sin(2 * PI * 4.5 * t)), (t) => 0.07 * swell(5.2)(t));
  // Two soft taps: the palm meeting the glass.
  const random = noise(11);
  const tap = track(0.12);
  for (let i = 0; i < tap.length; i += 1) tap[i] = random();
  lowpass(tap, 1800);
  for (const at of [8.0, 8.14]) {
    add(out, at, 0.12, (t) => tap[Math.min(tap.length - 1, Math.floor(t * SAMPLE_RATE))], (t) => 0.5 * pluck(0.001, 0.015)(t));
    add(out, at, 0.25, (t) => Math.sin(2 * PI * 150 * t), (t) => 0.22 * pluck(0.002, 0.04)(t));
  }
  // "Shh": a soft band of noise, low-passed twice with the bottom taken out.
  const shh = track(1.0);
  const hiss = noise(5);
  for (let i = 0; i < shh.length; i += 1) shh[i] = hiss();
  const low = Float32Array.from(shh);
  lowpass(shh, 3200);
  lowpass(shh, 3200);
  lowpass(low, 700);
  for (let i = 0; i < shh.length; i += 1) shh[i] -= low[i];
  add(out, 10.15, 1.0, (t) => shh[Math.min(shh.length - 1, Math.floor(t * SAMPLE_RATE))], (t) => 0.5 * swell(1.0)(t) ** 0.7);
  waltz(11.6, [
    [NOTE.C4, Cc, [[0, NOTE.E5], [2, NOTE.G5]]],
    [NOTE.G3, Gc, [[0, NOTE.F5], [1, NOTE.E5], [2, NOTE.D5]]],
    [NOTE.C4, Cc, [[0, NOTE.C5], [2, NOTE.E5]]],
    [NOTE.G3, Gc, [[0, NOTE.D5], [2, NOTE.F5]]],
    [NOTE.C4, Cc, [[0, NOTE.E5], [1, NOTE.D5], [2, NOTE.C5]]],
    [NOTE.G3, Gc, [[0, NOTE.D5], [2, NOTE.B4]]],
    [NOTE.C4, Cc, [[0, NOTE.C5]]]
  ]);
  // A quiet room under it all.
  const room = track(LOOP);
  const air = noise(3);
  for (let i = 0; i < room.length; i += 1) room[i] = air() * 0.01;
  lowpass(room, 300);
  for (let i = 0; i < out.length; i += 1) out[i] += room[i];
  return toWav(normalize(out, 0.7));
}

// ---------------------------------------------------------------------------

export async function build() {
  const glb = new Glb();
  glb.provenance({
    holoim: {
      authored: 'synthetic',
      author: meta.submittedBy,
      title: meta.name,
      note: 'The back room is the front room under a parent node scaled [1, 1, -1]: an exact mirror image.'
    }
  });

  const paint = new Paint();
  wallHalf(paint);
  floorAndRug(paint);
  const roomGeo = mergeGeometries([paint.geometry(), ...frameHalf(), ...furniture()]);
  const painted = glb.material({ name: 'Painted', color: '#ffffff', unlit: true, doubleSided: true });
  const roomMesh = glb.mesh('Room', roomGeo, painted);

  const scene = glb.node({ name: 'OtherSideOfTheMirror' });
  const roomA = glb.node({ name: 'RoomFront', parent: scene });
  const roomB = glb.node({ name: 'RoomBack', scale: [1, 1, -1], parent: scene });
  glb.node({ name: 'RoomFrontPaint', mesh: roomMesh, parent: roomA });
  glb.node({ name: 'RoomBackPaint', mesh: roomMesh, parent: roomB });
  glb.node({ name: 'Backstage', mesh: glb.mesh('Backstage', mergeGeometries(backstage()), painted), parent: scene });

  // The glass: one very faint pane and three glints.
  const { x0, x1, y0, y1 } = OPEN;
  const pane = new PlaneGeometry(x1 - x0, y1 - y0);
  pane.translate((x0 + x1) / 2, (y0 + y1) / 2, 0);
  const paneInk = glb.material({ name: 'Glass', color: '#bfe6f0', opacity: 0.06, unlit: true, doubleSided: true });
  glb.node({ name: 'Glass', mesh: glb.mesh('Glass', pane, paneInk), parent: scene });
  const glints = [];
  for (const [cx, cy, len, w] of [[0.62, 1.95, 0.42, 0.022], [0.7, 1.78, 0.22, 0.012], [-0.22, 0.55, 0.34, 0.016]]) {
    const g = new PlaneGeometry(w, len);
    g.rotateZ(-0.7);
    g.translate(cx, cy, 0.003);
    glints.push(g);
  }
  // Where the palm met the glass, a print stays a while after it has gone:
  // the one thing a reflection could never leave.
  const print = new CircleGeometry(1, 24);
  print.scale(0.055, 0.075, 1);
  const printInk = glb.material({ name: 'PalmPrint', color: '#e6f6ff', opacity: 0.2, unlit: true, doubleSided: true });
  const printNode = glb.node({ name: 'PalmPrint', mesh: glb.mesh('PalmPrint', print, printInk), translation: [0.58, 1.5, -0.002], scale: [1e-4, 1e-4, 1e-4], parent: scene });
  const printAt = sample(LOOP, 10, (t) => {
    const k = Math.max(1e-4, smooth(7.85, 8.05, t) * (1 - smooth(14.5, 16.5, t)));
    return [k, k, 1];
  });
  glb.animate(printNode, 'scale', printAt.times, printAt.values);
  const glintInk = glb.material({ name: 'Glint', color: '#eefaff', opacity: 0.28, unlit: true, doubleSided: true });
  glb.node({ name: 'Glints', mesh: glb.mesh('Glints', mergeGeometries(glints), glintInk), parent: scene });

  const times = [];
  const count = LOOP * FPS;
  for (let i = 0; i <= count; i += 1) times.push((i / count) * LOOP);
  const rigA = new Rig();
  const framesA = sampleFigure(rigA, 'A');
  const rigB = new Rig();
  const framesB = sampleFigure(rigB, 'B');

  const warm = glb.material({ name: 'FigureFront', color: GOLD, emissive: GLOW, emissiveStrength: 0.6, roughness: 0.4 });
  const cool = glb.material({ name: 'FigureBack', color: '#ffcf8f', emissive: '#f2ad74', emissiveStrength: 0.58, roughness: 0.4 });
  const hatA = glb.material({ name: 'HatFront', color: '#ffffff', emissive: '#1a120c', roughness: 0.8 });
  const hatB = glb.material({ name: 'HatBack', color: '#ffffff', emissive: '#14121a', roughness: 0.8 });
  writeFigure(glb, rigA, framesA, { name: 'figA', material: warm, hatMaterial: hatA, hatGeo: hatGeometry('#3a2a21', '#c99a52'), times, parent: roomA });
  writeFigure(glb, rigB, framesB, { name: 'figB', material: cool, hatMaterial: hatB, hatGeo: hatGeometry('#332e30', '#c3a070'), times, parent: roomB });

  glb.audio(sound());
  return glb;
}

const dirAt = (yawDeg, pitchDeg) => {
  const y = (yawDeg * PI) / 180;
  const p = (pitchDeg * PI) / 180;
  return [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)];
};
const camAt = (dir, d) => FEED_T.map((v, i) => +(v + dir[i] * d).toFixed(3));
const FEED_EYE = EYE.map((v) => +v.toFixed(3));

export const tiles = [
  { label: 'feed', cam: FEED_EYE, look: FEED_T, fov: 38, t: 0 },
  { label: 'feed', cam: FEED_EYE, look: FEED_T, fov: 38, t: 3 },
  { label: 'feed', cam: FEED_EYE, look: FEED_T, fov: 38, t: 10.5 },
  { label: 'feed 2x', cam: FEED_EYE, look: FEED_T, fov: 19, t: 10.5 },
  { label: 'behind (yaw 198)', cam: camAt(dirAt(198, 16), FEED_D), look: FEED_T, fov: 38, t: 10.5 },
  { label: 'side (yaw 90)', cam: camAt(dirAt(90, 10), FEED_D), look: FEED_T, fov: 38, t: 3 },
  { label: 'plan', cam: [0, 9.5, 0.6], look: [0, 0, 0], fov: 38, t: 10.5 },
  { label: 'close 1.6 m', cam: camAt(FEED_DIR, 1.6), look: FEED_T, fov: 38, t: 10.5 },
  { label: 'feed 4x', cam: FEED_EYE, look: [0.2, 1.3, -0.3], fov: 9.5, t: 10.5 }
];
