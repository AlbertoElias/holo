import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  LatheGeometry,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  Vector2,
  Vector3
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { add, lowpass, noise, normalize, pluck, sine, toWav, track } from './lib/audio.mjs';
import { renderLabels } from './lib/browser.mjs';
import { Glb } from './lib/glb.mjs';
import { addLabel, fbm3, noise3, quat, rng } from './lib/parts.mjs';
import { T } from './lib/tokens.mjs';

// "Every moment of the dive": one forward 1½ somersault in tuck from a 1 m
// springboard, frozen as a row of statues, one every 1/14 s of real time,
// each standing where the diver was at that instant. A living diver moves
// through them in slow motion and fits each one, because statues and diver
// are drawn from the same pose function of dive time. The centre of mass
// flies a true parabola (g = 9.81); the somersault rate comes from a
// conserved angular momentum and the body's changing moment of inertia.

export const meta = {
  slug: 'every-moment-of-the-dive',
  name: 'Every moment of the dive',
  submittedBy: 'Claude (agent-authored)'
};

const DEG = Math.PI / 180;
const LOOP = 16;
const FPS = 30;
const HIDDEN = [1e-4, 1e-4, 1e-4];

// ------------------------------------------------------------------ the place

const G = 9.81;
const VX = 1.0; // take-off velocity, m/s
const VY = 4.0;
const RATE = 14; // statues per second of real time
const SURF = 0.11; // water surface
const RIM_Y = 0.15; // pool edge and deck
const CLIP = SURF - 0.025; // below this a body is under water
const BOARD_TOP = SURF + 1.0;
const BOARD_T = 0.06;
const BOARD_LEN = 1.5;
const BOARD_W = 0.5;
const TIP_X = -0.3;
const BOARD_BACK = TIP_X - BOARD_LEN;
const DECK_X = -0.95; // the tiled edge: deck left of this, water right of it
const EDGE = [TIP_X - 0.012, BOARD_TOP]; // where the toes stand

// ------------------------------------------------------------------ small math

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => {
  const u = clamp((x - a) / (b - a));
  return u * u * (3 - 2 * u);
};
const smoother = (a, b, x) => {
  const u = clamp((x - a) / (b - a));
  return u * u * u * (u * (u * 6 - 15) + 10);
};
const dir = (a) => [Math.cos(a), Math.sin(a)];
const addv = (p, d, s = 1) => [p[0] + d[0] * s, p[1] + d[1] * s];
const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
const ang = (v) => Math.atan2(v[1], v[0]);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Cubic Hermite through keys [t, value, slope] (value may be an array). */
function hermite(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i += 1) {
    const [t0, p0, m0] = keys[i];
    const [t1, p1, m1] = keys[i + 1];
    if (t > t1) continue;
    const h = t1 - t0;
    const u = (t - t0) / h;
    const h00 = 2 * u ** 3 - 3 * u ** 2 + 1;
    const h10 = u ** 3 - 2 * u ** 2 + u;
    const h01 = -2 * u ** 3 + 3 * u ** 2;
    const h11 = u ** 3 - u ** 2;
    const f = (a, b, ma, mb) => h00 * a + h10 * h * ma + h01 * b + h11 * h * mb;
    if (Array.isArray(p0)) return p0.map((_, k) => f(p0[k], p1[k], m0[k], m1[k]));
    return f(p0, p1, m0, m1);
  }
  return keys[keys.length - 1][1];
}

// ------------------------------------------------------------------ the body
// A 1.70 m mannequin in the XY plane, facing +X (the water), its right side
// toward the viewer (+Z). Angles: the lower trunk leans forward by phi.

const L = { pel: 0.23, chest: 0.27, head: 0.28, ua: 0.3, fa: 0.255, hand: 0.17, th: 0.42, sh: 0.415, ft: 0.19 };
const SH_Z = 0.17;
const HIP_Z = 0.09;

// Segment: name, from, to, mass fraction, COM fraction, radius of gyration / length, side.
const SEGMENTS = [
  ['pelvis', 'P', 'W', 0.25, 0.45, 0.45, 0],
  ['chest', 'W', 'N', 0.247, 0.5, 0.42, 0],
  ['head', 'N', 'Ht', 0.081, 0.6, 0.3, 0],
  ...[-1, 1].flatMap((s) => {
    const n = s < 0 ? 'L' : 'R';
    return [
      [`upperArm${n}`, 'S', 'E', 0.028, 0.44, 0.3, s],
      [`forearm${n}`, 'E', 'Wr', 0.016, 0.43, 0.3, s],
      [`hand${n}`, 'Wr', 'Hd', 0.006, 0.5, 0.3, s],
      [`thigh${n}`, 'P', 'K', 0.1, 0.43, 0.3, s],
      [`shin${n}`, 'K', 'A', 0.0465, 0.43, 0.3, s],
      [`foot${n}`, 'A', 'Toe', 0.0145, 0.5, 0.3, s]
    ];
  })
];
const NOMINAL = { pelvis: L.pel, chest: L.chest, head: L.head, upperArm: L.ua, forearm: L.fa, hand: L.hand, thigh: L.th, shin: L.sh, foot: L.ft };
const kind = (name) => name.replace(/[LR]$/, '');

/** Planar two-bone IK; `bend` +1 turns the second bone counterclockwise from the first. */
function twoBone(root, target, a, b, bend) {
  const v = sub2(target, root);
  const d = clamp(Math.hypot(...v), Math.abs(a - b) + 1e-4, (a + b) * 0.9995);
  const base = ang(v);
  const off = Math.acos(clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1));
  const first = base - bend * off;
  const mid = addv(root, dir(first), a);
  return { mid, reach: Math.hypot(...v) / (a + b) };
}

/**
 * Joints from a pelvis point P, trunk lean phi and a shape. Shape angles
 * (radians): sp spine, n neck, s shoulder, e elbow, w wrist, h hip, k knee,
 * p plantar; optional `ankle` (absolute) + `foot` (world angle) for legs
 * standing on the board; `armIK` weight toward holding the shins; `zw`
 * wrist z (hands together in the streamline).
 */
function joints(P, phi, sh) {
  const j = { P };
  const up = Math.PI / 2 - phi;
  j.W = addv(P, dir(up), L.pel);
  const ac = up - sh.sp;
  j.N = addv(j.W, dir(ac), L.chest);
  j.Ht = addv(j.N, dir(ac - sh.n), L.head);
  j.S = addv(j.N, dir(ac), -0.045);
  // Legs.
  let reach = 0;
  if (sh.ankle) {
    j.A = sh.ankle;
    const ik = twoBone(P, j.A, L.th, L.sh, -1);
    j.K = ik.mid;
    reach = ik.reach;
    j.Toe = addv(j.A, dir(sh.foot), L.ft);
  } else {
    const at = up - Math.PI + sh.h;
    j.K = addv(P, dir(at), L.th);
    const as = at - sh.k;
    j.A = addv(j.K, dir(as), L.sh);
    j.Toe = addv(j.A, dir(as + Math.PI / 2 - sh.p), L.ft);
  }
  // Arms: forward kinematics, blended toward holding the shins.
  const aua = ac - Math.PI + sh.s;
  let a1 = aua;
  let a2 = aua + sh.e;
  if (sh.armIK > 0) {
    const shin = sub2(j.A, j.K);
    const front = [shin[1], -shin[0]].map((v) => v / Math.hypot(...shin)); // shin rotated CCW 90 = its front
    const grip = addv(addv(j.K, shin, 0.32), front, -0.055);
    const ik = twoBone(j.S, grip, L.ua, L.fa, 1);
    const b1 = ang(sub2(ik.mid, j.S));
    const b2 = ang(sub2(grip, ik.mid));
    a1 = aua + wrap(b1 - aua) * sh.armIK;
    a2 = aua + sh.e + wrap(b2 - (aua + sh.e)) * sh.armIK;
  }
  j.E = addv(j.S, dir(a1), L.ua);
  j.Wr = addv(j.E, dir(a2), L.fa);
  j.Hd = addv(j.Wr, dir(a2 + sh.w), L.hand);
  j.reach = reach;
  j.zw = sh.zw ?? SH_Z;
  return j;
}

function com(j) {
  let x = 0;
  let y = 0;
  for (const [, a, b, m, f] of SEGMENTS) {
    x += m * (j[a][0] + f * (j[b][0] - j[a][0]));
    y += m * (j[a][1] + f * (j[b][1] - j[a][1]));
  }
  return [x, y];
}

/** Moment of inertia about the COM and angular momentum of shape change (unit mass). */
function inertiaAndH(ja, jb, dt) {
  const ca = com(ja);
  const cb = com(jb);
  let I = 0;
  let H = 0;
  for (const [, a, b, m, f, k] of SEGMENTS) {
    const pa = [ja[a][0] + f * (ja[b][0] - ja[a][0]) - ca[0], ja[a][1] + f * (ja[b][1] - ja[a][1]) - ca[1]];
    const pb = [jb[a][0] + f * (jb[b][0] - jb[a][0]) - cb[0], jb[a][1] + f * (jb[b][1] - jb[a][1]) - cb[1]];
    const len = Math.hypot(...sub2(ja[b], ja[a]));
    const own = m * (k * len) ** 2;
    I += m * (pa[0] ** 2 + pa[1] ** 2) + own;
    const v = [(pb[0] - pa[0]) / dt, (pb[1] - pa[1]) / dt];
    const w = wrap(ang(sub2(jb[b], jb[a])) - ang(sub2(ja[b], ja[a]))) / dt;
    H += m * (pa[0] * v[1] - pa[1] * v[0]) + own * w;
  }
  return { I, H };
}

// ------------------------------------------------------------------ the dive
// Dive time tau: 0 at take-off. Shapes before take-off (on the board) and
// in the air, as functions of tau.

const TAU_A = -6 / RATE; // the first statue: standing still at the tip
const FOOT_FLAT = -20 * DEG;
const PHI0 = 14 * DEG; // forward lean at take-off

function flightShape(t) {
  const tin = smoother(0.0, 0.2, t);
  const kin = smoother(0.03, 0.22, t);
  const out = smoother(0.66, 0.85, t);
  const f = tin * (1 - out);
  const fk = kin * (1 - smoother(0.67, 0.86, t));
  const reachUp = smoother(0.66, 0.86, t);
  return {
    sp: 24 * DEG * f,
    n: (-6 + 36 * f + 4 * reachUp * (1 - f)) * DEG,
    s: (165 + 15 * reachUp) * DEG,
    e: 8 * DEG * (1 - reachUp),
    w: (-50 * smoother(0.88, 1.0, t) + 25 * f) * DEG,
    h: 132 * DEG * f,
    k: 142 * DEG * fk,
    p: (95 - 18 * f) * DEG,
    armIK: smoother(0.03, 0.16, t) * (1 - smoother(0.65, 0.76, t)),
    zw: SH_Z - 0.035 * f - 0.12 * smoother(0.76, 0.95, t)
  };
}

function boardShape(t, breath = 0) {
  const lift = smoother(TAU_A + 0.03, -0.1, t);
  const squat = Math.exp(-(((t + 0.19) / 0.11) ** 2));
  return {
    sp: (8 * squat - 2 * breath) * DEG,
    n: (-6 * smoother(TAU_A, 0, t) - 2 * breath) * DEG,
    s: (180 * lift - 15 * smoother(-0.1, 0, t) + 5 * breath) * DEG,
    e: (12 - 4 * smoother(-0.15, 0, t)) * DEG,
    w: 0,
    armIK: 0,
    zw: SH_Z
  };
}

/** Everything the dive needs, solved once: take-off, rotation table, contact. */
function solveDive() {
  // Take-off pose: flight shape at 0, toes on the board edge.
  const sh0 = flightShape(0);
  const j00 = joints([0, 0], PHI0, sh0);
  const P0 = sub2(EDGE, sub2(j00.Toe, [0, 0]));
  const j0 = joints(P0, PHI0, sh0);
  const C0 = com(j0);
  const foot0 = ang(sub2(j0.Toe, j0.A));

  // Standing pose: upright, foot flat with the toes on the edge.
  const ankleStand = addv(EDGE, dir(FOOT_FLAT), -L.ft);
  const Pstand = [ankleStand[0], ankleStand[1] + (L.th + L.sh) * 0.9995];
  const shStand = { ...boardShape(TAU_A), ankle: ankleStand, foot: FOOT_FLAT };
  const Cstand = com(joints(Pstand, 0, shStand));

  // Rotation in the air from conserved angular momentum.
  const DT = 1 / (RATE * 100);
  const N = Math.round(1.4 / DT);
  const I = [];
  const H = [];
  for (let i = 0; i <= N; i += 1) {
    const t = i * DT;
    const ja = joints([0, 0], 0, flightShape(t));
    const jb = joints([0, 0], 0, flightShape(t + 1e-4));
    const r = inertiaAndH(ja, jb, 1e-4);
    I.push(r.I);
    H.push(r.H);
  }
  const Cflight = (t) => [C0[0] + VX * t, C0[1] + VY * t - 0.5 * G * t * t];
  let tc = 1.0;
  let target = 540 * DEG;
  let L0 = 0;
  let phiTable = [];
  for (let iter = 0; iter < 8; iter += 1) {
    const nc = Math.round(tc / DT);
    let A = 0;
    let B = 0;
    for (let i = 0; i < nc; i += 1) {
      A += DT / I[i];
      B += (H[i] * DT) / I[i];
    }
    L0 = (target - PHI0 + B) / A;
    phiTable = [PHI0];
    for (let i = 0; i < N; i += 1) phiTable.push(phiTable[i] + ((L0 - H[i]) / I[i]) * DT);
    // Hand contact: the first time after the apex the hands reach the water.
    let found = tc;
    for (let i = Math.round(0.45 / DT); i < N; i += 1) {
      const t = i * DT;
      const j = joints([0, 0], phiTable[i], flightShape(t));
      const c = com(j);
      const handY = Cflight(t)[1] + Math.min(j.Hd[1], j.Wr[1]) - c[1] - 0.02;
      if (handY <= SURF) {
        found = t;
        break;
      }
    }
    tc = found;
    const ic = Math.round(tc / DT);
    const wc = (L0 - H[ic]) / I[ic];
    target = 540 * DEG - wc * 0.05;
  }
  const ic = Math.round(tc / DT);
  const phiC = phiTable[ic];
  const omegaC = (L0 - H[ic]) / I[ic];
  const omega0 = (L0 - H[0]) / I[0];
  const shC = flightShape(tc);
  const Cc = Cflight(tc);
  const vyC = VY - G * tc;
  return { DT, I, H, L0, phiTable, tc, phiC, omegaC, omega0, C0, P0, foot0, Cstand, Pstand, ankleStand, shC, Cc, vyC, Cflight };
}

const D = solveDive();

/** The whole body at dive time t: joints, plus `breath` for the living chest. */
function poseAt(t) {
  if (t < TAU_A) {
    // Standing at the tip before the dive: breathing, two breaths in 3 s.
    const breath = 0.5 * (1 - Math.cos((2 * Math.PI * (t - TAU_A)) / 1.5));
    const sh = { ...boardShape(TAU_A, breath), ankle: D.ankleStand, foot: FOOT_FLAT };
    return { j: joints(D.Pstand, 0, sh), breath };
  }
  if (t < 0) {
    const C = hermite(
      [
        [TAU_A, D.Cstand, [0, 0]],
        [-0.19, [D.Cstand[0] + 0.035, D.Cstand[1] - 0.13], [0.3, 0]],
        [0, D.C0, [VX, VY]]
      ],
      t
    );
    const phi = hermite(
      [
        [TAU_A, 0, 0],
        [-0.19, 9 * DEG, 0.5],
        [0, PHI0, D.omega0]
      ],
      t
    );
    const foot = FOOT_FLAT + (D.foot0 - FOOT_FLAT) * smoother(-0.17, 0, t);
    const ankle = addv(EDGE, dir(foot), -L.ft);
    const sh = { ...boardShape(t), ankle, foot };
    let P = sub2(C, [0, 0.0]);
    P = [P[0], P[1] - 0.05];
    let j = joints(P, phi, sh);
    for (let i = 0; i < 12; i += 1) {
      const c = com(j);
      P = addv(P, sub2(C, c));
      j = joints(P, phi, sh);
    }
    return { j, breath: 0 };
  }
  let phi;
  let C;
  let sh;
  if (t <= D.tc) {
    const x = t / D.DT;
    const i = Math.min(Math.floor(x), D.phiTable.length - 2);
    phi = D.phiTable[i] + (D.phiTable[i + 1] - D.phiTable[i]) * (x - i);
    C = D.Cflight(t);
    sh = flightShape(t);
  } else {
    // In the water: rotation stops on the vertical, the body slows.
    const dt = t - D.tc;
    const tdr = (540 * DEG - D.phiC) / D.omegaC;
    phi = D.phiC + D.omegaC * tdr * (1 - Math.exp(-dt / tdr));
    C = [D.Cc[0] + VX * 0.15 * (1 - Math.exp(-dt / 0.15)), D.Cc[1] + D.vyC * 2.0 * (1 - Math.exp(-dt / 2.0))];
    sh = D.shC;
  }
  const j0 = joints([0, 0], phi, sh);
  const c0 = com(j0);
  return { j: joints(sub2(C, c0), phi, sh), breath: 0 };
}

/** 3D segments of a pose. */
function segmentsOf(j) {
  return SEGMENTS.map(([name, a, b, , , , side]) => {
    const arm = /Arm|forearm|hand/.test(name);
    const zOf = (p) => {
      if (side === 0) return 0;
      if (!arm) return side * HIP_Z;
      if (p === 'S') return side * SH_Z;
      if (p === 'E') return side * (SH_Z + j.zw) / 2;
      return side * j.zw;
    };
    return { name, a: [...j[a], zOf(a)], b: [...j[b], zOf(b)] };
  });
}

// Which end of each segment stays up longest as it enters the water: the
// segment's mesh grows from that end, so going under shortens it from below.
const ENTRY = segmentsOf(poseAt(D.tc + 0.05).j);
const FLIP = Object.fromEntries(ENTRY.map((s) => [s.name, s.a[1] < s.b[1]]));

const _q = new Quaternion();
const _qx = new Quaternion();
const X_AXIS = new Vector3(1, 0, 0);
const Z_AXIS = new Vector3(0, 0, 1);

/** Node transform of one segment: origin, planar angle, tilt, scale. */
function segXform(seg) {
  const flip = FLIP[seg.name];
  const o = flip ? seg.b : seg.a;
  const e = flip ? seg.a : seg.b;
  const d = [e[0] - o[0], e[1] - o[1], e[2] - o[2]];
  const len = Math.hypot(...d);
  const theta = Math.atan2(d[1], d[0]) - Math.PI / 2;
  const beta = Math.asin(clamp(d[2] / len, -1, 1));
  let frac = 1;
  if (o[1] < CLIP) frac = 0;
  else if (e[1] < CLIP) frac = (o[1] - CLIP) / (o[1] - e[1]);
  const nominal = NOMINAL[kind(seg.name)];
  const across = smooth(0, 0.12, frac);
  const scale = frac <= 0 ? [...HIDDEN] : [Math.max(1e-4, across), Math.max(1e-4, (frac * len) / nominal), Math.max(1e-4, across)];
  const origin = [o[0], Math.max(o[1], CLIP), o[2]];
  return { origin, theta, beta, scale, frac };
}

function quatOf(theta, beta) {
  _q.setFromAxisAngle(Z_AXIS, theta);
  _qx.setFromAxisAngle(X_AXIS, beta);
  _q.multiply(_qx);
  return [_q.x, _q.y, _q.z, _q.w];
}

// ------------------------------------------------------------------ loop time

const T_SLOW0 = 3;
const T_UNDER = 11;
const T_REWIND = 12;
const T_BACK = 15.5;

function findUnder() {
  for (let t = D.tc; t < D.tc + 0.8; t += 0.002) {
    const segs = segmentsOf(poseAt(t).j);
    if (segs.every((s) => segXform(s).frac <= 0)) return t;
  }
  return D.tc + 0.8;
}
const TAU_UNDER = findUnder() + 0.02;
const SLOW = (T_UNDER - T_SLOW0) / (TAU_UNDER - TAU_A);
const TAU_MAX = TAU_A + (T_REWIND - T_SLOW0) / SLOW;

/** Loop time to dive time. */
function diveTime(t) {
  if (t < T_SLOW0) return TAU_A - T_SLOW0 + t;
  if (t < T_REWIND) return TAU_A + (t - T_SLOW0) / SLOW;
  if (t < T_BACK) return TAU_MAX + (TAU_A - TAU_MAX) * smoother(T_REWIND, T_BACK, t);
  return TAU_A;
}

// Statues: every 1/14 s from the first stillness until the body is nearly under.
const STATUES = [];
for (let k = -6; k < 40; k += 1) {
  const t = k / RATE;
  const j = poseAt(t).j;
  const top = Math.max(j.Toe[1], j.A[1], j.K[1], j.P[1], j.Hd[1], j.Ht[1]);
  if (t > D.tc && top - CLIP < 0.3) break;
  STATUES.push({ k, t, loopT: T_SLOW0 + (t - TAU_A) * SLOW });
}
const TAU_LAST = STATUES[STATUES.length - 1].t;
const T_CONTACT = T_SLOW0 + (D.tc - TAU_A) * SLOW;

// Splash, a function of dive time so it rewinds with everything else.
const XE = poseAt(D.tc).j.Hd[0];
const crownH = (t) => {
  const d = t - D.tc;
  return smooth(0.0, 0.32, d) * (1 - 0.45 * smooth(0.36, 0.75, d));
};
const crownR = (t) => {
  const d = t - D.tc;
  return smooth(0, 0.08, d) * (0.55 + 0.6 * smooth(0, 0.55, d));
};
const RINGS = [0.06, 0.2, 0.36];
const ringR = (t, delay) => 0.07 + 0.55 * Math.max(0, t - D.tc - delay);
const ringOn = (t, delay) => smooth(0, 0.05, t - D.tc - delay);

// ------------------------------------------------------------------ meshes

const KEEP = new Set(['position', 'normal']);
function clean(g) {
  for (const key of Object.keys(g.attributes)) if (!KEEP.has(key)) g.deleteAttribute(key);
  return g;
}
function ell(rx, ry, rz, c = [0, 0, 0], ws = 18, hs = 12) {
  const g = new SphereGeometry(1, ws, hs);
  g.scale(rx, ry, rz);
  g.translate(...c);
  return clean(g);
}
/** A tapered capsule along +Y from y0 to y0 + len, squashed sx / sz across. */
function capsule(len, ra, rb, { sx = 1, sz = 1, radial = 14, cap = 4, y0 = 0, x = 0, z = 0 } = {}) {
  const pts = [];
  for (let i = 0; i <= cap; i += 1) {
    const a = -Math.PI / 2 + (i / cap) * (Math.PI / 2);
    pts.push(new Vector2(Math.max(1e-4, ra * Math.cos(a)), ra * Math.sin(a)));
  }
  for (let i = 1; i <= 2; i += 1) pts.push(new Vector2(ra + ((rb - ra) * i) / 3, (len * i) / 3));
  for (let i = 0; i <= cap; i += 1) {
    const a = (i / cap) * (Math.PI / 2);
    pts.push(new Vector2(Math.max(1e-4, rb * Math.cos(a)), len + rb * Math.sin(a)));
  }
  const g = new LatheGeometry(pts, radial);
  g.scale(sx, 1, sz);
  g.translate(x, y0, z);
  return clean(g);
}

/** One segment's shape in its own frame: +Y from the first joint to the second, +X = that line turned clockwise. */
function segmentGeometry(name, lod) {
  const r = lod ? 14 : 8;
  const c = lod ? 4 : 2;
  const e = (rx, ry, rz, at) => ell(rx, ry, rz, at, lod ? 18 : 9, lod ? 12 : 6);
  const k = kind(name);
  let parts;
  if (k === 'pelvis') parts = [e(0.1, 0.11, 0.15, [-0.005, 0.0, 0]), e(0.088, 0.12, 0.125, [0.008, 0.15, 0])];
  else if (k === 'chest') {
    const bar = capsule(2 * SH_Z, 0.044, 0.044, { radial: r, cap: c });
    bar.rotateX(Math.PI / 2);
    bar.translate(-0.008, L.chest - 0.045, -SH_Z);
    parts = [e(0.105, 0.16, 0.148, [0.012, 0.13, 0]), bar];
  } else if (k === 'head') parts = [capsule(0.1, 0.047, 0.043, { radial: r, cap: c }), e(0.096, 0.113, 0.079, [0.014, 0.168, 0])];
  else if (k === 'upperArm') parts = [capsule(L.ua, 0.045, 0.036, { radial: r, cap: c })];
  else if (k === 'forearm') parts = [capsule(L.fa, 0.038, 0.029, { radial: r, cap: c, sx: 0.9 })];
  else if (k === 'hand') parts = [capsule(L.hand - 0.035, 0.027, 0.024, { radial: r, cap: c, sx: 0.7, sz: 1.25, y0: 0.0 })];
  else if (k === 'thigh') parts = [capsule(L.th, 0.077, 0.05, { radial: r, cap: c })];
  else if (k === 'shin') parts = [capsule(L.sh, 0.051, 0.033, { radial: r, cap: c }), e(0.046, 0.12, 0.05, [0.016, 0.13, 0])];
  else parts = [capsule(L.ft - 0.02, 0.034, 0.024, { radial: r, cap: c, sz: 1.3 }), e(0.04, 0.05, 0.036, [0.03, -0.012, 0])];
  const g = mergeGeometries(parts);
  if (FLIP[name]) {
    g.rotateZ(Math.PI);
    g.translate(0, NOMINAL[k], 0);
  }
  return g;
}

/** Unlit triangles with vertex colors. */
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
    g.setAttribute('position', new Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.c, 3));
    return g;
  }
}

const col = (hex) => new Color(hex);
const mix = (a, b, t) => col(a).lerp(col(b), clamp(t));

// ------------------------------------------------------------------ the pool

const SLAB_L = BOARD_BACK - 0.07;
const SLAB_R = XE + 0.42;
const SLAB = { cx: (SLAB_L + SLAB_R) / 2, rx: (SLAB_R - SLAB_L) / 2, rz: 0.74, p: 4 };
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
  return r0 + tear(th * 2.1, 4, 0.06);
}
const rimW = (th) => 0.035 + 0.02 * fbm3(th * 5, 1, 2, { octaves: 2, seed: 8 });
function polar(x, z) {
  const th = Math.atan2(z, x - SLAB.cx);
  return { th, r: Math.hypot(x - SLAB.cx, z), R: slabR(th) };
}
const insideRim = (x, z, m = 0) => {
  const p = polar(x, z);
  return p.r < p.R - rimW(p.th) - m;
};

function poolGeometry() {
  const paint = new Paint();
  const N = 300;
  const ring = (r, th, y) => [SLAB.cx + r * Math.cos(th), y, r * Math.sin(th)];
  // Dark water body under the translucent surface.
  const body = col('#06262b');
  for (let j = 0; j < N; j += 1) {
    const a = (j / N) * Math.PI * 2;
    const b = ((j + 1) / N) * Math.PI * 2;
    paint.tri([SLAB.cx, SURF - 0.035, 0], ring(slabR(b) - 0.01, b, SURF - 0.035), ring(slabR(a) - 0.01, a, SURF - 0.035), body);
  }
  // Inner wall of the pool from the rim down to the water body.
  const wallTop = col('#7fa9a6');
  const wallLow = col('#173f44');
  for (let j = 0; j < N; j += 1) {
    const a = (j / N) * Math.PI * 2;
    const b = ((j + 1) / N) * Math.PI * 2;
    const ra = slabR(a) - rimW(a);
    const rb = slabR(b) - rimW(b);
    const xa = ring(ra, a, 0)[0];
    const xb = ring(rb, b, 0)[0];
    if (xa < DECK_X && xb < DECK_X) continue;
    paint.quad(ring(ra, a, RIM_Y), ring(rb, b, RIM_Y), ring(rb, b, SURF - 0.034), ring(ra, a, SURF - 0.034), wallTop, wallTop, wallLow, wallLow);
  }
  // Deck tiles left of the tiled edge.
  const P = 0.075;
  const tileA = col('#d7e2dc');
  const tileB = col('#c3d6d2');
  const grout = col('#8fa29d');
  const cell = P / 4;
  for (let x = DECK_X - 1.4; x < DECK_X; x += cell) {
    for (let z = -0.9; z < 0.9; z += cell) {
      const x1 = Math.min(x + cell, DECK_X);
      if (!insideRim((x + x1) / 2, z + cell / 2, -0.02)) continue;
      const gx = ((x - DECK_X) / P) % 1;
      const gz = (((z + 0.9) / P) % 1 + 1) % 1;
      const ti = Math.floor((x - DECK_X) / P) + Math.floor((z + 0.9) / P);
      const onGrout = Math.abs(gx) < 0.02 || gz < 0.02;
      const shade = 0.88 + 0.1 * noise3(x * 13, z * 13, 1, 3);
      const c = (onGrout ? grout : ti % 2 === 0 ? tileA : tileB).clone().multiplyScalar(shade);
      paint.quad([x, RIM_Y, z], [x, RIM_Y, z + cell], [x1, RIM_Y, z + cell], [x1, RIM_Y, z], c);
    }
  }
  // The tiled edge face: pale tiles with a band of blue at the waterline.
  const zs = [];
  for (let z = -0.9; z <= 0.9; z += 0.0375) if (insideRim(DECK_X + 0.01, z, -0.03)) zs.push(z);
  for (const z of zs) {
    const z1 = z + 0.0375;
    const n = Math.round((z + 0.9) / 0.0375);
    const blue = n % 2 === 0 ? col('#2c6c8c') : col('#3b7d9b');
    const pale = n % 2 === 0 ? tileA : tileB;
    paint.quad([DECK_X, RIM_Y, z], [DECK_X, RIM_Y, z1], [DECK_X, SURF + 0.012, z1], [DECK_X, SURF + 0.012, z], pale.clone().multiplyScalar(0.92));
    paint.quad([DECK_X, SURF + 0.012, z], [DECK_X, SURF + 0.012, z1], [DECK_X, SURF - 0.034, z1], [DECK_X, SURF - 0.034, z], blue);
  }
  // Coping cap along the edge.
  const cap = col('#eef2ec');
  for (const z of zs) paint.quad([DECK_X - 0.05, RIM_Y + 0.004, z], [DECK_X - 0.05, RIM_Y + 0.004, z + 0.0375], [DECK_X + 0.012, RIM_Y + 0.004, z + 0.0375], [DECK_X + 0.012, RIM_Y + 0.004, z], cap);
  // The burnt rim on top, the gold edge down the side, a dark underside.
  const scorch = col('#2b1a10');
  const gold = col(T.gold);
  const high = col(T.highlight);
  const stone = col('#7b8f88');
  for (let j = 0; j < N; j += 1) {
    const a = (j / N) * Math.PI * 2;
    const b = ((j + 1) / N) * Math.PI * 2;
    const ra = slabR(a);
    const rb = slabR(b);
    const wa = rimW(a);
    const wb = rimW(b);
    const bands = [
      [1.0, stone],
      [0.5, scorch],
      [0.2, gold],
      [0, high]
    ];
    for (let q = 0; q < bands.length - 1; q += 1) {
      const [f0, c0] = bands[q];
      const [f1, c1] = bands[q + 1];
      paint.quad(ring(ra - wa * f0, a, RIM_Y + 0.002), ring(rb - wb * f0, b, RIM_Y + 0.002), ring(rb - wb * f1, b, RIM_Y + 0.002), ring(ra - wa * f1, a, RIM_Y + 0.002), c0, c0, c1, c1);
    }
    paint.quad(ring(ra, a, RIM_Y + 0.002), ring(rb, b, RIM_Y + 0.002), ring(rb * 0.997, b, RIM_Y * 0.55), ring(ra * 0.997, a, RIM_Y * 0.55), gold, gold, scorch, scorch);
    paint.quad(ring(ra * 0.997, a, RIM_Y * 0.55), ring(rb * 0.997, b, RIM_Y * 0.55), ring(rb * 0.99, b, 0), ring(ra * 0.99, a, 0), scorch, scorch, col('#160d08'), col('#160d08'));
    paint.tri([SLAB.cx, 0, 0], ring(ra * 0.99, a, 0), ring(rb * 0.99, b, 0), col('#120a06'));
  }
  return paint.geometry();
}

function waterGeometry() {
  const paint = new Paint();
  const cell = 0.05;
  for (let x = DECK_X; x < SLAB.cx + SLAB.rx + 0.2; x += cell) {
    for (let z = -0.9; z < 0.9; z += cell) {
      if (!insideRim(x + cell / 2, z + cell / 2, -0.035)) continue;
      const c = (px, pz) => {
        const n = fbm3(px * 2.2, pz * 2.2, 0.7, { octaves: 3, seed: 12 });
        const glint = Math.exp(-((Math.hypot(px - XE, pz) - 0.0) ** 2) / 0.5);
        return mix('#0f5a5e', '#3a9c98', 0.25 + 0.5 * n * n + 0.25 * glint);
      };
      paint.quad([x, SURF, z], [x, SURF, z + cell], [x + cell, SURF, z + cell], [x + cell, SURF, z], c(x, z), c(x, z + cell), c(x + cell, z + cell), c(x + cell, z));
    }
  }
  return paint.geometry();
}

function boardGeometry() {
  const parts = [];
  const paintBox = (w, h, d, at, hex, lo) => {
    const g = new BoxGeometry(w, h, d, 1, 1, 1).toNonIndexed();
    g.translate(...at);
    const pos = g.attributes.position;
    const out = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i += 1) {
      const y = pos.getY(i);
      const c = mix(lo ?? hex, hex, smooth(at[1] - h / 2, at[1] + h / 2, y));
      out.set([c.r, c.g, c.b], i * 3);
    }
    clean(g);
    g.deleteAttribute('normal');
    g.setAttribute('color', new BufferAttribute(out, 3));
    return g;
  };
  // Board: white body, sand-grip top, a blue-grey tip face.
  parts.push(paintBox(BOARD_LEN, BOARD_T, BOARD_W, [(TIP_X + BOARD_BACK) / 2, BOARD_TOP - BOARD_T / 2, 0], '#e9e6dc', '#9fa6a2'));
  parts.push(paintBox(BOARD_LEN - 0.02, 0.004, BOARD_W - 0.03, [(TIP_X + BOARD_BACK) / 2 - 0.01, BOARD_TOP + 0.002, 0], '#c9bfa6'));
  parts.push(paintBox(0.012, BOARD_T + 0.004, BOARD_W, [TIP_X - 0.004, BOARD_TOP - BOARD_T / 2, 0], '#3f6f86'));
  // The stand: a back pedestal and a fulcrum pedestal with its roller.
  const under = BOARD_TOP - BOARD_T;
  parts.push(paintBox(0.26, under - RIM_Y, 0.42, [BOARD_BACK + 0.15, (under + RIM_Y) / 2, 0], '#6f8288', '#3c4a4f'));
  const fx = BOARD_BACK + 0.72;
  parts.push(paintBox(0.22, under - 0.08 - RIM_Y, 0.46, [fx, (under - 0.08 + RIM_Y) / 2, 0], '#6f8288', '#3c4a4f'));
  const roller = new CylinderGeometry(0.04, 0.04, 0.56, 14).toNonIndexed();
  roller.rotateX(Math.PI / 2);
  roller.translate(fx, under - 0.04, 0);
  clean(roller);
  roller.deleteAttribute('normal');
  const rc = col('#c9a24a');
  roller.setAttribute('color', new BufferAttribute(new Float32Array(roller.attributes.position.count * 3).map((_, i) => [rc.r, rc.g, rc.b][i % 3]), 3));
  parts.push(roller);
  return mergeGeometries(parts);
}

/** The splash crown at full size, around the origin, standing on y = 0. */
function crownGeometry(lod) {
  const random = rng(31);
  const parts = [];
  const n = 20;
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2 + random() * 0.2;
    const h = 0.16 + 0.16 * random();
    const g = new ConeGeometry(0.03, h, lod ? 8 : 5, 1);
    g.translate(0, h / 2, 0);
    g.rotateZ(-(0.35 + 0.25 * random()));
    g.rotateY(-a);
    g.translate(0.13 * Math.cos(a), 0, 0.13 * Math.sin(a));
    parts.push(clean(g));
    if (i % 2 === 0) {
      const tip = new Vector3(0, h, 0).applyAxisAngle(Z_AXIS, -(0.35 + 0.25 * random())).applyAxisAngle(new Vector3(0, 1, 0), -a);
      const drop = ell(0.03, 0.036, 0.03, [0.13 * Math.cos(a) + tip.x * 1.25, tip.y * 1.2 + 0.04, 0.13 * Math.sin(a) + tip.z * 1.25], lod ? 10 : 6, lod ? 8 : 4);
      parts.push(drop);
    }
  }
  const sheet = new CylinderGeometry(0.2, 0.12, 0.13, lod ? 28 : 16, 1, true);
  sheet.translate(0, 0.065, 0);
  parts.push(clean(sheet));
  return mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
}

function annulus(r0, r1, seg = 48) {
  const g = new RingGeometry(r0, r1, seg, 1);
  g.rotateX(-Math.PI / 2);
  return clean(g);
}

// ------------------------------------------------------------------ statues

const FULL = 1.0; // the living diver's girth
const COOL = '#5fa6ee';
const WARM = '#f0a94e';
const PALE = '#cbc6e6';
const ROD = 0.01;
const HEAD_R = 0.065;
const BEAD = 0.018;
const TRACE = 0.005;
const HEAD_TRACE = 0.006;
const GHOST = 0.5; // skeleton rods, hand and foot traces: the quiet layer
const COM_TRACE = 0.022;
const THIN_PREP_ARMS = true; // every second preparation statue drawn without arms, so the board-tip bundle stays open

/** Time grading of a statue or a trace, cool pale blue to warm pale gold. */
function grade(t) {
  const u = clamp((t - STATUES[0].t) / (TAU_LAST - STATUES[0].t));
  return u < 0.5 ? mix(COOL, PALE, u * 2) : mix(PALE, WARM, u * 2 - 1);
}

function colored(g, c) {
  const geo = g.index ? g.toNonIndexed() : g;
  for (const key of Object.keys(geo.attributes)) if (key !== 'position') geo.deleteAttribute(key);
  const out = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < out.length; i += 3) out.set([c.r, c.g, c.b], i);
  geo.setAttribute('color', new BufferAttribute(out, 3));
  return geo;
}

const flat = (g) => {
  const geo = g.index ? g.toNonIndexed() : g;
  for (const key of Object.keys(geo.attributes)) if (key !== 'position' && key !== 'color') geo.deleteAttribute(key);
  return geo;
};

const _up = new Vector3(0, 1, 0);
/** A thin rod between two 3D points, cut where it goes under the water. */
function rod(a, b, r, c) {
  let A = new Vector3(...a);
  let B = new Vector3(...b);
  if (A.y < CLIP && B.y < CLIP) return null;
  if (A.y < CLIP) [A, B] = [B, A];
  if (B.y < CLIP) B = A.clone().lerp(B, (A.y - CLIP) / (A.y - B.y));
  const d = B.clone().sub(A);
  const len = d.length();
  if (len < 1e-3) return null;
  const g = new CylinderGeometry(r, r, len, 6, 1, true);
  g.translate(0, len / 2, 0);
  g.applyQuaternion(new Quaternion().setFromUnitVectors(_up, d.normalize()));
  g.translate(A.x, A.y, A.z);
  return colored(g, c);
}
function ball(p, r, c, ws = 8, hs = 6) {
  if (p[1] < CLIP + r * 0.5) return null;
  const g = new SphereGeometry(r, ws, hs);
  g.translate(...p);
  return colored(g, c);
}

/** One statue as a Marey line figure: rods on the limb axes, a small head, beads at hands and feet. */
function lineFigure(s) {
  const { j } = poseAt(s.t);
  const bright = grade(s.t).multiplyScalar(s.k % 2 === 0 ? 1.0 : 0.9);
  const c = bright.clone().multiplyScalar(GHOST);
  const z0 = (p) => [...p, 0];
  const parts = [rod(z0(j.P), z0(j.W), ROD, c), rod(z0(j.W), z0(j.N), ROD, c)];
  const headC = addv(j.N, sub2(j.Ht, j.N), 0.6);
  parts.push(ball(z0(headC), HEAD_R, bright.clone().multiplyScalar(1.15), 14, 10));
  parts.push(rod([...j.S, -SH_Z], [...j.S, SH_Z], ROD, c), rod([...j.P, -HIP_Z], [...j.P, HIP_Z], ROD, c));
  const arms = !(THIN_PREP_ARMS && s.k < 0 && s.k % 2 !== 0);
  for (const side of [-1, 1]) {
    const zE = (side * (SH_Z + j.zw)) / 2;
    if (arms) {
      parts.push(rod([...j.S, side * SH_Z], [...j.E, zE], ROD, c), rod([...j.E, zE], [...j.Wr, side * j.zw], ROD, c));
      parts.push(ball([...addv(j.Wr, sub2(j.Hd, j.Wr), 0.5), side * j.zw], BEAD, c));
    }
    parts.push(rod([...j.P, side * HIP_Z], [...j.K, side * HIP_Z], ROD, c), rod([...j.K, side * HIP_Z], [...j.A, side * HIP_Z], ROD, c));
    parts.push(ball([...addv(j.A, sub2(j.Toe, j.A), 0.55), side * HIP_Z], BEAD, c));
  }
  return parts.filter(Boolean);
}

/** A tube along points with per-point colors; breaks where the path is under water. */
function tube(points, colors, r, radial = 6) {
  const pos = [];
  const col3 = [];
  const Z = new Vector3(0, 0, 1);
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (a.y < SURF || b.y < SURF) continue;
    const ring = (p, tangent) => {
      const n = new Vector3().crossVectors(tangent, Z).normalize();
      const out = [];
      for (let k = 0; k < radial; k += 1) {
        const th = (k / radial) * Math.PI * 2;
        out.push(p.clone().addScaledVector(n, Math.cos(th) * r).addScaledVector(Z, Math.sin(th) * r));
      }
      return out;
    };
    const tA = (points[i + 1].clone().sub(points[Math.max(0, i - 1)])).normalize();
    const tB = (points[Math.min(points.length - 1, i + 2)].clone().sub(points[i])).normalize();
    const ra = ring(a, tA);
    const rb = ring(b, tB);
    for (let k = 0; k < radial; k += 1) {
      const k1 = (k + 1) % radial;
      for (const [p, c] of [[ra[k], colors[i]], [rb[k], colors[i + 1]], [rb[k1], colors[i + 1]], [ra[k], colors[i]], [rb[k1], colors[i + 1]], [ra[k1], colors[i]]]) {
        pos.push(p.x, p.y, p.z);
        col3.push(c.r, c.g, c.b);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col3, 3));
  return g;
}

/** Continuous traces through the whole action, from the same pose function. */
function traceGeometry() {
  const step = 1 / (RATE * 20); // 1/280 s
  const head = [];
  const handL = [];
  const handR = [];
  const feet = [];
  const mass = [];
  const colors = [];
  for (let t = TAU_A; t <= TAU_LAST + 1e-9; t += step) {
    const { j } = poseAt(t);
    const hc = addv(j.N, sub2(j.Ht, j.N), 0.6);
    head.push(new Vector3(hc[0], hc[1], 0));
    const hand = addv(j.Wr, sub2(j.Hd, j.Wr), 0.5);
    handL.push(new Vector3(hand[0], hand[1], -j.zw));
    handR.push(new Vector3(hand[0], hand[1], j.zw));
    const foot = addv(j.A, sub2(j.Toe, j.A), 0.55);
    feet.push(new Vector3(foot[0], foot[1], 0));
    const c = com(j);
    mass.push(new Vector3(c[0], c[1], 0));
    colors.push(grade(t));
  }
  // A deeper gold than the token: the viewer's tone mapping pales it, and it must stand apart from the warm lines.
  const gold = col('#ff9a00').multiplyScalar(1.0);
  const dim = colors.map((c) => c.clone().multiplyScalar(GHOST));
  return {
    limbs: mergeGeometries([tube(head, colors, HEAD_TRACE), tube(handL, dim, TRACE), tube(handR, dim, TRACE), tube(feet, dim, TRACE)]),
    mass: tube(mass, mass.map(() => gold), COM_TRACE, 10)
  };
}
const LIGHT_DIR = new Vector3(0.35, 0.8, 0.5).normalize();

function shadeInto(g, color, dim = 0.7) {
  const ng = g.index ? g : mergeVertices(g, 1e-6);
  if (!ng.attributes.normal) ng.computeVertexNormals();
  const nor = ng.attributes.normal;
  const out = new Float32Array(nor.count * 3);
  const n = new Vector3();
  for (let i = 0; i < nor.count; i += 1) {
    n.fromBufferAttribute(nor, i);
    const lam = Math.max(0, n.dot(LIGHT_DIR));
    // Edges seen side-on darken, so overlapping limbs keep their outlines.
    const edge = 0.5 + 0.5 * Math.sqrt(Math.abs(n.z));
    const s = dim * (0.55 + 0.6 * lam) * edge;
    out.set([color.r * s, color.g * s, color.b * s], i * 3);
  }
  ng.deleteAttribute('normal');
  ng.setAttribute('color', new BufferAttribute(out, 3));
  return ng;
}

function statueGeometry() {
  const all = [];
  for (const st of STATUES) all.push(...lineFigure(st));
  // The frozen splash and rings, as the last statue.
  const ts = TAU_LAST;
  const crown = mergeVertices(crownGeometry(false), 1e-6);
  crown.scale(crownR(ts), Math.max(1e-3, crownH(ts)), crownR(ts));
  crown.translate(XE, SURF - 0.02, 0);
  all.push(flat(shadeInto(crown, col(WARM).lerp(col('#f4ecd8'), 0.4), 0.95)));
  for (const delay of RINGS) {
    if (ringOn(ts, delay) <= 0.01) continue;
    const r = ringR(ts, delay);
    const g = annulus(r, r + 0.03, 40);
    g.translate(XE, SURF + 0.003, 0);
    all.push(flat(shadeInto(g, col(WARM), 0.9)));
  }
  return mergeGeometries(all);
}

// ------------------------------------------------------------------ sound

function sound() {
  const out = track(LOOP);
  // A low held pad: partials on whole cycles of the loop so it joins.
  add(out, 0, LOOP, (t) => 0.05 * sine(55)(t) + 0.03 * sine(82.5)(t) * (0.7 + 0.3 * sine(0.125)(t)) + 0.012 * sine(110)(t) * (0.6 + 0.4 * sine(0.0625, 1)(t)));
  // A soft tick as the living diver meets each statue in the slow section.
  const tick = (t) => sine(740)(t) + 0.3 * sine(1110)(t);
  for (const s of STATUES) add(out, s.loopT, 0.25, tick, (t) => 0.06 * pluck(0.002, 0.035)(t));
  // The splash: low-passed noise, slow like the picture.
  const splash = track(LOOP);
  const r = noise(5);
  add(splash, T_CONTACT, 2.4, () => r(), (t) => 0.5 * (t < 0.06 ? t / 0.06 : Math.exp(-(t - 0.06) / 0.55)));
  lowpass(splash, (t) => 900 - 500 * smooth(T_CONTACT, T_CONTACT + 2, t));
  lowpass(splash, 1200);
  for (let i = 0; i < out.length; i += 1) out[i] += splash[i];
  // The rewind: a gentle rising whirr.
  const len = T_BACK - T_REWIND;
  let phase = 0;
  const whirr = new Float32Array(Math.round(len * 32000));
  for (let i = 0; i < whirr.length; i += 1) {
    const u = i / whirr.length;
    phase += (2 * Math.PI * (170 + 260 * u * u)) / 32000;
    whirr[i] = (Math.sin(phase) + 0.25 * Math.sin(2 * phase)) * Math.sin(Math.PI * u) ** 2 * 0.045 * (0.8 + 0.2 * Math.sin(2 * Math.PI * 9 * u * len));
  }
  add(out, T_REWIND, len, (t) => whirr[Math.min(whirr.length - 1, Math.round(t * 32000))]);
  return toWav(normalize(out, 0.6));
}

// ------------------------------------------------------------------ build

export async function build() {
  const flight = D.tc.toFixed(2);
  const labels = await renderLabels([
    { id: 'title', text: 'One dive. A statue every 1/14 of a second.', font: 'title', italic: true, size: 40, color: T.gold },
    {
      id: 'facts',
      text: `forward 1½ somersault, tuck  ·  1 m springboard  ·  ${flight} s in the air  ·  ${STATUES.length} statues  ·  gold line: the centre of mass`,
      font: 'ui',
      size: 22,
      color: T.textMuted,
      letterSpacing: 0.04
    }
  ]);

  const glb = new Glb();
  glb.provenance({
    holoim: {
      authored: 'synthetic',
      author: meta.submittedBy,
      title: meta.name,
      facts: {
        takeoffMetersPerSecond: { forward: VX, up: VY },
        gravity: G,
        flightSeconds: +D.tc.toFixed(3),
        statueIntervalSeconds: 1 / RATE,
        statues: STATUES.length,
        slowMotion: `1/${SLOW.toFixed(2)}`,
        dive: 'forward 1.5 somersault tuck (103C) from a 1 m springboard'
      }
    }
  });
  const root = glb.node({ name: 'EveryMomentOfTheDive' });

  const painted = glb.material({ name: 'Painted', unlit: true });
  glb.node({ name: 'Pool', mesh: glb.mesh('Pool', poolGeometry(), painted), parent: root });
  glb.node({ name: 'Board', mesh: glb.mesh('Board', boardGeometry(), painted), parent: root });
  const waterInk = glb.material({ name: 'WaterTop', opacity: 0.72, unlit: true });
  glb.node({ name: 'WaterTop', mesh: glb.mesh('WaterTop', waterGeometry(), waterInk), parent: root });

  // The statues.
  glb.node({ name: 'Statues', mesh: glb.mesh('Statues', mergeVertices(statueGeometry(), 1e-5), painted), parent: root });
  const traces = traceGeometry();
  // The loudest line: a glowing gold the tone mapping cannot pale.
  const comInk = glb.material({ name: 'CentreOfMassGlow', color: '#ffa21f', emissive: '#ff7a00', emissiveStrength: 1.5, roughness: 0.5 });
  const comGeometry = (g) => {
    g.deleteAttribute('color');
    const m = mergeVertices(g, 1e-5);
    m.computeVertexNormals();
    return m;
  };
  glb.node({ name: 'Traces', mesh: glb.mesh('Traces', mergeVertices(traces.limbs, 1e-5), painted), parent: root });
  glb.node({ name: 'CentreOfMass', mesh: glb.mesh('CentreOfMass', comGeometry(traces.mass), comInk), parent: root });

  // The living diver: one node per segment, all keyed on one shared time array.
  const times = [];
  const steps = LOOP * FPS;
  for (let i = 0; i <= steps; i += 1) times.push((i / steps) * LOOP);
  for (const s of STATUES) times.push(s.loopT);
  // The rewind runs near real speed: key it three times as densely.
  for (let i = 1; i < (T_BACK - T_REWIND) * FPS * 3; i += 1) if (i % 3) times.push(T_REWIND + i / (FPS * 3));
  times.sort((a, b) => a - b);
  const keyTimes = times.filter((t, i) => i === 0 || t - times[i - 1] > 1e-4);
  keyTimes[keyTimes.length - 1] = LOOP;

  const frames = keyTimes.map((t) => {
    const p = poseAt(diveTime(t));
    return { segs: segmentsOf(p.j).map(segXform), breath: p.breath };
  });
  const body = glb.material({ name: 'LivingDiver', color: '#ff9b3d', emissive: '#c4561a', emissiveStrength: 0.9, roughness: 0.45 });
  SEGMENTS.forEach(([name], si) => {
    const geo = segmentGeometry(name, true);
    const f0 = frames[0].segs[si];
    const node = glb.node({
      name: `fig-${name}`,
      mesh: glb.mesh(`fig-${name}`, geo, body),
      translation: f0.origin,
      rotation: quatOf(f0.theta, f0.beta),
      scale: [f0.scale[0] * FULL, f0.scale[1], f0.scale[2] * FULL],
      parent: root
    });
    let prevTheta = null;
    const rot = [];
    let prevQ = null;
    for (const f of frames) {
      let th = f.segs[si].theta;
      if (prevTheta !== null) th = prevTheta + wrap(th - prevTheta);
      prevTheta = th;
      let q = quatOf(th, f.segs[si].beta);
      if (prevQ && prevQ[0] * q[0] + prevQ[1] * q[1] + prevQ[2] * q[2] + prevQ[3] * q[3] < 0) q = q.map((v) => -v);
      prevQ = q;
      rot.push(...q);
    }
    const breathe = name === 'chest';
    glb.animate(node, 'translation', keyTimes, frames.flatMap((f) => f.segs[si].origin));
    glb.animate(node, 'rotation', keyTimes, rot);
    glb.animate(
      node,
      'scale',
      keyTimes,
      frames.flatMap((f) => {
        const s0 = f.segs[si].scale;
        const s = s0[0] > 1e-3 ? [s0[0] * FULL, s0[1], s0[2] * FULL] : s0;
        return breathe && s[0] > 1e-3 ? [s[0] * (1 + 0.035 * f.breath), s[1], s[2] * (1 + 0.012 * f.breath)] : s;
      })
    );
  });

  // The living splash: the same crown as the frozen one, grown and shrunk with dive time.
  const splashInk = glb.material({ name: 'Splash', color: '#d9f4f0', emissive: '#4fa9a6', emissiveStrength: 0.6, roughness: 0.3 });
  const crown = glb.node({ name: 'SplashCrown', mesh: glb.mesh('SplashCrown', crownGeometry(true), splashInk), translation: [XE, SURF - 0.02, 0], scale: HIDDEN, parent: root });
  const crownScale = (t) => {
    const r = crownR(t);
    const h = crownH(t);
    return r < 1e-3 || h < 1e-3 ? HIDDEN : [r, h, r];
  };
  glb.animate(crown, 'scale', keyTimes, keyTimes.flatMap((t) => crownScale(diveTime(t))));
  const ringInk = glb.material({ name: 'Ring', color: '#cdeee9', unlit: true });
  const ringMesh = glb.mesh('Ring', annulus(1, 1.07, 64), ringInk);
  RINGS.forEach((delay, i) => {
    const node = glb.node({ name: `Ring${i + 1}`, mesh: ringMesh, translation: [XE, SURF + 0.006, 0], scale: HIDDEN, parent: root });
    glb.animate(
      node,
      'scale',
      keyTimes,
      keyTimes.flatMap((t) => {
        const tau = diveTime(t);
        const on = ringOn(tau, delay);
        const settle = 1 - smooth(TAU_MAX - 0.18, TAU_MAX, tau);
        const r = ringR(tau, delay);
        return on * settle < 0.02 ? HIDDEN : [r, 1, r];
      })
    );
  });

  // Words on the front edge of the pool, tilted up to the first view.
  const tilt = quat([1, 0, 0], -58 * DEG);
  const M = 0.0021;
  const front = SLAB.rz - 0.02;
  addLabel(glb, labels.title, { name: 'TitleLabel', metersPerPx: M, translation: [SLAB.cx + 0.35, RIM_Y + 0.004, front - 0.2], rotation: tilt, parent: root });
  addLabel(glb, labels.facts, { name: 'FactsLabel', metersPerPx: 0.0017, translation: [SLAB.cx + 0.35, RIM_Y + 0.004, front - 0.08], rotation: tilt, parent: root });

  glb.audio(sound());
  return glb;
}

// ------------------------------------------------------------------ contact sheet

const H_BOUNDS = 3.5;
export const FEED_T = [SLAB.cx, 0.57 * H_BOUNDS, 0];
export const FEED_D = 3.2 * H_BOUNDS;
const FEED_DIR = [0.297, 0.276, 0.914];
export const EYE = FEED_T.map((v, i) => v + FEED_DIR[i] * FEED_D);
const dirOf = (yawDeg, pitchDeg) => [Math.sin(yawDeg * DEG) * Math.cos(pitchDeg * DEG), Math.sin(pitchDeg * DEG), Math.cos(yawDeg * DEG) * Math.cos(pitchDeg * DEG)];
const from = (c, yaw, pitch, d) => c.map((v, i) => v + dirOf(yaw, pitch)[i] * d);
const statueT = (k) => STATUES.find((s) => s.k === k)?.loopT ?? 6;

export const tiles = [
  { label: 'feed', cam: EYE, look: FEED_T, fov: 38, t: 0 },
  { label: 'feed 2x tuck', cam: EYE, look: [...poseAt(6 / RATE).j.P, 0], fov: 19, t: statueT(6) },
  { label: 'end-on yaw 100', cam: from([XE - 0.6, 1.8, 0], 100, 10, 7.5), look: [XE - 0.6, 1.8, 0], t: statueT(9) },
  { label: 'top', cam: [SLAB.cx, 6.5, 0.6], look: [SLAB.cx, 0.5, 0], t: statueT(3) },
  { label: 'close 1.6 m', cam: from(FEED_T, 18, 16, 1.6), look: FEED_T, t: statueT(4) },
  { label: 'board crowd', cam: from([TIP_X, 1.9, 0], 35, 12, 2.2), look: [TIP_X, 1.9, 0], t: 1.5 },
  { label: 'entry 10.2', cam: from([XE, 0.6, 0], 25, 14, 2.6), look: [XE, 0.6, 0], t: T_CONTACT + 0.8 },
  { label: 'rewind 13.6', cam: EYE, look: FEED_T, fov: 30, t: 13.6 },
  { label: 'words and rings 11.6', cam: [SLAB.cx + 0.4, 1.5, 2.6], look: [SLAB.cx + 0.4, 0.2, 0.4], t: 11.6 }
];
