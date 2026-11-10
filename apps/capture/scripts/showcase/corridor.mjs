import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  Euler,
  ExtrudeGeometry,
  LatheGeometry,
  Matrix4,
  Object3D,
  Path,
  Quaternion,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { SAMPLE_RATE, add, lowpass, noise, normalize, pluck, toWav, track } from './lib/audio.mjs';
import { renderLabels } from './lib/browser.mjs';
import { Glb } from './lib/glb.mjs';
import { addLabel, fbm3, noise3, quat } from './lib/parts.mjs';
import { T } from './lib/tokens.mjs';

// "The corridor is a lie": a forced-perspective gallery in the manner of the
// baroque trick colonnades. Through one arch the first view sees a vaulted
// colonnade about 36 m long running down to a sunlit court with a statue.
// It is a wedge 1.7 m deep. Every vertex of the long virtual corridor is
// slid along its ray from the designed eye, so from that eye nothing has
// moved, and from anywhere else the lie is plain: columns shrinking from
// two meters to half of one, a rising floor, a dropping vault, a statue the
// size of a cat. And a real cat, which nobody squeezed, walks in and becomes
// a tiger.

export const meta = {
  slug: 'the-corridor-is-a-lie',
  name: 'The corridor is a lie',
  submittedBy: 'Claude (agent-authored)'
};

const LOOP = 18;
const FPS = 30;
const TOP = 0.03; // top of the floor slab
const Y0 = 0.1; // threshold height (top of the low step)

// The designed eye and the point it looks at, in root-local meters (the
// root is turned +18 degrees about Y so local +Z faces the feed camera).
const EYE = new Vector3(0, 4.69, 9.54);
const TGT = new Vector3(0, 1.85, -0.36);
const D = EYE.distanceTo(TGT);

// The virtual corridor: its axis is the ray from the eye through the middle
// of the arch, so it descends at SL (rise over horizontal run) away from us.
const ARCH_W = 0.75; // half width of the arch opening
const ARCH_SPRING = 1.75; // y where the round head starts
const AXIS_H = 1.2; // the axis height above the virtual floor (arch middle)
const SL = (EYE.y - (Y0 + AXIS_H)) / EYE.z;
const LEN = 38; // virtual length along the floor, entrance to court
const LH = LEN / Math.hypot(1, SL); // the same, horizontally
const DEPTH = 1.7; // where the virtual far end lands, real meters behind the entrance
const D0 = EYE.z;
// 1/d' = A + B/d keeps d = D0 fixed and sends D0 + LH to D0 + DEPTH.
const SQ_B = (DEPTH * (D0 + LH)) / (LH * (D0 + DEPTH));
const SQ_A = (1 - SQ_B) / D0;
const FAR_K = (D0 + DEPTH) / (D0 + LH);

const BAY = (LH - 2.0) / 16; // 17 columns a side, 16 bays
const COL_S = Array.from({ length: 17 }, (_, i) => 1.0 + i * BAY);
const COL_U = 0.9; // column rows at u = +-0.9
const STYLO = 1.1; // half width of the corridor floor
const ENT_H0 = 2.3; // entablature bottom (column top)
const SPRING = 2.5; // vault spring
const VAULT_W = 0.65;
const VAULT_RISE = 0.45;
const VAULT_R = (VAULT_W * VAULT_W + VAULT_RISE * VAULT_RISE) / (2 * VAULT_RISE);
const VAULT_HC = SPRING + VAULT_RISE - VAULT_R;
const VAULT_TH = Math.asin(VAULT_W / VAULT_R);
const COURT_S = LH + 0.25; // court floor starts behind the end wall
const HEDGE_S = LH + 26; // back hedge
const SKY_S = HEDGE_S + 3;
const COURT_U = 1.7;
const STATUE_S = LH + 3.5;
const STATUE_H = 1.9; // virtual, with the plinth
const PLINTH_H = 0.45;
const STATUE_U = 0.3; // a little right of the axis, so the cat can sit beside it

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;
const frac = (x) => x - Math.floor(x);
const TAU = Math.PI * 2;

/** The squeeze: slides a virtual point along its ray from the eye. */
function squeezeK(z) {
  const d = EYE.z - z;
  const dp = 1 / (SQ_A + SQ_B / d);
  return dp / d;
}
function squeeze(v) {
  const k = squeezeK(v.z);
  return v.sub(EYE).multiplyScalar(k).add(EYE);
}
/** Corridor frame (u across, h above the virtual floor, z = -s) to the virtual world. */
function toVirtual(v) {
  v.y += Y0 + SL * v.z;
  return v;
}
function corridorToReal(u, h, s) {
  return squeeze(toVirtual(new Vector3(u, h, -s)));
}
/** Real floor height at real z (the threshold step is flat, the squeezed floor rises). */
function floorY(z) {
  if (z >= 0) return Y0;
  const dp = EYE.z - z;
  const d = SQ_B / (1 / dp - SQ_A);
  return corridorToReal(0, 0, d - D0).y;
}

const col = (hex) => new Color(hex);
const mul = (c, k) => [Math.min(1, c.r * k), Math.min(1, c.g * k), Math.min(1, c.b * k)];
const mixc = (a, b, t) => new Color(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t);

/** Vertex-painted triangles, built in some frame and mapped to real space at the end. */
class Bake {
  constructor() {
    this.p = [];
    this.c = [];
  }
  tri(a, b, c, paint) {
    const n = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a)).normalize();
    for (const v of [a, b, c]) {
      this.p.push(v.x, v.y, v.z);
      this.c.push(...paint(v.x, v.y, v.z, n.x, n.y, n.z));
    }
  }
  quad(a, b, c, d, paint) {
    this.tri(a, b, c, paint);
    this.tri(a, c, d, paint);
  }
  /** A three geometry, transformed by `matrix`, painted per vertex from its normals. */
  geo(g, paint, matrix) {
    let geom = g;
    if (!geom.attributes.normal) geom.computeVertexNormals();
    if (matrix) geom.applyMatrix4(matrix);
    if (geom.index) geom = geom.toNonIndexed();
    const pos = geom.attributes.position;
    const nor = geom.attributes.normal;
    for (let i = 0; i < pos.count; i += 1) {
      this.p.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      this.c.push(...paint(pos.getX(i), pos.getY(i), pos.getZ(i), nor.getX(i), nor.getY(i), nor.getZ(i)));
    }
  }
  build(map) {
    const out = new Float32Array(this.p.length);
    const v = new Vector3();
    for (let i = 0; i < this.p.length; i += 3) {
      v.set(this.p[i], this.p[i + 1], this.p[i + 2]);
      if (map) map(v);
      out[i] = v.x;
      out[i + 1] = v.y;
      out[i + 2] = v.z;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(out, 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.c), 3));
    return g;
  }
}

const V = (x, y, z) => new Vector3(x, y, z);
const at = (x, y, z) => new Matrix4().makeTranslation(x, y, z);

// ---------------------------------------------------------------------------
// Painted light inside the corridor (corridor frame; s = -z).

/** General brightness along the hall: a little light at the door, dim middle, the court's glow at the end. */
const amb = (s) => 0.6 + 0.18 * (1 - smooth(0, 7, s)) + 0.3 * smooth(LH - 12, LH, s);
/** Sun from the right, through the gaps of the right-hand row: 0 in a column's shadow, 1 in a sunlit band. */
function sunBand(u, s) {
  const q = frac((s - COL_S[0] + 0.55 * (COL_U - u)) / BAY);
  const dist = Math.min(q, 1 - q) * BAY;
  return smooth(0.2, 0.36, dist);
}

const STONE = col('#e6dac3');
const STONE_WARM = col('#efdcb4');
const TILE_A = col('#e4d3ae');
const TILE_B = col('#7e4b36');
const COFFER = col('#dccbaa');
const RECESS = col('#6f5843');
const ROOF = col('#8a4b34');

function columnPaint(x, y, z, nx, ny, nz) {
  const s = -z;
  const sun = 0.58 + 0.5 * Math.max(0, nx) + 0.1 * Math.max(0, nz) - 0.1 * Math.max(0, -nx);
  const rise = 0.86 + 0.14 * smooth(0, 2.2, y);
  return mul(STONE, amb(s) * sun * rise * (ny < -0.5 ? 0.7 : 1));
}

function floorGeometry(bake) {
  const TILE = 0.55;
  const across = Math.round((2 * STYLO) / TILE);
  const along = Math.ceil(LH / TILE);
  const SUB = 6;
  for (let i = 0; i < across; i += 1) {
    for (let j = 0; j < along; j += 1) {
      const base = (i + j) % 2 === 0 ? TILE_A : TILE_B;
      const u0 = -STYLO + i * TILE;
      const s0 = j * TILE;
      const s1 = Math.min(LH, s0 + TILE);
      const vary = 0.94 + 0.1 * noise3(i * 1.7, j * 1.3, 0.5, 5);
      const paint = (x, y, z) => {
        const s = -z;
        const lit = 0.5 + 0.62 * sunBand(x, s);
        return mul(base, amb(s) * lit * vary);
      };
      for (let a = 0; a < 2; a += 1) {
        for (let b = 0; b < SUB; b += 1) {
          const ua = u0 + (a * TILE) / 2;
          const ub = ua + TILE / 2;
          const sa = s0 + ((s1 - s0) * b) / SUB;
          const sb = s0 + ((s1 - s0) * (b + 1)) / SUB;
          bake.quad(V(ua, 0, -sa), V(ub, 0, -sa), V(ub, 0, -sb), V(ua, 0, -sb), paint);
        }
      }
    }
  }
}

function columnsGeometry(bake) {
  const profile = [
    [0.001, 0.08], [0.25, 0.08], [0.25, 0.12], [0.22, 0.15], [0.22, 0.18], [0.2, 0.22],
    [0.19, 0.3], [0.18, 1.2], [0.17, 1.95], [0.185, 1.98], [0.2, 2.04], [0.235, 2.11],
    [0.25, 2.17], [0.001, 2.17]
  ].map(([r, y]) => new Vector2(r, y));
  for (const s of COL_S) {
    for (const u of [-COL_U, COL_U]) {
      const m = at(u, 0, -s);
      bake.geo(new LatheGeometry(profile, 14), columnPaint, m);
      const plinth = new BoxGeometry(0.58, 0.08, 0.58);
      plinth.translate(0, 0.04, 0);
      bake.geo(plinth, columnPaint, m);
      const abacus = new BoxGeometry(0.58, 0.13, 0.58);
      abacus.translate(0, 2.235, 0);
      bake.geo(abacus, columnPaint, m);
    }
  }
}

function entablatureGeometry(bake) {
  const s0 = 0.15;
  const n = 32;
  for (const side of [-1, 1]) {
    const ui = side * 0.55;
    const uo = side * 1.25;
    const paint = (x, y, z, nx, ny) => {
      const s = -z;
      let k = 0.85;
      if (ny < -0.5) k = 0.52;
      else if (ny > 0.5) k = 0.9;
      else if (Math.abs(x) < 0.9) k = side < 0 ? 0.98 : 0.7; // inner faces
      else k = side > 0 ? 0.95 : 0.62;
      return mul(STONE_WARM, amb(s) * k);
    };
    for (let i = 0; i < n; i += 1) {
      const a = -lerp(s0, LH, i / n);
      const b = -lerp(s0, LH, (i + 1) / n);
      bake.quad(V(ui, ENT_H0, a), V(uo, ENT_H0, a), V(uo, ENT_H0, b), V(ui, ENT_H0, b), paint); // soffit
      bake.quad(V(ui, ENT_H0, a), V(ui, ENT_H0, b), V(ui, SPRING, b), V(ui, SPRING, a), paint); // inner face
      bake.quad(V(uo, ENT_H0, a), V(uo, SPRING + 0.05, a), V(uo, SPRING + 0.05, b), V(uo, ENT_H0, b), paint); // outer
      bake.quad(V(ui, SPRING, a), V(ui, SPRING, b), V(uo, SPRING + 0.05, b), V(uo, SPRING + 0.05, a), paint); // top
      // a fascia line along the inner face
      bake.quad(V(ui - side * 0.03, 2.4, a), V(ui - side * 0.03, 2.4, b), V(ui - side * 0.03, 2.44, b), V(ui - side * 0.03, 2.44, a), (x, y, z) => mul(STONE_WARM, amb(-z) * 1.05));
    }
  }
}

function vaultPoint(th, rho, s) {
  return V(rho * Math.sin(th), VAULT_HC + rho * Math.cos(th), -s);
}

function vaultGeometry(bake) {
  const shadeAt = (x, s) => {
    const crown = clamp(1 - Math.abs(x) / VAULT_W);
    return amb(s) * (0.98 - 0.42 * crown);
  };
  const paintFrame = (x, y, z) => mul(COFFER, shadeAt(x, -z));
  const paintRecess = (x, y, z) => mul(RECESS, shadeAt(x, -z) * 1.05);
  const paintRib = (x, y, z) => mul(STONE, shadeAt(x, -z) * 1.08);
  const ACROSS = 5;
  const RIB = 0.32;
  const DEP = 0.09;
  const strip = (thA, thB, sA, sB, rho, paint, steps = 1) => {
    for (let k = 0; k < steps; k += 1) {
      const a = lerp(thA, thB, k / steps);
      const b = lerp(thA, thB, (k + 1) / steps);
      bake.quad(vaultPoint(a, rho, sA), vaultPoint(b, rho, sA), vaultPoint(b, rho, sB), vaultPoint(a, rho, sB), paint);
    }
  };
  const coffer = (thA, thB, sA, sB) => {
    const mS = 0.08;
    const mT = 0.08 / VAULT_R;
    const ta = thA + mT;
    const tb = thB - mT;
    const sa = sA + mS;
    const sb = sB - mS;
    strip(thA, thB, sA, sa, VAULT_R, paintFrame);
    strip(thA, thB, sb, sB, VAULT_R, paintFrame);
    strip(thA, ta, sa, sb, VAULT_R, paintFrame);
    strip(tb, thB, sa, sb, VAULT_R, paintFrame);
    strip(ta, tb, sa, sb, VAULT_R + DEP, paintRecess);
    // recess walls
    const R1 = VAULT_R + DEP;
    bake.quad(vaultPoint(ta, VAULT_R, sa), vaultPoint(ta, R1, sa), vaultPoint(tb, R1, sa), vaultPoint(tb, VAULT_R, sa), paintFrame);
    bake.quad(vaultPoint(ta, VAULT_R, sb), vaultPoint(tb, VAULT_R, sb), vaultPoint(tb, R1, sb), vaultPoint(ta, R1, sb), paintRecess);
    bake.quad(vaultPoint(ta, VAULT_R, sa), vaultPoint(ta, VAULT_R, sb), vaultPoint(ta, R1, sb), vaultPoint(ta, R1, sa), paintRecess);
    bake.quad(vaultPoint(tb, VAULT_R, sa), vaultPoint(tb, R1, sa), vaultPoint(tb, R1, sb), vaultPoint(tb, VAULT_R, sb), paintRecess);
  };
  const rib = (sA, sB) => {
    const R0 = VAULT_R - 0.07;
    strip(-VAULT_TH, VAULT_TH, sA, sB, R0, paintRib, 10);
    for (let k = 0; k < 10; k += 1) {
      const a = lerp(-VAULT_TH, VAULT_TH, k / 10);
      const b = lerp(-VAULT_TH, VAULT_TH, (k + 1) / 10);
      bake.quad(vaultPoint(a, R0, sA), vaultPoint(a, VAULT_R, sA), vaultPoint(b, VAULT_R, sA), vaultPoint(b, R0, sA), paintRib);
      bake.quad(vaultPoint(a, R0, sB), vaultPoint(b, R0, sB), vaultPoint(b, VAULT_R, sB), vaultPoint(a, VAULT_R, sB), paintRib);
    }
  };
  // Plain stretch behind the facade, then coffered bays between ribs.
  strip(-VAULT_TH, VAULT_TH, 0.15, COL_S[0] - RIB / 2, VAULT_R, paintFrame, 10);
  for (let i = 0; i < COL_S.length; i += 1) {
    const s = COL_S[i];
    rib(s - RIB / 2, s + RIB / 2);
    const next = i + 1 < COL_S.length ? COL_S[i + 1] - RIB / 2 : LH;
    const start = s + RIB / 2;
    const cells = i + 1 < COL_S.length ? 2 : 1;
    for (let c = 0; c < cells; c += 1) {
      const sA = lerp(start, next, c / cells);
      const sB = lerp(start, next, (c + 1) / cells);
      for (let k = 0; k < ACROSS; k += 1) {
        coffer(lerp(-VAULT_TH, VAULT_TH, k / ACROSS), lerp(-VAULT_TH, VAULT_TH, (k + 1) / ACROSS), sA, sB);
      }
    }
  }
  // The roof over it: two slopes, seen only from outside.
  const ridge = SPRING + VAULT_RISE + 0.2;
  const paintRoof = (x, y, z, nx) => mul(ROOF, (nx > 0 ? 0.95 : 0.66) * (0.8 + 0.2 * smooth(0, 10, -z)));
  const n = 24;
  for (let i = 0; i < n; i += 1) {
    const a = -lerp(0.15, LH, i / n);
    const b = -lerp(0.15, LH, (i + 1) / n);
    bake.quad(V(-1.25, SPRING + 0.05, a), V(-1.25, SPRING + 0.05, b), V(0, ridge, b), V(0, ridge, a), paintRoof);
    bake.quad(V(1.25, SPRING + 0.05, a), V(0, ridge, a), V(0, ridge, b), V(1.25, SPRING + 0.05, b), paintRoof);
  }
}

function endWallGeometry(bake) {
  const shape = new Shape();
  shape.moveTo(-1.6, -0.05);
  shape.lineTo(1.6, -0.05);
  shape.lineTo(1.6, 3.4);
  shape.lineTo(-1.6, 3.4);
  shape.lineTo(-1.6, -0.05);
  const hole = new Path();
  const r = 0.6;
  hole.moveTo(-r, -0.01);
  hole.lineTo(r, -0.01);
  hole.lineTo(r, 2.05);
  hole.absarc(0, 2.05, r, 0, Math.PI, false);
  hole.lineTo(-r, -0.01);
  shape.holes.push(hole);
  const g = new ExtrudeGeometry(shape, { depth: 0.25, bevelEnabled: false, curveSegments: 16 });
  const paint = (x, y, z, nx, ny, nz) => {
    if (nz > 0.5) return mul(STONE, 0.78 * (0.85 + 0.15 * smooth(0, 3, y)));
    if (nz < -0.5) return mul(STONE_WARM, 1.0);
    return mul(STONE_WARM, 1.05); // reveals catch the court's light
  };
  bake.geo(g, paint, at(0, 0, -LH - 0.25));
}

function courtGeometry(bake) {
  const PAVE_A = col('#f4e2b6');
  const PAVE_B = col('#e9cf9d');
  const P = 1.1;
  const nu = Math.ceil((2 * COURT_U) / P);
  const ns = Math.ceil((HEDGE_S - COURT_S) / P);
  for (let i = 0; i < nu; i += 1) {
    for (let j = 0; j < ns; j += 1) {
      const base = (i + j) % 2 ? PAVE_A : PAVE_B;
      const ua = -COURT_U + i * P;
      const ub = Math.min(COURT_U, ua + P);
      const sa = COURT_S + j * P;
      const sb = Math.min(HEDGE_S, sa + P);
      const paint = (x, y, z) => mul(base, 0.98 + 0.04 * noise3(x * 2, z * 2, 1, 3));
      bake.quad(V(ua, 0, -sa), V(ub, 0, -sa), V(ub, 0, -sb), V(ua, 0, -sb), paint);
    }
  }
  // Back hedge with an arched niche behind the statue.
  const LEAF_D = col('#2d5229');
  const LEAF_L = col('#a3bd5e');
  const NICHE = col('#1b3220');
  const HH = 2.7;
  const inNiche = (u, h) => (Math.abs(u - STATUE_U) < 0.75 && h < 1.6) || Math.hypot(u - STATUE_U, h - 1.6) < 0.75;
  const hedgePaint = (x, y) => {
    const h = y;
    const n = fbm3(x * 3, h * 3, 0.5, { octaves: 3, seed: 13 });
    const sun = smooth(0.4, 2.6, h) * 0.7 + 0.3 * smooth(-1.7, 1.7, x);
    return mul(mixc(LEAF_D, LEAF_L, clamp(sun * 0.85 + (n - 0.5) * 0.7)), 1);
  };
  const STEP = 0.12;
  for (let u = -COURT_U; u < COURT_U - 1e-6; u += STEP) {
    for (let h = 0; h < HH - 1e-6; h += STEP) {
      const uc = u + STEP / 2;
      const hc = h + STEP / 2;
      if (inNiche(uc, hc)) {
        const sN = HEDGE_S + 1.2;
        const paint = (x, y) => mul(NICHE, 0.8 + 0.5 * smooth(0, 2.3, y));
        bake.quad(V(u, h, -sN), V(u + STEP, h, -sN), V(u + STEP, h + STEP, -sN), V(u, h + STEP, -sN), paint);
      } else {
        const bump = 0.12 * fbm3(uc * 2, hc * 2, 3, { octaves: 2, seed: 4 });
        const sH = HEDGE_S - bump;
        bake.quad(V(u, h, -sH), V(u + STEP, h, -sH), V(u + STEP, h + STEP, -sH), V(u, h + STEP, -sH), hedgePaint);
      }
    }
  }
  // Niche floor between the hedge and the niche back.
  bake.quad(V(STATUE_U - 0.75, 0, -HEDGE_S), V(STATUE_U + 0.75, 0, -HEDGE_S), V(STATUE_U + 0.75, 0, -HEDGE_S - 1.2), V(STATUE_U - 0.75, 0, -HEDGE_S - 1.2), () => mul(PAVE_B, 0.6));
  // The warm sky over the court.
  const SKY_LO = col('#ffe3a6');
  const SKY_HI = col('#f2bf7c');
  for (let k = 0; k < 6; k += 1) {
    const h0 = HH - 0.1 + k * 0.4;
    const h1 = h0 + 0.4;
    const paint = (x, y) => {
      const c = mixc(SKY_LO, SKY_HI, smooth(HH, HH + 2.4, y));
      return [c.r, c.g, c.b];
    };
    bake.quad(V(-2.6, h0, -SKY_S), V(2.6, h0, -SKY_S), V(2.6, h1, -SKY_S), V(-2.6, h1, -SKY_S), paint);
  }
}

/** The wedge's own sides, in real space: from the squeezed floor edge down to the slab. */
function wedgeSides(bake) {
  const SIDE = col('#cdbb9a');
  const paint = (x, y, z, nx) => mul(SIDE, (nx > 0 ? 0.82 : 0.6) * (0.7 + 0.3 * smooth(TOP, 0.4, y)));
  const run = (u, s0, s1, n) => {
    for (let i = 0; i < n; i += 1) {
      const a = corridorToReal(u, 0, lerp(s0, s1, i / n));
      const b = corridorToReal(u, 0, lerp(s0, s1, (i + 1) / n));
      const a0 = V(a.x, TOP, a.z);
      const b0 = V(b.x, TOP, b.z);
      if (u > 0) bake.quad(a0, b0, b, a, paint);
      else bake.quad(a0, a, b, b0, paint);
    }
  };
  for (const u of [-STYLO, STYLO]) run(u, 0, COURT_S, 20);
  for (const u of [-COURT_U, COURT_U]) run(u, COURT_S, HEDGE_S + 1.2, 4);
  // Steps between the corridor floor and the wider court floor.
  for (const side of [-1, 1]) {
    const a = corridorToReal(side * STYLO, 0, COURT_S);
    const b = corridorToReal(side * COURT_U, 0, COURT_S);
    bake.quad(V(a.x, TOP, a.z), V(b.x, TOP, b.z), b, a, paint);
  }
  const e0 = corridorToReal(-COURT_U, 0, HEDGE_S + 1.2);
  const e1 = corridorToReal(COURT_U, 0, HEDGE_S + 1.2);
  bake.quad(V(e0.x, TOP, e0.z), e0, e1, V(e1.x, TOP, e1.z), paint);
}

// ---------------------------------------------------------------------------
// The facade: real size, not squeezed, standing on the entrance plane.

const OCHRE = col('#c4834a');
const TRIM = col('#ece1c9');

function facadePaint(base) {
  return (x, y, z, nx, ny, nz) => {
    let k = 1;
    if (nz > 0.5) k = 1;
    else if (nz < -0.5) k = 0.55;
    else if (ny > 0.5) k = 1.04;
    else if (ny < -0.5) k = 0.5;
    else if (nx > 0.5) k = 0.86;
    else k = 0.64;
    const inArch = Math.abs(x) < ARCH_W + 0.01 && z < 0.17 && y < 2.52 && nz < 0.5;
    if (inArch) k *= 0.8;
    return mul(base, k * (0.8 + 0.2 * smooth(0, 2.6, y)));
  };
}

function facadeGeometry(bake) {
  const wallPaint = facadePaint(OCHRE);
  const trimPaint = facadePaint(TRIM);
  const wall = new Shape();
  wall.moveTo(-1.2, TOP);
  wall.lineTo(1.2, TOP);
  wall.lineTo(1.2, 2.62);
  wall.lineTo(-1.2, 2.62);
  wall.lineTo(-1.2, TOP);
  const hole = new Path();
  hole.moveTo(-ARCH_W, Y0);
  hole.lineTo(ARCH_W, Y0);
  hole.lineTo(ARCH_W, ARCH_SPRING);
  hole.absarc(0, ARCH_SPRING, ARCH_W, 0, Math.PI, false);
  hole.lineTo(-ARCH_W, Y0);
  wall.holes.push(hole);
  bake.geo(new ExtrudeGeometry(wall, { depth: 0.16, bevelEnabled: false, curveSegments: 24 }), wallPaint);

  const box = (w, h, d, x, y, z, paint = trimPaint) => {
    const g = new BoxGeometry(w, h, d);
    g.translate(x, y, z);
    bake.geo(g, paint);
  };
  for (const sx of [-1, 1]) {
    const x = sx * 0.98;
    box(0.26, 2.62 - TOP, 0.1, x, (2.62 + TOP) / 2, 0.19);
    box(0.34, 0.16, 0.14, x, TOP + 0.08, 0.2);
    box(0.34, 0.12, 0.14, x, 2.52, 0.2);
    box(0.12, 0.08, 0.06, sx * 0.81, ARCH_SPRING - 0.03, 0.19); // impost
    box(0.16, 2.62 - TOP, 0.04, sx * 1.18, (2.62 + TOP) / 2, 0.17, wallPaint); // corner band
  }
  // Archivolt and keystone.
  const ring = new Shape();
  ring.moveTo(0.88, ARCH_SPRING);
  ring.absarc(0, ARCH_SPRING, 0.88, 0, Math.PI, false);
  ring.lineTo(-ARCH_W, ARCH_SPRING);
  ring.absarc(0, ARCH_SPRING, ARCH_W, Math.PI, 0, true);
  ring.lineTo(0.88, ARCH_SPRING);
  const ringG = new ExtrudeGeometry(ring, { depth: 0.05, bevelEnabled: false, curveSegments: 24 });
  ringG.translate(0, 0, 0.16);
  bake.geo(ringG, trimPaint);
  box(0.17, 0.3, 0.1, 0, 2.53, 0.2);
  // Entablature, cornice, pediment.
  box(2.6, 0.24, 0.3, 0, 2.74, 0.13);
  box(2.74, 0.07, 0.36, 0, 2.895, 0.14);
  const ped = new Shape();
  ped.moveTo(-1.32, 2.93);
  ped.lineTo(1.32, 2.93);
  ped.lineTo(0, 3.37);
  ped.lineTo(-1.32, 2.93);
  const tymp = new Path();
  tymp.moveTo(-0.9, 3.0);
  tymp.lineTo(0.9, 3.0);
  tymp.lineTo(0, 3.29);
  tymp.lineTo(-0.9, 3.0);
  ped.holes.push(tymp);
  const pedG = new ExtrudeGeometry(ped, { depth: 0.32, bevelEnabled: false });
  pedG.translate(0, 0, -0.03);
  bake.geo(pedG, trimPaint);
  const tympS = new Shape();
  tympS.moveTo(-0.9, 3.0);
  tympS.lineTo(0.9, 3.0);
  tympS.lineTo(0, 3.29);
  tympS.lineTo(-0.9, 3.0);
  const tympG = new ExtrudeGeometry(tympS, { depth: 0.25, bevelEnabled: false });
  tympG.translate(0, 0, -0.03);
  bake.geo(tympG, wallPaint);
  // A round window (an oculus, painted dark) in the tympanum.
  const oc = new SphereGeometry(0.075, 16, 8, 0, TAU, 0, Math.PI / 2);
  oc.rotateX(Math.PI / 2);
  oc.translate(0, 3.11, 0.225);
  bake.geo(oc, () => mul(col('#3a2418'), 1));
  // The low step in front of the arch.
  box(1.56, Y0 - TOP, 0.36, 0, (Y0 + TOP) / 2, 0.34, facadePaint(col('#d9c9a9')));
}

// ---------------------------------------------------------------------------
// The torn slab with the burnt-gold rim.

const SLAB = { cz: -0.36, rx: 1.55, rz: 1.66, p: 3.2 };
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
  return r0 + tear(th * 1.9, 9, 0.07);
}

function slabGeometry(bake) {
  const N = 240;
  const RINGS = 6;
  const pave = col('#4b4f49');
  const paveL = col('#5f625a');
  const scorch = col('#2b1a10');
  const gold = col(T.gold);
  const high = col(T.highlight);
  const body = col('#7d6a55');
  const pt = (r, th, y) => V(r * Math.cos(th), y, SLAB.cz + r * Math.sin(th));
  const topPaint = (x, y, z) => {
    const n = fbm3(x * 3, z * 3, 1, { octaves: 3, seed: 21 });
    const c = mixc(pave, paveL, n);
    return [c.r, c.g, c.b];
  };
  for (let j = 0; j < N; j += 1) {
    const a = (j / N) * TAU;
    const b = ((j + 1) / N) * TAU;
    const ra = slabR(a);
    const rb = slabR(b);
    const wa = 0.035 + 0.02 * fbm3(a * 5, 1, 2, { octaves: 2, seed: 8 });
    const wb = 0.035 + 0.02 * fbm3(b * 5, 1, 2, { octaves: 2, seed: 8 });
    for (let k = 0; k < RINGS; k += 1) {
      const f0 = k / RINGS;
      const f1 = (k + 1) / RINGS;
      const r0a = (ra - wa) * f0;
      const r1a = (ra - wa) * f1;
      const r0b = (rb - wb) * f0;
      const r1b = (rb - wb) * f1;
      if (k === 0) bake.tri(pt(0, a, TOP), pt(r1b, b, TOP), pt(r1a, a, TOP), topPaint);
      else bake.quad(pt(r0a, a, TOP), pt(r0b, b, TOP), pt(r1b, b, TOP), pt(r1a, a, TOP), topPaint);
    }
    const bands = [[1, body], [0.45, scorch], [0.18, gold], [0, high]];
    for (let q = 0; q < bands.length - 1; q += 1) {
      const [f0, c0] = bands[q];
      const [f1, c1] = bands[q + 1];
      const A = pt(ra - wa * f0, a, TOP + 0.0008);
      const Bp = pt(rb - wb * f0, b, TOP + 0.0008);
      const C = pt(rb - wb * f1, b, TOP + 0.0008);
      const Dp = pt(ra - wa * f1, a, TOP + 0.0008);
      const paint = (x, y, z) => {
        const r = Math.hypot(x, z - SLAB.cz);
        const th = Math.atan2(z - SLAB.cz, x);
        const R = slabR(th);
        const w = 0.045;
        const f = clamp((R - r) / w);
        const t = clamp((f - f1) / Math.max(1e-6, f0 - f1));
        const c = mixc(c1, c0, t);
        return [c.r, c.g, c.b];
      };
      bake.quad(A, Bp, C, Dp, paint);
    }
    const side = (y) => (y > TOP * 0.6 ? [gold.r, gold.g, gold.b] : [scorch.r, scorch.g, scorch.b]);
    bake.quad(pt(ra, a, TOP + 0.0008), pt(ra * 0.99, a, 0), pt(rb * 0.99, b, 0), pt(rb, b, TOP + 0.0008), (x, y) => side(y));
    bake.tri(pt(0, a, 0), pt(ra * 0.99, a, 0), pt(rb * 0.99, b, 0), () => [0.02, 0.012, 0.008]);
  }
}

// ---------------------------------------------------------------------------
// Jointed mannequins (the person, and the statue in stone). After door.mjs.

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
    wristR: R.hand,
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
  constructor({ s, x0, y0 = 0, z0, yaw }) {
    this.s = s;
    this.root = new Object3D();
    this.root.position.set(x0, y0, z0);
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
    this.geo = {};
    for (const [name, list] of Object.entries(figureParts())) this.geo[name] = mergedParts(list, s);
    this.root.updateMatrixWorld(true);
  }

  holder(name) {
    return name === 'chestBreath' ? this.breath : this.j[name];
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

function applyPose(rig, P) {
  const { j } = rig;
  j.pelvis.position.set(...P.pelvis.map((v) => v * rig.s));
  j.pelvis.quaternion.copy(eul(P.pelvisPitch ?? 0, P.pelvisYaw ?? 0, P.pelvisRoll ?? 0));
  j.spine.quaternion.copy(eul(...P.spine));
  j.chest.quaternion.copy(eul(...P.chest));
  j.neck.quaternion.copy(eul(...P.neck));
  j.head.quaternion.copy(eul(...P.head));
  rig.breath.scale.set(...P.breath);
  rig.root.updateMatrixWorld(true);
  const rootQ = rig.root.quaternion;
  for (const sideName of ['L', 'R']) {
    const foot = P.feet[sideName];
    const target = rig.toWorld(foot.pos.map((v) => v * rig.s));
    const pole = rig.dirToWorld([sideName === 'L' ? 0.12 : -0.12, 0, 1]).applyAxisAngle(new Vector3(0, 1, 0), foot.yaw * 0.6);
    twoBone(j[`hip${sideName}`], j[`knee${sideName}`], j[`ankle${sideName}`].position.length(), target, pole, -1);
    const desired = rootQ.clone().multiply(eul(foot.pitch ?? 0, foot.yaw, 0));
    const kneeQ = j[`knee${sideName}`].getWorldQuaternion(new Quaternion());
    j[`ankle${sideName}`].quaternion.copy(kneeQ.invert().multiply(desired));
  }
  for (const sideName of ['L', 'R']) {
    const arm = P.arms[sideName];
    j[`shoulder${sideName}`].quaternion.copy(eul(...arm.shoulder, 'XYZ'));
    j[`elbow${sideName}`].quaternion.copy(eul(...arm.elbow, 'XYZ'));
    j[`wrist${sideName}`].quaternion.copy(eul(...(arm.wrist ?? [0, 0, 0]), 'XYZ'));
  }
  rig.root.updateMatrixWorld(true);
}

function sampleFigure(rig, pose) {
  const count = LOOP * FPS;
  const frames = [];
  for (let i = 0; i <= count; i += 1) {
    const t = (i / count) * LOOP;
    applyPose(rig, pose(t));
    const f = { q: {}, pelvis: rig.j.pelvis.position.toArray(), breath: rig.breath.scale.toArray() };
    for (const [name] of SKELETON) f.q[name] = rig.j[name].quaternion.toArray();
    frames.push(f);
  }
  return frames;
}

/** Keeps consecutive quaternions in one hemisphere so LINEAR keys never spin the long way. */
function continuous(quats) {
  const out = [];
  let prev = null;
  for (let q of quats) {
    if (prev && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0) q = q.map((v) => -v);
    out.push(...q);
    prev = q;
  }
  return out;
}

function writeFigure(glb, rig, frames, { name, material, times, parent }) {
  const root = glb.node({ name, translation: rig.root.position.toArray(), rotation: rig.root.quaternion.toArray(), parent });
  const nodes = {};
  const meshFor = (part) => glb.mesh(`${name}-${part}`, rig.geo[part], material);
  for (const [joint, par, offset] of SKELETON) {
    nodes[joint] = glb.node({
      name: `${name}-${joint}`,
      mesh: rig.geo[joint] ? meshFor(joint) : undefined,
      translation: joint === 'pelvis' ? frames[0].pelvis : offset.map((v) => v * rig.s),
      rotation: frames[0].q[joint],
      parent: par ? nodes[par] : root
    });
    if (joint === 'chest') {
      nodes.chestBreath = glb.node({ name: `${name}-chestBreath`, mesh: meshFor('chestBreath'), scale: frames[0].breath, parent: nodes.chest });
    }
  }
  for (const [joint] of SKELETON) glb.animate(nodes[joint], 'rotation', times, continuous(frames.map((f) => f.q[joint])));
  glb.animate(nodes.pelvis, 'translation', times, frames.flatMap((f) => f.pelvis));
  glb.animate(nodes.chestBreath, 'scale', times, frames.flatMap((f) => f.breath));
}

// The statue: the same mannequin, posed once, baked into stone, set on its
// plinth in the virtual court, then scaled about the eye as one piece (so it
// stays a round figurine rather than a paper-thin cut-out).
function statueGeometry(bake) {
  const fig = STATUE_H - PLINTH_H;
  const rig = new Rig({ s: fig / 1.7, x0: 0, z0: 0, yaw: 0 });
  applyPose(rig, {
    pelvis: [0.025, 0.95, 0],
    pelvisYaw: 0.08,
    pelvisRoll: -0.05,
    spine: [0, -0.04, 0.03],
    chest: [-0.03, -0.06, 0.04],
    neck: [0.08, 0.15, 0],
    head: [0.18, 0.2, -0.06],
    breath: [1, 1, 1],
    feet: { L: { pos: [0.11, ANKLE_H, 0.02], yaw: 0.25 }, R: { pos: [-0.12, ANKLE_H + 0.03, -0.1], yaw: -0.2, pitch: 0.3 } },
    arms: {
      L: { shoulder: [-0.25, 0, 0.12], elbow: [-1.1, 0, 0], wrist: [0, 0, 0] },
      R: { shoulder: [-2.5, 0.2, -0.25], elbow: [-0.35, 0, 0], wrist: [0.2, 0, 0] }
    }
  });
  const PALE = col('#f1ebe0');
  const light = new Vector3(0.45, 0.65, 0.6).normalize();
  const stone = (base) => (x, y, z, nx, ny, nz) => mul(base, 0.55 + 0.5 * Math.max(0, nx * light.x + ny * light.y + nz * light.z));
  const part = new Bake();
  for (const name of Object.keys(rig.geo)) {
    const holder = rig.holder(name);
    holder.updateWorldMatrix(true, false);
    const g = rig.geo[name].clone();
    g.computeVertexNormals();
    part.geo(g, stone(PALE), holder.matrixWorld.clone().premultiply(at(0, PLINTH_H, 0)));
  }
  const PLINTH = col('#d8cdb9');
  const pbox = (w, h, d, y) => {
    const g = new BoxGeometry(w, h, d);
    g.translate(0, y, 0);
    part.geo(g, stone(PLINTH));
  };
  pbox(0.6, PLINTH_H - 0.1, 0.6, (PLINTH_H - 0.1) / 2);
  pbox(0.72, 0.07, 0.72, PLINTH_H - 0.065);
  pbox(0.66, 0.05, 0.66, PLINTH_H - 0.01);
  pbox(0.78, 0.35, 0.78, -0.12); // base, partly below the floor
  // Place it in the virtual court, then scale about the eye.
  const base = toVirtual(V(STATUE_U, 0, -STATUE_S));
  const kc = squeezeK(base.z);
  const g = part.build((v) => v.add(base).sub(EYE).multiplyScalar(kc).add(EYE));
  for (const v of g.attributes.position.array) bake.p.push(v);
  for (const v of g.attributes.color.array) bake.c.push(v);
  return kc;
}

// ---------------------------------------------------------------------------
// The cat: real size, never squeezed. Forward is +Z in its own frame,
// origin on the floor under the middle of the body.

const CAT = {
  pivot: new Vector3(0, 0.12, -0.12), // the rump it sits back on
  neck: new Vector3(0, 0.24, 0.17),
  front: [new Vector3(0.036, 0.165, 0.12), new Vector3(-0.036, 0.165, 0.12)],
  hind: [new Vector3(0.045, 0.15, -0.13), new Vector3(-0.045, 0.15, -0.13)],
  tailBase: new Vector3(0, 0.2, -0.165),
  frontLen: 0.165,
  hindLen: 0.15,
  tailSegs: 6,
  tailSeg: 0.045
};
const SIT_PITCH = 0.55;

const START = { x: 0, z: 0.3 };
const FAR = { x: -0.13, z: -1.5 };
const FAR_TURN = { x: -0.03, z: -1.4 };
const HOME = { x: 0, z: 0.36 };
const TIMES = {
  rise1: [2.6, 3.3],
  trotIn: [3.3, 7.3],
  rub: [7.3, 8.9],
  sit2: [8.9, 9.6],
  rise2: [11.3, 11.9],
  turnFar: [11.9, 12.9],
  trotOut: [12.9, 16.5],
  turnHome: [16.5, 17.2],
  sit3: [17.2, 17.85]
};
const GAIT_HZ = 2;
const ease = (t, [a, b]) => smooth(a, b, t);

/** Where the cat is and what it is doing at time t. */
function catState(t) {
  const st = { x: START.x, z: START.z, yaw: Math.PI, w: 1, gait: 0, headPitch: -0.12, headYaw: 0, headRoll: 0, rub: 0 };
  const inR = (r) => t >= r[0] && t < r[1];
  if (t < TIMES.rise1[0]) {
    st.headYaw = 0.25 * Math.sin((TAU * t) / 2.6) * smooth(0.2, 1, t);
  } else if (t < TIMES.trotIn[0]) {
    st.w = 1 - ease(t, TIMES.rise1);
  } else if (t < TIMES.rub[0]) {
    const u = ease(t, TIMES.trotIn);
    st.x = lerp(START.x, FAR.x, u);
    st.z = lerp(START.z, FAR.z, u);
    st.w = 0;
    st.gait = smooth(TIMES.trotIn[0], TIMES.trotIn[0] + 0.35, t) * (1 - smooth(TIMES.trotIn[1] - 0.35, TIMES.trotIn[1], t));
    st.headPitch = -0.05;
  } else if (t < TIMES.rise2[0]) {
    st.x = FAR.x;
    st.z = FAR.z;
    if (inR(TIMES.rub)) {
      const u = (t - TIMES.rub[0]) / (TIMES.rub[1] - TIMES.rub[0]);
      const rub = Math.sin(Math.PI * u);
      st.rub = rub;
      st.x = FAR.x + 0.012 * rub;
      st.yaw = Math.PI - 0.22 * rub * (0.7 + 0.3 * Math.sin(TAU * 2 * u));
      st.headRoll = -0.35 * rub;
      st.headYaw = -0.3 * rub;
      st.w = 0;
    } else {
      st.w = ease(t, TIMES.sit2);
      const u = smooth(9.4, 10.2, t) * (1 - smooth(10.6, 11.2, t));
      st.headPitch = -0.12 - 0.45 * u;
      st.headYaw = -0.25 * u;
    }
  } else if (t < TIMES.turnFar[0]) {
    st.x = FAR.x;
    st.z = FAR.z;
    st.w = 1 - ease(t, TIMES.rise2);
  } else if (t < TIMES.trotOut[0]) {
    const u = ease(t, TIMES.turnFar);
    st.x = lerp(FAR.x, FAR_TURN.x, u);
    st.z = lerp(FAR.z, FAR_TURN.z, u);
    st.yaw = lerp(Math.PI, 0, u);
    st.w = 0;
    st.gait = 0.5 * Math.sin(Math.PI * clamp((t - TIMES.turnFar[0]) / (TIMES.turnFar[1] - TIMES.turnFar[0])));
  } else if (t < TIMES.turnHome[0]) {
    const u = ease(t, TIMES.trotOut);
    st.x = lerp(FAR_TURN.x, HOME.x, u);
    st.z = lerp(FAR_TURN.z, HOME.z, u);
    st.yaw = 0;
    st.w = 0;
    st.gait = smooth(TIMES.trotOut[0], TIMES.trotOut[0] + 0.35, t) * (1 - smooth(TIMES.trotOut[1] - 0.35, TIMES.trotOut[1], t));
  } else if (t < TIMES.sit3[0]) {
    const u = ease(t, TIMES.turnHome);
    st.x = lerp(HOME.x, START.x, u);
    st.z = lerp(HOME.z, START.z, u);
    st.yaw = lerp(0, Math.PI, u);
    st.w = 0;
    st.gait = 0.5 * Math.sin(Math.PI * clamp((t - TIMES.turnHome[0]) / (TIMES.turnHome[1] - TIMES.turnHome[0])));
  } else {
    st.w = ease(t, TIMES.sit3);
  }
  return st;
}

function buildCatRig() {
  const root = new Object3D();
  const body = new Object3D();
  body.position.copy(CAT.pivot);
  root.add(body);
  const head = new Object3D();
  head.position.copy(CAT.neck).sub(CAT.pivot);
  body.add(head);
  const legs = [];
  for (const [i, p] of [...CAT.front, ...CAT.hind].entries()) {
    const leg = new Object3D();
    leg.position.copy(p).sub(CAT.pivot);
    leg.userData = { front: i < 2, phase: i === 0 || i === 3 ? 0 : Math.PI };
    body.add(leg);
    legs.push(leg);
  }
  const tail = [];
  let parent = body;
  for (let i = 0; i < CAT.tailSegs; i += 1) {
    const seg = new Object3D();
    if (i === 0) seg.position.copy(CAT.tailBase).sub(CAT.pivot);
    else seg.position.set(0, 0, -CAT.tailSeg);
    parent.add(seg);
    tail.push(seg);
    parent = seg;
  }
  return { root, body, head, legs, tail };
}

function poseCat(rig, t) {
  const st = catState(t);
  const { w } = st;
  // Root: on the real floor, tilted to its slope.
  const y = floorY(st.z);
  const slope = (floorY(st.z - 0.05) - floorY(st.z + 0.05)) / 0.1; // rise per meter toward -z
  const n = new Vector3(0, 1, slope).normalize();
  rig.root.position.set(st.x, y, st.z);
  rig.root.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), n).multiply(eul(0, st.yaw, 0));
  const phase = TAU * GAIT_HZ * t;
  const bob = 0.006 * st.gait * Math.abs(Math.sin(phase));
  rig.body.position.set(CAT.pivot.x, CAT.pivot.y - 0.06 * w + bob, CAT.pivot.z + 0.03 * w);
  rig.body.quaternion.copy(eul(-SIT_PITCH * w, 0, 0.12 * st.rub));
  rig.root.updateMatrixWorld(true);
  for (const leg of rig.legs) {
    const swing = 0.45 * st.gait * Math.sin(phase + leg.userData.phase);
    const lift = 1 - 0.14 * st.gait * Math.max(0, Math.cos(phase + leg.userData.phase));
    // Joint height in the root (floor) frame.
    const p = leg.position.clone().applyQuaternion(rig.body.quaternion).add(rig.body.position);
    if (leg.userData.front) {
      leg.quaternion.copy(eul(SIT_PITCH * w + swing, 0, 0, 'XYZ'));
      leg.scale.set(1, (p.y / Math.cos(swing) / CAT.frontLen) * lift, 1);
    } else {
      const ang = (1 - w) * swing + w * -1.25;
      leg.quaternion.copy(eul(ang + SIT_PITCH * w, 0, 0, 'XYZ'));
      const reach = (p.y / Math.cos(swing) / CAT.hindLen) * lift;
      leg.scale.set(1, lerp(reach, 0.95, w), 1);
    }
  }
  rig.head.quaternion.copy(eul(SIT_PITCH * w * 0.85 + st.headPitch, st.headYaw, st.headRoll));
  // Tail: up and curving when walking; down and round the feet when sitting; flicking at the tip.
  const flick = (0.25 + 0.35 * w) * Math.sin((TAU * 23 * t) / LOOP) * (0.6 + 0.4 * Math.sin((TAU * 3 * t) / LOOP));
  rig.tail.forEach((seg, i) => {
    const f = i / (CAT.tailSegs - 1);
    const walkX = i === 0 ? 1.15 : -0.16;
    const sitX = i === 0 ? -0.75 : i < 3 ? -0.18 : 0.02;
    const sitY = i === 0 ? 0.5 : 0.38;
    const x = lerp(walkX, sitX, w);
    const yw = lerp(0.05 * Math.sin(phase * 0.5 + i), sitY, w) + flick * f * f;
    seg.quaternion.copy(eul(x, yw, 0));
  });
  rig.root.updateMatrixWorld(true);
}

function catGeometries() {
  const BLACK = col('#d07a36');
  const WHITE = col('#f2efe8');
  const PINK = col('#d98c8c');
  const RED = col('#b8322b');
  const EYEC = col('#b9c24a');
  const parts = { body: [], head: [], front: [], hind: [], tail: [], tip: [] };
  const put = (list, g, c, m) => {
    let geom = g;
    if (geom.attributes.uv) geom.deleteAttribute('uv');
    geom.computeVertexNormals();
    if (m) geom.applyMatrix4(m);
    if (geom.index) geom = geom.toNonIndexed();
    const cs = new Float32Array(geom.attributes.position.count * 3);
    for (let i = 0; i < cs.length; i += 3) cs.set([c.r, c.g, c.b], i);
    geom.setAttribute('color', new BufferAttribute(cs, 3));
    list.push(geom);
  };
  const toBody = at(-CAT.pivot.x, -CAT.pivot.y, -CAT.pivot.z);
  const e = (rx, ry, rz, x, y, z) => ell(rx, ry, rz, [x, y, z], 20, 14);
  put(parts.body, e(0.066, 0.068, 0.17, 0, 0.19, 0), BLACK, toBody);
  put(parts.body, e(0.062, 0.076, 0.085, 0, 0.19, 0.105), BLACK, toBody);
  put(parts.body, e(0.046, 0.072, 0.075, 0.032, 0.17, -0.11), BLACK, toBody);
  put(parts.body, e(0.046, 0.072, 0.075, -0.032, 0.17, -0.11), BLACK, toBody);
  put(parts.body, e(0.04, 0.055, 0.03, 0, 0.175, 0.17), WHITE, toBody);
  put(parts.body, e(0.045, 0.03, 0.09, 0, 0.13, 0.04), WHITE, toBody);
  const collar = new TorusGeometry(0.05, 0.009, 8, 24);
  collar.rotateX(Math.PI / 2 - 0.75);
  collar.translate(0, 0.228, 0.165);
  put(parts.body, collar, RED, toBody);
  // Head (in the head node's frame, at the neck).
  put(parts.head, e(0.058, 0.052, 0.056, 0, 0.045, 0.045), BLACK);
  put(parts.head, e(0.032, 0.025, 0.026, 0, 0.022, 0.092), WHITE);
  put(parts.head, e(0.008, 0.006, 0.005, 0, 0.038, 0.115), PINK);
  for (const sx of [-1, 1]) {
    put(parts.head, e(0.009, 0.009, 0.005, sx * 0.024, 0.058, 0.093), EYEC);
    const ear = new ConeGeometry(0.024, 0.05, 10);
    ear.rotateZ(-sx * 0.3);
    ear.translate(sx * 0.034, 0.093, 0.035);
    put(parts.head, ear, BLACK);
  }
  // Legs (pivot at the top, hanging down -Y), white paws.
  put(parts.front, new CapsuleGeometry(0.018, CAT.frontLen - 0.03, 4, 10), BLACK, at(0, -CAT.frontLen / 2, 0));
  put(parts.front, e(0.022, 0.014, 0.03, 0, -CAT.frontLen + 0.012, 0.012), WHITE);
  const thigh = limb([0, 0.01, 0], [0, -CAT.hindLen + 0.02, 0], 0.03, 0.017, 1, 1.2, 12);
  put(parts.hind, thigh, BLACK);
  put(parts.hind, e(0.022, 0.014, 0.032, 0, -CAT.hindLen + 0.012, 0.014), WHITE);
  // Tail segment along -Z.
  put(parts.tail, new CapsuleGeometry(0.015, CAT.tailSeg, 4, 10), BLACK, new Matrix4().makeRotationX(Math.PI / 2).premultiply(at(0, 0, -CAT.tailSeg / 2)));
  put(parts.tip, new CapsuleGeometry(0.013, CAT.tailSeg, 4, 10), col('#8f4a1e'), new Matrix4().makeRotationX(Math.PI / 2).premultiply(at(0, 0, -CAT.tailSeg / 2)));
  const out = {};
  for (const [k, list] of Object.entries(parts)) out[k] = mergeGeometries(list);
  return out;
}

function writeCat(glb, parent, times) {
  const rig = buildCatRig();
  const nodes = [rig.root, rig.body, rig.head, ...rig.legs, ...rig.tail];
  const frames = nodes.map(() => ({ p: [], q: [], s: [] }));
  const count = LOOP * FPS;
  const steps = [];
  for (let i = 0; i <= count; i += 1) {
    const t = (i / count) * LOOP;
    poseCat(rig, t);
    nodes.forEach((n, k) => {
      frames[k].p.push(...n.position.toArray());
      frames[k].q.push(n.quaternion.toArray());
      frames[k].s.push(...n.scale.toArray());
    });
  }
  // Footfalls for the bell: a diagonal pair lands every half gait cycle.
  for (let k = 0; k < LOOP * GAIT_HZ * 2; k += 1) {
    const t = k / (GAIT_HZ * 2) + 0.06;
    const st = catState(t);
    if (st.gait > 0.3) steps.push({ t, z: st.z, gait: st.gait });
  }
  const geos = catGeometries();
  const fur = glb.material({ name: 'CatFur', color: '#ffffff', roughness: 0.7, emissive: '#2a170b', emissiveStrength: 1 });
  const bellInk = glb.material({ name: 'CatBell', color: T.gold, emissive: T.glow, emissiveStrength: 0.9, metallic: 0.4, roughness: 0.35 });
  const mesh = (name, g) => glb.mesh(name, g, fur);
  const ids = [];
  const names = ['cat', 'cat-torso', 'cat-noggin', 'cat-paw-fl', 'cat-paw-fr', 'cat-paw-hl', 'cat-paw-hr', ...rig.tail.map((_, i) => `cat-tail${i}`)];
  const meshOf = [
    undefined,
    mesh('CatTorso', geos.body),
    mesh('CatNoggin', geos.head),
    undefined, undefined, undefined, undefined
  ];
  const frontMesh = mesh('CatFrontLeg', geos.front);
  const hindMesh = mesh('CatHindLeg', geos.hind);
  const tailMesh = mesh('CatTail', geos.tail);
  const tipMesh = mesh('CatTailTip', geos.tip);
  meshOf[3] = frontMesh;
  meshOf[4] = frontMesh;
  meshOf[5] = hindMesh;
  meshOf[6] = hindMesh;
  rig.tail.forEach((_, i) => meshOf.push(i >= CAT.tailSegs - 2 ? tipMesh : tailMesh));
  const parentOf = [parent, 0, 1, 1, 1, 1, 1, 1, 7, 8, 9, 10, 11];
  nodes.forEach((n, k) => {
    const par = k === 0 ? parent : ids[parentOf[k]];
    ids.push(
      glb.node({
        name: names[k],
        mesh: meshOf[k],
        translation: frames[k].p.slice(0, 3),
        rotation: frames[k].q[0],
        scale: frames[k].s.slice(0, 3),
        parent: par
      })
    );
  });
  // The bell hangs from the collar.
  const bell = new SphereGeometry(0.016, 14, 10);
  bell.translate(0, 0.18 - CAT.pivot.y, 0.198 - CAT.pivot.z);
  glb.node({ name: 'cat-bell', mesh: glb.mesh('CatBell', bell, bellInk), parent: ids[1] });
  nodes.forEach((n, k) => {
    glb.animate(ids[k], 'rotation', times, continuous(frames[k].q));
    if (k <= 1) glb.animate(ids[k], 'translation', times, frames[k].p);
    if (k >= 3 && k <= 6) glb.animate(ids[k], 'scale', times, frames[k].s);
  });
  return steps;
}

// ---------------------------------------------------------------------------
// The person beside the door: nearly still, the head following the cat.

const KEEPER = { x: -1.12, z: 0.56, yaw: 1.2 };

function keeperPose(t) {
  const sway = Math.sin((TAU * 2 * t) / LOOP);
  const b = Math.sin((TAU * 5 * t) / LOOP);
  const st = catState(t);
  const dx = st.x - KEEPER.x;
  const dz = st.z - KEEPER.z;
  let rel = Math.atan2(dx, dz) - KEEPER.yaw;
  while (rel > Math.PI) rel -= TAU;
  while (rel < -Math.PI) rel += TAU;
  const yawHead = 0.55 * clamp(rel, -1.4, 1.4);
  const dist = Math.hypot(dx, dz);
  const pitch = 0.35 * Math.atan2(1.5 - floorY(st.z), dist);
  return {
    pelvis: [0.018 * sway, 0.955, 0],
    pelvisYaw: 0.03 * sway,
    pelvisRoll: 0.025 * sway,
    spine: [0.02, 0.05 * yawHead, -0.015 * sway],
    chest: [0.01, 0.1 * yawHead, 0],
    neck: [0.05 + pitch * 0.4, yawHead * 0.4, 0],
    head: [0.08 + pitch * 0.6, yawHead * 0.6, 0],
    breath: [1, 1 + 0.01 * b, 1 + 0.02 * b],
    feet: { L: { pos: [0.1, ANKLE_H, 0.03], yaw: 0.12 }, R: { pos: [-0.1, ANKLE_H, -0.03], yaw: -0.12 } },
    arms: {
      L: { shoulder: [0.04, 0, 0.09 + 0.01 * sway], elbow: [-0.28, 0, 0] },
      R: { shoulder: [0.04, 0, -0.09 + 0.01 * sway], elbow: [-0.28, 0, 0] }
    }
  };
}

// ---------------------------------------------------------------------------
// Sound: a quiet garden air, a small bell on each trot step that drops in
// pitch as the cat goes in (it is getting bigger) and rises as it comes
// back, and at the far end a purr low and slow enough for a tiger.

const loopHz = (hz) => Math.round(hz * LOOP) / LOOP;

function sound(steps) {
  const out = track(LOOP);
  const air = track(LOOP);
  const rnd = noise(17);
  for (let i = 0; i < air.length; i += 1) air[i] = rnd();
  lowpass(air, 520);
  lowpass(air, 900);
  for (let i = 0; i < out.length; i += 1) {
    const t = i / SAMPLE_RATE;
    out[i] += air[i] * 0.11 * (0.7 + 0.3 * Math.sin((TAU * t) / 9));
  }
  const p1 = loopHz(110);
  const p2 = loopHz(164.8);
  add(out, 0, LOOP, (t) => 0.012 * Math.sin(TAU * p1 * t) + 0.008 * Math.sin(TAU * p2 * t) * (0.6 + 0.4 * Math.sin((TAU * t) / 6)));

  const bell = (hz) => (t) => Math.sin(TAU * hz * t) + 0.25 * Math.sin(TAU * hz * 2.76 * t) * Math.exp(-t / 0.05);
  const zIn = [START.z, FAR.z];
  for (const s of steps) {
    const depth = clamp((zIn[0] - s.z) / (zIn[0] - zIn[1]));
    const hz = 1250 * 2 ** -depth; // one octave down by the far end
    add(out, s.t, 0.5, bell(hz), (t) => 0.06 * s.gait * pluck(0.002, 0.11)(t));
  }
  // A few jingles while it rubs.
  for (const t0 of [7.55, 7.95, 8.4]) add(out, t0, 0.5, bell(640), (t) => 0.035 * pluck(0.002, 0.13)(t));

  // Purr: low noise, pulsed slowly, breathing in and out.
  const purr = track(LOOP);
  const pr = noise(5);
  for (let i = 0; i < purr.length; i += 1) purr[i] = pr();
  lowpass(purr, 140);
  lowpass(purr, 160);
  lowpass(purr, 180);
  const P0 = 7.5;
  const P1 = 11.6;
  for (let i = 0; i < out.length; i += 1) {
    const t = i / SAMPLE_RATE;
    if (t < P0 || t > P1) continue;
    const env = smooth(P0, P0 + 0.6, t) * (1 - smooth(P1 - 0.8, P1, t));
    const pulse = (0.5 + 0.5 * Math.sin(TAU * 9 * t)) ** 2;
    const breath = 0.55 + 0.45 * Math.sin(TAU * 0.4 * (t - P0));
    out[i] += purr[i] * 6 * env * pulse * breath + 0.05 * env * pulse * breath * Math.sin(TAU * 48 * t);
  }
  return toWav(normalize(out, 0.6));
}

// ---------------------------------------------------------------------------

export async function build() {
  const labels = await renderLabels([
    { id: 'len', text: `About ${LEN} meters. About.`, font: 'title', italic: true, size: 30, color: T.gold }
  ]);
  const glb = new Glb();
  glb.provenance({
    holoim: {
      authored: 'synthetic',
      author: meta.submittedBy,
      title: meta.name,
      designedEye: EYE.toArray(),
      designedTarget: TGT.toArray(),
      virtualLengthMeters: LEN,
      realDepthMeters: DEPTH,
      farScale: +FAR_K.toFixed(3),
      method: 'perspective squeeze toward the eye: 1/d\' = A + B/d along each ray; the cat is real size'
    }
  });
  const root = glb.node({ name: 'Corridor', rotation: quat([0, 1, 0], (18 * Math.PI) / 180) });

  const hall = new Bake();
  floorGeometry(hall);
  columnsGeometry(hall);
  entablatureGeometry(hall);
  vaultGeometry(hall);
  endWallGeometry(hall);
  courtGeometry(hall);
  const real = new Bake();
  wedgeSides(real);
  facadeGeometry(real);
  slabGeometry(real);
  statueGeometry(real);
  const paint = glb.material({ name: 'PaintedStone', color: '#ffffff', unlit: true, doubleSided: true });
  const all = mergeGeometries([hall.build((v) => squeeze(toVirtual(v))), real.build()]);
  glb.node({ name: 'Gallery', mesh: glb.mesh('Gallery', all, paint), parent: root });

  const times = sample(LOOP, FPS);
  const steps = writeCat(glb, root, times);

  const keeper = new Rig({ s: 1, x0: KEEPER.x, y0: TOP, z0: KEEPER.z, yaw: KEEPER.yaw });
  const keeperInk = glb.material({ name: 'Keeper', color: T.identity[3], emissive: T.identity[5], emissiveStrength: 0.55, roughness: 0.4 });
  writeFigure(glb, keeper, sampleFigure(keeper, keeperPose), { name: 'Keeper', material: keeperInk, times, parent: root });

  addLabel(glb, labels.len, {
    name: 'LengthLabel',
    metersPerPx: 0.0021,
    translation: [0.62, TOP + 0.002, 0.82],
    rotation: quat([1, 0, 0], (-64 * Math.PI) / 180),
    parent: root
  });

  glb.audio(sound(steps));
  return glb;
}

function sample(duration, fps) {
  const count = Math.round(duration * fps);
  return Array.from({ length: count + 1 }, (_, i) => (i / count) * duration);
}

// ---------------------------------------------------------------------------
// Contact sheet. Cameras are given root-local and turned into world space.

const YAW = (18 * Math.PI) / 180;
const W = (p) => [p[0] * Math.cos(YAW) + p[2] * Math.sin(YAW), p[1], -p[0] * Math.sin(YAW) + p[2] * Math.cos(YAW)];
const FAR_T = 10.2;
const eyeW = W(EYE.toArray());
const tgtW = W(TGT.toArray());
const closeCam = TGT.clone().add(EYE.clone().sub(TGT).normalize().multiplyScalar(1.6));

export const tiles = [
  { label: 'feed', cam: eyeW, look: tgtW, fov: 38, t: 0 },
  { label: 'feed far', cam: eyeW, look: tgtW, fov: 38, t: FAR_T },
  { label: 'feed 2x', cam: eyeW, look: tgtW, fov: 19, t: FAR_T },
  { label: 'side', cam: W([6.0, 1.1, -1.5]), look: W([0, 0.65, -0.95]), fov: 34, t: FAR_T },
  { label: 'side trot', cam: W([4.6, 2.6, -4.2]), look: W([0, 0.6, -0.6]), fov: 38, t: 5.3 },
  { view: 'top', t: FAR_T },
  { label: 'close', cam: W(closeCam.toArray()), look: tgtW, fov: 38, t: 1.0 },
  { label: 'feed far 4x', cam: eyeW, look: W([0.03, 0.62, -1.66]), fov: 8, t: FAR_T },
  { label: 'side at far end', cam: W([3.0, 0.85, -1.62]), look: W([0, 0.6, -1.62]), fov: 24, t: FAR_T }
];

export const design = { EYE: EYE.toArray(), TGT: TGT.toArray(), D, LH, FAR_K, SQ_A, SQ_B };
