import { BufferGeometry, Float32BufferAttribute, Matrix4, Quaternion, Vector3 } from 'three';

import { toWav, SAMPLE_RATE } from './lib/audio.mjs';
import { Glb } from './lib/glb.mjs';
import { fbm3, rng } from './lib/parts.mjs';
import { T } from './lib/tokens.mjs';

// "Murmuration": 480 starlings of light, true size, as one thick flock that
// travels, stretches, folds and wheels. Each bird holds a place inside a
// deforming volume (blue-noise in a ball, pushed through a time-periodic
// stretch, taper, twist, fold and a density wave that bunches parts of it).
// The volume's centre flies a four-petal rose around the standing spot, so it
// sweeps through the listener four times a loop: engulfs, then leaves. A video
// can only pick the outside or the inside; here you zoom between them. Every
// function of time has a whole number of cycles per loop, so the loop is
// seamless by construction (and checked numerically in build()).

export const meta = {
  slug: 'murmuration',
  name: 'Murmuration',
  submittedBy: 'Claude (agent-authored)'
};

const TAU = Math.PI * 2;
const LOOP = 24;
const KEY_HZ = 12; // position and rotation
const KEYS = LOOP * KEY_HZ;
const FLAP_HZ = 30; // wing scale keys, shared by all birds
const FLAP_KEYS = LOOP * FLAP_HZ;
const BIRDS = 480;
const HEAD = new Vector3(0, 1.6, 0);
const CLEAR = 0.3; // a bird's centre never comes closer to the head than this
const ROSE = 2.2; // reach of the flock's path
const SURGE = 0.17; // how much faster the flock moves through the middle than around the petal tips

// ---------------------------------------------------------------- the flow

/** Path phase for loop phase tau: quick through the middle (origin passes), slow wheeling at the petal tips. */
function pathPhase(tau) {
  let th = tau;
  for (let i = 0; i < 6; i += 1) th -= (th + SURGE * Math.sin(4 * th) - tau) / (1 + 4 * SURGE * Math.cos(4 * th));
  return th;
}

/** The flock centre at loop phase tau. */
function flockCentre(tau, out) {
  const th = pathPhase(tau);
  const r = ROSE * Math.cos(2 * th);
  return out.set(r * Math.cos(th), 2.5 + 0.4 * Math.cos(4 * th) + 0.2 * Math.sin(tau + 0.7), r * Math.sin(th));
}

const cA = new Vector3();
const cB = new Vector3();
const cC = new Vector3();
const frame = { fx: 0, fz: 1 };

/** Horizontal direction of travel at tau, smoothed over a little time so wheeling is gradual. */
function travel(tau) {
  const d = 0.02;
  flockCentre(tau + d, cA);
  flockCentre(tau - d, cB);
  const x = cA.x - cB.x;
  const z = cA.z - cB.z;
  const n = Math.hypot(x, z) || 1;
  frame.fx = x / n;
  frame.fz = z / n;
}

const sP = new Vector3();

/** Bird position at time t (s), written into `out`. */
function birdAt(b, t, out) {
  const tau = (TAU * t) / LOOP;
  const th = pathPhase(tau);
  const c4 = Math.cos(4 * th);
  flockCentre(tau, cC);
  travel(tau);
  const fx = frame.fx;
  const fz = frame.fz;

  // The bird's place in the unit volume, wandering a little (whole cycles per loop).
  let f = b.u[0] + 0.1 * Math.sin(b.m[0] * tau + b.ph[0]);
  let l = b.u[1] + 0.1 * Math.sin(b.m[1] * tau + b.ph[1]);
  let v = b.u[2] + 0.1 * Math.sin(b.m[2] * tau + b.ph[2]);
  // Density waves: slopes stay positive, so birds bunch and thin without crossing.
  f += 0.15 * Math.sin(3 * f - 3 * tau + 0.4);
  l += 0.14 * Math.sin(2.5 * f - 2 * tau + 1.3);
  v += 0.12 * Math.sin(3 * l + 2 * tau);
  // A teardrop that points forwards, then backwards; a twist; a fold.
  const taper = 1 - 0.55 * Math.sin(tau + 0.4) * f;
  l *= taper;
  v *= taper;
  const twist = 0.9 * Math.sin(2 * tau + 0.3) * f;
  const ct = Math.cos(twist);
  const st = Math.sin(twist);
  const l2 = l * ct - v * st;
  const v2 = l * st + v * ct;
  const fold = 1.0 * Math.sin(2 * tau + 2) * (f * f - 0.3);
  const bend = 0.4 * Math.sin(3 * tau) * (f * f - 0.3);
  // Stretched along the path while it surges, a pancake while it wheels.
  const sf = 1.6 - 0.6 * c4 + 0.3 * Math.sin(3 * tau + 0.2);
  const sl = 1.35 - 0.05 * c4 + 0.3 * Math.sin(2 * tau + 1);
  const sv = 0.85 - 0.2 * c4 + 0.1 * Math.sin(5 * tau + 0.8);
  const af = f * sf;
  const al = (l2 + bend) * sl;
  const av = v2 * sv + fold * 0.9;
  out.set(cC.x + af * fx + al * -fz, cC.y + av, cC.z + af * fz + al * fx);

  // The listener's clear radius: exact at the head, a soft push out to ~1.5 m.
  const dx = out.x - HEAD.x;
  const dy = out.y - HEAD.y;
  const dz = out.z - HEAD.z;
  const r = Math.hypot(dx, dy, dz) || 1e-6;
  const r2 = Math.sqrt(r * r + CLEAR * CLEAR);
  out.set(HEAD.x + (dx / r) * r2, HEAD.y + (dy / r) * r2, HEAD.z + (dz / r) * r2);
  // A smooth floor: nothing drops below about 0.4 m.
  const z = out.y - 0.45;
  out.y = 0.45 + 0.5 * (z + Math.sqrt(z * z + 0.04));
  void sP;
  return out;
}

function makeFlock() {
  const random = rng(20261109);
  const ball = () => {
    for (;;) {
      const p = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1];
      if (p[0] * p[0] + p[1] * p[1] + p[2] * p[2] <= 1) return p;
    }
  };
  const placed = [];
  // Blue-noise: each bird is the best of several candidates, so neighbours keep their spacing.
  for (let i = 0; i < BIRDS; i += 1) {
    let best = null;
    let bestScore = -1;
    for (let k = 0; k < 12; k += 1) {
      const p = ball();
      let score = Infinity;
      for (const o of placed) {
        const d = (p[0] - o[0]) ** 2 + (p[1] - o[1]) ** 2 + (p[2] - o[2]) ** 2;
        if (d < score) score = d;
      }
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    placed.push(best);
  }
  return placed.map((u) => ({
    u,
    m: [1 + Math.floor(random() * 3), 1 + Math.floor(random() * 3), 1 + Math.floor(random() * 3)],
    ph: [random() * TAU, random() * TAU, random() * TAU],
    hue: Math.floor(random() * 4),
    flap: Math.floor(random() * 8)
  }));
}

const FLOCK = makeFlock();

// Keep every bird's keyed path (the straight chords the viewer draws between keys) clear of the head.
{
  const random = rng(77);
  const p = new Vector3();
  const q = new Vector3();
  const s = new Vector3();
  const w = new Vector3();
  const near = (b) => {
    let min = Infinity;
    birdAt(b, 0, q);
    for (let k = 1; k <= KEYS; k += 1) {
      p.copy(q);
      birdAt(b, k / KEY_HZ, q);
      s.copy(q).sub(p);
      const h = Math.max(0, Math.min(1, s.dot(w.copy(HEAD).sub(p)) / (s.lengthSq() || 1)));
      min = Math.min(min, w.copy(p).addScaledVector(s, h).distanceTo(HEAD));
    }
    return min;
  };
  for (const b of FLOCK) {
    const home = b.u.slice();
    for (let tries = 0; tries < 80 && near(b) < CLEAR * 0.98; tries += 1) {
      b.u = home.map((v) => v + (random() - 0.5) * 0.3);
    }
  }
}

// ------------------------------------------------------- baked motion

const forward = new Vector3();
const accel = new Vector3();
const pa = new Vector3();
const pb = new Vector3();
const pc = new Vector3();
const basis = new Matrix4();
const rightV = new Vector3();
const upV = new Vector3();
const backV = new Vector3();

function orientation(b, t, q) {
  const h = 1 / 40;
  birdAt(b, t - h, pa);
  birdAt(b, t, pb);
  birdAt(b, t + h, pc);
  forward.copy(pc).sub(pa).normalize();
  accel.copy(pa).add(pc).addScaledVector(pb, -2).multiplyScalar(1 / (h * h));
  upV.set(0, 9.8, 0).addScaledVector(accel, 0.5).normalize();
  upV.addScaledVector(forward, -upV.dot(forward)).normalize();
  rightV.crossVectors(forward, upV);
  backV.copy(forward).negate();
  basis.makeBasis(rightV, upV, backV);
  return q.setFromRotationMatrix(basis);
}

// Eight wingbeat tracks (whole beats per loop each), shared by every bird. Scale Y runs +1 (raised V) to -0.5 (flipped).
const FLAP_TIMES = Array.from({ length: FLAP_KEYS + 1 }, (_, k) => k / FLAP_HZ);
const FLAP_TRACKS = [
  [5, 0],
  [5, 3.1],
  [6, 0.8],
  [6, 3.9],
  [6.6666667, 1.7],
  [6.6666667, 4.7],
  [7.5, 2.4],
  [7.5, 5.3]
].map(([beat, phase]) => {
  const values = [];
  for (const t of FLAP_TIMES) values.push(1, 0.25 + 0.75 * Math.cos(TAU * beat * t + phase), 1);
  return values;
});

function bake() {
  const times = Array.from({ length: KEYS + 1 }, (_, k) => k / KEY_HZ);
  const birds = FLOCK.map((b) => {
    const pos = new Float32Array((KEYS + 1) * 3);
    const rot = new Float32Array((KEYS + 1) * 4);
    const q = new Quaternion();
    const prev = new Quaternion();
    for (let k = 0; k <= KEYS; k += 1) {
      const t = times[k];
      birdAt(b, t, pb);
      pos.set([pb.x, pb.y, pb.z], k * 3);
      orientation(b, t, q);
      if (k > 0 && q.dot(prev) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      prev.copy(q);
      rot.set([q.x, q.y, q.z, q.w], k * 4);
    }
    return { pos, rot };
  });
  return { times, birds };
}

let BAKED = null;
function baked() {
  BAKED ??= bake();
  return BAKED;
}

// ------------------------------------------------------------ analysis

function analyse(motion) {
  const { birds } = motion;
  let seamPos = 0;
  let seamHead = 0;
  let stepMax = 0;
  let stepSum = 0;
  let stepCount = 0;
  let minHead = Infinity;
  let minY = Infinity;
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const f0 = new Vector3();
  const f1 = new Vector3();
  const quatA = new Quaternion();
  const quatB = new Quaternion();
  for (const bird of birds) {
    for (let k = 0; k <= KEYS; k += 1) {
      const x = bird.pos[k * 3];
      const y = bird.pos[k * 3 + 1];
      const z = bird.pos[k * 3 + 2];
      minY = Math.min(minY, y);
      minHead = Math.min(minHead, Math.hypot(x - HEAD.x, y - HEAD.y, z - HEAD.z));
      [x, y, z].forEach((value, i) => {
        bounds.min[i] = Math.min(bounds.min[i], value);
        bounds.max[i] = Math.max(bounds.max[i], value);
      });
      if (k > 0) {
        const step = Math.hypot(x - bird.pos[k * 3 - 3], y - bird.pos[k * 3 - 2], z - bird.pos[k * 3 - 1]);
        stepMax = Math.max(stepMax, step);
        stepSum += step;
        stepCount += 1;
      }
    }
    seamPos = Math.max(seamPos, Math.hypot(bird.pos[0] - bird.pos[KEYS * 3], bird.pos[1] - bird.pos[KEYS * 3 + 1], bird.pos[2] - bird.pos[KEYS * 3 + 2]));
    quatA.set(bird.rot[0], bird.rot[1], bird.rot[2], bird.rot[3]);
    quatB.set(bird.rot[KEYS * 4], bird.rot[KEYS * 4 + 1], bird.rot[KEYS * 4 + 2], bird.rot[KEYS * 4 + 3]);
    f0.set(0, 0, -1).applyQuaternion(quatA);
    f1.set(0, 0, -1).applyQuaternion(quatB);
    seamHead = Math.max(seamHead, f0.angleTo(f1));
  }
  // Birds within 1.5 m of the head, every half second.
  const near = [];
  for (let k = 0; k < KEYS; k += KEY_HZ / 2) {
    let n = 0;
    for (const bird of birds) if (Math.hypot(bird.pos[k * 3] - HEAD.x, bird.pos[k * 3 + 1] - HEAD.y, bird.pos[k * 3 + 2] - HEAD.z) < 1.5) n += 1;
    near.push(n);
  }
  return { seamPos, seamHead, stepMax, meanStep: stepSum / stepCount, minHead, minY, bounds, near };
}

// ------------------------------------------------------------ the bird

function birdGeometry() {
  // A starling from above: forward is -Z, up +Y, body 0.19 long and 0.045 wide with a pointed beak and a notched tail;
  // two narrow pointed wings (span 0.35, root chord 0.07) swept back and raised in a shallow V.
  const v = {
    beak: [0, 0, -0.095],
    headL: [-0.012, 0, -0.06],
    headR: [0.012, 0, -0.06],
    shL: [-0.0225, 0, -0.02],
    shR: [0.0225, 0, -0.02],
    hipL: [-0.016, 0, 0.045],
    hipR: [0.016, 0, 0.045],
    tailL: [-0.026, 0, 0.095],
    tailR: [0.026, 0, 0.095],
    notch: [0, 0, 0.072],
    rootFL: [-0.02, 0.003, -0.03],
    rootFR: [0.02, 0.003, -0.03],
    rootBL: [-0.02, 0, 0.04],
    rootBR: [0.02, 0, 0.04],
    midFL: [-0.095, 0.014, -0.028],
    midFR: [0.095, 0.014, -0.028],
    midBL: [-0.09, 0.012, 0.022],
    midBR: [0.09, 0.012, 0.022],
    tipL: [-0.175, 0.035, 0.035],
    tipR: [0.175, 0.035, 0.035]
  };
  const shade = {
    beak: 1.0, headL: 0.95, headR: 0.95, shL: 0.85, shR: 0.85, hipL: 0.75, hipR: 0.75, tailL: 0.6, tailR: 0.6, notch: 0.65,
    rootFL: 0.85, rootFR: 0.85, rootBL: 0.75, rootBR: 0.75, midFL: 0.95, midFR: 0.95, midBL: 0.8, midBR: 0.8, tipL: 1.0, tipR: 1.0
  };
  const tris = [
    ['beak', 'headL', 'headR'],
    ['headL', 'shL', 'shR'],
    ['headL', 'shR', 'headR'],
    ['shL', 'hipL', 'hipR'],
    ['shL', 'hipR', 'shR'],
    ['hipL', 'tailL', 'notch'],
    ['hipR', 'notch', 'tailR'],
    ['hipL', 'notch', 'hipR'],
    ['rootFL', 'midFL', 'midBL'],
    ['rootFL', 'midBL', 'rootBL'],
    ['midFL', 'tipL', 'midBL'],
    ['rootFR', 'midBR', 'midFR'],
    ['rootFR', 'rootBR', 'midBR'],
    ['midFR', 'midBR', 'tipR']
  ];
  const position = [];
  const color = [];
  for (const tri of tris) {
    for (const name of tri) {
      position.push(...v[name]);
      color.push(shade[name], shade[name], shade[name]);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(position, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(color, 3));
  return geometry;
}

// ----------------------------------------------------------- the spot

function discGeometries() {
  const N = 72;
  const radius = (q) => {
    let r = 0.32 + 0.07 * (fbm3(Math.cos(q) * 1.6 + 5, Math.sin(q) * 1.6, 0.3, { seed: 9 }) - 0.5);
    for (const [at, w, d] of [[0.7, 0.14, 0.09], [2.5, 0.1, 0.07], [4.1, 0.16, 0.1], [5.4, 0.08, 0.06]]) {
      let dq = Math.abs(q - at);
      dq = Math.min(dq, TAU - dq);
      r -= d * Math.exp(-((dq / w) ** 2));
    }
    return r;
  };
  const face = [];
  const rim = [];
  for (let i = 0; i < N; i += 1) {
    const q0 = (i / N) * TAU;
    const q1 = ((i + 1) / N) * TAU;
    const r0 = radius(q0);
    const r1 = radius(q1);
    const p0 = [r0 * Math.cos(q0), r0 * Math.sin(q0)];
    const p1 = [r1 * Math.cos(q1), r1 * Math.sin(q1)];
    face.push(0, 0, 0, p1[0], 0, p1[1], p0[0], 0, p0[1]);
    // The lit lip: a band just inside the torn edge, wider where the noise says it burns.
    const lip0 = 0.012 + 0.03 * fbm3(q0 * 2, 1.0, 0.0, { seed: 4 });
    const lip1 = 0.012 + 0.03 * fbm3(q1 * 2, 1.0, 0.0, { seed: 4 });
    const i0 = [(r0 - lip0) * Math.cos(q0), (r0 - lip0) * Math.sin(q0)];
    const i1 = [(r1 - lip1) * Math.cos(q1), (r1 - lip1) * Math.sin(q1)];
    rim.push(i0[0], 0, i0[1], p1[0], 0, p1[1], p0[0], 0, p0[1], i0[0], 0, i0[1], i1[0], 0, i1[1], p1[0], 0, p1[1]);
  }
  const faceGeo = new BufferGeometry();
  faceGeo.setAttribute('position', new Float32BufferAttribute(face, 3));
  const rimGeo = new BufferGeometry();
  rimGeo.setAttribute('position', new Float32BufferAttribute(rim, 3));
  // Flakes torn off the edge and drifting out.
  const random = rng(31);
  const flakes = [];
  for (let i = 0; i < 9; i += 1) {
    const q = random() * TAU;
    const r = 0.38 + random() * 0.14;
    const s = 0.012 + random() * 0.02;
    const rot = random() * TAU;
    const c = [r * Math.cos(q), r * Math.sin(q)];
    for (const k of [0, 1, 2]) {
      const a = rot + (k / 3) * TAU;
      flakes.push(c[0] + s * Math.cos(a) * (k === 0 ? 1.6 : 1), 0, c[1] + s * Math.sin(a) * (k === 0 ? 1.6 : 1));
    }
  }
  const flakeGeo = new BufferGeometry();
  flakeGeo.setAttribute('position', new Float32BufferAttribute(flakes, 3));
  return { faceGeo, rimGeo, flakeGeo };
}

// ------------------------------------------------------------- sound

function sound(motion) {
  const { birds } = motion;
  // Loudness and brightness follow how many birds are near the head and how fast they move.
  const level = new Float64Array(KEYS);
  for (let k = 0; k < KEYS; k += 1) {
    let sum = 0;
    const kn = (k + 1) % KEYS;
    const kp = (k + KEYS - 1) % KEYS;
    for (const bird of birds) {
      const dx = bird.pos[k * 3] - HEAD.x;
      const dy = bird.pos[k * 3 + 1] - HEAD.y;
      const dz = bird.pos[k * 3 + 2] - HEAD.z;
      const speed =
        (Math.hypot(bird.pos[kn * 3] - bird.pos[kp * 3], bird.pos[kn * 3 + 1] - bird.pos[kp * 3 + 1], bird.pos[kn * 3 + 2] - bird.pos[kp * 3 + 2]) * KEY_HZ) / 2;
      sum += (speed / 4) / (1 + (dx * dx + dy * dy + dz * dz) / 1.2) ** 1.5;
    }
    level[k] = sum;
  }
  const smooth = new Float64Array(KEYS);
  for (let k = 0; k < KEYS; k += 1) {
    let s = 0;
    for (let d = -2; d <= 2; d += 1) s += level[(k + d + KEYS) % KEYS] * (3 - Math.abs(d));
    smooth[k] = s / 9;
  }
  let lo = Infinity;
  let hi = 0;
  for (const v of smooth) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const at = (t) => {
    const x = (((t * KEY_HZ) % KEYS) + KEYS) % KEYS;
    const k = Math.floor(x);
    const f = x - k;
    return (smooth[k] * (1 - f) + smooth[(k + 1) % KEYS] * f - lo) / (hi - lo); // 0 quietest, 1 closest pass
  };

  const length = Math.round(LOOP * SAMPLE_RATE);
  const out = new Float32Array(length);
  let seed = 12345;
  const white = () => {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed / 0x7fffffff - 1;
  };
  const noiseBuf = (s) => {
    seed = s;
    const n = new Float32Array(length);
    for (let i = 0; i < length; i += 1) n[i] = white();
    return n;
  };
  // Two-pole low-pass run twice around the loop so its state is continuous across the join.
  const filtered = (src, cutoff) => {
    let y1 = 0;
    let y2 = 0;
    const res = new Float32Array(length);
    for (let pass = 0; pass < 2; pass += 1) {
      for (let i = 0; i < length; i += 1) {
        const a = 1 - Math.exp((-TAU * cutoff(i / SAMPLE_RATE)) / SAMPLE_RATE);
        y1 += a * (src[i] - y1);
        y2 += a * (y1 - y2);
        if (pass === 1) res[i] = y2;
      }
    }
    return res;
  };

  const rushed = filtered(noiseBuf(99), (t) => 400 + 3800 * at(t) ** 0.7);
  const air = filtered(noiseBuf(5), () => 220);
  const hush = filtered(noiseBuf(17), (t) => 1500 + 500 * Math.sin((TAU * 2 * t) / LOOP));
  for (let i = 0; i < length; i += 1) {
    const t = i / SAMPLE_RATE;
    const l = at(t);
    // Wing flutter: whole cycles per loop (6 Hz and 8 Hz), deeper when the flock is close.
    const flutter = 1 - (0.1 + 0.3 * l) * (0.5 + 0.5 * Math.sin(TAU * 6 * t)) * (0.6 + 0.4 * Math.sin(TAU * 8 * t + 1));
    const swell = 0.015 + 0.985 * l ** 1.5;
    const bed = air[i] * 1.4 * (0.7 + 0.3 * Math.sin((TAU * 3 * t) / LOOP)) + hush[i] * 0.55 * (0.5 + 0.5 * Math.sin((TAU * 2 * t) / LOOP + 1));
    out[i] = rushed[i] * 4.5 * swell * flutter + bed * 0.5;
  }
  let max = 0;
  for (const s of out) max = Math.max(max, Math.abs(s));
  for (let i = 0; i < length; i += 1) out[i] *= 0.7 / max;
  return toWav(out);
}

// --------------------------------------------------------------- build

const VARIANTS = [
  ['BirdGold', T.gold],
  ['BirdGlow', T.glow],
  ['BirdCream', T.highlight],
  ['BirdAmber', '#e0985a']
];

export async function build() {
  const motion = baked();
  const stats = analyse(motion);

  const glb = new Glb();
  glb.provenance({ holoim: { authored: 'synthetic', author: meta.submittedBy, title: meta.name } });
  const root = glb.node({ name: 'Murmuration' });

  // The standing spot: a torn disc of dark floor with a gold-lit lip and flakes drifting off it.
  const { faceGeo, rimGeo, flakeGeo } = discGeometries();
  const floorInk = glb.material({ name: 'SpotFloor', color: T.groundMid, emissive: '#0f3a40', emissiveStrength: 0.8, roughness: 1, doubleSided: true });
  const lipInk = glb.material({ name: 'SpotLip', color: T.gold, emissive: T.glow, emissiveStrength: 1.8, roughness: 1, unlit: true, doubleSided: true });
  glb.node({ name: 'StandingSpot', mesh: glb.mesh('StandingSpot', faceGeo, floorInk), parent: root });
  glb.node({ name: 'StandingSpotLip', mesh: glb.mesh('StandingSpotLip', rimGeo, lipInk), translation: [0, 0.002, 0], parent: root });
  glb.node({ name: 'StandingSpotFlakes', mesh: glb.mesh('StandingSpotFlakes', flakeGeo, lipInk), translation: [0, 0.002, 0], parent: root });

  // One shared bird geometry, four warm materials.
  const geometry = birdGeometry();
  const meshes = VARIANTS.map(([name, hex]) => glb.mesh(name, geometry, glb.material({ name, color: hex, unlit: true, doubleSided: true })));
  const group = glb.node({ name: 'Flock', parent: root });
  FLOCK.forEach((bird, i) => {
    const m = motion.birds[i];
    const track = FLAP_TRACKS[bird.flap];
    const node = glb.node({
      name: `Bird${String(i + 1).padStart(3, '0')}`,
      mesh: meshes[bird.hue],
      translation: [m.pos[0], m.pos[1], m.pos[2]],
      rotation: [m.rot[0], m.rot[1], m.rot[2], m.rot[3]],
      scale: [track[0], track[1], track[2]],
      parent: group
    });
    glb.animate(node, 'translation', motion.times, m.pos);
    glb.animate(node, 'rotation', motion.times, m.rot);
    glb.animate(node, 'scale', FLAP_TIMES, track);
  });

  glb.audio(sound(motion));

  const fmt = (n, d = 4) => +n.toFixed(d);
  console.log(
    'loop seam: max position gap', fmt(stats.seamPos, 9), 'm, max heading gap', fmt(stats.seamHead, 9),
    'rad; one key of motion = mean', fmt(stats.meanStep), 'm, max', fmt(stats.stepMax), 'm =>',
    stats.seamPos <= stats.meanStep && stats.seamHead < 0.1 ? 'SEAMLESS' : 'SEAM FAILS'
  );
  console.log(
    'closest bird centre to head', fmt(stats.minHead), 'm (clear radius', CLEAR, '); lowest bird y', fmt(stats.minY),
    '; birds within 1.5 m of head every 0.5 s (min', Math.min(...stats.near), 'max', Math.max(...stats.near), '):', stats.near.join(' ')
  );
  console.log('flock bounds', stats.bounds.min.map((v) => fmt(v, 2)), stats.bounds.max.map((v) => fmt(v, 2)), 'animated nodes', BIRDS);
  return glb;
}

// ----------------------------------------------------------- the views

function insideViews() {
  // From the baked flock: three moments and directions where the flock fills an 80 degree view from the head.
  const { birds } = baked();
  const picks = [];
  const candidates = [];
  for (let t = 0; t < LOOP; t += 0.5) {
    const k = Math.round(t * KEY_HZ);
    for (let deg = 0; deg < 360; deg += 30) {
      const yaw = (deg * Math.PI) / 180;
      const dir = [Math.sin(yaw), 0, -Math.cos(yaw)];
      let score = 0;
      for (const bird of birds) {
        const x = bird.pos[k * 3];
        const y = bird.pos[k * 3 + 1] - HEAD.y;
        const z = bird.pos[k * 3 + 2];
        const d = Math.hypot(x, y, z);
        if (d > 4.5) continue;
        const cos = (x * dir[0] + y * dir[1] + z * dir[2]) / d;
        if (cos < Math.cos(0.62)) continue;
        score += 1 / Math.max(d, 0.5);
      }
      candidates.push({ t, deg, dir, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    if (picks.length === 3) break;
    if (picks.every((p) => Math.abs(p.t - c.t) >= 3 && Math.abs(((p.deg - c.deg + 540) % 360) - 180) >= 60)) picks.push(c);
  }
  return picks.map((c, i) => ({ label: `inside ${i + 1}`, cam: [0, 1.6, 0], look: [c.dir[0] * 3, 1.6, c.dir[2] * 3], t: c.t, fov: 80 }));
}

function farView(label, t) {
  // Aimed at the flock's own centre so it fills the tile.
  const c = flockCentre((TAU * t) / LOOP, new Vector3());
  return { label, cam: [c.x * 0.6, c.y + 1.2, c.z * 0.6 + 7.2], look: [c.x, c.y, c.z], t, fov: 40 };
}

function closeView(label, index, t) {
  const { birds } = baked();
  const k = Math.round(t * KEY_HZ);
  const b = birds[index];
  const q = new Quaternion(b.rot[k * 4], b.rot[k * 4 + 1], b.rot[k * 4 + 2], b.rot[k * 4 + 3]);
  const right = new Vector3(1, 0, 0).applyQuaternion(q);
  const up = new Vector3(0, 1, 0).applyQuaternion(q);
  const fwd = new Vector3(0, 0, -1).applyQuaternion(q);
  const p = new Vector3(b.pos[k * 3], b.pos[k * 3 + 1], b.pos[k * 3 + 2]);
  const cam = p.clone().addScaledVector(right, 0.35).addScaledVector(up, 0.9).addScaledVector(fwd, 0.6);
  return { label, cam: [cam.x, cam.y, cam.z], look: [p.x, p.y, p.z], t: k / KEY_HZ, fov: 45 };
}

export const tiles = [
  { view: 'front', t: 4 },
  { view: 'top', t: 10 },
  { view: 'quarter', t: 16 },
  farView('far a', 2),
  farView('far b', 8.5),
  farView('far c', 15),
  ...insideViews(),
  closeView('close bird', 40, 7),
  closeView('close bird 2', 300, 15),
  { label: 'standing spot', cam: [0.8, 0.75, 0.8], look: [0, 0, 0], t: 6, fov: 45 }
];
