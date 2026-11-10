import { BufferAttribute, BufferGeometry, CatmullRomCurve3, Color, ConeGeometry, CylinderGeometry, IcosahedronGeometry, Quaternion, RingGeometry, SphereGeometry, TubeGeometry, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { add, lowpass, noise, normalize, pluck, sine, toWav, track, SAMPLE_RATE } from './lib/audio.mjs';
import { Glb, sample } from './lib/glb.mjs';
import { fbm3, noise3, quat, rng } from './lib/parts.mjs';
import { T as TOKEN } from './lib/tokens.mjs';

// "The shape the rain leaves": rain on a small piece of street under a lamp,
// and two people standing in it whom nobody drew: an adult, getting wet, and
// a small child under a red umbrella, holding hands. They exist only as what
// they interrupt. The bodies are capsules and ellipsoids in this file and are
// never drawn; every streak stops where a vertical ray first meets them,
// splashes and runoff trace their surfaces, and the ground under them is dry.

export const meta = {
  slug: 'the-shape-the-rain-leaves',
  name: 'The shape the rain leaves',
  submittedBy: 'Claude (agent-authored)'
};

const LOOP = 12;
const TAU = Math.PI * 2;
const HIDDEN = [1e-4, 1e-4, 1e-4];
const SLAB = 0.06; // paving thickness; the street level is y = 0 in the root's frame
const SLAB_R = 1.5;
const RAIN_V = 3; // m/s, slowed
const RAIN_TOP = 3.2;
const STREAK_L = 0.17;
const RAIN_PERIOD = 1.2; // every streak falls 10 times a loop

// The lamp: post at the back-left, head over the scene.
const POST = [-1.2, 0, -0.55];
const LAMP = [-0.3, 2.93, -0.34];
const CONE_TAN = 0.56;

// The hop.
const HOP_UP = 8.0;
const HOP_LAND = 8.34;
const HOP_PEAK = 0.11;

// Palette (none of these is a design token; the gold rim is).
const col = (hex) => new Color(hex);
const mix = (a, b, t) => col(a).lerp(col(b), Math.min(1, Math.max(0, t)));
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// ---------------------------------------------------------------- vectors

const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const norm3 = (a) => mul3(a, 1 / (len3(a) || 1e-9));
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Quaternion turning +Y onto `n`. */
function alignY(n) {
  const up = [0, 1, 0];
  const d = dot3(up, n);
  if (d > 0.9999) return [0, 0, 0, 1];
  if (d < -0.9999) return [1, 0, 0, 0];
  const axis = norm3(cross3(up, n));
  return quat(axis, Math.acos(clamp(d, -1, 1)));
}

// ---------------------------------------------------------------- the invisible bodies

const cap = (a, b, r1, r2, tag) => ({ kind: 'cap', a, b, r1, r2: r2 ?? r1, tag });
const ell = (c, r, tag) => ({ kind: 'ell', c, r, tag });

function partDist(p, part) {
  if (part.kind === 'cap') {
    const pa = sub3(p, part.a);
    const ba = sub3(part.b, part.a);
    const h = clamp(dot3(pa, ba) / dot3(ba, ba), 0, 1);
    return len3(sub3(pa, mul3(ba, h))) - (part.r1 + (part.r2 - part.r1) * h);
  }
  const q = [(p[0] - part.c[0]) / part.r[0], (p[1] - part.c[1]) / part.r[1], (p[2] - part.c[2]) / part.r[2]];
  const k0 = len3(q);
  const k1 = Math.hypot(q[0] / part.r[0], q[1] / part.r[1], q[2] / part.r[2]);
  return (k0 * (k0 - 1)) / (k1 || 1e-9);
}

function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function makeBody(parts, k) {
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    const pts = part.kind === 'cap' ? [part.a, part.b] : [part.c];
    const r = part.kind === 'cap' ? Math.max(part.r1, part.r2) : Math.max(...part.r);
    for (const q of pts) {
      lo = lo.map((v, i) => Math.min(v, q[i] - r));
      hi = hi.map((v, i) => Math.max(v, q[i] + r));
    }
  }
  const body = {
    parts,
    lo,
    hi,
    sdf(p) {
      let d = Infinity;
      for (const part of parts) d = smin(d === Infinity ? 1 : d, partDist(p, part), k);
      return d;
    },
    tag(p) {
      let best = Infinity;
      let tag = '';
      for (const part of parts) {
        const d = partDist(p, part);
        if (d < best) {
          best = d;
          tag = part.tag;
        }
      }
      return tag;
    }
  };
  return body;
}

// The adult: 1.72 m, standing at x = 0.15 facing +Z, head bowed toward the
// child, shoulders square, the right arm reaching down and out to the child's
// hand, the far arm a little away from the body.
const SHOULDER = [-0.06, 1.39, 0]; // the reaching arm's pivot
const GRIP = [-0.34, 0.765, 0.085]; // the two hands, joined
const legs = (x, z) => [
  cap([x, 0.88, z], [x - 0.004, 0.49, z + 0.015], 0.08, 0.06, 'leg'),
  cap([x - 0.004, 0.49, z + 0.015], [x - 0.008, 0.09, z - 0.005], 0.056, 0.04, 'leg'),
  cap([x - 0.008, 0.045, z - 0.04], [x - 0.012, 0.042, z + 0.12], 0.042, 0.04, 'foot')
];
const ADULT = makeBody(
  [
    ell([0.118, 1.598, 0.04], [0.079, 0.104, 0.093], 'head'),
    cap([0.148, 1.44, 0.0], [0.13, 1.53, 0.028], 0.052, 0.05, 'neck'),
    cap([-0.035, 1.405, -0.005], [0.335, 1.405, -0.005], 0.062, 0.062, 'shoulder'),
    ell([0.15, 1.27, 0.0], [0.178, 0.19, 0.116], 'chest'),
    ell([0.15, 1.06, 0.006], [0.152, 0.17, 0.106], 'torso'),
    ell([0.15, 0.92, 0.0], [0.17, 0.12, 0.112], 'hips'),
    ...legs(0.072, 0.0),
    ...legs(0.236, 0.0),
    cap([0.36, 1.39, -0.005], [0.43, 1.12, -0.012], 0.048, 0.04, 'farArm'),
    cap([0.43, 1.12, -0.012], [0.468, 0.88, 0.03], 0.04, 0.032, 'farArm'),
    ell([0.478, 0.8, 0.036], [0.028, 0.066, 0.042], 'farHand'),
    cap(SHOULDER, [-0.2, 1.1, 0.05], 0.048, 0.04, 'reach'),
    cap([-0.2, 1.1, 0.05], [-0.31, 0.83, 0.08], 0.04, 0.032, 'reach'),
    ell(GRIP, [0.03, 0.06, 0.045], 'hand')
  ],
  0.035
);

// The child: 1.05 m at x = -0.72, the left hand up in the adult's, the right
// fist holding the umbrella in front of the chest.
const CX = -0.72;
const CZ = 0.1;
const FIST = [-0.775, 0.7, 0.19];
const CHILD = makeBody(
  [
    ell([CX, 0.925, CZ + 0.005], [0.076, 0.089, 0.083], 'cHead'),
    cap([CX, 0.8, CZ], [CX, 0.86, CZ], 0.04, 0.04, 'cNeck'),
    cap([CX - 0.11, 0.795, CZ], [CX + 0.11, 0.795, CZ], 0.045, 0.045, 'cShoulder'),
    ell([CX, 0.66, CZ], [0.12, 0.16, 0.085], 'cTorso'),
    ell([CX, 0.5, CZ], [0.115, 0.085, 0.08], 'cHips'),
    cap([CX - 0.055, 0.47, CZ], [CX - 0.06, 0.07, CZ], 0.05, 0.04, 'cLeg'),
    cap([CX + 0.055, 0.47, CZ], [CX + 0.06, 0.07, CZ], 0.05, 0.04, 'cLeg'),
    cap([CX - 0.06, 0.036, CZ - 0.03], [CX - 0.062, 0.036, CZ + 0.09], 0.036, 0.034, 'cFoot'),
    cap([CX + 0.06, 0.036, CZ - 0.03], [CX + 0.062, 0.036, CZ + 0.09], 0.036, 0.034, 'cFoot'),
    cap([CX + 0.12, 0.79, CZ], [-0.5, 0.69, 0.13], 0.035, 0.03, 'cReach'),
    cap([-0.5, 0.69, 0.13], [-0.385, 0.755, 0.095], 0.03, 0.026, 'cReach'),
    ell([-0.362, 0.765, 0.09], [0.03, 0.045, 0.04], 'cHand'),
    cap([CX - 0.12, 0.79, CZ], [-0.86, 0.64, 0.15], 0.035, 0.03, 'cArm'),
    cap([-0.86, 0.64, 0.15], FIST, 0.03, 0.027, 'cArm'),
    ell(FIST, [0.033, 0.035, 0.033], 'cFist')
  ],
  0.025
);
const CHILD_FEET = [
  [CX - 0.06, 0, CZ + 0.03],
  [CX + 0.06, 0, CZ + 0.03]
];

// The umbrella: canopy 75 cm across on a shaft through the child's fist.
const U_R = 0.375;
const U_DEPTH = 0.13;
const U_APEX = [-0.765, 1.38, 0.135];
const U_AXIS = norm3(sub3(U_APEX, FIST));
const U_E1 = norm3(cross3(U_AXIS, [0, 0, 1]));
const U_E2 = cross3(U_AXIS, U_E1);
const RIBS = 8;
const scallop = (phi) => 0.5 - 0.5 * Math.cos(RIBS * phi);
const rimR = (phi) => U_R * (1 - 0.045 * scallop(phi));
/** Canopy height along the axis below the apex, at radius r and angle phi. */
const canopyA = (r, phi) => -U_DEPTH * (r / U_R) ** 1.7 - 0.016 * (r / U_R) ** 1.5 * scallop(phi);
const canopyPoint = (r, phi) => add3(U_APEX, add3(add3(mul3(U_E1, r * Math.cos(phi)), mul3(U_E2, r * Math.sin(phi))), mul3(U_AXIS, canopyA(r, phi))));

function canopyLocal(p) {
  const d = sub3(p, U_APEX);
  const a = dot3(d, U_AXIS);
  const x = dot3(d, U_E1);
  const y = dot3(d, U_E2);
  return { a, r: Math.hypot(x, y), phi: Math.atan2(y, x) };
}
const canopyF = (p) => {
  const { a, r, phi } = canopyLocal(p);
  return a - canopyA(Math.min(r, U_R), phi);
};

function gradient(f, p, eps = 0.0015) {
  const g = [
    f([p[0] + eps, p[1], p[2]]) - f([p[0] - eps, p[1], p[2]]),
    f([p[0], p[1] + eps, p[2]]) - f([p[0], p[1] - eps, p[2]]),
    f([p[0], p[1], p[2] + eps]) - f([p[0], p[1], p[2] - eps])
  ];
  return norm3(g);
}

/** First canopy point on the vertical ray at (x, z), or null. */
function canopyHit(x, z) {
  let prev = null;
  for (let y = U_APEX[1] + 0.03; y > U_APEX[1] - 0.3; y -= 0.004) {
    const p = [x, y, z];
    const { r, phi } = canopyLocal(p);
    const inside = r <= rimR(phi) && canopyF(p) <= 0;
    if (inside) {
      if (prev === null) return y;
      let lo = y;
      let hi = prev;
      for (let i = 0; i < 12; i += 1) {
        const mid = (lo + hi) / 2;
        if (canopyF([x, mid, z]) <= 0) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    }
    prev = y;
  }
  return null;
}

/** First point of `body` on the vertical ray at (x, z) below y0, or null. */
function bodyHit(body, x, z, y0 = RAIN_TOP + 0.1) {
  if (x < body.lo[0] - 0.01 || x > body.hi[0] + 0.01 || z < body.lo[2] - 0.01 || z > body.hi[2] + 0.01) return null;
  let y = Math.min(y0, body.hi[1] + 0.02);
  for (let i = 0; i < 400; i += 1) {
    const d = body.sdf([x, y, z]);
    if (d < 0.0006) return y;
    y -= Math.max(d * 0.9, 0.0012);
    if (y < 0) return null;
  }
  return null;
}

/** What a raindrop falling at (x, z) lands on. */
function hitTop(x, z) {
  let best = { y: 0, obj: 'ground' };
  const a = bodyHit(ADULT, x, z);
  if (a !== null && a > best.y) best = { y: a, obj: 'adult' };
  const c = bodyHit(CHILD, x, z);
  if (c !== null && c > best.y) best = { y: c, obj: 'child' };
  const u = canopyHit(x, z);
  if (u !== null && u > best.y) best = { y: u, obj: 'umbrella' };
  const p = [x, best.y, z];
  if (best.obj === 'adult') return { ...best, p, n: gradient(ADULT.sdf, p), tag: ADULT.tag(p) };
  if (best.obj === 'child') return { ...best, p, n: gradient(CHILD.sdf, p), tag: CHILD.tag(p) };
  if (best.obj === 'umbrella') {
    let n = gradient(canopyF, p);
    if (dot3(n, U_AXIS) < 0) n = mul3(n, -1);
    return { ...best, p, n, tag: 'canopy' };
  }
  return { ...best, p, n: [0, 1, 0], tag: 'ground' };
}

const isDry = (x, z) => hitTop(x, z).obj !== 'ground';

// ---------------------------------------------------------------- light

/** How much of the lamp's cone a point is in, 0..1. */
function lampWarmth(x, y, z) {
  const reach = Math.max(0.05, (LAMP[1] - y) * CONE_TAN);
  const d = Math.hypot(x - LAMP[0], z - LAMP[2]);
  return 1 - smooth(0.78, 1.08, d / reach);
}

// ---------------------------------------------------------------- geometry helpers

/** Non-indexed, position (+ color, + normal if `lit`) only, ready to merge. */
function prep(geometry, color, { lit = false } = {}) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  if (lit && !g.attributes.normal) g.computeVertexNormals();
  for (const key of Object.keys(g.attributes)) {
    if (key === 'position' || key === 'color' || (lit && key === 'normal')) continue;
    g.deleteAttribute(key);
  }
  g.clearGroups();
  if (color !== undefined) {
    const pos = g.attributes.position;
    const out = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i += 1) {
      const c = typeof color === 'function' ? color(pos.getX(i), pos.getY(i), pos.getZ(i)) : col(color);
      out.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('color', new BufferAttribute(out, 3));
  }
  return g;
}

/** A (rows+1) x (cols+1) grid from fn(i, j) -> { p, c }, wound so its normals agree with `outward(p)`. */
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

function quadsGeometry(quads) {
  // quads: [{ p: [4 corners], c: Color }]
  const positions = new Float32Array(quads.length * 18);
  const colors = new Float32Array(quads.length * 18);
  quads.forEach((q, k) => {
    const order = [0, 2, 1, 0, 3, 2];
    order.forEach((v, m) => {
      positions.set(q.p[v], k * 18 + m * 3);
      colors.set([q.c.r, q.c.g, q.c.b], k * 18 + m * 3);
    });
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  g.setAttribute('color', new BufferAttribute(colors, 3));
  return g;
}

// ---------------------------------------------------------------- the street

function rimMul(theta) {
  const x = Math.cos(theta);
  const z = Math.sin(theta);
  let r = 1 + 0.12 * (fbm3(x * 1.3 + 3, z * 1.3, 0.5, { seed: 14 }) - 0.5) + 0.06 * (fbm3(x * 5 + 1, z * 5, 1.5, { seed: 19 }) - 0.5);
  r -= 0.05 * Math.max(0, noise3(x * 7 + 1, z * 7, 2, 27) - 0.62) / 0.38;
  return r;
}

const PUDDLE = { x: -0.66, z: 0.34, rx: 0.4, rz: 0.26 };
const puddleR = (theta) => 1 + 0.16 * (fbm3(Math.cos(theta) * 1.6 + 4, Math.sin(theta) * 1.6, 0.2, { seed: 33 }) - 0.5);
function inPuddle(x, z) {
  const dx = (x - PUDDLE.x) / PUDDLE.rx;
  const dz = (z - PUDDLE.z) / PUDDLE.rz;
  return Math.hypot(dx, dz) < puddleR(Math.atan2(dz, dx));
}

/** Wet paving, lamp-painted: dark flagstones, a warm pool, a smear of reflected lamp toward the front. */
function wetPaving(x, z) {
  const w = lampWarmth(x, 0, z);
  const n = fbm3(x * 6, 0, z * 6, { seed: 8 });
  const c = mix('#121a1e', '#1d272b', n);
  // Flagstones 0.55 m, joints a little darker.
  const ang = 0.21;
  const u = x * Math.cos(ang) - z * Math.sin(ang);
  const v = x * Math.sin(ang) + z * Math.cos(ang);
  const ju = Math.abs(((u / 0.55) % 1 + 1) % 1 - 0.5);
  const jv = Math.abs((((v + (Math.floor(u / 0.55) % 2) * 0.27) / 0.55) % 1 + 1) % 1 - 0.5);
  const joint = smooth(0.44, 0.49, Math.max(ju, jv));
  c.lerp(col('#080d10'), joint * 0.7);
  c.lerp(col('#3a3022'), w * 0.42);
  // The lamp's reflection, drawn out toward the viewer as on wet stone.
  const along = z - LAMP[2];
  const smear = Math.exp(-(((x - LAMP[0] - along * 0.3) / (0.12 + 0.08 * Math.max(0, along))) ** 2)) * smooth(-0.5, 0.0, along) * (1 - smooth(0.6, 1.4, along));
  c.lerp(col('#9a7448'), smear * 0.5 * (0.6 + 0.4 * fbm3(x * 14, 1, z * 3, { seed: 5 })));
  return c;
}

function dryPaving(x, z) {
  const w = lampWarmth(x, 0, z);
  const c = mix('#38393a', '#46453f', fbm3(x * 9, 2, z * 9, { seed: 6 }));
  c.lerp(col('#6a5a44'), w * 0.45);
  return c;
}

function slabGeometry() {
  const N = 200;
  const R = 44;
  const M = 6;
  const rows = [];
  for (let k = 0; k <= R; k += 1) rows.push({ kind: 'top', f: Math.max(0.002, k / R) });
  for (let m = 0; m <= M; m += 1) rows.push({ kind: 'side', s: m / M });
  const fn = (i, j) => {
    const theta = (j / N) * TAU;
    const row = rows[i];
    const rr = SLAB_R * rimMul(theta);
    if (row.kind === 'top') {
      const x = row.f * rr * Math.cos(theta);
      const z = row.f * rr * Math.sin(theta);
      const y = -0.006 * smooth(0.93, 1, row.f);
      const c = wetPaving(x, z);
      c.lerp(col('#1a1210'), smooth(0.93, 0.975, row.f));
      c.lerp(col(TOKEN.gold), smooth(0.982, 1, row.f));
      return { p: [x, y, z], c };
    }
    const s = row.s;
    const r2 = rr * (1 - 0.035 * s) + 0.01 * (fbm3(Math.cos(theta) * 6, s * 3, Math.sin(theta) * 6, { seed: 31 }) - 0.5);
    const y = -0.006 + (-SLAB + 0.006) * s;
    let c = mix('#3b2c24', '#4c3a2f', fbm3(theta * 4, y * 60, 1, { seed: 3 }));
    if (s < 0.12) c = mix(TOKEN.gold, '#a0632e', s / 0.12);
    return { p: [r2 * Math.cos(theta), y, r2 * Math.sin(theta)], c };
  };
  const top = grid(rows.length - 1, N, fn, (x, y, z) => [x, y + 0.5, z]);
  // A flat underside nobody sees, so the slab is closed from the side.
  const under = grid(1, N, (i, j) => {
    const theta = (j / N) * TAU;
    const rr = SLAB_R * rimMul(theta) * (1 - 0.035) * (1 - i * 0.998);
    return { p: [rr * Math.cos(theta), -SLAB, rr * Math.sin(theta)], c: col('#2a211c') };
  }, () => [0, -1, 0]);
  return [prep(top), prep(under)];
}

function puddleGeometry() {
  const N = 72;
  const R = 12;
  const g = grid(R, N, (i, j) => {
    const theta = (j / N) * TAU;
    const f = Math.max(0.002, i / R);
    const pr = puddleR(theta) * f;
    const x = PUDDLE.x + PUDDLE.rx * pr * Math.cos(theta);
    const z = PUDDLE.z + PUDDLE.rz * pr * Math.sin(theta);
    const c = mix('#16272d', '#1d3239', fbm3(x * 5, 3, z * 5, { seed: 2 }));
    // The lamp, mirrored: a soft warm bloom toward its back edge.
    const lampGlint = Math.exp(-(((x - (LAMP[0] - 0.2)) / 0.16) ** 2 + ((z - (PUDDLE.z - 0.12)) / 0.09) ** 2));
    c.lerp(col('#c79a5e'), lampGlint * 0.55);
    // And the umbrella, a red smudge just in front of the feet.
    const red = Math.exp(-(((x - (U_APEX[0] + 0.02)) / 0.2) ** 2 + ((z - (PUDDLE.z + 0.05)) / 0.09) ** 2));
    c.lerp(col('#6e1712'), red * 0.22);
    c.lerp(col('#2a2a28'), smooth(0.86, 1, f) * 0.6);
    return { p: [x, 0.0012, z], c };
  }, () => [0, 1, 0]);
  return prep(g);
}

function dryGeometry() {
  const cell = 0.012;
  const quads = [];
  for (let x = -1.22; x < 0.66; x += cell) {
    for (let z = -0.34; z < 0.62; z += cell) {
      const cx = x + cell / 2;
      const cz = z + cell / 2;
      if (inPuddle(cx, cz)) continue;
      if (!isDry(cx, cz)) continue;
      const y = 0.0022;
      quads.push({ p: [[x, y, z], [x + cell, y, z], [x + cell, y, z + cell], [x, y, z + cell]], c: dryPaving(cx, cz) });
    }
  }
  return quadsGeometry(quads);
}

function lampGeometry() {
  const parts = [];
  const base = new CylinderGeometry(0.075, 0.1, 0.22, 16);
  base.translate(POST[0], 0.11, POST[2]);
  parts.push(base);
  const ring = new CylinderGeometry(0.06, 0.06, 0.03, 16);
  ring.translate(POST[0], 0.24, POST[2]);
  parts.push(ring);
  const post = new CylinderGeometry(0.03, 0.045, 2.9, 12);
  post.translate(POST[0], 1.45, POST[2]);
  parts.push(post);
  const top = [POST[0], 2.9, POST[2]];
  const over = [LAMP[0], LAMP[1] + 0.12, LAMP[2]];
  const curve = new CatmullRomCurve3(
    [
      top,
      [POST[0], 3.02, POST[2]],
      [POST[0] + (over[0] - POST[0]) * 0.25, 3.1, POST[2] + (over[2] - POST[2]) * 0.25],
      [POST[0] + (over[0] - POST[0]) * 0.7, 3.1, POST[2] + (over[2] - POST[2]) * 0.7],
      [over[0], 3.07, over[2]],
      over
    ].map((p) => new Vector3(...p))
  );
  parts.push(new TubeGeometry(curve, 40, 0.022, 8, false));
  const hood = new ConeGeometry(0.15, 0.1, 16, 1, true);
  hood.translate(LAMP[0], LAMP[1] + 0.07, LAMP[2]);
  parts.push(hood);
  const cap2 = new CylinderGeometry(0.03, 0.03, 0.04, 10);
  cap2.translate(LAMP[0], LAMP[1] + 0.13, LAMP[2]);
  parts.push(cap2);
  return mergeGeometries(parts.map((g) => prep(g, '#ffffff', { lit: true })));
}

// ---------------------------------------------------------------- the umbrella (in the fist's frame)

function umbrellaGeometry() {
  const toLamp = (p) => norm3(sub3(LAMP, p));
  const N = 96;
  const R = 16;
  const paint = (p, n, under) => {
    const lam = Math.max(0, dot3(n, toLamp(p)));
    const { phi, r } = canopyLocal(p);
    const seam = 1 - smooth(0.0, 0.05, Math.abs(((phi * RIBS) / TAU) % 1 + 1) % 1 - 0.0) * smooth(0.0, 0.05, 1 - (((phi * RIBS) / TAU) % 1 + 1) % 1);
    if (under) return mix('#3c0b09', '#6a1610', lam * 0.6 + 0.2 * r);
    const c = mix('#8e1a14', '#e8402e', 0.25 + 0.75 * lam);
    c.lerp(col('#ffb08a'), smooth(0.65, 1, lam) * 0.35);
    c.lerp(col('#5a0f0b'), seam * 0.45);
    return c;
  };
  const surface = (under) =>
    grid(R, N, (i, j) => {
      const r = Math.max(0.003, (i / R) * U_R);
      const phi = (j / N) * TAU;
      const rr = (r / U_R) * rimR(phi);
      let p = canopyPoint(rr, phi);
      if (under) p = sub3(p, mul3(U_AXIS, 0.004));
      let n = gradient(canopyF, p);
      if (dot3(n, U_AXIS) < 0) n = mul3(n, -1);
      return { p: sub3(p, FIST), c: paint(p, n, under) };
    }, () => (under ? mul3(U_AXIS, -1) : U_AXIS));
  const parts = [prep(surface(false)), prep(surface(true))];
  // Rim piping and rib tips.
  const rim = [];
  for (let j = 0; j < 120; j += 1) {
    const phi = (j / 120) * TAU;
    rim.push(new Vector3(...sub3(canopyPoint(rimR(phi), phi), FIST)));
  }
  parts.push(prep(new TubeGeometry(new CatmullRomCurve3(rim, true), 120, 0.004, 5, true), '#7a1510'));
  for (let k = 0; k < RIBS; k += 1) {
    const tip = new SphereGeometry(0.007, 8, 6);
    tip.translate(...sub3(canopyPoint(rimR((k / RIBS) * TAU), (k / RIBS) * TAU), FIST));
    parts.push(prep(tip, '#d9d3c4'));
  }
  // Shaft from just above the fist through the apex to a tip, and the grip in the fist.
  const shaftLen = len3(sub3(U_APEX, FIST)) + 0.05;
  const shaft = new CylinderGeometry(0.0055, 0.0055, shaftLen - 0.04, 8);
  shaft.translate(0, 0.04 + (shaftLen - 0.04) / 2, 0);
  const grip = new CylinderGeometry(0.017, 0.015, 0.105, 12);
  grip.translate(0, -0.005, 0);
  const end = new SphereGeometry(0.018, 10, 8);
  end.translate(0, -0.058, 0);
  const tipTop = new ConeGeometry(0.008, 0.035, 8);
  tipTop.translate(0, shaftLen + 0.012, 0);
  const q = alignY(U_AXIS);
  const axisParts = [
    [shaft, (x, y) => mix('#9aa0a4', '#d7dadb', smooth(0.4, 0.75, y + 0.3))],
    [grip, () => col('#b8231a')],
    [end, () => col('#c92a1f')],
    [tipTop, () => col('#c9c3b6')]
  ];
  for (const [g, c] of axisParts) {
    g.applyQuaternion(new Quaternion(...q));
    parts.push(prep(g, c));
  }
  return mergeGeometries(parts);
}

// ---------------------------------------------------------------- water shapes

function streakGeometry() {
  const w = 0.0035;
  const a = new BufferGeometry();
  const p = [
    [-w, 0, 0], [w, 0, 0], [w, STREAK_L, 0], [-w, STREAK_L, 0],
    [0, 0, -w], [0, 0, w], [0, STREAK_L, w], [0, STREAK_L, -w]
  ];
  const tri = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
  a.setAttribute('position', new BufferAttribute(new Float32Array(tri.flatMap((i) => p[i])), 3));
  return a;
}

/** A small crown of spray: six spikes thrown up and out, and a bead in the middle. */
function splashGeometry() {
  const parts = [];
  const spikes = [];
  for (let k = 0; k < 6; k += 1) {
    const a = (k / 6) * TAU + 0.3;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const t = [-s * 0.004, 0, c * 0.004];
    spikes.push([c * 0.005 + t[0], 0.002, s * 0.005 + t[2]], [c * 0.005 - t[0], 0.002, s * 0.005 - t[2]], [c * 0.032, 0.024, s * 0.032]);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(spikes.flat()), 3));
  parts.push(g);
  const bead = new IcosahedronGeometry(0.008, 0);
  bead.translate(0, 0.006, 0);
  parts.push(prep(bead));
  return mergeGeometries(parts.map((x) => prep(x)));
}

// ---------------------------------------------------------------- keys

/**
 * Keys for a function that repeats every `period` (which divides LOOP),
 * offset by `phase`, given the local times of its corners within one
 * period. Between corners the motion must be linear (or held, for STEP).
 */
function periodicKeys(period, phase, corners, fn) {
  const set = new Set([0, LOOP]);
  const n = Math.round(LOOP / period);
  for (let k = -1; k <= n; k += 1) {
    for (const c of corners) {
      const t = phase + k * period + c;
      if (t > 1e-4 && t < LOOP - 1e-4) set.add(+t.toFixed(5));
    }
  }
  const times = [...set].sort((a, b) => a - b);
  const values = [];
  for (const t of times) {
    const local = ((((t - phase) % period) + period) % period);
    values.push(...fn(t === LOOP ? (((0 - phase) % period) + period) % period : local));
  }
  return { times, values };
}

const sampledTimes = new Map();
/** Keys `fn(t)` at `fps` over the loop; all channels at one fps share one times array. */
function sampled(fps, fn) {
  if (!sampledTimes.has(fps)) sampledTimes.set(fps, sample(LOOP, fps, () => [0]).times);
  const times = sampledTimes.get(fps);
  const values = [];
  for (const t of times) values.push(...fn(t === LOOP ? 0 : t));
  return { times, values };
}

// The child's hop, as height over time.
function hopY(t) {
  const crouch = HOP_UP - 0.18;
  if (t < crouch || t > HOP_LAND + 0.3) return 0;
  if (t < HOP_UP) return -0.025 * Math.sin((Math.PI / 2) * ((t - crouch) / 0.18));
  if (t < HOP_LAND) {
    const u = (t - HOP_UP) / (HOP_LAND - HOP_UP);
    return -0.025 * (1 - u) ** 3 + HOP_PEAK * 4 * u * (1 - u);
  }
  const e = (t - HOP_LAND) / 0.3;
  return -0.03 * Math.sin(Math.PI * e) * (1 - e * 0.5);
}

// The umbrella's dip and bob after the landing, relative to the fist.
function bob(t) {
  const e = t - HOP_LAND;
  if (t > HOP_UP - 0.05 && e < 0) return { y: -0.02 * Math.sin((Math.PI * (t - HOP_UP + 0.05)) / (HOP_LAND - HOP_UP + 0.05)), a: 0 };
  if (e < 0 || e > 2.4) return { y: 0, a: 0 };
  const fade = Math.exp(-e / 0.38) * (1 - smooth(1.8, 2.4, e));
  return { y: -0.065 * fade * Math.sin(TAU * 2.4 * e), a: 0.11 * fade * Math.sin(TAU * 1.7 * e + 0.4) };
}

// ---------------------------------------------------------------- runoff paths

function project(f, p) {
  let q = p;
  for (let i = 0; i < 4; i += 1) {
    const d = f(q);
    if (Math.abs(d) < 2e-4) break;
    q = sub3(q, mul3(gradient(f, q), d));
  }
  return q;
}

/** A drop sliding down `body` from `start`: down the slope, dripping off overhangs, down to the street. */
function trace(body, start, random) {
  const f = body.sdf;
  const pts = [{ p: start, fall: false }];
  let p = project(f, start);
  const a0 = random() * TAU;
  const drift = [Math.cos(a0), 0, Math.sin(a0)];
  const wobble = (random() - 0.5) * 0.5;
  let stuck = 0;
  let lastY = p[1];
  for (let i = 0; i < 500; i += 1) {
    const n = gradient(f, p);
    if (n[1] < -0.42 || stuck > 25) {
      // Drip: fall straight down to whatever is below.
      const q = [p[0] + n[0] * 0.012, p[1] - 0.012, p[2] + n[2] * 0.012];
      const land = bodyHit(body, q[0], q[2], q[1]);
      if (land === null || land < 0.01) {
        pts.push({ p: [q[0], 0, q[2]], fall: true });
        break;
      }
      p = project(f, [q[0], land, q[2]]);
      pts.push({ p, fall: true });
      stuck = 0;
      lastY = p[1];
      continue;
    }
    const g = [n[0] * n[1], -1 + n[1] * n[1], n[2] * n[1]];
    const gl = len3(g);
    const h = sub3(drift, mul3(n, dot3(n, drift)));
    let dir = add3(gl > 1e-6 ? mul3(g, 1 / gl) : [0, 0, 0], mul3(h, 0.9 * (1 - smooth(0.15, 0.55, gl))));
    if (gl > 1e-3) dir = add3(dir, mul3(norm3(cross3(n, g)), wobble * Math.sin(i * 0.21 + a0) * 0.6));
    p = project(f, add3(p, mul3(norm3(dir), 0.011)));
    if (p[1] < 0.004) {
      pts.push({ p: [p[0], 0, p[2]], fall: false });
      break;
    }
    pts.push({ p, fall: false });
    if (p[1] > lastY - 0.0015) stuck += 1;
    else stuck = Math.max(0, stuck - 1);
    lastY = Math.min(lastY, p[1]);
  }
  return pts;
}

/** Positions along a path over time: sliding at `vSlide`, falling at `vFall`. Returns { duration, at(t) }. */
function timeline(pts, vSlide, vFall = 2.6) {
  const times = [0];
  for (let i = 1; i < pts.length; i += 1) {
    const d = len3(sub3(pts[i].p, pts[i - 1].p));
    // A drop beads, then runs: slower near the start.
    const v = pts[i].fall ? vFall : vSlide * (0.55 + 0.45 * smooth(0, 12, i));
    times.push(times[i - 1] + d / v);
  }
  const duration = times[times.length - 1];
  let cursor = 0;
  return {
    duration,
    at(t) {
      if (t <= 0) return pts[0].p;
      if (t >= duration) return pts[pts.length - 1].p;
      if (times[cursor] > t) cursor = 0;
      while (cursor < times.length - 2 && times[cursor + 1] < t) cursor += 1;
      const u = (t - times[cursor]) / (times[cursor + 1] - times[cursor] || 1);
      return add3(pts[cursor].p, mul3(sub3(pts[cursor + 1].p, pts[cursor].p), u));
    }
  };
}

const PERIODS = [2, 3, 4, 6, 12];

// ---------------------------------------------------------------- scene

export async function build() {
  const glb = new Glb();
  glb.provenance({
    holoim: {
      authored: 'synthetic',
      author: meta.submittedBy,
      title: meta.name,
      scale: '1:1',
      facts: { adultHeightM: 1.72, childHeightM: 1.05, umbrellaCanopyM: 0.75, rainFallMPerS: RAIN_V, loopSeconds: LOOP }
    }
  });
  const random = rng(20261110);
  const root = glb.node({ name: 'ShapeTheRainLeaves', translation: [0, SLAB, 0] });

  // ---- materials
  const painted = glb.material({ name: 'Painted', unlit: true });
  const iron = glb.material({ name: 'LampIron', color: '#262d31', metallic: 0.4, roughness: 0.5 });
  const glass = glb.material({ name: 'LampGlass', color: '#fff0c8', emissive: '#ffd79a', emissiveStrength: 4 });
  const halo = glb.material({ name: 'LampHalo', color: TOKEN.glow, opacity: 0.2, unlit: true });
  const rainCool = glb.material({ name: 'RainCool', color: '#4f6576', unlit: true, doubleSided: true });
  const rainWarm = glb.material({ name: 'RainWarm', color: '#9c8460', unlit: true, doubleSided: true });
  const splashWarm = glb.material({ name: 'SplashWarm', color: '#fff2d8', unlit: true, doubleSided: true });
  const splashCool = glb.material({ name: 'SplashCool', color: '#d4e8f6', unlit: true, doubleSided: true });
  const beadWarm = glb.material({ name: 'BeadWarm', color: '#fffaf0', unlit: true });
  const beadCool = glb.material({ name: 'BeadCool', color: '#e6f4ff', unlit: true });
  const cling = glb.material({ name: 'Cling', color: '#d8cdb6', unlit: true });
  const rippleCool = glb.material({ name: 'RippleCool', color: '#6c8394', unlit: true, doubleSided: true });
  const rippleWarm = glb.material({ name: 'RippleWarm', color: '#c7a676', unlit: true, doubleSided: true });

  // ---- the street: slab, puddle, the dry shapes, all one mesh
  const ground = mergeGeometries([...slabGeometry(), puddleGeometry(), dryGeometry()]);
  glb.node({ name: 'Street', mesh: glb.mesh('Street', ground, painted), parent: root });

  // ---- the lamp
  glb.node({ name: 'Lamp', mesh: glb.mesh('Lamp', lampGeometry(), iron), parent: root });
  const lantern = new CylinderGeometry(0.06, 0.075, 0.1, 14);
  lantern.translate(LAMP[0], LAMP[1] - 0.005, LAMP[2]);
  glb.node({ name: 'LampLight', mesh: glb.mesh('LampLight', lantern, glass), parent: root });
  glb.node({ name: 'LampHalo', mesh: glb.mesh('LampHalo', new SphereGeometry(0.11, 20, 14), halo), translation: LAMP, parent: root });

  // ---- moving frames: the child (hops), the umbrella (bobs), the adult's reaching arm (follows)
  const childFrame = glb.node({ name: 'ChildFrame', parent: root });
  const hop = sampled(30, (t) => [0, hopY(t), 0]);
  glb.animate(childFrame, 'translation', hop.times, hop.values);

  const umbrella = glb.node({ name: 'Umbrella', translation: FIST, parent: childFrame });
  glb.node({ name: 'UmbrellaCanopy', mesh: glb.mesh('UmbrellaCanopy', umbrellaGeometry(), painted), parent: umbrella });
  const wobbleAxis = norm3([1, 0, 0.5]);
  const umbT = sampled(30, (t) => add3(FIST, [0, bob(t).y, 0]));
  const umbR = sampled(30, (t) => quat(wobbleAxis, bob(t).a));
  glb.animate(umbrella, 'translation', umbT.times, umbT.values);
  glb.animate(umbrella, 'rotation', umbR.times, umbR.values);

  const reachV = sub3(GRIP, SHOULDER);
  const reachAxis = norm3(cross3(reachV, [0, 1, 0]));
  const arm = glb.node({ name: 'AdultReach', translation: SHOULDER, parent: root });
  const armR = sampled(30, (t) => quat(reachAxis, Math.max(-0.05, hopY(((t - 0.05) % LOOP + LOOP) % LOOP)) / len3(reachV)));
  glb.animate(arm, 'rotation', armR.times, armR.values);

  /** Which frame a point on a body belongs to, and its position in that frame. */
  const frameOf = (obj, tag, p) => {
    if (obj === 'adult' && (tag === 'reach' || tag === 'hand')) return { parent: arm, p: sub3(p, SHOULDER) };
    if (obj === 'umbrella') return { parent: umbrella, p: sub3(p, FIST) };
    if (obj === 'child') return { parent: childFrame, p };
    return { parent: root, p };
  };

  // ---- the rain
  const streakMesh = { cool: glb.mesh('RainCool', streakGeometry(), rainCool), warm: glb.mesh('RainWarm', streakGeometry(), rainWarm) };
  const tracks = new Map();
  const PHASES = 12;
  const rainTrack = (top, land, phaseIndex) => {
    const key = `${top}|${land}|${phaseIndex}`;
    if (tracks.has(key)) return tracks.get(key);
    const fall = (top - land) / RAIN_V;
    const phase = ((phaseIndex + 0.5) / PHASES) * RAIN_PERIOD;
    const corners = [0, fall - 0.001, fall];
    const tr = periodicKeys(RAIN_PERIOD, phase, corners, (u) => [0, u < fall - 0.0005 ? top - RAIN_V * u : u < fall ? land : top, 0]);
    const sc = periodicKeys(RAIN_PERIOD, phase, corners, (u) => (u < fall - 0.0005 ? [1, 1, 1] : HIDDEN));
    // Share the times array between the two channels.
    const track = { times: tr.times, tr: tr.values, sc: sc.values };
    tracks.set(key, track);
    return track;
  };
  const STREAKS = 720;
  const side = Math.ceil(Math.sqrt(STREAKS / (Math.PI / 4)));
  const spots = [];
  for (let i = 0; i < side; i += 1) {
    for (let j = 0; j < side; j += 1) {
      const x = ((i + random()) / side) * 2 - 1;
      const z = ((j + random()) / side) * 2 - 1;
      if (Math.hypot(x, z) < 0.97) spots.push([x * SLAB_R * 0.94, z * SLAB_R * 0.94, random()]);
    }
  }
  spots.sort((a, b) => a[2] - b[2]);
  let streakCount = 0;
  for (const [x, z] of spots.slice(0, STREAKS)) {
    const hit = hitTop(x, z);
    const land = Math.round(hit.y / 0.015) * 0.015;
    const top = RAIN_TOP - STREAK_L - [0, 0.08, 0.16][Math.floor(random() * 3)];
    const track = rainTrack(+top.toFixed(3), +land.toFixed(3), Math.floor(random() * PHASES));
    const warm = lampWarmth(x, 1.2, z) > 0.5;
    const holder = glb.node({ name: `rain-${streakCount}`, translation: [x, 0, z], parent: root });
    const drop = glb.node({ name: `rain-${streakCount}-drop`, mesh: warm ? streakMesh.warm : streakMesh.cool, translation: [0, 1, 0], scale: HIDDEN, parent: holder });
    glb.animate(drop, 'translation', track.times, track.tr);
    glb.animate(drop, 'scale', track.times, track.sc, 'STEP');
    streakCount += 1;
  }

  // ---- sample where rain lands on the people
  const hits = { adult: [], child: [], umbrella: [] };
  for (let i = 0; i < 9000; i += 1) {
    const x = -1.2 + random() * 1.75;
    const z = -0.3 + random() * 0.65;
    const hit = hitTop(x, z);
    if (hit.obj !== 'ground') hits[hit.obj].push(hit);
  }
  const pick = (list, filter, count) => {
    const pool = list.filter(filter);
    const out = [];
    for (let i = 0; i < count && pool.length; i += 1) out.push(pool[Math.floor(random() * pool.length)]);
    return out;
  };

  // ---- splashes: a crown where a drop strikes, dense on the silhouettes
  const crown = splashGeometry();
  const splashMesh = { warm: glb.mesh('SplashWarm', crown, splashWarm), cool: glb.mesh('SplashCool', crown, splashCool) };
  const SPLASH_PERIOD = 0.8;
  const splashTracks = [];
  for (let k = 0; k < 16; k += 1) {
    const phase = ((k + 0.5) / 16) * SPLASH_PERIOD;
    const corners = [0, 0.035, 0.17, 0.171];
    const sc = periodicKeys(SPLASH_PERIOD, phase, corners, (u) => {
      if (u < 0.035) return HIDDEN.map((h, i) => h + ((u / 0.035) * (1 - h)) * [1, 1, 1][i]);
      if (u < 0.17) {
        const s = 1 + 0.5 * ((u - 0.035) / 0.135);
        const flat = 1 - 0.65 * ((u - 0.035) / 0.135);
        return [s, flat, s];
      }
      return HIDDEN;
    });
    splashTracks.push(sc);
  }
  const head = (h) => ['head', 'neck'].includes(h.tag);
  const shoulders = (h) => ['shoulder', 'chest'].includes(h.tag);
  const reachArm = (h) => ['reach', 'hand'].includes(h.tag);
  const farArm = (h) => ['farArm', 'farHand'].includes(h.tag);
  const splashSpots = [
    ...pick(hits.adult, head, 55),
    ...pick(hits.adult, shoulders, 80),
    ...pick(hits.adult, reachArm, 50),
    ...pick(hits.adult, farArm, 32),
    ...pick(hits.child, () => true, 12),
    ...pick(hits.umbrella, () => true, 70)
  ];
  // Sparse on the street, mostly along the edges of the dry shapes.
  for (let tries = 0; splashSpots.length < 330 && tries < 4000; tries += 1) {
    const x = -1.35 + random() * 2.2;
    const z = -0.7 + random() * 1.5;
    if (Math.hypot(x, z) > SLAB_R * 0.9 || isDry(x, z)) continue;
    const near = [[0.12, 0], [-0.12, 0], [0, 0.12], [0, -0.12]].some(([dx, dz]) => isDry(x + dx, z + dz));
    if (!near && random() > 0.25) continue;
    splashSpots.push({ obj: 'ground', tag: 'ground', p: [x, 0.002, z], n: [0, 1, 0] });
  }
  splashSpots.forEach((hit, i) => {
    const { parent, p } = frameOf(hit.obj, hit.tag, hit.p);
    const warm = lampWarmth(hit.p[0], hit.p[1], hit.p[2]) > 0.35;
    const size = hit.obj === 'ground' ? 0.7 : 1;
    const node = glb.node({ name: `splash-${i}`, mesh: warm ? splashMesh.warm : splashMesh.cool, translation: p, rotation: alignY(hit.n), scale: HIDDEN, parent });
    const track = splashTracks[Math.floor(random() * splashTracks.length)];
    const values = size === 1 ? track.values : (track.scaled ??= track.values.map((v) => (v > 1e-3 ? v * size : v)));
    glb.animate(node, 'scale', track.times, values);
  });

  // ---- runoff: beads sliding down the bodies and dripping off the umbrella
  const beadGeometry = new IcosahedronGeometry(0.0115, 1);
  const beadMesh = { warm: glb.mesh('BeadWarm', beadGeometry, beadWarm), cool: glb.mesh('BeadCool', beadGeometry, beadCool) };
  let beadCount = 0;
  const addBead = (parent, path, period, phase, stretch = [1, 1, 1], warm = true) => {
    const node = glb.node({ name: `bead-${beadCount}`, mesh: warm ? beadMesh.warm : beadMesh.cool, scale: HIDDEN, parent });
    beadCount += 1;
    const tr = sampled(10, (t) => path.at((((t - phase) % period) + period) % period));
    const sc = sampled(10, (t) => {
      const u = (((t - phase) % period) + period) % period;
      return u > 0.04 && u < path.duration - 0.02 ? stretch : HIDDEN;
    });
    glb.animate(node, 'translation', tr.times, tr.values);
    glb.animate(node, 'scale', sc.times, sc.values, 'STEP');
  };
  const runoff = (body, obj, starts) => {
    for (const hit of starts) {
      const pts = trace(body, hit.p, random);
      if (pts.length < 6) continue;
      const v = 0.3 + random() * 0.18;
      let path = timeline(pts, v);
      let period = PERIODS.find((P) => P >= path.duration + 0.3);
      if (!period) {
        path = timeline(pts, (v * path.duration) / 11.5);
        period = 12;
      }
      const { parent } = frameOf(obj, hit.tag, hit.p);
      const local = parent === arm ? { duration: path.duration, at: (t) => sub3(path.at(t), SHOULDER) } : path;
      addBead(parent, local, period, random() * period, [1, 1, 1], lampWarmth(...hit.p) > 0.35);
    }
  };
  runoff(ADULT, 'adult', [
    ...pick(hits.adult, head, 26),
    ...pick(hits.adult, shoulders, 64),
    ...pick(hits.adult, reachArm, 26),
    ...pick(hits.adult, farArm, 24)
  ]);
  runoff(CHILD, 'child', pick(hits.child, () => true, 10));
  const bodyBeads = beadCount;

  // The umbrella: beads run down the ribs to the tips; a ring of drips falls from the rim.
  const umbrellaPath = (phi, r0) => {
    const pts = [];
    for (let i = 0; i <= 20; i += 1) {
      const r = r0 + (rimR(phi) - r0) * (i / 20);
      pts.push({ p: sub3(canopyPoint(r, phi), FIST), fall: false });
    }
    const tip = pts[pts.length - 1].p;
    pts.push({ p: [tip[0], tip[1] - 0.012, tip[2]], fall: false });
    pts.push({ p: [tip[0], -FIST[1], tip[2]], fall: true });
    return pts;
  };
  for (let i = 0; i < 26; i += 1) {
    const rib = (Math.floor(random() * RIBS) + (random() < 0.3 ? 0.5 : 0)) / RIBS;
    const path = timeline(umbrellaPath(rib * TAU + (random() - 0.5) * 0.05, 0.05 + random() * 0.1), 0.22 + random() * 0.1, RAIN_V);
    const period = PERIODS.find((P) => P >= path.duration + 0.3) ?? 12;
    addBead(umbrella, path, period, random() * period);
  }
  const DRIPS = 64;
  for (let i = 0; i < DRIPS; i += 1) {
    const phi = ((i + random() * 0.6) / DRIPS) * TAU;
    const rim = sub3(canopyPoint(rimR(phi), phi), FIST);
    const pts = [
      { p: [rim[0], rim[1] - 0.008, rim[2]], fall: false },
      { p: [rim[0], rim[1] - 0.02, rim[2]], fall: false },
      { p: [rim[0], -FIST[1] + 0.01, rim[2]], fall: true }
    ];
    const path = timeline(pts, 0.05, RAIN_V);
    const period = [1.2, 1.5, 2, 2.4, 3][Math.floor(random() * 5)];
    addBead(umbrella, path, period, random() * period, [0.8, 2.2, 0.8]);
  }
  const umbrellaBeads = beadCount - bodyBeads;

  // ---- water clinging to the bodies: static, one mesh per moving frame
  const clingParts = { root: [], arm: [], child: [] };
  const sprinkle = (body, obj, count, accept) => {
    let placed = 0;
    for (let tries = 0; placed < count && tries < count * 60; tries += 1) {
      const q = [body.lo[0] + random() * (body.hi[0] - body.lo[0]), body.lo[1] + random() * (body.hi[1] - body.lo[1]), body.lo[2] + random() * (body.hi[2] - body.lo[2])];
      if (Math.abs(body.sdf(q)) > 0.012) continue;
      const p = project(body.sdf, q);
      const n = gradient(body.sdf, p);
      const tag = body.tag(p);
      if (!accept(p, n, tag)) continue;
      const r = 0.0055 + random() * 0.0045;
      const g = new IcosahedronGeometry(r, 0);
      g.scale(1, 1.25, 1);
      g.translate(...add3(p, mul3(n, r * 0.6)));
      const frame = frameOf(obj, tag, p);
      const key = frame.parent === arm ? 'arm' : obj === 'child' ? 'child' : 'root';
      if (key === 'arm') g.translate(-SHOULDER[0], -SHOULDER[1], -SHOULDER[2]);
      clingParts[key].push(prep(g));
      placed += 1;
    }
  };
  sprinkle(ADULT, 'adult', 1900, (p, n) => random() < 0.45 + 0.55 * Math.max(0, n[1]) && p[1] > 0.03);
  sprinkle(CHILD, 'child', 650, (p, n, tag) => (p[1] < 0.3 && p[1] > 0.02) || random() < 0.32 || ((tag === 'cReach' || tag === 'cHand') && hitTop(p[0], p[2]).obj === 'child'));
  glb.node({ name: 'ClingAdult', mesh: glb.mesh('ClingAdult', mergeGeometries(clingParts.root), cling), parent: root });
  glb.node({ name: 'ClingReach', mesh: glb.mesh('ClingReach', mergeGeometries(clingParts.arm), cling), parent: arm });
  glb.node({ name: 'ClingChild', mesh: glb.mesh('ClingChild', mergeGeometries(clingParts.child), cling), parent: childFrame });

  // ---- ripples on the street, never inside the dry shapes
  const ringGeometry = new RingGeometry(0.82, 1, 28);
  ringGeometry.rotateX(-Math.PI / 2);
  const rippleMesh = { cool: glb.mesh('RippleCool', ringGeometry, rippleCool), warm: glb.mesh('RippleWarm', ringGeometry, rippleWarm) };
  const rippleTracks = [];
  for (let k = 0; k < 10; k += 1) {
    const period = k % 2 ? 1.2 : 1.5;
    const phase = ((k + 0.5) / 10) * period;
    const grow = 0.55;
    rippleTracks.push(
      periodicKeys(period, phase, [0, grow, grow + 0.001], (u) => {
        if (u >= grow) return HIDDEN;
        const s = 0.012 + 0.07 * (u / grow) ** 0.6;
        return [s, 1, s];
      })
    );
  }
  const rippleSpots = [];
  // Where the umbrella's drips land: a ring around the child's dry patch.
  for (let i = 0; i < 16; i += 1) {
    const phi = ((i + 0.5) / 16) * TAU;
    const rim = canopyPoint(rimR(phi), phi);
    rippleSpots.push([rim[0], rim[2]]);
  }
  for (let tries = 0; rippleSpots.length < 84 && tries < 6000; tries += 1) {
    const x = -1.4 + random() * 2.6;
    const z = -1.0 + random() * 2.2;
    if (Math.hypot(x, z) > SLAB_R * 0.88 || isDry(x, z)) continue;
    const near = [[0.15, 0], [-0.15, 0], [0, 0.15], [0, -0.15]].some(([dx, dz]) => isDry(x + dx, z + dz));
    const pool = lampWarmth(x, 0, z);
    if (!near && !inPuddle(x, z) && random() > 0.15 + 0.35 * pool) continue;
    rippleSpots.push([x, z]);
  }
  rippleSpots.forEach(([x, z], i) => {
    const warm = lampWarmth(x, 0, z) > 0.45;
    const node = glb.node({ name: `ripple-${i}`, mesh: warm ? rippleMesh.warm : rippleMesh.cool, translation: [x, inPuddle(x, z) ? 0.003 : 0.0035, z], scale: HIDDEN, parent: root });
    const track = rippleTracks[Math.floor(random() * rippleTracks.length)];
    glb.animate(node, 'scale', track.times, track.values);
  });

  // ---- the hop: rings and droplets thrown up from two small footprints
  const hopRingGeometry = new RingGeometry(0.86, 1, 36);
  hopRingGeometry.rotateX(-Math.PI / 2);
  const hopRing = glb.mesh('HopRing', hopRingGeometry, splashWarm);
  CHILD_FEET.forEach((foot, f) => {
    const land = HOP_LAND + f * 0.04;
    for (let k = 0; k < 2; k += 1) {
      const start = land + k * 0.12;
      const node = glb.node({ name: `hop-ring-${f}-${k}`, mesh: hopRing, translation: [foot[0], 0.004, foot[2]], scale: HIDDEN, parent: root });
      const sc = sampled(30, (t) => {
        const u = (t - start) / 0.75;
        if (u < 0 || u > 1) return HIDDEN;
        const s = 0.03 + (0.16 + 0.05 * k) * Math.sqrt(u);
        return [s, 1, s];
      });
      glb.animate(node, 'scale', sc.times, sc.values);
    }
    for (let k = 0; k < 10; k += 1) {
      const a = (k / 10) * TAU + random() * 0.5 + f;
      const vh = 0.35 + random() * 0.45;
      const vy = 0.9 + random() * 0.8;
      const g = 5;
      const flight = (2 * vy) / g;
      const start = land + random() * 0.03;
      const node = glb.node({ name: `hop-drop-${f}-${k}`, mesh: beadMesh.warm, scale: HIDDEN, parent: root });
      const at = (t) => {
        const u = Math.min(Math.max(t - start, 0), flight);
        return [foot[0] + Math.cos(a) * (0.03 + vh * u), 0.01 + vy * u - 0.5 * g * u * u, foot[2] + Math.sin(a) * (0.03 + vh * u)];
      };
      const tr = sampled(30, at);
      const sc = sampled(30, (t) => (t > start && t < start + flight - 0.02 ? [0.85, 0.85, 0.85] : HIDDEN));
      glb.animate(node, 'translation', tr.times, tr.values);
      glb.animate(node, 'scale', sc.times, sc.values, 'STEP');
    }
  });

  glb.audio(sound());
  build.stats = { streaks: streakCount, rainTracks: tracks.size, splashes: splashSpots.length, bodyBeads, umbrellaBeads, ripples: rippleSpots.length };
  return glb;
}

// ---------------------------------------------------------------- sound

function sound() {
  const N = track(LOOP).length;
  const out = new Float32Array(N);
  // The rain bed: lowpassed noise, folded over the loop point so it joins.
  const fade = SAMPLE_RATE;
  const raw = new Float32Array(N + fade);
  const hiss = noise(11);
  for (let i = 0; i < raw.length; i += 1) raw[i] = hiss();
  lowpass(raw, 1300);
  lowpass(raw, 1900);
  const rumble = Float32Array.from(raw);
  lowpass(rumble, 140);
  for (let i = 0; i < N; i += 1) out[i] = 0.55 * (raw[i] - 0.7 * rumble[i]);
  for (let i = 0; i < fade; i += 1) {
    const w = i / fade;
    out[i] = 0.55 * (Math.sqrt(w) * (raw[i] - 0.7 * rumble[i]) + Math.sqrt(1 - w) * (raw[N + i] - 0.7 * rumble[N + i]));
  }

  // The umbrella's patter: light, soft taps, a little pitched like stretched cloth.
  const random = rng(77);
  const tick = noise(5);
  for (let k = 0; k < LOOP * 22; k += 1) {
    const at = random() * LOOP;
    const hz = 900 + random() * 700;
    const gain = 0.03 + random() * 0.035;
    add(out, at, 0.05, (t) => sine(hz)(t) * 0.7 + tick() * 0.3, (t) => gain * pluck(0.0015, 0.011)(t));
  }

  // The double splash at the landing: two soft thumps of water, then a few droplets.
  const splashNoise = noise(23);
  const burst = new Float32Array(Math.round(0.45 * SAMPLE_RATE));
  for (let i = 0; i < burst.length; i += 1) burst[i] = splashNoise() * pluck(0.004, 0.085)(i / SAMPLE_RATE);
  lowpass(burst, 1200);
  lowpass(burst, 1500);
  const play = (buffer, gain) => (t) => gain * (buffer[Math.min(buffer.length - 1, Math.floor(t * SAMPLE_RATE))] ?? 0);
  add(out, HOP_LAND, 0.45, play(burst, 3.2));
  add(out, HOP_LAND + 0.04, 0.45, play(burst, 2.4));
  for (let k = 0; k < 7; k += 1) {
    const at = HOP_LAND + 0.25 + random() * 0.45;
    const hz = 600 + random() * 500;
    add(out, at, 0.06, sine(hz), (t) => 0.05 * pluck(0.002, 0.016)(t));
  }

  // The lamp: a low warm hum, whole cycles per loop.
  add(out, 0, LOOP, (t) => (0.018 * sine(60)(t) + 0.01 * sine(120)(t) + 0.003 * sine(180)(t)) * (0.8 + 0.2 * sine(0.25)(t)));
  return toWav(normalize(out, 0.6));
}

// ---------------------------------------------------------------- contact sheet

const MID = [0, 1.66, 0];
const FEED_D = 6.6;
const feedCam = [MID[0] + 0.297 * FEED_D, MID[1] + 0.276 * FEED_D, MID[2] + 0.914 * FEED_D];
const PEOPLE = [-0.25, 0.95, 0.05];

export const tiles = [
  { label: 'feed', cam: feedCam, look: MID, t: 3.0 },
  { label: 'front', cam: [-0.2, 1.25, 4.6], look: PEOPLE, t: 4.0 },
  { label: 'left', cam: [-4.6, 1.25, 0.1], look: PEOPLE, t: 5.0 },
  { label: 'right', cam: [4.6, 1.25, 0.1], look: PEOPLE, t: 5.5 },
  { label: 'close head', cam: [0.45, 1.85, 1.5], look: [0.08, 1.42, 0.0], t: 2.2, fov: 40 },
  { label: 'top', cam: [-0.25, 5.2, 0.35], look: [-0.25, 0, 0.05], t: 6.0, fov: 40 },
  { label: 'hop', cam: [-0.3, 1.25, 1.9], look: [-0.68, 0.62, 0.15], t: 8.46, fov: 50 },
  { label: 'quiet', cam: feedCam, look: MID, t: 11.0 },
  { label: 'back', cam: [0.6, 2.2, -4.6], look: PEOPLE, t: 0.5 }
];
