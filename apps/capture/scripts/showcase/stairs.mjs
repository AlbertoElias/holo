import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ExtrudeGeometry,
  Float32BufferAttribute,
  LatheGeometry,
  Matrix4,
  Path,
  Quaternion,
  Shape,
  SphereGeometry,
  Vector2,
  Vector3
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { add, lowpass, noise, normalize, pluck, sine, toWav, track } from './lib/audio.mjs';
import { Glb, sample } from './lib/glb.mjs';
import { fbm3, noise3 } from './lib/parts.mjs';
import { T as TOKEN } from './lib/tokens.mjs';

// "Everyone's down is different": a small building of three peoples whose
// gravities stand at right angles. Everything is designed in cube
// coordinates (a, b, c): people A stand toward +a, B toward +b, C toward +c.
// One stair unit is authored for the pair (A, B) and repeated for (B, C) and
// (C, A) by cyclic permutation of the axes. On each shared flight the treads
// of one people are the risers of the other, and both climb it at once, in
// opposite directions, in two lanes. The cube stands on a face: A's up is the
// world's, so from the first view A climb ordinary staircases while B and C
// stick out level from the risers and walk on the walls.

export const meta = {
  slug: 'everyones-down-is-different',
  name: "Everyone's down is different",
  submittedBy: 'Claude (agent-authored)'
};

const LOOP = 12;
const FPS = 24;

// --------------------------------------------------------------- the cube

const S = 0.11; // tread = riser
const N = 7; // risers per flight
const H = N * S; // rise of a flight
const W = 0.5; // flight width: two lanes
const LANE = W / 2;
const H1 = 0.5; // low floor level of each people
const H2 = H1 + H; // high floor level
const LO = 0.4; // low landing length beyond the flight
const HI = 0.3; // high landing length beyond the flight
const EXTRA = [0.2, 0.15, 0]; // longer second-people low landings, where B and C sit
const SLAB = 0.06; // landing thickness
const BOX_LO = [-0.09, -0.2, -0.2]; // low corner of the box the building fills (cube coords): below the B/C flight on the floor
const BOX_Q = 2.12; // that box's edge: room for A's heads on the high landings
const LIFT = 0.091; // world height of the building's lowest point: 4 cm above the slab top

const GOLD = TOKEN.gold;

// People colours: the floors each people stands on are tinted in its family.
const PEOPLE = [
  { key: 'A', floor: '#e3b866', body: '#ffbe3d', glow: '#ff9500', pitch: 392 },
  { key: 'B', floor: '#72bccc', body: '#5ee6ff', glow: '#00b4e6', pitch: 523.25 },
  { key: 'C', floor: '#dc8aa2', body: '#ff86ad', glow: '#ff2f72', pitch: 659.25 }
];

/** Cyclic permutation k of a cube point: k = 1 maps a -> b, b -> c, c -> a. */
function perm(p, k) {
  const m = ((k % 3) + 3) % 3;
  if (m === 0) return [p[0], p[1], p[2]];
  if (m === 1) return [p[2], p[0], p[1]];
  return [p[1], p[2], p[0]];
}
const axis = (i) => [0, 1, 2].map((j) => (j === i ? 1 : 0));

// The cube stands on a face: +a is world up. b and c are level, at 45° either
// side of the direction toward the first-view camera (turned by QUARTER
// quarter turns about Y), so the viewer looks into the open corner.
const YAW = (18 * Math.PI) / 180;
const toCam = new Vector3(Math.sin(YAW), 0, Math.cos(YAW));
const UPW = new Vector3(0, 1, 0);
const QUARTER = 0; // of the four quarter turns, the one that shows both of A's flights clear
const rotY = (v, ang) => v.clone().applyAxisAngle(UPW, ang);
const aW = UPW.clone();
let bW = rotY(toCam, Math.PI / 4 + (QUARTER * Math.PI) / 2);
let cW = rotY(toCam, -Math.PI / 4 + (QUARTER * Math.PI) / 2);
if (new Vector3().crossVectors(aW, bW).dot(cW) < 0) [bW, cW] = [cW, bW];
const CUBE = new Matrix4().makeBasis(aW, bW, cW);
const CUBE_Q = new Quaternion().setFromRotationMatrix(CUBE);
const BOX_MID = BOX_LO[1] + BOX_Q / 2;
const CUBE_T = bW.clone().add(cW).multiplyScalar(-BOX_MID).add(new Vector3(0, LIFT - BOX_LO[0], 0));

// ------------------------------------------------------------ the feed eye
// Measured in the real feed through the viewer's test observer (world
// meters): the look target and the camera's distance at the first view.
const TGT = [0.029, 1.324, 0];
const D = 7.463;
const DIR = [0.297, 0.276, 0.914];
const EYE = TGT.map((v, i) => v + DIR[i] * D);

// ------------------------------------------------------------- utilities

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (x) => {
  const t = clamp(x);
  return t * t * (3 - 2 * t);
};
const v3 = (p) => new Vector3(...p);

/** Collects coloured triangles in cube coordinates; one mesh at the end. */
class Paint {
  constructor() {
    this.p = [];
    this.c = [];
  }

  /**
   * Adds a three geometry. `color(n, centroid)` picks each triangle's colour
   * from its (cube) normal; `m` places it in the cube.
   */
  geometry(g, color, m) {
    const geo = (g.index ? g.toNonIndexed() : g).clone();
    if (m) geo.applyMatrix4(m);
    const pos = geo.attributes.position;
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    for (let i = 0; i < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i);
      b.fromBufferAttribute(pos, i + 1);
      c.fromBufferAttribute(pos, i + 2);
      const n = new Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
      if (n.lengthSq() < 1e-14) continue;
      n.normalize();
      const centroid = a.clone().add(b).add(c).multiplyScalar(1 / 3);
      const col = color(n, centroid);
      for (const v of [a, b, c]) {
        this.p.push(v.x, v.y, v.z);
        this.c.push(col.r, col.g, col.b);
      }
    }
  }

  build() {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.c, 3));
    g.computeVertexNormals();
    return g;
  }
}

const col = (hex) => new Color(hex);
const GOLD_C = col(GOLD);
const UNDER = col('#b8b0a2');
const STAIR = col('#fbf8f1');
const STAIR_UNDER = col('#d6d0c4');
const STAIR_SIDE = col('#d9ccb2');

/** The face colour rule: a face facing +axis k is people k's floor. */
function faceColor(n, { trim = [] } = {}) {
  const ax = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)];
  const k = ax.indexOf(Math.max(...ax));
  if (ax[k] < 0.9) return UNDER.clone();
  if (trim.includes(k)) return GOLD_C.clone();
  const sign = [n.x, n.y, n.z][k];
  const tint = col(PEOPLE[k].floor);
  return sign > 0 ? tint : tint.clone().lerp(UNDER, 0.5).multiplyScalar(0.85);
}

/** A slab: box between cube corners lo..hi, its thin sides gold. */
function slab(paint, lo, hi, k) {
  const size = [0, 1, 2].map((i) => hi[i] - lo[i]);
  const thin = size.indexOf(Math.min(...size));
  const g = new BoxGeometry(...size);
  g.translate(...[0, 1, 2].map((i) => (lo[i] + hi[i]) / 2));
  const trim = [0, 1, 2].filter((i) => i !== thin);
  const m = permMatrix(k);
  paint.geometry(g, (n) => faceColor(n, { trim: trim.map((i) => (i + k) % 3) }), m);
}

/** The matrix of perm(., k). */
function permMatrix(k) {
  const e = [0, 1, 2].map((i) => v3(perm(axis(i), k)));
  return new Matrix4().makeBasis(e[0], e[1], e[2]);
}

// ------------------------------------------------------ the stair unit
// Authored for the pair (A, B): A climbs +a moving -b, B climbs +b moving
// -a, on the same zigzag. Lane c in [0, LANE] is A's, [LANE, W] is B's.

function flightShape() {
  // In the shape's 2D plane: x = b, y = a.
  const s = new Shape();
  s.moveTo(H2, H1);
  for (let k = 0; k < N; k += 1) {
    s.lineTo(H2 - k * S, H1 + (k + 1) * S); // riser (faces +b)
    s.lineTo(H2 - (k + 1) * S, H1 + (k + 1) * S); // tread (faces +a)
  }
  const T = 0.1;
  s.lineTo(H1, H2 - T);
  s.lineTo(H2 - T, H1);
  s.lineTo(H2, H1);
  return s;
}

function unitGeometry(paint, stairs, k) {
  const m = permMatrix(k);
  const across = v3(perm([0, 0, 1], k)); // the flight's width axis
  // The flight: the zigzag extruded across both lanes. Shape (x, y) = (b, a), depth along c.
  const flight = new ExtrudeGeometry(flightShape(), { depth: W, bevelEnabled: false, curveSegments: 1 });
  const swap = new Matrix4().set(0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1); // (x, y, z) -> (a = y, b = x, c = z)
  // The brightest thing in the building: near-white, gold on every nosing.
  stairs.geometry(flight, (n) => {
    if (Math.abs(n.dot(across)) > 0.9) return STAIR_SIDE.clone();
    return Math.max(Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)) < 0.9 ? STAIR_UNDER.clone() : STAIR.clone();
  }, m.clone().multiply(swap));
  for (let j = 0; j < N; j += 1) {
    const nose = new BoxGeometry(0.014, 0.014, W);
    nose.translate(H1 + (j + 1) * S - 0.008, H2 - j * S - 0.008, W / 2);
    stairs.geometry(nose, () => GOLD_C.clone(), m);
  }
  // Gold stringers on both sides: the zigzag outlined, so it reads from afar.
  const rim = new Shape();
  const P = 0.02;
  rim.moveTo(H2 + P, H1 - 0.02);
  for (let j = 0; j < N; j += 1) {
    rim.lineTo(H2 + P - j * S, H1 + (j + 1) * S + P);
    rim.lineTo(H2 - (j + 1) * S + P, H1 + (j + 1) * S + P);
  }
  rim.lineTo(H1 - 0.02, H2 + P);
  rim.lineTo(H1 - 0.02, H2 - 0.03);
  for (let j = N - 1; j >= 0; j -= 1) {
    rim.lineTo(H2 - (j + 1) * S - 0.03, H1 + (j + 1) * S - 0.03);
    rim.lineTo(H2 - j * S - 0.03, H1 + (j + 1) * S - 0.03);
  }
  rim.lineTo(H2 - 0.03, H1 - 0.02);
  for (const z of [-0.012, W]) {
    const stringer = new ExtrudeGeometry(rim, { depth: 0.012, bevelEnabled: false, curveSegments: 1 });
    stringer.translate(0, 0, z);
    stairs.geometry(stringer, (n) => GOLD_C.clone().multiplyScalar(Math.abs(n.dot(across)) > 0.9 ? 1 : 0.8), m.clone().multiply(swap));
  }

  // Landings, one at each end of each lane: A's facing +a, B's facing +b.
  slab(paint, [H1 - SLAB, H2, 0], [H1, H2 + LO, LANE], k);
  slab(paint, [H2 - SLAB, H1 - HI, 0], [H2, H1, LANE], k);
  slab(paint, [H2, H1 - SLAB, LANE], [H2 + LO + EXTRA[k], H1, W], k);
  slab(paint, [H1 - HI, H2 - SLAB, LANE], [H1, H2, W], k);
}

function doorway(paint, k) {
  // Wall in the plane b = const, spanning c (width) and a (height).
  // Only as wide as A's lane, so B's head clears it at the top of B's flight.
  const x0 = -0.06;
  const x1 = LANE - 0.006;
  const tall = 0.98;
  const s = new Shape();
  s.moveTo(x0, 0);
  s.lineTo(x1, 0);
  s.lineTo(x1, tall);
  s.lineTo(x0, tall);
  s.lineTo(x0, 0);
  const hole = new Path();
  const r = 0.1;
  const cx = LANE / 2;
  hole.moveTo(cx - r, 0);
  hole.lineTo(cx + r, 0);
  hole.lineTo(cx + r, 0.74);
  hole.absarc(cx, 0.74, r, 0, Math.PI, false);
  hole.lineTo(cx - r, 0);
  s.holes.push(hole);
  const g = new ExtrudeGeometry(s, { depth: SLAB, bevelEnabled: false, curveSegments: 10 });
  // shape (x, y, z) -> (c = x, a = y + H1, b = z + base)
  const base = H2 + 0.12;
  const place = new Matrix4().set(0, 1, 0, H1, 0, 0, 1, base, 1, 0, 0, 0, 0, 0, 0, 1);
  const m = permMatrix(k).multiply(place);
  paint.geometry(g, (n) => faceColor(n, { trim: [(0 + k) % 3, (2 + k) % 3] }), m);
}

// ---------------------------------------------------------- the floor

function tear(u, seed, big = 0.09) {
  return (
    big * (fbm3(u * 1.3, 0.5, seed * 1.7, { octaves: 3, seed }) - 0.5) * 2 +
    0.025 * (fbm3(u * 7, 2.5, seed, { octaves: 3, seed: seed + 5 }) - 0.5) * 2 +
    0.007 * (noise3(u * 33, 4.5, seed, seed + 9) - 0.5) * 2
  );
}

function floorGeometry() {
  const p = [];
  const c = [];
  const TOP = 0.05;
  const n = 260;
  // Just wider than the building's square footprint. Kept tight: every
  // extra meter of footprint pushes the feed's first view further back.
  const half = BOX_Q / 2 + 0.05;
  const phi = Math.atan2(bW.z, bW.x);
  const rad = (th) => {
    const u = Math.abs(Math.cos(th - phi));
    const v = Math.abs(Math.sin(th - phi));
    const sq = half / (u ** 6 + v ** 6) ** (1 / 6);
    return sq + 0.03 + tear(th * 2.1, 4, 0.04);
  };
  const R = half * Math.SQRT2;
  const top = col(TOKEN.groundTop);
  const scorch = col('#2a190e');
  const high = col(TOKEN.highlight);
  const tri = (a, b, d, ca, cb, cd) => {
    p.push(...a, ...b, ...d);
    c.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b, cd.r, cd.g, cd.b);
  };
  const ring = (r, th, y) => [r * Math.cos(th), y, r * Math.sin(th)];
  for (let j = 0; j < n; j += 1) {
    const a = (j / n) * Math.PI * 2;
    const b = ((j + 1) / n) * Math.PI * 2;
    const ra = rad(a);
    const rb = rad(b);
    const shade = (r) => top.clone().multiplyScalar(0.8 + 0.25 * (1 - r / R));
    // Top in rings, a little lighter toward the middle.
    const steps = [0, 0.35, 0.7, 0.9];
    for (let q = 0; q < steps.length - 1; q += 1) {
      const f0 = steps[q];
      const f1 = steps[q + 1];
      tri(ring(ra * f0, a, TOP), ring(rb * f1, b, TOP), ring(ra * f1, a, TOP), shade(ra * f0), shade(rb * f1), shade(ra * f1));
      tri(ring(ra * f0, a, TOP), ring(rb * f0, b, TOP), ring(rb * f1, b, TOP), shade(ra * f0), shade(rb * f0), shade(rb * f1));
    }
    const bands = [
      [0.9, shade(ra * 0.9)],
      [0.955, scorch],
      [0.985, GOLD_C],
      [1, high]
    ];
    for (let q = 0; q < bands.length - 1; q += 1) {
      const [f0, c0] = bands[q];
      const [f1, c1] = bands[q + 1];
      const y = TOP + 0.0006;
      tri(ring(ra * f0, a, y), ring(rb * f1, b, y), ring(ra * f1, a, y), c0, c1, c1);
      tri(ring(ra * f0, a, y), ring(rb * f0, b, y), ring(rb * f1, b, y), c0, c0, c1);
    }
    tri(ring(ra, a, TOP), ring(rb, b, TOP), ring(rb * 0.99, b, 0), GOLD_C, GOLD_C, scorch);
    tri(ring(ra, a, TOP), ring(rb * 0.99, b, 0), ring(ra * 0.99, a, 0), GOLD_C, scorch, scorch);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(p, 3));
  g.setAttribute('color', new Float32BufferAttribute(c, 3));
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------ the people
// Jointed mannequins of light, 0.74 m tall, limbs 1.3 times stout. Every part is its own node in
// cube coordinates: the feet are planted where the footstep plan puts them,
// the legs solved to reach them, the arms swing under the torso.

const SC = 0.74 / 1.7;
const STOUT = 1.3;
const THIGH = 0.42 * SC;
const SHIN = 0.415 * SC;
const ANKLE = 0.065 * SC;
const HIP_X = 0.088 * SC * 1.15;
const HIP_DROP = 0.065 * SC;
const PELVIS_H = 0.4;
const SHOULDER = [0.172 * SC * 1.22, 0.428 * SC, -0.014 * SC];
const UPPER = 0.3 * SC;
const FOOT_W = 0.05;

function ell(rx, ry, rz, c = [0, 0, 0], ws = 14, hs = 10) {
  const g = new SphereGeometry(1, ws, hs);
  g.scale(rx, ry, rz);
  g.translate(...c);
  g.deleteAttribute('uv');
  return g;
}

function limb(a, b, ra, rb, radial = 10) {
  const A = v3(a);
  const B = v3(b);
  const L = A.distanceTo(B);
  const pts = [];
  const cap = 4;
  for (let i = 0; i <= cap; i += 1) {
    const ang = -Math.PI / 2 + (i / cap) * (Math.PI / 2);
    pts.push(new Vector2(Math.max(1e-4, ra * Math.cos(ang)), ra * Math.sin(ang)));
  }
  for (let i = 0; i <= cap; i += 1) {
    const ang = (i / cap) * (Math.PI / 2);
    pts.push(new Vector2(Math.max(1e-4, rb * Math.cos(ang)), L + rb * Math.sin(ang)));
  }
  const g = new LatheGeometry(pts, radial);
  g.deleteAttribute('uv');
  const dir = B.clone().sub(A).normalize();
  const q = dir.y < -0.9999 ? new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI) : new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir);
  g.applyQuaternion(q);
  g.translate(A.x, A.y, A.z);
  return g;
}

const merge = (list) => mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)));

function figureMeshes() {
  const s = SC;
  const parts = {
    torso: merge([
      ell(0.15 * s, 0.11 * s, 0.1 * s, [0, -0.03 * s, 0]),
      ell(0.12 * s, 0.13 * s, 0.09 * s, [0, 0.15 * s, 0.006 * s]),
      ell(0.152 * s, 0.165 * s, 0.104 * s, [0, 0.345 * s, 0.012 * s]),
      limb([0.03 * s, 0.46 * s, -0.008 * s], [0.165 * s, 0.43 * s, -0.014 * s], 0.034 * s, 0.036 * s),
      limb([-0.03 * s, 0.46 * s, -0.008 * s], [-0.165 * s, 0.43 * s, -0.014 * s], 0.034 * s, 0.036 * s),
      limb([0, 0.46 * s, -0.01 * s], [0, 0.57 * s, 0], 0.05 * s, 0.045 * s),
      ell(0.079 * s, 0.113 * s, 0.096 * s, [0, 0.64 * s, 0.01 * s]),
      ell(0.058 * s, 0.055 * s, 0.066 * s, [0, 0.585 * s, 0.035 * s])
    ]),
    upper: merge([ell(0.054 * s, 0.054 * s, 0.056 * s, [0, -0.012 * s, 0]), limb([0, -0.01 * s, 0], [0, -UPPER, 0], 0.048 * s, 0.037 * s)]),
    fore: merge([limb([0, 0, 0], [0, -0.25 * s, 0], 0.037 * s, 0.027 * s), limb([0, -0.25 * s, 0], [0, -0.4 * s, 0.006 * s], 0.026 * s, 0.019 * s)]),
    thigh: limb([0, 0, 0], [0, -THIGH, 0], 0.078 * s, 0.05 * s),
    shin: limb([0, 0, 0], [0, -SHIN, 0], 0.052 * s, 0.034 * s),
    foot: merge([ell(0.037 * s, 0.037 * s, 0.04 * s), limb([0, -0.03 * s, -0.045 * s], [0, -0.038 * s, 0.16 * s], 0.035 * s, 0.027 * s)])
  };
  // Stouter, not longer: limbs widen across their length; the foot keeps its length.
  for (const [name, g] of Object.entries(parts)) {
    if (name === 'foot') g.scale(STOUT, STOUT, 1);
    else if (name === 'torso') g.scale(1.22, 1, STOUT);
    else g.scale(STOUT, 1, STOUT);
  }
  return parts;
}

/** Rotation taking local (X right, Y up, Z forward) to cube axes. */
function basisQ(right, up, fwd) {
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, up, fwd));
}
const DOWN = new Vector3(0, -1, 0);
const segQ = (dir) => new Quaternion().setFromUnitVectors(DOWN, dir.clone().normalize());

function solveKnee(hip, ankle, fwd) {
  const d0 = ankle.clone().sub(hip);
  const u = d0.clone().normalize();
  const d = clamp(d0.length(), 0.02, (THIGH + SHIN) * 0.999);
  const cosA = clamp((THIGH * THIGH + d * d - SHIN * SHIN) / (2 * THIGH * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const p = fwd.clone().addScaledVector(u, -fwd.dot(u)).normalize();
  const knee = hip.clone().addScaledVector(u, THIGH * cosA).addScaledVector(p, THIGH * sinA);
  const end = hip.clone().addScaledVector(u, d);
  return { knee, end };
}

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;

/**
 * A walker's frame: origin O at the bottom riser on the lane centre, `f`
 * the out direction (up the flight), `u` its people's up; all cube axes.
 */
function frame(O, f, u) {
  const F = v3(f);
  const U = v3(u);
  const R = new Vector3().crossVectors(U, F);
  return {
    U,
    F,
    R,
    at: (x, z, y) => v3(O).addScaledVector(F, x).addScaledVector(R, z).addScaledVector(U, y),
    dir: (th) => F.clone().multiplyScalar(Math.cos(th)).addScaledVector(R, Math.sin(th)),
    right: (th) => F.clone().multiplyScalar(-Math.sin(th)).addScaledVector(R, Math.cos(th))
  };
}

/**
 * The out-and-back footstep plan along one lane: [{x, y, th}] in the walker
 * frame. One step per tread, toes short of the next riser going up, heels
 * clear of the nosing going down; turns in place at both ends.
 */
function plan({ dLo, dHi, nLo, nHi, nHiB, nLoB, turn }) {
  const out = [];
  const xT = (N - 2) * S + 0.035;
  const xEnd = (N - 1) * S + dHi;
  const xb = (N - 1) * S + 0.075;
  for (let j = 1; j <= nLo; j += 1) out.push({ x: -dLo + (j * (dLo - 0.085)) / nLo, y: 0, th: 0 });
  for (let k = 0; k < N - 1; k += 1) out.push({ x: k * S + 0.035, y: (k + 1) * S, th: 0 });
  for (let j = 1; j <= nHi; j += 1) out.push({ x: xT + (j * (xEnd - xT)) / nHi, y: H, th: 0 });
  for (let j = 1; j <= turn; j += 1) out.push({ x: xEnd, y: H, th: (j * Math.PI) / turn });
  for (let j = 1; j <= nHiB; j += 1) out.push({ x: xEnd - (j * (xEnd - xb)) / nHiB, y: H, th: Math.PI });
  for (let k = N - 2; k >= 0; k -= 1) out.push({ x: k * S + 0.075, y: (k + 1) * S, th: Math.PI });
  for (let j = 1; j <= nLoB; j += 1) out.push({ x: -0.025 - (j * (dLo - 0.025)) / nLoB, y: 0, th: Math.PI });
  for (let j = 1; j <= turn; j += 1) out.push({ x: -dLo, y: 0, th: Math.PI + (j * Math.PI) / turn });
  return out;
}

/** Feet, pelvis and arms of a walker at time t (cube coordinates). */
function walkerPose(w, t) {
  const M = w.holds.length;
  const tau = LOOP / M;
  const u = (((t / tau + w.shift) % M) + M) % M;
  const k = Math.floor(u);
  const p = u - k;
  const at = (i) => w.holds[((i % M) + M) % M];
  const place = (h, side) => {
    const lateral = side * FOOT_W;
    return { pos: w.fr.at(h.x, 0, h.y).addScaledVector(w.fr.right(h.th), lateral), th: h.th, y: h.y };
  };
  const sideOf = (i) => ((((i % M) + M) % M) % 2 === 0 ? -1 : 1);
  const from = place(at(k - 2), sideOf(k));
  const to = place(at(k), sideOf(k));
  const stance = place(at(k - 1), sideOf(k - 1));
  const q = smooth((p - 0.08) / 0.78);
  const dy = to.y - from.y;
  // Climbing, the foot lifts before it travels; descending, it travels first.
  const qh = dy > 0.001 ? smooth((q - 0.3) / 0.7) : dy < -0.001 ? smooth(q / 0.6) : q;
  const swingPos = from.pos.clone().lerp(to.pos, qh);
  const rise = dy > 0.001 ? smooth(q / 0.45) : dy < -0.001 ? smooth((q - 0.4) / 0.6) : q;
  // Undo the straight-line height, then use the shaped one plus a lift.
  swingPos.addScaledVector(w.fr.U, -dy * qh + dy * rise + 0.03 * Math.sin(Math.PI * q));
  const swing = { pos: swingPos, th: lerpAngle(from.th, to.th, q) };
  const feet = sideOf(k) < 0 ? { L: swing, R: stance } : { L: stance, R: swing };

  // Pelvis: from between the old pair to between the new pair.
  const midA = from.pos.clone().add(stance.pos).multiplyScalar(0.5);
  const midB = stance.pos.clone().add(to.pos).multiplyScalar(0.5);
  const centre = midA.lerp(midB, p);
  const th = lerpAngle(stance.th, swing.th, 0.5);
  const fwd = w.fr.dir(th);
  const right = w.fr.right(th);
  const U = w.fr.U;
  const footY = (f) => f.pos.clone().sub(w.fr.at(0, 0, 0)).dot(U);
  const avgY = (footY(feet.L) + footY(feet.R)) / 2;
  let py = avgY + PELVIS_H + 0.006 * Math.cos(4 * Math.PI * p);
  // Never ask a leg to reach further than it can.
  const centreFlat = centre.clone().addScaledVector(U, -centre.clone().sub(w.fr.at(0, 0, 0)).dot(U));
  for (const [side, f] of [[-1, feet.L], [1, feet.R]]) {
    const hipFlat = centreFlat.clone().addScaledVector(right, side * HIP_X);
    const ankle = f.pos.clone().addScaledVector(U, ANKLE);
    const ankleFlat = ankle.clone().addScaledVector(U, -ankle.clone().sub(w.fr.at(0, 0, 0)).dot(U));
    const hd = hipFlat.distanceTo(ankleFlat);
    const reach = (THIGH + SHIN) * 0.985;
    const dv = Math.sqrt(Math.max(0, reach * reach - hd * hd));
    py = Math.min(py, footY(f) + ANKLE + dv + HIP_DROP);
  }
  const pelvis = centreFlat.addScaledVector(U, py);
  const lean = clamp(Math.abs(at(k).y - at(k - 2).y) * 2.2, 0, 0.16);
  const upT = U.clone().multiplyScalar(Math.cos(lean)).addScaledVector(fwd, Math.sin(lean));
  const fwdT = fwd.clone().multiplyScalar(Math.cos(lean)).addScaledVector(U, -Math.sin(lean));
  return { pelvis, torsoQ: basisQ(right, upT, fwdT), right, fwd, U, feet, swingArm: (side) => {
    const opp = side < 0 ? feet.R : feet.L;
    return clamp(opp.pos.clone().sub(pelvis).dot(fwd) * 4, -0.45, 0.45);
  } };
}

/** Joint transforms of a pose: every node's [translation, quaternion]. */
function solvePose(pose) {
  const { pelvis, torsoQ, right, fwd, U, feet } = pose;
  const out = { torso: [pelvis, torsoQ] };
  const hipBase = pelvis.clone().addScaledVector(U, -HIP_DROP);
  for (const [name, side] of [['L', -1], ['R', 1]]) {
    const f = feet[name];
    const hip = hipBase.clone().addScaledVector(right, side * HIP_X);
    const ankle = f.pos.clone().addScaledVector(U, ANKLE);
    const footFwd = pose.fwdOf ? pose.fwdOf(f) : fwd;
    const { knee, end } = solveKnee(hip, ankle, f.kneeDir ?? footFwd);
    out[`thigh${name}`] = [hip, segQ(knee.clone().sub(hip))];
    out[`shin${name}`] = [knee, segQ(end.clone().sub(knee))];
    const fr = f.fwd ?? footFwd;
    out[`foot${name}`] = [ankle, basisQ(new Vector3().crossVectors(U, fr), U, fr)];
  }
  return out;
}

const NAMES = ['torso', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR'];

function writeFigure(glb, root, meshes, name, frames, armFrames) {
  const nodes = {};
  for (const part of NAMES) {
    const [t0, q0] = frames[0][part];
    const mesh = meshes[part.replace(/[LR]$/, '')];
    nodes[part] = glb.node({ name: `${name}-${part}`, mesh, translation: t0.toArray(), rotation: q0.toArray(), parent: root });
  }
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? -1 : 1;
    const up = glb.node({
      name: `${name}-upperArm${side}`,
      mesh: meshes.upper,
      translation: [sx * SHOULDER[0], SHOULDER[1], SHOULDER[2]],
      rotation: armFrames[0][side][0],
      parent: nodes.torso
    });
    const fore = glb.node({ name: `${name}-foreArm${side}`, mesh: meshes.fore, translation: [0, -UPPER, 0], rotation: armFrames[0][side][1], parent: up });
    if (frames.length > 1) {
      glb.animate(up, 'rotation', TIMES, continuous(armFrames.map((f) => f[side][0])));
      glb.animate(fore, 'rotation', TIMES, continuous(armFrames.map((f) => f[side][1])));
    }
  }
  if (frames.length > 1) {
    for (const part of NAMES) {
      glb.animate(nodes[part], 'translation', TIMES, frames.flatMap((f) => f[part][0].toArray()));
      glb.animate(nodes[part], 'rotation', TIMES, continuous(frames.map((f) => f[part][1].toArray())));
    }
  }
}

function continuous(quats) {
  const values = [];
  let prev = null;
  for (let q of quats) {
    if (prev && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0) q = q.map((v) => -v);
    values.push(...q);
    prev = q;
  }
  return values;
}

const TIMES = sample(LOOP, FPS, () => []).times;

const armQ = (pitch, roll, bend) => [
  new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), roll).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), pitch)).toArray(),
  new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), bend).toArray()
];

// The walkers: unit k, role 'X' (the people k, climbing -perm(b)) or 'Y'
// (people k+1, climbing -perm(a)), and a footstep plan.
// Cadences: A 3, B 4, C 5 steps every 2 s (18, 24, 30 steps per loop).
// A turns on the top and bottom treads; B and C step off onto the landings.
const GAITS = {
  0: { dLo: 0.09, dHi: 0.09, nLo: 0, nHi: 0, nHiB: 0, nLoB: 0, turn: 3 },
  1: { dLo: 0.26, dHi: 0.22, nLo: 2, nHi: 1, nHiB: 1, nLoB: 2, turn: 3 },
  2: { dLo: 0.32, dHi: 0.26, nLo: 3, nHi: 3, nHiB: 3, nLoB: 3, turn: 3 }
};

function walkerFrame(unit, role) {
  if (role === 'X') {
    // People `unit`: up perm(a), out = -perm(b), lane centre c = LANE / 2.
    return { people: unit, fr: frame(perm([H1, H2, LANE / 2], unit), perm([0, -1, 0], unit), perm([1, 0, 0], unit)) };
  }
  return { people: (unit + 1) % 3, fr: frame(perm([H2, H1, LANE * 1.5], unit), perm([-1, 0, 0], unit), perm([0, 1, 0], unit)) };
}

/** Whether a walker is on the treads (mid-flight) at time t. */
function onFlight(w, t) {
  const M = w.holds.length;
  const k = Math.floor((((t / (LOOP / M) + w.shift) % M) + M) % M);
  const h = w.holds[k];
  const h2 = w.holds[(k + M - 1) % M];
  return h.y > 0.05 && h.y < H - 0.05 && h2.y > 0.05 && h2.y < H - 0.05;
}

// Each shared flight has a moment both its peoples are on it at once.
const PASS = [2.0, 6.0, 10.0];

function makeWalkers() {
  const list = [];
  for (let unit = 0; unit < 3; unit += 1) {
    const pair = ['X', 'Y'].map((role) => {
      const { people, fr } = walkerFrame(unit, role);
      const holds = plan(GAITS[people]);
      return { unit, role, people, fr, holds, shift: 0 };
    });
    // Choose step offsets so that both are mid-flight, going opposite ways, at PASS[unit].
    const tp = PASS[unit];
    for (const w of pair) {
      const M = w.holds.length;
      let best = 0;
      for (let s = 0; s < M; s += 1) {
        w.shift = s;
        const k = Math.floor(((tp / (LOOP / M) + s) % M + M) % M);
        const h = w.holds[k];
        // X climbs (out) and Y climbs too: both out-going, mid-flight.
        if (onFlight(w, tp) && h.th === 0 && h.y > S * 1.5) {
          best = s;
          break;
        }
      }
      w.shift = best;
    }
    list.push(...pair);
  }
  return list;
}

// Sitters: one per people, each on the far edge of a landing nobody turns
// on, legs swinging over what is a wall (or the open air) for the others.
// `swings` per loop, whole numbers. Cube coordinates.
const SITTERS = [
  // A on its high landing of the (A, B) flight, facing -b.
  { people: 0, up: [1, 0, 0], fwd: [0, -1, 0], seat: [H2, H1 - HI + 0.04, LANE / 2], swings: 3 },
  // B on the top edge of its low landing of the same flight: a wall for A, facing world up.
  { people: 1, up: [0, 1, 0], fwd: [1, 0, 0], seat: [H2 + LO + EXTRA[0] - 0.04, H1, LANE * 1.5], swings: 4 },
  // C at the far end of its low landing of the (B, C) flight, facing +b.
  { people: 2, up: [0, 0, 1], fwd: [0, 1, 0], seat: [LANE * 1.5, H2 + LO + EXTRA[1] - 0.04, H1], swings: 5 }
];

function sitterPose(t, spec) {
  const U = v3(spec.up);
  const fwd = v3(spec.fwd);
  const swings = spec.swings;
  const right = new Vector3().crossVectors(U, fwd);
  const seat = v3(spec.seat);
  const pelvis = seat.clone().addScaledVector(U, 0.06).addScaledVector(fwd, -0.03);
  const feet = {};
  for (const [n, side] of [['L', -1], ['R', 1]]) {
    const kick = 0.06 * Math.sin((2 * Math.PI * swings * t) / LOOP + (side > 0 ? Math.PI : 0));
    const p = seat.clone().addScaledVector(fwd, 0.2 + kick).addScaledVector(U, -0.29 + Math.max(0, kick) * 0.5).addScaledVector(right, side * 0.06);
    feet[n] = { pos: p, fwd: fwd.clone().addScaledVector(U, -0.6).normalize(), kneeDir: fwd.clone().addScaledVector(U, 0.8).normalize() };
  }
  const torsoQ = basisQ(right, U.clone().addScaledVector(fwd, -0.12).normalize(), fwd.clone().addScaledVector(U, 0.12).normalize());
  return { pelvis, torsoQ, right, fwd, U, feet };
}

function sitterArms(t) {
  const sway = 0.08 * Math.sin((2 * Math.PI * t * 2) / LOOP);
  return { L: armQ(-0.35 + sway, -0.1, -0.5), R: armQ(-0.35 - sway, 0.1, -0.5) };
}

// ------------------------------------------------------------- the sound

function sound(walkers) {
  const out = track(LOOP);
  // A quiet warm chord, whole cycles per loop so it joins.
  const chord = [110, 138.59, 164.81, 220];
  add(out, 0, LOOP, (t) => chord.reduce((sum, hz, i) => sum + (0.02 / (i + 1)) * sine(hz)(t) * (0.7 + 0.3 * Math.sin((2 * Math.PI * (i + 1) * t) / LOOP)), 0));
  const hiss = track(LOOP);
  const random = noise(5);
  for (let i = 0; i < hiss.length; i += 1) hiss[i] = random() * 0.006;
  lowpass(hiss, 300);
  for (let i = 0; i < out.length; i += 1) out[i] += hiss[i];
  // Woody ticks: one per footfall, each people its own pitch.
  for (const w of walkers) {
    const M = w.holds.length;
    const tau = LOOP / M;
    const hz = PEOPLE[w.people].pitch;
    const click = noise(11 + w.unit * 3 + (w.role === 'X' ? 0 : 1));
    for (let k = 0; k < M; k += 1) {
      const at = ((((k - w.shift + 0.86) * tau) % LOOP) + LOOP) % LOOP;
      const wood = (t) => sine(hz)(t) + 0.45 * sine(hz * 2.76)(t) + 0.3 * click() * Math.exp(-t / 0.004);
      add(out, at, 0.18, wood, (t) => 0.09 * pluck(0.002, 0.03)(t));
    }
  }
  lowpass(out, 3200);
  return toWav(normalize(out, 0.6));
}

// ------------------------------------------------------------- the build

export async function build() {
  const glb = new Glb();
  glb.provenance({
    holoim: {
      authored: 'synthetic',
      author: meta.submittedBy,
      title: meta.name,
      note: 'Three peoples, three gravities at right angles, one building standing on a face. Shared stairs: one people’s treads are another’s risers.'
    }
  });
  const root = glb.node({ name: 'EveryonesDown' });

  // The floor slab (world).
  const floorInk = glb.material({ name: 'Floor', roughness: 1, emissive: '#1a120b', emissiveStrength: 1 });
  glb.node({ name: 'Floor', mesh: glb.mesh('Floor', floorGeometry(), floorInk), parent: root });

  // The building, in cube coordinates.
  const cube = glb.node({ name: 'Cube', translation: CUBE_T.toArray(), rotation: CUBE_Q.toArray(), parent: root });
  const paint = new Paint();
  const stairs = new Paint();
  for (let k = 0; k < 3; k += 1) unitGeometry(paint, stairs, k);
  // One doorway, on C's low landing: a door for C (and B), a hatch for A.
  doorway(paint, 2);
  const plaster = glb.material({ name: 'Plaster', roughness: 0.85, emissive: '#2c2822', emissiveStrength: 1 });
  glb.node({ name: 'Building', mesh: glb.mesh('Building', paint.build(), plaster), parent: cube });
  // The stairs: the brightest surfaces in the building.
  const stairInk = glb.material({ name: 'Stairs', roughness: 0.7, emissive: '#6e685c', emissiveStrength: 1 });
  glb.node({ name: 'Stairs', mesh: glb.mesh('Stairs', stairs.build(), stairInk), parent: cube });

  // The people.
  const geo = figureMeshes();
  const meshes = PEOPLE.map((pp) => {
    const ink = glb.material({ name: `Body${pp.key}`, color: pp.body, emissive: pp.glow, emissiveStrength: 1.15, roughness: 0.5 });
    return Object.fromEntries(Object.entries(geo).map(([part, g]) => [part, glb.mesh(`fig${pp.key}-${part}`, g, ink)]));
  });
  const walkers = makeWalkers();
  walkers.forEach((w, i) => {
    const frames = [];
    const arms = [];
    for (const t of TIMES) {
      const pose = walkerPose(w, t);
      frames.push(solvePose(pose));
      const sl = pose.swingArm(-1);
      const sr = pose.swingArm(1);
      arms.push({ L: armQ(-sl, -0.08, -0.25 - Math.max(0, sl) * 0.4), R: armQ(-sr, 0.08, -0.25 - Math.max(0, sr) * 0.4) });
    }
    writeFigure(glb, cube, meshes[w.people], `fig${PEOPLE[w.people].key}-walker${i}`, frames, arms);
  });
  // The sitters.
  for (const spec of SITTERS) {
    const frames = TIMES.map((t) => solvePose(sitterPose(t, spec)));
    writeFigure(glb, cube, meshes[spec.people], `fig${PEOPLE[spec.people].key}-sitter`, frames, TIMES.map(sitterArms));
  }


  glb.audio(sound(walkers));
  return glb;
}

const turn = (deg) => {
  const r = (deg * Math.PI) / 180;
  const dx = EYE[0] - TGT[0];
  const dz = EYE[2] - TGT[2];
  return [TGT[0] + dx * Math.cos(r) + dz * Math.sin(r), EYE[1], TGT[2] - dx * Math.sin(r) + dz * Math.cos(r)];
};

export const tiles = [
  { label: 'feed', cam: EYE, look: TGT, fov: 38, t: 0 },
  { label: 'feed', cam: EYE, look: TGT, fov: 38, t: PASS[0] },
  { label: 'feed 2x A+B', cam: EYE, look: TGT, fov: 19, t: PASS[0] },
  { label: 'feed 2x C+A', cam: EYE, look: TGT, fov: 19, t: PASS[2] },
  { label: 'turn 90', cam: turn(90), look: TGT, fov: 38, t: 4 },
  { label: 'turn 180', cam: turn(180), look: TGT, fov: 38, t: 6 },
  { label: 'turn 270', cam: turn(270), look: TGT, fov: 38, t: 8 },
  { view: 'top', t: 6 },
  { label: 'close 1.6 m', cam: TGT.map((v, i) => v + [0.38, 0.4, 1.5][i]), look: TGT, fov: 45, t: PASS[0] + 0.3 }
];
