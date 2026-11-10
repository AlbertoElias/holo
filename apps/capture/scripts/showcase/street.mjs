import { BufferAttribute, BufferGeometry, BoxGeometry, Color, CylinderGeometry, Matrix4, Quaternion, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { add, lowpass, normalize, pluck, sine, swell, toWav, track } from './lib/audio.mjs';
import { renderLabels } from './lib/browser.mjs';
import { Glb, sample } from './lib/glb.mjs';
import { addLabel, fbm3, noise3, quat, rng } from './lib/parts.mjs';
import { T as TOKEN } from './lib/tokens.mjs';

// "The street that turns to follow you": a reverse-perspective relief. Three
// truncated pyramids stick out of a painting toward the first-view eye, and
// each is painted as a street running away from it, so the far end of every
// street is the part physically nearest you. Move, and the real parallax
// fights the painted one: the streets swing round to follow you.
//
// The paint is a true projection. Each pyramid is, from EYE, the image of a
// straight box-shaped street (cross-sections parallel to the panel, scaled
// about the eye), so every virtual point (across, up, along the street) maps
// to the point of the pyramid on the same ray from EYE.

export const meta = {
  slug: 'the-street-that-turns-to-follow-you',
  name: 'The street that turns to follow you',
  submittedBy: 'Claude (agent-authored)'
};

// ---------------------------------------------------------------- the eye

// Root-local meters (the root is yawed +18° so local +Z faces the feed camera).
const T = [0, 1.24, 0.05]; // what the feed camera looks at (0.69 × H above the floor, measured)
const D = 6.88; // feed camera distance (3.82 × H, measured)
const EYE = [0, T[1] + 0.276 * D, T[2] + 0.961 * D]; // (0, 3.14, 6.66)
const YAW = (18 * Math.PI) / 180;

const PANEL_C = [0, 1.0, -0.15]; // middle of the relief's back plane
const TILT = Math.atan2(EYE[1] - PANEL_C[1], EYE[2] - PANEL_C[2]); // lean back to face EYE
const E_W = Math.hypot(EYE[1] - PANEL_C[1], EYE[2] - PANEL_C[2]); // EYE on the panel's +w axis

const LOOP = 16;
const HOLD = 3;
const SWAY = (10 * Math.PI) / 180;
const TOP = 0.03; // top of the floor slab

// ---------------------------------------------------------------- the relief

const PANEL_W = 2.6;
const BV = 0.6; // half height of the panel and of every pyramid base
const H = 0.55; // pyramid height toward the eye
const R = 0.22; // tip size / base size
const K = 12; // virtual meters per physical meter at the near end
const EDGE_STRIP = 0.1;
const GAP_STRIP = 0.16;
const BASE_W = (PANEL_W - 2 * EDGE_STRIP - 2 * GAP_STRIP) / 3;
const BU = BASE_W / 2;
const CENTRES = [-(BASE_W + GAP_STRIP), 0, BASE_W + GAP_STRIP];
const HV = 2 * BV * K; // virtual building canyon height (14.4 m)
const HH = BV * K; // virtual half height: the eye is at mid height
const WH = BU * K; // virtual half street width
const ZCAP = K * ((E_W - H) / R - E_W); // virtual length of each street
const LAYER = 0.0022; // paint layers lift toward the eye by this much each

const col = (hex) => new Color(hex);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));

const lamOf = (z) => {
  const A = E_W + z / K;
  return clamp((A - E_W) / (A * (1 - R) - H));
};

/** Virtual normalized (X across, Y up, both -1..1) at street distance Z to the panel point. */
function P(st, X, Y, Z) {
  const lam = lamOf(Z);
  const f = 1 - (1 - R) * lam;
  const cu = st.cu * (1 - (H * lam) / E_W);
  return [cu + X * BU * f, Y * BV * f, H * lam];
}

function lift(p, layer) {
  if (!layer) return p;
  const d = new Vector3(-p[0], -p[1], E_W - p[2]).normalize().multiplyScalar(layer * LAYER);
  return [p[0] + d.x, p[1] + d.y, p[2] + d.z];
}

// Colors.
const HAZE = col('#f7e7cc');
const SKY = [
  [0, col('#2a70c4')],
  [0.45, col('#6fb4e6')],
  [0.8, col('#bfe2f0')],
  [1, col('#fff1c8')]
];
function skyColor(lam) {
  for (let i = 1; i < SKY.length; i += 1) {
    if (lam <= SKY[i][0]) {
      const [a, ca] = SKY[i - 1];
      const [b, cb] = SKY[i];
      return ca.clone().lerp(cb, (lam - a) / (b - a));
    }
  }
  return SKY[SKY.length - 1][1].clone();
}
const fog = (z) => 0.5 * (1 - Math.exp(-z / 120));
const SHADE_TINT = col('#4b5d8c');
const shade = (c) => c.clone().lerp(SHADE_TINT, 0.32).multiplyScalar(0.7);

const WALLS = ['#e2a447', '#c9653d', '#e7a7a1', '#f0dcb0', '#efc257', '#e58a63', '#d9877f', '#e9c08f'];
const SHUTTERS = ['#2e6b4e', '#2b5c91', '#25787a', '#3d7a3a'];
const AWNING = ['#c8443a', '#2b5c91', '#2e6b4e', '#d9932f'];
const GLASS = col('#3a2a28');
const CORNICE = col('#f7ecd6');

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

/** In-face coordinates (a, z) to virtual normalized X, Y, Z. a is height on facades, across on paving / sky. */
function faceXYZ(face, a, z) {
  if (face === 'L') return [-1, a / HH - 1, z];
  if (face === 'R') return [1, a / HH - 1, z];
  if (face === 'B') return [a / WH, -1, z];
  return [a / WH, 1, z]; // 'T'
}

/** z values from z0 to z1 with steps of at most `dl` in lambda. */
function zsteps(z0, z1, dl = 0.035) {
  const n = Math.max(1, Math.ceil((lamOf(z1) - lamOf(z0)) / dl));
  const out = [];
  for (let i = 0; i <= n; i += 1) {
    const lam = lamOf(z0) + ((lamOf(z1) - lamOf(z0)) * i) / n;
    const A = (E_W - H * lam) / (1 - (1 - R) * lam);
    out.push(i === 0 ? z0 : i === n ? z1 : K * (A - E_W));
  }
  return out;
}

/**
 * A rectangle on a face in virtual meters, a0..a1 by z0..z1. `colour` is a
 * Color or (a, z) => Color; haze is added by distance unless `sky`.
 */
function rect(paint, st, face, a0, a1, z0, z1, colour, { layer = 0, sky = false, dl = 0.035 } = {}) {
  if (a1 <= a0 || z1 <= z0) return;
  const zs = zsteps(z0, z1, dl);
  const at = (a, z) => lift(P(st, ...faceXYZ(face, a, z)), layer);
  const tint = (a, z) => {
    const c = typeof colour === 'function' ? colour(a, z) : colour.clone();
    return sky ? c : c.lerp(HAZE, fog(z));
  };
  for (let i = 0; i < zs.length - 1; i += 1) {
    const za = zs[i];
    const zb = zs[i + 1];
    paint.quad(at(a0, za), at(a1, za), at(a1, zb), at(a0, zb), tint(a0, za), tint(a1, za), tint(a1, zb), tint(a0, zb));
  }
}

/** A point in the air of the street (x across, y up, z along) to where its ray meets the pyramid. */
function air(st, x, y, z) {
  const X = x / WH;
  const Y = y / HH - 1;
  const Dn = K * E_W + z;
  const s = 1 / Math.max(Math.abs(X), Math.abs(Y), 1e-6);
  const Dp = s * Dn;
  if (Dp - K * E_W > ZCAP) {
    const q = (K * E_W + ZCAP) / Dn;
    return { face: 'C', p: P(st, X * q, Y * q, ZCAP), z: ZCAP };
  }
  const face = Math.abs(X) * s > 0.99999 ? (X < 0 ? 'L' : 'R') : Y < 0 ? 'B' : 'T';
  return { face, p: P(st, X * s, Y * s, Dp - K * E_W), z: Dp - K * E_W };
}

/** A polygon in the air (each vertex [x, y, z]); drawn when all of it lands on one face. */
function airPoly(paint, st, pts, colour, layer = 2) {
  const hits = pts.map(([x, y, z]) => air(st, x, y, z));
  if (hits.some((h) => h.face !== hits[0].face)) return;
  const ps = hits.map((h) => lift(h.p, layer));
  const cs = hits.map((h) => colour.clone().lerp(HAZE, fog(h.z) * 0.8));
  for (let i = 1; i < ps.length - 1; i += 1) paint.tri(ps[0], ps[i], ps[i + 1], cs[0], cs[i], cs[i + 1]);
}

// ---------------------------------------------------------------- one street

function facade(paint, st, side, firstColour) {
  const face = side < 0 ? 'L' : 'R';
  const random = rng(st.seed * 7 + (side < 0 ? 1 : 2));
  const lit = (c) => (side < 0 ? shade(c) : c.clone());
  const pick = (list) => list[Math.floor(random() * list.length)];
  let z = 0;
  let first = true;
  let last = '';
  while (z < ZCAP - 0.01) {
    const width = first ? 11 + random() * 3 : 8 + random() * 9;
    const z1 = ZCAP - (z + width) < 6 ? ZCAP : z + width;
    let hex = first ? firstColour : pick(WALLS);
    if (hex === last) hex = WALLS[(WALLS.indexOf(hex) + 3) % WALLS.length];
    last = hex;
    const wall = lit(col(hex));
    const floors = random() < 0.55 ? 3 : 2;
    const roof = Math.min(HV, 3.8 + floors * 3.1 + 0.7 + (random() < 0.3 ? 0.9 : 0));
    const shutter = lit(col(st.shutters ?? pick(SHUTTERS)));
    rect(paint, st, face, 0, roof, z, z1, wall);
    rect(paint, st, face, roof, HV, z, z1, (a, zz) => skyColor(lamOf(zz)), { sky: true });
    // Cornice and plinth.
    rect(paint, st, face, roof - 0.45, roof, z, z1, lit(CORNICE), { layer: 1 });
    rect(paint, st, face, 0, 0.5, z, z1, lit(col(hex)).multiplyScalar(0.72), { layer: 1 });
    rect(paint, st, face, 3.6, 3.8, z, z1, lit(CORNICE).multiplyScalar(0.92), { layer: 1 });
    // A chimney now and then.
    if (random() < 0.4 && roof < HV - 1.2) {
      const cz = z + 2 + random() * (z1 - z - 4);
      rect(paint, st, face, roof, roof + 1.1, cz, cz + 0.9, lit(col('#b4553a')), { layer: 1 });
    }
    // Ground floor: shopfronts with striped awnings, or doors.
    const shop = random() < 0.65;
    if (shop) {
      const s0 = z + 0.9;
      const s1 = z1 - 0.9;
      rect(paint, st, face, 0.5, 2.9, s0, s1, lit(GLASS), { layer: 1 });
      const awn = col(pick(AWNING));
      for (let q = s0 - 0.2; q < s1 + 0.2; q += 0.7) {
        const c = Math.round((q - s0) / 0.7) % 2 === 0 ? awn : col('#f6efe2');
        rect(paint, st, face, 2.85, 3.45, q, Math.min(q + 0.7, s1 + 0.2), lit(c), { layer: 2 });
      }
    } else {
      for (let q = z + 1.4; q + 1.4 < z1 - 0.8; q += 4.2) {
        rect(paint, st, face, 0.5, 2.9, q, q + 1.4, lit(col('#5a3424')), { layer: 1 });
      }
    }
    // Upper windows with open shutters.
    const balcony = random() < 0.4;
    for (let q = z + 1.4; q + 1.1 + 0.6 < z1 - 0.8; q += 2.7) {
      for (let f = 0; f < floors; f += 1) {
        const sill = 3.8 + f * 3.1 + 0.8;
        if (sill + 1.8 > roof - 0.5) continue;
        rect(paint, st, face, sill, sill + 1.75, q, q + 1.1, lit(GLASS), { layer: 1 });
        rect(paint, st, face, sill, sill + 1.75, q - 0.55, q - 0.03, shutter, { layer: 1 });
        rect(paint, st, face, sill, sill + 1.75, q + 1.13, q + 1.65, shutter, { layer: 1 });
        rect(paint, st, face, sill - 0.14, sill, q - 0.6, q + 1.7, lit(CORNICE), { layer: 1 });
        if (balcony && f === 0) rect(paint, st, face, sill - 0.14, sill + 0.75, q - 0.3, q + 1.4, lit(col('#33302e')), { layer: 2 });
        else if (random() < 0.25) rect(paint, st, face, sill, sill + 0.3, q, q + 1.1, lit(col('#c8443a')), { layer: 2 });
      }
    }
    // Pilaster between buildings.
    if (!first) rect(paint, st, face, 0, roof, z, z + 0.35, lit(CORNICE).multiplyScalar(0.9), { layer: 1 });
    // A wall lantern.
    if (random() < 0.5) {
      const lz = z + width * 0.5;
      rect(paint, st, face, 4.1, 4.7, lz, lz + 0.35, col('#ffd36a'), { layer: 2 });
    }
    first = false;
    z = z1;
  }
}

function paving(paint, st) {
  const xs = -WH + 0.42 * 2 * WH; // the left buildings' shadow ends here
  const pave = (a0, a1, z0, z1, c, layer = 0) => {
    rect(paint, st, 'B', a0, Math.min(a1, xs), z0, z1, shade(c), { layer });
    rect(paint, st, 'B', Math.max(a0, xs), a1, z0, z1, c, { layer });
  };
  const SW = 1.5;
  const walk = col('#dccaa6');
  const road = col('#8e7b66');
  pave(-WH, -WH + SW, 0, ZCAP, walk);
  pave(-WH + SW, WH - SW, 0, ZCAP, road);
  pave(WH - SW, WH, 0, ZCAP, walk);
  const kerb = col('#f3e8d2');
  pave(-WH + SW - 0.22, -WH + SW, 0, ZCAP, kerb, 1);
  pave(WH - SW, WH - SW + 0.22, 0, ZCAP, kerb, 1);
  // Joints: crosswise on the pavements and setts across the road.
  const joint = col('#8c7a60');
  for (let z = 1.2; z < ZCAP * 0.6; z += 1.8) {
    pave(-WH, -WH + SW - 0.22, z, z + 0.1, joint, 1);
    pave(WH - SW + 0.22, WH, z, z + 0.1, joint, 1);
  }
  for (let z = 2; z < ZCAP * 0.6; z += 3) pave(-WH + SW, WH - SW, z, z + 0.08, col('#7a6855'), 1);
  // Tram rails run the whole way to the sea.
  const rail = col('#efe6d2');
  const groove = col('#3f3631');
  for (const x of [-0.78, 0.68]) {
    pave(x, x + 0.14, 0, ZCAP, rail, 2);
    pave(x + 0.14, x + 0.22, 0, ZCAP, groove, 2);
  }
  // A zebra crossing near the corner.
  if (st.zebra) {
    for (let x = -WH + SW + 0.3; x + 0.5 < WH - SW; x += 1.0) pave(x, x + 0.5, 4.5, 8.5, col('#f6f1e6'), 2);
  }
}

function skyFace(paint, st) {
  rect(paint, st, 'T', -WH, WH, 0, ZCAP, (a, z) => skyColor(lamOf(z)), { sky: true, dl: 0.03 });
  const random = rng(st.seed * 13 + 5);
  const cloud = col('#ffffff');
  for (let i = 0; i < st.clouds; i += 1) {
    const zc = 15 + random() * 140;
    const xc = -WH + random() * 2 * WH;
    const len = 8 + random() * 14;
    for (let b = 0; b < 3; b += 1) {
      const z0 = zc + (b - 1) * len * 0.3;
      const rx = (1.2 + random() * 1.2) * (b === 1 ? 1.3 : 1);
      const rz = len * (b === 1 ? 0.45 : 0.3);
      const N = 14;
      const at = (j) => {
        const th = (j / N) * Math.PI * 2;
        const a = clamp(xc + rx * Math.cos(th), -WH, WH);
        const z = Math.max(0.2, z0 + rz * Math.sin(th));
        return [a, z];
      };
      const c0 = lift(P(st, ...faceXYZ('T', clamp(xc, -WH, WH), Math.max(0.2, z0))), 1 + b * 0);
      for (let j = 0; j < N; j += 1) {
        const [a1, z1] = at(j);
        const [a2, z2] = at(j + 1);
        const p1 = lift(P(st, ...faceXYZ('T', a1, z1)), 1);
        const p2 = lift(P(st, ...faceXYZ('T', a2, z2)), 1);
        const tone = cloud.clone().lerp(skyColor(lamOf(z0)), 0.12);
        paint.tri(c0, p1, p2, tone);
      }
    }
  }
}

/** The far end: the street opens onto the sea at the horizon, the brightest part of each street. */
function cap(paint, st) {
  const at = (X, Y) => lift(P(st, X, Y, ZCAP), 0);
  const rows = [
    [1, skyColor(1)],
    [0.45, col(TOKEN.highlight)],
    [0.08, col('#fffbe9')],
    [0, col('#fffbea')],
    [-0.02, col('#cfe3e6')],
    [-0.35, col('#7fb2c9')],
    [-1, col('#4d8fb6')]
  ];
  for (let i = 0; i < rows.length - 1; i += 1) {
    const [y0, c0] = rows[i];
    const [y1, c1] = rows[i + 1];
    paint.quad(at(-1, y0), at(1, y0), at(1, y1), at(-1, y1), c0, c0, c1, c1);
  }
  const atL = (X, Y, l) => lift(P(st, X, Y, ZCAP), l);
  // Glitter under the sun and a quay edge where the paving ends.
  paint.quad(atL(-0.5, -0.05, 1), atL(0.5, -0.05, 1), atL(0.3, -0.16, 1), atL(-0.3, -0.16, 1), col('#fff6d6'));
  paint.quad(atL(-1, -0.9, 1), atL(1, -0.9, 1), atL(1, -1, 1), atL(-1, -1, 1), col('#c9b79a'));
  if (st.sail) {
    const sx = st.sail;
    paint.tri(atL(sx, 0.02, 2), atL(sx + 0.16, 0.02, 2), atL(sx + 0.05, 0.42, 2), col('#ffffff'));
    paint.quad(atL(sx - 0.04, 0.02, 2), atL(sx + 0.22, 0.02, 2), atL(sx + 0.17, -0.06, 2), atL(sx + 0.01, -0.06, 2), col('#7b4a34'));
  }
}

/** Strings across the street: bunting or laundry. */
function strings(paint, st) {
  const random = rng(st.seed * 31 + 3);
  const FLAGS = ['#d8402f', '#f2c341', '#2b6cb3', '#ffffff', '#2e8b57'];
  const LAUNDRY = ['#ffffff', '#f4d7d0', '#a9cde8', '#ffffff', '#f2c341'];
  for (const z of st.strings) {
    const y0 = 9.2 + random() * 2.2;
    const sag = 0.9 + random() * 0.5;
    const rope = (x) => y0 - sag * (1 - (x / WH) ** 2);
    const N = 36;
    for (let i = 0; i < N; i += 1) {
      const xa = -WH + (2 * WH * i) / N;
      const xb = -WH + (2 * WH * (i + 1)) / N;
      airPoly(paint, st, [[xa, rope(xa) + 0.07, z], [xb, rope(xb) + 0.07, z], [xb, rope(xb) - 0.07, z], [xa, rope(xa) - 0.07, z]], col('#5a4a40'), 2);
    }
    if (st.laundry) {
      for (let x = -WH + 0.6; x < WH - 1.2; x += 1.3 + random() * 0.5) {
        const w = 0.8 + random() * 0.4;
        const h = 0.9 + random() * 0.7;
        const c = col(LAUNDRY[Math.floor(random() * LAUNDRY.length)]);
        const top = Math.min(rope(x), rope(x + w));
        airPoly(paint, st, [[x, top, z], [x + w, top, z], [x + w, top - h, z], [x, top - h, z]], c, 3);
      }
    } else {
      let k = 0;
      for (let x = -WH + 0.3; x < WH - 0.7; x += 0.75) {
        const c = col(FLAGS[k % FLAGS.length]);
        k += 1;
        airPoly(paint, st, [[x, rope(x), z], [x + 0.5, rope(x + 0.5), z], [x + 0.25, rope(x + 0.25) - 0.75, z]], c, 3);
      }
    }
  }
}

/** The flat strips of the back plane between streets: the near ends of the blocks, facing you. */
function blockFront(paint, u0, u1, hex, seed) {
  const random = rng(seed);
  const at = (x, y, l) => lift([u0 + x / K, y / K - BV, 0], l);
  const r = (x0, x1, y0, y1, c, l) => paint.quad(at(x0, y0, l), at(x1, y0, l), at(x1, y1, l), at(x0, y1, l), c);
  const w = (u1 - u0) * K;
  const roof = 13.2;
  const wall = col(hex).multiplyScalar(0.94);
  const top = skyColor(0);
  r(0, w, roof, HV, top, 0);
  r(0, w, 0, roof, wall, 0);
  r(0, w, roof - 0.45, roof, CORNICE, 1);
  r(0, w, 3.6, 3.8, CORNICE, 1);
  r(0, w, 0, 0.5, wall.clone().multiplyScalar(0.72), 1);
  const win = Math.min(1.0, w * 0.45);
  const sh = Math.min(0.48, (w - win) / 2 - 0.08);
  const x0 = (w - win) / 2;
  const shutter = col(SHUTTERS[Math.floor(random() * SHUTTERS.length)]);
  for (let f = 0; f < 3; f += 1) {
    const sill = 3.8 + f * 3.1 + 0.8;
    r(x0, x0 + win, sill, sill + 1.75, GLASS, 1);
    r(x0 - sh, x0 - 0.03, sill, sill + 1.75, shutter, 1);
    r(x0 + win + 0.03, x0 + win + sh, sill, sill + 1.75, shutter, 1);
    r(x0 - sh - 0.05, x0 + win + sh + 0.05, sill - 0.14, sill, CORNICE, 1);
    if (f === 0) r(x0, x0 + win, sill, sill + 0.3, col('#c8443a'), 2);
  }
  // A door, and a lamp on a bracket beside it.
  const dw = Math.min(1.1, w * 0.5);
  r((w - dw) / 2, (w + dw) / 2, 0.5, 2.9, col('#5a3424'), 1);
  r((w - dw) / 2 - 0.1, (w + dw) / 2 + 0.1, 2.9, 3.1, CORNICE, 1);
  if (w > 1.5) {
    r(w * 0.12, w * 0.12 + 0.08, 3.0, 3.5, col('#2f2b28'), 2);
    r(w * 0.12 - 0.12, w * 0.12 + 0.2, 3.3, 3.85, col('#ffd36a'), 2);
  }
}

const BLOCKS = ['#efc257', '#e7a7a1', '#e2a447', '#c9653d'];
const STREETS = [
  { seed: 3, clouds: 3, strings: [10, 26, 48, 80], laundry: true, zebra: false, sail: -0.55, shutters: '#2e6b4e' },
  { seed: 5, clouds: 3, strings: [9, 22, 40, 66, 105], laundry: false, zebra: true, sail: 0.2, shutters: undefined },
  { seed: 8, clouds: 3, strings: [14, 34, 60, 95], laundry: true, zebra: false, sail: 0.45, shutters: '#2b5c91' }
];

function relief() {
  const paint = new Paint();
  STREETS.forEach((spec, i) => {
    const st = { ...spec, cu: CENTRES[i] };
    facade(paint, st, -1, BLOCKS[i]);
    facade(paint, st, 1, BLOCKS[i + 1]);
    paving(paint, st);
    skyFace(paint, st);
    cap(paint, st);
    strings(paint, st);
  });
  const edges = [-PANEL_W / 2, ...CENTRES.flatMap((c) => [c - BU, c + BU]), PANEL_W / 2];
  for (let j = 0; j < 4; j += 1) blockFront(paint, edges[2 * j], edges[2 * j + 1], BLOCKS[j], 40 + j);
  return paint.geometry();
}

// ---------------------------------------------------------------- solid things

function tint(geometry, hex) {
  const c = col(hex);
  const n = geometry.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) colors.set([c.r, c.g, c.b], i * 3);
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  return geometry;
}
function box(sx, sy, sz, at, hex) {
  const g = new BoxGeometry(sx, sy, sz);
  g.translate(...at);
  return tint(g, hex);
}
function beam(a, b, radius, hex, radial = 10) {
  const va = new Vector3(...a);
  const vb = new Vector3(...b);
  const dir = vb.clone().sub(va);
  const g = new CylinderGeometry(radius, radius, dir.length(), radial);
  g.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.clone().normalize()));
  const mid = va.add(vb).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return tint(g, hex);
}
function disc(radius, height, at, hex, radial = 20) {
  const g = new CylinderGeometry(radius, radius, height, radial);
  g.translate(at[0], at[1] + height / 2, at[2]);
  return tint(g, hex);
}

const MOUNT = new Matrix4().compose(
  new Vector3(...PANEL_C),
  new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -TILT),
  new Vector3(1, 1, 1)
);
const mountToLocal = (p) => new Vector3(...p).applyMatrix4(MOUNT).toArray();

const WOOD = '#6e4a2c';
function frameGeometry() {
  const F = 0.05;
  const parts = [
    box(PANEL_W + 2 * F, F, 0.075, [0, BV + F / 2, 0.01], WOOD),
    box(PANEL_W + 2 * F, F, 0.075, [0, -BV - F / 2, 0.01], WOOD),
    box(F, 2 * BV, 0.075, [-PANEL_W / 2 - F / 2, 0, 0.01], WOOD),
    box(F, 2 * BV, 0.075, [PANEL_W / 2 + F / 2, 0, 0.01], WOOD),
    box(PANEL_W, 2 * BV, 0.024, [0, 0, -0.013], '#a2835c'),
    box(1.1, 0.03, 0.13, [0, -BV - 0.065, 0.03], WOOD),
    box(0.14, 0.3, 0.05, [0, 0, -0.05], WOOD),
    box(0.14, 0.3, 0.05, [0, 0.45, -0.05], WOOD),
    box(0.14, 0.2, 0.05, [0, -0.45, -0.05], WOOD)
  ];
  return mergeGeometries(parts);
}

/** The easel: a mast behind the panel's swing axis on a tripod, a stool, paint pots and brushes. */
function studioGeometry() {
  const parts = [];
  const mastW = -0.085;
  const vAt = (y) => {
    // v on the mast line where root-local height is y.
    const a = mountToLocal([0, 0, mastW]);
    const b = mountToLocal([0, 1, mastW]);
    return (y - a[1]) / (b[1] - a[1]);
  };
  const hub = mountToLocal([0, vAt(0.24), mastW]);
  const mastTop = mountToLocal([0, BV + 0.1, mastW]);
  parts.push(beam(hub, mastTop, 0.026, WOOD));
  parts.push(beam(hub, [-0.62, TOP, 0.42], 0.02, WOOD));
  parts.push(beam(hub, [0.62, TOP, 0.42], 0.02, WOOD));
  parts.push(beam(mountToLocal([0, BV - 0.1, mastW]), [0, TOP, -0.6], 0.02, WOOD));
  parts.push(beam([-0.42, 0.12, 0.33], [0.42, 0.12, 0.33], 0.012, WOOD));
  // The stool, with a palette on it.
  const sx = -1.1;
  const sz = 0.36;
  parts.push(disc(0.17, 0.035, [sx, 0.36, sz], '#7d5634'));
  for (const [dx, dz] of [[0.11, 0.11], [-0.11, 0.11], [0.11, -0.11], [-0.11, -0.11]]) {
    parts.push(beam([sx + dx * 1.35, TOP, sz + dz * 1.35], [sx + dx * 0.8, 0.36, sz + dz * 0.8], 0.014, WOOD));
  }
  const palette = disc(0.15, 0.012, [0, 0, 0], '#c9a477', 24);
  palette.scale(1.25, 1, 0.85);
  palette.translate(sx, 0.397, sz);
  parts.push(palette);
  // Paint pots and a jar of brushes on the right.
  const pots = [[0.98, 0.4, 0.075], [1.15, 0.22, 0.065], [0.82, 0.52, 0.06]];
  for (const [x, z, r] of pots) parts.push(disc(r, 0.13, [x, TOP, z], '#9aa2a6'));
  parts.push(disc(0.055, 0.15, [1.2, TOP, 0.45], '#b9c9cc'));
  const brushes = [[1.17, 0.43, -0.07, 0.04], [1.23, 0.43, 0.06, 0.03], [1.22, 0.48, 0.02, -0.06], [1.19, 0.47, -0.02, -0.04]];
  for (const [x, z, dx, dz] of brushes) {
    parts.push(beam([x, TOP + 0.03, z], [x + dx * 2.5, TOP + 0.26, z + dz * 2.5], 0.0075, '#c23b2f', 8));
    parts.push(beam([x + dx * 2.5, TOP + 0.26, z + dz * 2.5], [x + dx * 2.9, TOP + 0.31, z + dz * 2.9], 0.011, '#3a2a20', 8));
  }
  // The pennant's pole.
  parts.push(beam(mastTop, [mastTop[0], mastTop[1] + 0.16, mastTop[2]], 0.008, WOOD, 8));
  return { geometry: mergeGeometries(parts), mastTop };
}

/** Paint on the pots, the palette and the floor: unlit dabs. */
function dabsGeometry() {
  const paint = new Paint();
  const blob = (x, y, z, rx, rz, hex, n = 16) => {
    const c = col(hex);
    for (let j = 0; j < n; j += 1) {
      const a = (j / n) * Math.PI * 2;
      const b = ((j + 1) / n) * Math.PI * 2;
      const wob = (t) => 1 + 0.18 * Math.sin(t * 3 + x * 9);
      paint.tri([x, y, z], [x + rx * wob(b) * Math.cos(b), y, z + rz * wob(b) * Math.sin(b)], [x + rx * wob(a) * Math.cos(a), y, z + rz * wob(a) * Math.sin(a)], c);
    }
  };
  blob(0.98, TOP + 0.132, 0.4, 0.07, 0.07, '#e2a447');
  blob(1.15, TOP + 0.132, 0.22, 0.06, 0.06, '#c9653d');
  blob(0.82, TOP + 0.132, 0.52, 0.055, 0.055, '#2f7fd0');
  const py = 0.404;
  const dabs = ['#e2a447', '#c9653d', '#e7a7a1', '#2f7fd0', '#2e6b4e', '#ffffff', '#efc257'];
  dabs.forEach((hex, i) => {
    const a = -2.2 + i * 0.55;
    blob(-1.1 + 0.13 * Math.cos(a), py, 0.36 + 0.09 * Math.sin(a), 0.026, 0.022, hex, 10);
  });
  const random = rng(77);
  for (let i = 0; i < 9; i += 1) {
    const x = -0.9 + random() * 1.8;
    const z = 0.12 + random() * 0.38;
    const r = 0.02 + random() * 0.05;
    blob(x, TOP + 0.0012, z, r, r * (0.6 + random() * 0.5), dabs[i % dabs.length], 14);
  }
  return paint.geometry();
}

// ---------------------------------------------------------------- the floor

const SLAB = { rx: 1.4, rz: 0.74, p: 3.4 };
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
  return r0 + tear(th * 1.9, 4, 0.07);
}
function boards(x, z) {
  const row = Math.floor((z + 2) / 0.16);
  const seam = Math.abs(((z + 2) / 0.16) - row - 0.5) > 0.46 ? 0.7 : 1;
  const tone = 0.86 + 0.18 * noise3(row * 1.7, 0.3, 0.2, 3) + 0.12 * (fbm3(x * 3, row, 0.5, { octaves: 3, seed: 9 }) - 0.5);
  return col('#8f7356').multiplyScalar(tone * seam);
}
function slabGeometry() {
  const paint = new Paint();
  const N = 240;
  const RINGS = 18;
  const TAU = Math.PI * 2;
  const ring = (r, th, y = TOP) => [r * Math.cos(th), y, r * Math.sin(th)];
  for (let j = 0; j < N; j += 1) {
    const a = (j / N) * TAU;
    const b = ((j + 1) / N) * TAU;
    const ra = slabR(a) - 0.035;
    const rb = slabR(b) - 0.035;
    for (let k = 0; k < RINGS; k += 1) {
      const f0 = k / RINGS;
      const f1 = (k + 1) / RINGS;
      const p = [ring(ra * f0, a), ring(rb * f0, b), ring(rb * f1, b), ring(ra * f1, a)];
      paint.quad(p[0], p[1], p[2], p[3], ...p.map((q) => boards(q[0], q[2])));
    }
    const scorch = col('#2b1a10');
    const gold = col(TOKEN.gold);
    const high = col(TOKEN.highlight);
    const Ra = slabR(a);
    const Rb = slabR(b);
    const bands = [[0.035, boards(ra * Math.cos(a), ra * Math.sin(a))], [0.02, scorch], [0.008, gold], [0, high]];
    for (let q = 0; q < bands.length - 1; q += 1) {
      const [w0, c0] = bands[q];
      const [w1, c1] = bands[q + 1];
      paint.quad(ring(Ra - w0, a, TOP + 0.0006), ring(Rb - w0, b, TOP + 0.0006), ring(Rb - w1, b, TOP + 0.0006), ring(Ra - w1, a, TOP + 0.0006), c0, c0, c1, c1);
    }
    paint.quad(ring(Ra, a, TOP + 0.0006), ring(Rb, b, TOP + 0.0006), ring(Rb * 0.995, b, TOP * 0.55), ring(Ra * 0.995, a, TOP * 0.55), gold, gold, scorch, scorch);
    paint.quad(ring(Ra * 0.995, a, TOP * 0.55), ring(Rb * 0.995, b, TOP * 0.55), ring(Rb * 0.985, b, 0), ring(Ra * 0.985, a, 0), scorch, scorch, col('#160d08'), col('#160d08'));
    paint.tri([0, 0, 0], ring(Ra * 0.985, b, 0), ring(Ra * 0.985, a, 0), col('#120a06'));
  }
  return paint.geometry();
}

// ---------------------------------------------------------------- motion and sound

const ease = (u) => u - Math.sin(2 * Math.PI * u) / (2 * Math.PI);
function swayAngle(t) {
  if (t <= HOLD) return 0;
  const u = (t - HOLD) / (LOOP - HOLD);
  return SWAY * Math.sin(2 * Math.PI * ease(u));
}
function easeInverse(e) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (ease(mid) < e) lo = mid;
    else hi = mid;
  }
  return lo;
}
const PEAK_A = +(HOLD + (LOOP - HOLD) * easeInverse(0.25)).toFixed(3);
const PEAK_B = +(HOLD + (LOOP - HOLD) * easeInverse(0.75)).toFixed(3);
const MIDDLE = +(HOLD + (LOOP - HOLD) * 0.5).toFixed(3);

function sound() {
  const out = track(LOOP);
  // Two soft accordion chords, each a pair of slightly detuned reeds, crossfading
  // so their sum stays level: C major at rest, F major through the swing.
  const reed = (hz) => (t) => {
    let s = 0;
    for (let n = 1; n <= 5; n += 1) s += Math.sin(2 * Math.PI * hz * n * t) / (n * n * 0.7 + 0.3);
    return s;
  };
  const chord = (notes) => (t) => notes.reduce((s, hz) => s + reed(hz)(t) + reed(hz * 1.0035)(t), 0);
  const pad = track(LOOP);
  add(pad, -5, LOOP, chord([130.81, 261.63, 329.63, 392.0]), (t) => 0.06 * Math.sin((Math.PI * t) / LOOP) ** 2);
  add(pad, 3, LOOP, chord([174.61, 220.0, 261.63, 349.23]), (t) => 0.06 * Math.sin((Math.PI * t) / LOOP) ** 2);
  lowpass(pad, 1400);
  for (let i = 0; i < out.length; i += 1) out[i] += pad[i];
  // A slow bellows breath over the whole loop, so the pad is not static.
  add(out, 0, LOOP, () => 0, swell(LOOP));
  // Distant bells: one as the street starts to turn, one at each extreme, one coming home.
  const bell = (hz) => (t) => sine(hz)(t) + 0.3 * sine(hz * 2.0)(t) + 0.12 * sine(hz * 2.76)(t);
  const far = track(LOOP);
  add(far, HOLD + 0.2, 4, bell(523.25), (t) => 0.22 * pluck(0.006, 1.1)(t));
  add(far, PEAK_A, 4, bell(659.25), (t) => 0.2 * pluck(0.006, 1.2)(t));
  add(far, PEAK_B, 4, bell(587.33), (t) => 0.2 * pluck(0.006, 1.2)(t));
  add(far, LOOP - 1.2, 4, bell(392.0), (t) => 0.18 * pluck(0.006, 1.3)(t));
  lowpass(far, 2400);
  for (let i = 0; i < out.length; i += 1) out[i] += far[i];
  return toWav(normalize(out, 0.6));
}

// ---------------------------------------------------------------- build

export async function build() {
  const labels = await renderLabels([
    { id: 'note', text: 'Every street here points at you.', font: 'title', italic: true, size: 30, color: TOKEN.gold }
  ]);

  const glb = new Glb();
  glb.provenance({
    holoim: {
      authored: 'synthetic',
      author: meta.submittedBy,
      title: meta.name,
      trick: 'reverse perspective: painted far ends are the physically nearest points',
      firstViewEye: { eye: EYE, target: T, distance: D, frame: 'root-local, root yawed 18 degrees' }
    }
  });
  const root = glb.node({ name: 'StreetRoot', rotation: quat([0, 1, 0], YAW) });

  const paintInk = glb.material({ name: 'Paint', unlit: true, doubleSided: true });
  const solid = glb.material({ name: 'Wood', roughness: 0.85 });
  const floor = glb.material({ name: 'Floor', roughness: 1 });

  glb.node({ name: 'Floor', mesh: glb.mesh('Floor', slabGeometry(), floor), parent: root });
  const studio = studioGeometry();
  glb.node({ name: 'Easel', mesh: glb.mesh('Easel', studio.geometry, solid), parent: root });
  glb.node({ name: 'PaintDabs', mesh: glb.mesh('PaintDabs', dabsGeometry(), paintInk), parent: root });

  const mount = glb.node({ name: 'ReliefMount', translation: PANEL_C, rotation: quat([1, 0, 0], -TILT), parent: root });
  const sway = glb.node({ name: 'ReliefSway', parent: mount });
  glb.node({ name: 'ReliefFrame', mesh: glb.mesh('ReliefFrame', frameGeometry(), solid), parent: sway });
  glb.node({ name: 'ReliefPaint', mesh: glb.mesh('ReliefPaint', relief(), paintInk), parent: sway });
  const swayTrack = sample(LOOP, 30, (t) => quat([0, 1, 0], swayAngle(t)));
  glb.animate(sway, 'rotation', swayTrack.times, swayTrack.values);

  // The pennant on top of the mast.
  const pen = new Paint();
  const red = col('#c9653d');
  pen.tri([0, 0.16, 0], [0, 0.08, 0], [0.17, 0.12, 0], red);
  const pennant = glb.node({ name: 'Pennant', mesh: glb.mesh('Pennant', pen.geometry(), paintInk), translation: studio.mastTop, parent: root });
  const flutter = sample(LOOP, 15, (t) => quat([0, 1, 0], 0.5 + 0.35 * Math.sin((2 * Math.PI * 3 * t) / LOOP) + 0.12 * Math.sin((2 * Math.PI * 7 * t) / LOOP)));
  glb.animate(pennant, 'rotation', flutter.times, flutter.values);

  const toEye = Math.atan2(EYE[1] - TOP, EYE[2] - 0.5);
  addLabel(glb, labels.note, { name: 'Note', metersPerPx: 0.0016, translation: [0, TOP + 0.002, 0.5], rotation: quat([1, 0, 0], -(Math.PI / 2 - toEye) * 0.85), parent: root });

  glb.audio(sound());
  return glb;
}

// ---------------------------------------------------------------- the sheet

const world = (p) => [p[0] * Math.cos(YAW) + p[2] * Math.sin(YAW), p[1], -p[0] * Math.sin(YAW) + p[2] * Math.cos(YAW)];
const W_EYE = world(EYE);
const W_T = world(T);
const DIR = [0.297, 0.276, 0.914];
const CLOSE = W_T.map((v, i) => v + DIR[i] * 1.6);
const ABOVE = world([0, PANEL_C[1] + 3.2 * Math.cos(TILT), PANEL_C[2] - 3.2 * Math.sin(TILT) + 0.02]);

export const tiles = [
  { label: 'feed', cam: W_EYE, look: W_T, fov: 38, t: 0 },
  { label: 'feed +10', cam: W_EYE, look: W_T, fov: 38, t: PEAK_A },
  { label: 'feed -10', cam: W_EYE, look: W_T, fov: 38, t: PEAK_B },
  { label: 'feed 2x', cam: W_EYE, look: W_T, fov: 19, t: 0 },
  { label: 'feed 2x +10', cam: W_EYE, look: W_T, fov: 19, t: PEAK_A },
  { label: 'feed 2x -10', cam: W_EYE, look: W_T, fov: 19, t: PEAK_B },
  { label: 'side yaw 90', cam: [W_T[0] + 6.6, W_T[1] + 1.1, W_T[2]], look: W_T, fov: 38, t: 0 },
  { label: 'above edge', cam: ABOVE, look: world(PANEL_C), fov: 45, t: 0 },
  { label: 'close 1.6 m', cam: CLOSE, look: W_T, fov: 45, t: MIDDLE }
];
