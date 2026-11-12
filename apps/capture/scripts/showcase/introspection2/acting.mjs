import { Vector3 } from 'three';

import { bodyDir, bodyPoint, stepFeet } from '../introspection/figures.mjs';
import { K, PI, clamp, mix, smooth } from './timeline.mjs';

// The acting of The way down II: key-framed poses with eased holds, and
// breath laid over them. A pose is a flat set of numbers (body angles, foot
// and hand targets in the body's own frame: x left, y up from its floor,
// z forward), so any two poses blend. Hands are [x, y, z, weight]; a hand
// whose weight is 0 at one key takes its target from the other key, so it
// never sweeps through a stale target while it fades in.

const ease = (x) => x * x * x * (x * (x * 6 - 15) + 10);
const win = (a, b, t, r) => smooth(a - r, a, t) * (1 - smooth(b, b + r, t));

export const DEF = {
  pelvisY: 0.93, px: 0, pz: 0, pp: 0, py: 0, pr: 0, sp: 0.03, cp: 0.02, cr: 0, cy: 0,
  np: 0, hp: 0.05, hy: 0, hr: 0, hat: 0, spread: 0, elbow: 0, swing: 0,
  fL: [0.1, 0, 0.02, 0, 0.12], fR: [-0.1, 0, 0.02, 0, -0.12],
  hL: [0.25, 0.9, 0.1, 0], hR: [-0.25, 0.9, 0.1, 0],
  pL: [0.75, -1, -0.35], pR: [-0.75, -1, -0.35],
  knee: [0, 0, 1], touch: 0, hug: 0
};

function lerpPose(a, b, x) {
  const out = {};
  for (const k of Object.keys(a)) {
    const va = a[k];
    const vb = b[k];
    if (Array.isArray(va) && (k === 'hL' || k === 'hR')) {
      const pa = va[3] < 1e-3 ? vb : va;
      const pb = vb[3] < 1e-3 ? va : vb;
      out[k] = [mix(pa[0], pb[0], x), mix(pa[1], pb[1], x), mix(pa[2], pb[2], x), mix(va[3], vb[3], x)];
    } else if (Array.isArray(va)) out[k] = va.map((v, i) => mix(v, vb[i], x));
    else out[k] = mix(va, vb, x);
  }
  return out;
}

/** A pose track from [t, poseName, overrides?] keys: smootherstep between keys, held at each. */
export function keyed(keys, poses, base = DEF) {
  const list = keys.map(([t, name, extra]) => [t, { ...base, ...(poses[name] ?? {}), ...(extra ?? {}) }]);
  return (t) => {
    if (t <= list[0][0]) return { ...list[0][1] };
    const last = list[list.length - 1];
    if (t >= last[0]) return { ...last[1] };
    let i = 0;
    while (t > list[i + 1][0]) i += 1;
    const [ta, a] = list[i];
    const [tb, b] = list[i + 1];
    return lerpPose(a, b, ease(clamp((t - ta) / (tb - ta || 1))));
  };
}

/** applyPose's P from a numeric pose, placed at {x, z, yaw, floor} in the rig's space. */
export function toP(rig, q, place = {}) {
  const P = {
    base: new Vector3(place.x ?? 0, 0, place.z ?? 0), floor: place.floor ?? 0, yaw: place.yaw ?? 0,
    pelvisY: q.pelvisY, pelvisOff: [q.px, q.pz], pp: q.pp, py: q.py, pr: q.pr, sp: q.sp, cp: q.cp, cr: q.cr,
    cy: q.cy, np: q.np, hp: q.hp, hy: q.hy, hr: q.hr, hat: q.hat, spread: q.spread, elbow: q.elbow,
    swing: q.swing, kneePole: q.knee
  };
  const foot = (f) => ({ pos: bodyPoint(P, f[0], rig.ankleH + f[1], f[2]), yaw: P.yaw + f[4], pitch: f[3] });
  P.feet = place.feet ?? { L: foot(q.fL), R: foot(q.fR) };
  P.hands = { L: [], R: [] };
  for (const s of ['L', 'R']) {
    const h = q[`h${s}`];
    if (h[3] > 1e-3) P.hands[s].push({ w: h[3], at: bodyPoint(P, h[0], h[1], h[2]), pole: bodyDir(P, ...q[`p${s}`]) });
  }
  return P;
}

const breathe = (q, amp, t, period, phase = 0) => {
  const b = amp * Math.sin((2 * PI * (t - phase)) / period);
  q.cp += b;
  q.sp += 0.4 * b;
  q.np -= 0.5 * b;
  return b;
};

// ---------------------------------------------------------------------------
// The man: composed, then the hand to the heart and a held breath. His torso
// is still from 4.5 s to 7 s so the trap door (built on his statue) sits on
// his shirt; 58.5–60 is the exhale back into the opening pose.

const MAN_BASE = {
  ...DEF, pelvisY: 0.935, sp: -0.02, cp: -0.06, hp: -0.05, spread: 0.04,
  fL: [0.11, 0, 0.02, 0, 0.14], fR: [-0.11, 0, 0.02, 0, -0.14]
};
const TIE_POLE = [0.9, -0.7, 0.1];
const MAN = {
  settle: { px: 0.018, pr: 0.022, pelvisY: 0.928 },
  neutral: {},
  tie: { hL: [0.0, 1.405, 0.17, 1], hp: 0.14, pL: TIE_POLE },
  tieA: { hL: [0.022, 1.4, 0.17, 1], hp: 0.17, hr: 0.04, pL: TIE_POLE },
  tieB: { hL: [-0.018, 1.412, 0.17, 1], hp: 0.12, hr: -0.03, pL: TIE_POLE },
  watch: { hL: [0.04, 1.19, 0.33, 1], hp: 0.36, pL: [0.9, -0.7, -0.1] },
  still: { hp: -0.08 },
  chest: { hL: [0.14, 1.12, 0.17, 1], hp: -0.13, pL: [0.9, -0.8, 0] },
  exhale: { cp: 0.03, sp: 0.03, np: 0.06, hp: 0.14, pelvisY: 0.922, hL: [0.15, 1.1, 0.18, 0.55], pL: [0.9, -0.8, 0] }
};
const manKeys = keyed([
  [0, 'settle'], [0.6, 'neutral'], [0.8, 'neutral'], [1.2, 'tie'], [1.45, 'tieA'], [1.7, 'tieB'], [1.95, 'tieA'],
  [2.2, 'tie'], [2.5, 'neutral'], [2.9, 'watch'], [3.9, 'watch'], [4.3, 'neutral'], [4.4, 'still'], [4.9, 'still'],
  [5.9, 'chest'], [7, 'chest'],
  [58.5, 'chest'], [59.1, 'exhale'], [59.6, 'neutral'], [60, 'settle']
], MAN, MAN_BASE);

export function manPose(rig, t) {
  const q = manKeys(t);
  const amp = 0.012 * (1 - smooth(4.1, 4.5, t)) * (t < 30 ? 1 : 0) + (t > 58.5 ? 0.012 * smooth(59.3, 60, t) : 0);
  breathe(q, amp, t, 4);
  return toP(rig, q);
}

// ---------------------------------------------------------------------------
// The traveller, in her own frame (feet at the origin, facing +z). Where that
// frame is in the world is the scene's job; in the dark (37–58.5) her frame
// is the hug frame, shared with the child, and `travellerPlace` walks it.

const FALL = [0.09, 0.09, 0.03, 0.75, 0.1];
const FALL_R = [-0.09, 0.09, 0.03, 0.75, -0.1];
const T_POSES = {
  pocket: { hL: [0.15, 1.28, 0.22, 1], hR: [-0.15, 1.28, 0.22, 1], hp: -0.12, pL: [1, -0.4, -0.3], pR: [-1, -0.4, -0.3] },
  cling: {
    pelvisY: 0.88, pp: 0.08, sp: 0.05, cp: 0.05, hp: -0.25,
    hL: [0.16, 1.62, 0.22, 1], hR: [-0.16, 1.5, 0.22, 1],
    fL: [0.1, 0.12, 0.17, 0.6, 0], fR: [-0.12, 0.0, 0.15, 0.6, 0]
  },
  clingLook: {
    pelvisY: 0.88, pp: 0.06, sp: 0.04, cp: 0.04, hp: -0.05, hy: 1.1, cy: 0.35,
    hL: [0.16, 1.58, 0.22, 1], hR: [-0.32, 1.05, 0.02, 0.6],
    fL: [0.1, 0.12, 0.17, 0.6, 0], fR: [-0.12, 0.0, 0.15, 0.6, 0]
  },
  clingReachR: {
    pelvisY: 0.86, pp: 0.08, sp: 0.05, cp: 0.05, hp: -0.15, hy: -0.4, pr: -0.08,
    hL: [0.18, 1.45, 0.22, 1], hR: [-0.42, 1.55, 0.2, 1],
    fL: [0.08, 0.02, 0.17, 0.6, 0], fR: [-0.2, 0.18, 0.15, 0.6, 0]
  },
  crouchDoor: {
    pelvisY: 0.55, pp: 0.3, sp: 0.2, cp: 0.15, hp: -0.2, knee: [0, 0.2, 1],
    hL: [0.12, 0.85, 0.24, 1], hR: [-0.12, 0.85, 0.24, 1],
    fL: [0.14, 0, 0.12, 0.3, 0.1], fR: [-0.14, 0, 0.12, 0.3, -0.1]
  },
  haulLow: {
    pelvisY: 0.6, pp: 0.25, sp: 0.15, cp: 0.1, hp: -0.3, knee: [0, 0.2, 1],
    hL: [0.1, 0.75, 0.24, 1], hR: [-0.1, 0.75, 0.24, 1],
    fL: [0.15, 0, 0.1, 0.3, 0.1], fR: [-0.15, 0, 0.1, 0.3, -0.1]
  },
  haul: {
    pelvisY: 0.9, pp: -0.08, sp: -0.12, cp: -0.15, hp: -0.4,
    hL: [0.12, 1.78, 0.2, 1], hR: [-0.12, 1.78, 0.2, 1], pL: [1, -0.2, -0.2], pR: [-1, -0.2, -0.2],
    fL: [0.13, 0, 0.08, 0.2, 0.1], fR: [-0.13, 0, 0.08, 0.2, -0.1]
  },
  drop: {
    hp: -0.25, hL: [0.15, 1.86, 0.02, 1], hR: [-0.15, 1.86, 0.02, 1], pL: [1, 0, 0], pR: [-1, 0, 0],
    fL: FALL, fR: FALL_R
  },
  float: {
    sp: 0.06, cp: 0.04, hp: 0.0, hL: [0.45, 1.18, 0.12, 0.7], hR: [-0.45, 1.2, 0.1, 0.7],
    fL: [0.11, 0.14, 0.08, 0.6, 0.1], fR: [-0.1, 0.1, 0.0, 0.7, -0.1]
  },
  shield: {
    pp: 0.25, sp: 0.25, cp: 0.15, hp: 0.25, np: 0.1,
    hL: [0.08, 1.5, 0.27, 1], hR: [-0.1, 1.46, 0.28, 1], pL: [1, -0.4, -0.2], pR: [-1, -0.4, -0.2],
    fL: [0.1, 0.3, 0.2, 0.4, 0.1], fR: [-0.12, 0.22, 0.14, 0.4, -0.1], knee: [0, 0.3, 1]
  },
  swim: {
    pp: 0.5, sp: 0.15, hp: -0.35, hL: [0.2, 1.42, 0.55, 1], hR: [-0.2, 1.42, 0.55, 1],
    fL: [0.1, 0.2, -0.22, 1.0, 0.1], fR: [-0.1, 0.28, -0.3, 1.0, -0.1]
  },
  swimPull: {
    pp: 0.45, sp: 0.12, hp: -0.3, hL: [0.38, 1.0, -0.08, 1], hR: [-0.38, 1.0, -0.08, 1],
    fL: [0.1, 0.3, -0.3, 1.0, 0.1], fR: [-0.1, 0.18, -0.2, 1.0, -0.1]
  },
  knocked: {
    pp: -0.4, sp: -0.3, cp: -0.2, hp: -0.45, hL: [0.5, 1.5, 0.3, 1], hR: [-0.52, 1.45, 0.32, 1],
    fL: [0.12, 0.25, 0.3, 0.2, 0.2], fR: [-0.14, 0.15, 0.22, 0.2, -0.2]
  },
  clawL: {
    pp: 0.35, sp: 0.25, hp: -0.2, hL: [0.15, 1.42, 0.62, 1], hR: [-0.15, 1.12, 0.32, 1],
    fL: [0.1, 0.25, -0.25, 0.9, 0.1], fR: [-0.1, 0.15, -0.15, 0.9, -0.1]
  },
  clawR: {
    pp: 0.35, sp: 0.25, hp: -0.2, hL: [0.15, 1.12, 0.32, 1], hR: [-0.15, 1.42, 0.62, 1],
    fL: [0.1, 0.15, -0.15, 0.9, 0.1], fR: [-0.1, 0.25, -0.25, 0.9, -0.1]
  },
  suck: {
    hp: -0.15, hL: [0.2, 0.78, -0.16, 1], hR: [-0.2, 0.78, -0.16, 1], pL: [1, 0.2, -0.3], pR: [-1, 0.2, -0.3],
    fL: [0.05, 0.09, -0.02, 0.9, 0], fR: [-0.05, 0.09, -0.02, 0.9, 0]
  },
  tread: {
    sp: 0.05, cp: 0.0, hp: -0.1, hL: [0.42, 1.25, 0.18, 1], hR: [-0.42, 1.25, 0.18, 1],
    fL: [0.11, 0.16, 0.06, 0.6, 0.1], fR: [-0.1, 0.1, -0.04, 0.7, -0.1]
  },
  gasp: {
    sp: -0.1, cp: -0.22, hp: -0.5, hL: [0.36, 1.72, 0.2, 1], hR: [-0.3, 1.45, 0.36, 1],
    fL: [0.11, 0.2, 0.1, 0.6, 0.1], fR: [-0.1, 0.08, -0.06, 0.7, -0.1]
  },
  under: {
    hp: -0.3, sp: -0.05, hL: [0.12, 1.9, 0.06, 1], hR: [-0.12, 1.9, 0.04, 1], pL: [1, 0, 0], pR: [-1, 0, 0],
    fL: FALL, fR: FALL_R
  },
  reachUp: {
    hp: -0.55, cr: 0.08, hR: [-0.05, 2.02, 0.06, 1], hL: [0.3, 0.95, 0.1, 0.5], pR: [-1, 0, 0],
    fL: FALL, fR: FALL_R
  },
  limp: {
    pp: 0.15, sp: 0.2, cp: 0.15, np: 0.2, hp: 0.35, hL: [0.42, 1.32, -0.05, 0.6], hR: [-0.38, 1.4, 0.0, 0.6],
    fL: [0.12, 0.12, 0.05, 0.8, 0.2], fR: [-0.08, 0.06, -0.06, 0.8, -0.2]
  },
  landed: {
    pelvisY: 0.42, pp: 0.35, sp: 0.3, cp: 0.2, hp: 0.25, knee: [0, 0.3, 1],
    hL: [0.2, 0.12, 0.35, 1], hR: [-0.25, 0.38, 0.2, 0.6],
    fL: [0.13, 0, 0.12, 0, 0.2], fR: [-0.13, 0, 0.06, 0, -0.2]
  },
  careful: { pelvisY: 0.92, pp: 0.05, sp: 0.06, hp: 0.12, hL: [0.22, 1.08, 0.4, 0.8], hR: [-0.22, 0.95, 0.2, 0.3] },
  listen: { pelvisY: 0.92, pp: 0.02, sp: 0.03, cp: 0.0, hp: 0.05, hy: -0.35, hr: 0.1, hL: [0.2, 1.12, 0.36, 0.8], hR: [-0.2, 0.92, 0.12, 0.2] },
  kneel: {
    pelvisY: 0.5, pp: 0.02, sp: 0.06, cp: 0.04, hp: 0.25, knee: [0, -0.6, 1],
    hL: [0.12, 0.55, 0.18, 0.6], hR: [-0.12, 0.55, 0.18, 0.6],
    fL: [0.12, -0.02, -0.36, -1.25, 0.05], fR: [-0.12, -0.02, -0.36, -1.25, -0.05]
  },
  reach: { hR: [-0.06, 0.82, 0.42, 1] },
  withdraw: { hR: [-0.1, 0.72, 0.2, 1], hp: 0.15, sp: 0.02 },
  touch: { touch: 1, sp: 0.12, pp: 0.08, hp: 0.3 },
  hugOpen: { hL: [0.32, 0.95, 0.3, 1], hR: [-0.32, 0.95, 0.3, 1], sp: 0.1, pp: 0.1, hp: 0.2 },
  hug: { pelvisY: 0.44, pp: 0.14, sp: 0.18, cp: 0.15, hp: 0.48, hy: 0.15, hr: 0.12, hug: 1 }
};
const KNEELING = (name) => ({ ...T_POSES.kneel, ...T_POSES[name] });
const T_ALL = { ...T_POSES, reach: KNEELING('reach'), withdraw: KNEELING('withdraw'), touch: KNEELING('touch'), hugOpen: KNEELING('hugOpen'), hug: KNEELING('hug') };

const travKeys = keyed([
  [0, 'pocket'], [0.9, 'pocket'], [1.6, 'cling'], [2.0, 'clingLook'], [2.7, 'clingLook'], [3.0, 'cling'],
  [3.4, 'clingReachR'], [3.8, 'cling'], [4.1, 'clingReachR'], [4.5, 'crouchDoor'], [4.9, 'crouchDoor', { hy: 0.5 }],
  [5.4, 'crouchDoor'], [6.6, 'crouchDoor'], [7.0, 'haulLow'], [7.7, 'haul'], [8.2, 'haul'], [8.6, 'drop'],
  [10.4, 'drop'], [11.2, 'float'],
  // gas: buffeted, spun, swimming down, knocked back, clawing at the knot
  [12.6, 'float'], [13.2, 'shield'], [13.9, 'float'], [14.4, 'shield'], [15.2, 'float'], [15.8, 'knocked'],
  [16.6, 'float'], [17.2, 'swim'], [17.7, 'swimPull'], [18.2, 'swim'], [18.7, 'swimPull'], [19.2, 'swim'],
  [19.6, 'knocked'], [20.3, 'float'], [20.8, 'clawL'], [21.3, 'clawR'], [21.75, 'clawL'], [22.2, 'clawR'],
  [22.6, 'clawL'], [23.0, 'clawR'], [23.4, 'clawL'], [23.8, 'clawR'], [24.3, 'suck'], [26.2, 'suck'],
  // liquid: on the surface, pulled under, gasping, under again, reaching
  [27.0, 'tread'], [29.6, 'tread'], [30.1, 'under'], [31.0, 'under'], [31.4, 'gasp'], [32.2, 'gasp'],
  [32.6, 'tread'], [33.0, 'under'], [34.6, 'under'], [35.1, 'reachUp'], [36.0, 'reachUp'], [36.4, 'under'],
  [36.9, 'limp'],
  // the dark
  [39.6, 'limp'], [40.0, 'landed'], [40.6, 'landed'], [41.3, 'careful'], [42.4, 'careful'], [42.8, 'listen'],
  [43.5, 'listen'], [43.9, 'careful'], [44.4, 'careful'], [45.3, 'kneel'], [45.8, 'reach'], [46.3, 'withdraw'],
  [46.7, 'withdraw'], [47.4, 'touch'], [47.8, 'touch'], [48.05, 'withdraw'], [48.7, 'touch'], [49.3, 'hugOpen'],
  [50.1, 'hug'], [58.4, 'hug'], [58.5, 'pocket'], [60, 'pocket']
], T_ALL);

/** The traveller's pose at t in her frame; `ctx` holds the child's points in the hug frame. */
export function travellerPose(rig, t, place = {}, ctx = null) {
  const q = travKeys(t);
  // Breath: quick and shallow in the gas and the liquid, slow in the hug, synced to the child.
  const hold = smooth(50, 51.5, t);
  if (t < 37) breathe(q, 0.02 * (t > 11 ? 1.6 : 1), t, t > 11 ? 0.9 : 3.2);
  else if (t > 40.4) breathe(q, mix(0.015, 0.03, hold), t, mix(2.2, 3.6, hold), 50);
  // Gasping heaves at the surface.
  q.cp -= 0.12 * win(31.4, 32.2, t, 0.2) * Math.max(0, Math.sin(2 * PI * 2.4 * t));
  const P = toP(rig, q, place);
  if (ctx && q.touch > 1e-3) P.hands.R.push({ w: q.touch, at: ctx.shoulder.clone(), pole: bodyDir(P, -1, -0.6, -0.2) });
  if (ctx && q.hug > 1e-3) {
    P.hands.L.push({ w: q.hug, at: ctx.back.L.clone(), pole: bodyDir(P, 1, -0.3, 0.2) });
    P.hands.R.push({ w: q.hug, at: ctx.back.R.clone(), pole: bodyDir(P, -1, -0.3, 0.2) });
  }
  return P;
}

// Her path in the hug frame (37–58.5): she leaves the seam at the frame's
// zoom point, falls limp and slow, turning once, lands to the left, walks to
// the child and kneels. Units are her body's (she is 1.75 tall).
export const HUG = { centre: [-0.06, 0.5], child: { x: 0.15, z: 0 }, kneel: { x: -0.27, z: 0 }, land: { x: -1.6, z: 0.05 } };
const START_PELVIS = 1.23;
const PX = K([[37, HUG.centre[0]], [40, HUG.land.x], [41.1, HUG.land.x], [44.4, HUG.kneel.x], [60, HUG.kneel.x]]);
const PZ = K([[37, 0], [40, HUG.land.z], [41.1, HUG.land.z], [44.4, HUG.kneel.z], [60, HUG.kneel.z]]);
const PYAW = K([[37, PI / 2], [37.6, PI / 2], [39.6, PI / 2 + 2 * PI], [60, PI / 2 + 2 * PI]]);
export const travellerBody = (t) => ({ x: PX(t), z: PZ(t), yaw: PYAW(t), floor: 0 });

export function travellerPlace(rig, t) {
  const b = travellerBody(t);
  const q = travKeys(t);
  // Falling: the floor under her frame drops from where her pelvis left the seam.
  const fall = 1 - smooth(37, 40, t) ** 1.4;
  const floor = (START_PELVIS - travKeys(37).pelvisY) * fall;
  const place = { x: b.x, z: b.z, yaw: b.yaw, floor };
  const walk = smooth(41.0, 41.3, t) * (1 - smooth(44.2, 44.6, t));
  if (walk > 1e-3) {
    const steps = stepFeet(travellerBody, t, { period: 0.8, lift: 0.05, width: 0.1, ankleH: rig.ankleH, floor: 0 });
    const P = toP(rig, q, place);
    for (const s of ['L', 'R']) {
      P.feet[s].pos.lerp(steps[s].pos, walk);
      P.feet[s].yaw = mix(P.feet[s].yaw, steps[s].yaw, walk);
      P.feet[s].pitch = mix(P.feet[s].pitch, steps[s].pitch, walk);
    }
    place.feet = P.feet;
  }
  return place;
}

// ---------------------------------------------------------------------------
// The child, in the hug frame: hunched, knees up, face hidden, sobbing; he
// flinches at her touch, looks, turns into her and holds on while the sobs
// slow into breathing.

/** Sobbing: irregular bursts, as a 0..1 pulse train. */
function sob(t) {
  const env = smooth(40.5, 41.5, t) * (t < 48.2 ? 1 : Math.exp(-(t - 48.2) / 1.6));
  const pulse = Math.max(0, Math.sin(2 * PI * 2.3 * t)) ** 3 * 0.7 + Math.max(0, Math.sin(2 * PI * 1.1 * t + 1)) ** 4 * 0.5;
  return env * pulse * (0.75 + 0.25 * Math.sin(2 * PI * 0.37 * t));
}

export const childPresence = (t) => smooth(43.5, 44.3, t) * (t < 58.5 ? 1 : 0);

export function childPose(rig, t, ctx) {
  const look = smooth(48.0, 48.8, t);
  const turn = smooth(48.4, 49.6, t);
  const rise = smooth(48.6, 49.8, t);
  const hug = smooth(48.9, 50.0, t);
  const flinch = win(47.75, 48.05, t, 0.12);
  const s = sob(t) * (1 - look * 0.6);
  const settle = smooth(50, 51.5, t);
  const breath = 0.025 * settle * Math.sin((2 * PI * (t - 50)) / 3.6);
  const base = new Vector3(HUG.child.x + 0.03 * flinch, 0, HUG.child.z);
  const P = { base, floor: 0, yaw: mix(-0.35, -PI / 2, turn) };
  P.pelvisY = mix(0.09, 0.27, rise);
  P.pelvisOff = [0, mix(-0.02, 0.06, rise)];
  P.pp = mix(-0.35, 0.05, rise) - 0.2 * flinch;
  P.pr = 0.12 * flinch;
  P.sp = mix(0.42, 0.1, rise) + 0.07 * s + 0.4 * breath;
  P.cp = mix(0.42, 0.18, rise) - 0.12 * look * (1 - rise) + 0.1 * s + breath;
  P.np = mix(0.2, 0.0, look);
  P.hp = mix(0.55, -0.15, look) + 0.12 * s - 0.3 * flinch + mix(0, 0.25, rise);
  P.hy = 0.08 * Math.sin(2 * PI * 0.3 * t) * (1 - look) + 0.5 * look * (1 - hug) - 0.5 * hug;
  P.hr = 0.25 * hug;
  P.spread = 0.06 * s;
  const seat = {};
  const kneel = {};
  for (const [side, sx] of [['L', 1], ['R', -1]]) {
    seat[side] = { pos: bodyPoint(P, sx * 0.075, rig.ankleH, 0.25), yaw: P.yaw + sx * 0.1, pitch: 0.15 };
    kneel[side] = { pos: bodyPoint(P, sx * 0.08, rig.ankleH * 0.7, -0.18), yaw: P.yaw, pitch: -1.2 };
  }
  P.feet = {};
  for (const side of ['L', 'R']) {
    P.feet[side] = { pos: seat[side].pos.clone().lerp(kneel[side].pos, rise), yaw: mix(seat[side].yaw, kneel[side].yaw, rise), pitch: mix(seat[side].pitch, kneel[side].pitch, rise) };
  }
  P.kneePole = [0, mix(1, -0.5, rise), 1];
  const knees = 1 - hug;
  P.hands = {
    L: [{ w: knees, at: bodyPoint(P, 0.06, 0.34, 0.27), pole: bodyDir(P, 1, 0, -0.2) }],
    R: [{ w: knees, at: bodyPoint(P, -0.06, 0.32, 0.27), pole: bodyDir(P, -1, 0, -0.2) }]
  };
  if (ctx?.neck) {
    P.hands.L.push({ w: hug, at: ctx.neck.L.clone(), pole: bodyDir(P, 1, -0.5, 0) });
    P.hands.R.push({ w: hug, at: ctx.neck.R.clone(), pole: bodyDir(P, -1, -0.5, 0) });
  }
  if (ctx?.head) P.look = { at: ctx.head, w: look * (1 - hug) };
  return P;
}
