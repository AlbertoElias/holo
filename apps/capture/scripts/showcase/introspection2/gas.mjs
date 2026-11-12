import { BufferGeometry, Float32BufferAttribute, SphereGeometry } from 'three';

import { lin } from '../introspection/common.mjs';
import { curlField, keyTimes, keyTrack, noise3, tubeGeometry, tubePositions } from './flow.mjs';
import { rng } from './layers.mjs';
import { PI, clamp, mix, smooth } from './timeline.mjs';
import { FOLLOW, SCREEN } from './zoom.mjs';

// The gas, "Tugged" (BEATS.md beats 3-4). Everything here is in the gas's
// home units round C (the layer is drawn at s = S/U.gas, about 6 to 12 while
// he is in it). Five billows are the day's demands; each pulses in its own
// rhythm with its own voice, and a wisp from it catches one of his limbs and
// pulls. The rest of the gas is ambient billows and a dense, slow bank under
// him that swells into a mound round C, with a hatch where the line from C
// toward the feed leaves it. Every billow rolls and roils as if advected by a
// turbulent flow: the vertices are integrated through a curl-noise field,
// held to their billow by a spring, and keyed every 0.8 s (flow.mjs). When he
// lets go (21.5 s) the flow calms, the billows thin and part, and the hatch
// shows.

const sub = (a, b) => a.map((v, k) => v - b[k]);
const addv = (a, b, k = 1) => a.map((v, i) => v + k * b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(...a);
const norm = (a) => a.map((v) => v / len(a));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const UP = [0, 1, 0];
const { right: SR, up: SU } = SCREEN;
const F = FOLLOW;

/** Calm: 0 while he fights, 1 once he has let go (21.5-23.8 s). */
export const calm = (t) => smooth(21.5, 23.8, t);

// ---------------------------------------------------------------------------
// The hatch and the mound (home units). The hatch is centred where the line
// C + r·F leaves the mound, tilted halfway between up and F so it reads as a
// trap door in a floor; the mound is a ball through that point with that
// normal, big enough to hide the liquid round C until the hatch opens.

export const HATCH = (() => {
  const r = 0.04;
  const centre = (C) => addv(C, F, r);
  const n = norm(addv(UP, F));
  const right = norm(cross(UP, n).map((v) => -v)); // screen right, in the hatch plane
  const far = cross(n, right); // in the plane, away from the camera and up
  const half = 0.02;
  const rho = 0.07;
  return { r, centre, n, right: dot(right, SR) < 0 ? right.map((v) => -v) : right, far, half, rho };
})();
// `far` must point away from the camera along the plane.
if (dot(HATCH.far, F) > 0) HATCH.far = HATCH.far.map((v) => -v);
export const moundCentre = (C) => addv(HATCH.centre(C), HATCH.n, -HATCH.rho);

/** The hatch lid's opening angle (radians) at t: he lifts it 24.15-24.7 s; it closes unseen after the loop's turn. */
export const lidAngle = (t) => (t < 30 ? 1.95 * smooth(24.15, 24.7, t) ** 1.3 : 1.95);

// ---------------------------------------------------------------------------
// The traveller's place in the gas, in world metres off C: above the hatch and
// a little toward the camera. Its home position therefore sinks toward the
// mound as the world grows round him (s 6 → 12): that is the descent.

export const ANCHOR = { up: 0.34, toward: 0.12 };
export const anchorWorld = (C, s) => addv(addv(C, F, HATCH.r * s + ANCHOR.toward), SU, ANCHOR.up);

// ---------------------------------------------------------------------------
// The five demands: their place (home units off C, in screen axes a·right +
// b·up + c·toward), size, colour, and the rhythm of their pulses. Each
// rhythm is a list of events [t, length, strength] that the picture (a swell)
// and the voice share. The pulses crowd closer as the gas builds, and each
// voice stops for good when he has let go of its billow.

const at = (C, a, b, c) => C.map((v, k) => v + a * SR[k] + b * SU[k] + c * F[k]);
const crowd = (t) => 1 - 0.38 * smooth(13, 21, t);

function pattern(start, stop, gap, make) {
  const out = [];
  let t = start;
  let i = 0;
  while (t < stop) {
    for (const e of make(t, i)) if (e[0] < stop) out.push(e);
    t += gap(t, i) * crowd(t);
    i += 1;
  }
  return out;
}

export const DEMANDS = [
  {
    id: 'chime', pos: [-0.105, 0.115, -0.03], r: 0.066, hex: '#f28fb6', seed: 3,
    // a two-note door chime
    events: pattern(12.9, 21.9, () => 3.0, (t) => [[t, 0.45, 1], [t + 0.5, 0.7, 0.8]])
  },
  {
    id: 'buzz', pos: [0.118, 0.035, -0.02], r: 0.062, hex: '#8fe3b4', seed: 5,
    // a phone vibrating on a table: buzz-buzz
    events: pattern(12.2, 22.3, () => 2.5, (t) => [[t, 0.38, 1], [t + 0.55, 0.38, 1]])
  },
  {
    id: 'tick', pos: [-0.122, -0.06, 0.0], r: 0.072, hex: '#b49cf0', seed: 7,
    // a clock that won't stop
    events: pattern(13.6, 22.8, () => 0.5, (t, i) => [[t, 0.12, i % 2 ? 0.45 : 0.7]])
  },
  {
    id: 'kettle', pos: [0.09, 0.14, -0.05], r: 0.058, hex: '#f5cf72', seed: 9,
    // a kettle coming to the boil: a long rise, cut off
    events: pattern(14.3, 23.3, () => 4.1, (t) => [[t, 2.6, 1]])
  },
  {
    id: 'clatter', pos: [0.112, -0.095, -0.04], r: 0.064, hex: '#86c8f0', seed: 13,
    // dishes, keys, something dropped: irregular bursts
    events: (() => {
      const R = rng(41);
      return pattern(15.4, 21.6, () => 1.8 + 1.4 * R(), (t) => [[t, 0.35, 1], [t + 0.12, 0.25, 0.7], [t + 0.3, 0.3, 0.8]]);
    })()
  }
];
export const demandCentre = (C, d) => at(C, ...d.pos);

/** A demand's swell at t, 0..1: quick in, eased out, per event; the kettle swells for its whole rise. */
export function pulse(d, t) {
  let v = 0;
  for (const [t0, dur, a] of d.events) {
    if (t < t0 - 0.05 || t > t0 + dur + 0.6) continue;
    const x = d.id === 'kettle'
      ? smooth(t0, t0 + dur, t) * (1 - smooth(t0 + dur, t0 + dur + 0.25, t))
      : smooth(t0 - 0.03, t0 + 0.06, t) * (1 - smooth(t0 + 0.06, t0 + dur + 0.5, t));
    v = Math.max(v, a * x);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Geometry.

/**
 * A billow: a cauliflower of round puffs (a smooth union of offset spheres,
 * measured along each ray from the centre), flatter underneath as a cloud's
 * base is, with fine noise on top. `userData.cavity` (0 in the folds between
 * puffs, 1 on their crowns) shades the folds.
 */
function billowGeometry(centre, r, { seed, w = 40, h = 28, squash = [1.15, 0.85, 1], puffs = 7, lump = 1 }) {
  const R = rng(seed * 7 + 1);
  const g = new SphereGeometry(1, w, h);
  const fine = noise3(seed + 17);
  const list = [[[0, 0, 0], 0.72]];
  for (let k = 0; k < puffs; k += 1) {
    let d;
    do d = [R() * 2 - 1, R() * 1.6 - 0.5, R() * 2 - 1]; while (len(d) > 1 || len(d) < 0.3);
    list.push([norm(d).map((v) => v * (0.28 + 0.3 * R()) * lump), 0.42 + 0.26 * R()]);
  }
  const pos = g.attributes.position;
  const radii = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i += 1) {
    const d = [pos.getX(i), pos.getY(i), pos.getZ(i)];
    // Distance along d to each puff's far surface; a soft max of them.
    let sum = 0;
    for (const [o, rho] of list) {
      const b = dot(d, o);
      const disc = b * b - dot(o, o) + rho * rho;
      if (disc <= 0) continue;
      sum += Math.exp(14 * (b + Math.sqrt(disc)));
    }
    let k = Math.log(sum) / 14;
    k += 0.035 * fine(d[0] * 5, d[1] * 5, d[2] * 5) + 0.015 * fine(d[0] * 11 + 3, d[1] * 11, d[2] * 11);
    if (d[1] < 0) k *= 1 - 0.18 * Math.min(1, -d[1] * 1.6);
    radii[i] = k;
    pos.setXYZ(i, centre[0] + d[0] * k * r * squash[0], centre[1] + d[1] * k * r * squash[1], centre[2] + d[2] * k * r * squash[2]);
  }
  g.computeVertexNormals();
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of radii) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  g.userData.cavity = Array.from(radii, (v) => (v - lo) / (hi - lo || 1));
  return g;
}

/**
 * Colour and alpha: lit softly from above and a little from the feed, cool
 * and darker underneath and in the folds, and soft at the silhouette as seen
 * from the feed (alpha from the normal against the fixed Follow direction),
 * so the edges read as haze, not a hard skin.
 */
function gasPaint(geo, hex, { edge = [0.04, 0.7], floor = 0.04, core = 0.96, tint = null, shade = '#8a84a8' } = {}) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const base = lin(hex);
  const top = tint ? lin(tint) : base.map((v) => Math.min(1, v * 1.22 + 0.06));
  const under = lin(shade).map((v, k) => mix(v, base[k], 0.45));
  const L = norm([0.25, 0.9, 0.35]);
  const cav = geo.userData.cavity;
  const col = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i += 1) {
    const n = [nor.getX(i), nor.getY(i), nor.getZ(i)];
    const wrap = clamp((dot(n, L) + 0.4) / 1.4);
    const fold = cav ? 0.72 + 0.28 * cav[i] : 1;
    const facing = Math.abs(dot(n, F));
    const a = floor + (core - floor) * smooth(edge[0], edge[1], facing);
    for (let k = 0; k < 3; k += 1) col[i * 4 + k] = mix(under[k], top[k], wrap) * fold;
    col[i * 4 + 3] = a;
  }
  geo.setAttribute('color', new Float32BufferAttribute(col, 4));
  return geo;
}

/** Plain geometry (position, colour, index), triangles sorted far to near along Follow, for blending without depth writes. */
function finish(geo, sortFar = true) {
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(Array.from(geo.attributes.position.array), 3));
  out.setAttribute('color', geo.attributes.color.clone());
  let idx = Array.from(geo.index.array);
  if (sortFar) {
    const p = geo.attributes.position;
    const tris = [];
    for (let i = 0; i < idx.length; i += 3) {
      let d = 0;
      for (let k = 0; k < 3; k += 1) d += p.getX(idx[i + k]) * F[0] + p.getY(idx[i + k]) * F[1] + p.getZ(idx[i + k]) * F[2];
      tris.push([d, idx[i], idx[i + 1], idx[i + 2]]);
    }
    tris.sort((a, b) => a[0] - b[0]);
    idx = tris.flatMap((x) => x.slice(1));
  }
  out.setIndex(idx);
  return out;
}

function merge(parts) {
  let count = 0;
  const pos = [];
  const col = [];
  const idx = [];
  for (const g of parts) {
    pos.push(...g.attributes.position.array);
    col.push(...g.attributes.color.array);
    for (const i of g.index.array) idx.push(i + count);
    count += g.attributes.position.count;
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(pos, 3));
  out.setAttribute('color', new Float32BufferAttribute(col, 4));
  out.setIndex(idx);
  return out;
}

// ---------------------------------------------------------------------------
// The flow. Each vertex is integrated through the curl field with a spring to
// its rest place; the rest place itself rolls about its billow's centre, and
// in the letting go drifts out of the way (part) and in toward its centre
// (thin). Keys every 0.8 s from 9.4 to 26.6 s.

const FLOW = { start: 9.4, end: 26.6, step: 0.8, dt: 1 / 20 };
const flowAmp = (t) => mix(1, 0.18, calm(t)) * (0.55 + 0.45 * smooth(10, 14, t));

/**
 * Keys a set of billows. Each billow is { first, count, centre, r, roll (rad/s),
 * axis, part (home offset at full calm), thin (scale at full calm), amp, k, mask(i) }.
 */
function flowKeys(geo, billows, seed) {
  const pos = geo.attributes.position.array;
  const base = Float32Array.from(pos);
  const times = keyTimes(FLOW.start, FLOW.end, FLOW.step);
  const keys = times.map(() => Float32Array.from(base)); // vertices outside every billow stay put
  for (const b of billows) {
    const field = curlField(seed + b.seed, b.r * 0.9);
    const ax = norm(b.axis);
    for (let i = b.first; i < b.first + b.count; i += 1) {
      const p0 = [base[i * 3], base[i * 3 + 1], base[i * 3 + 2]];
      const rel0 = sub(p0, b.centre);
      const m = b.mask ? b.mask(p0) : 1;
      const rest = (t) => {
        const th = b.roll * (t - FLOW.start) * mix(1, 0.3, calm(t));
        // Rodrigues: rel0 rolled by th about ax.
        const c = Math.cos(th);
        const s = Math.sin(th);
        const kx = cross(ax, rel0);
        const kd = dot(ax, rel0);
        const rolled = rel0.map((v, k) => v * c + kx[k] * s + ax[k] * kd * (1 - c));
        const cl = calm(t);
        const sc = mix(1, b.thin, cl);
        return addv(addv(b.centre, rolled, sc), b.part, cl);
      };
      let x = rest(FLOW.start);
      let t = FLOW.start;
      let next = 0;
      while (next < times.length) {
        if (t >= times[next] - 1e-6) {
          keys[next].set(x, i * 3);
          next += 1;
          continue;
        }
        const v = field(x[0], x[1], x[2], t);
        const r = rest(t);
        const a = b.amp * flowAmp(t) * m;
        x = x.map((xv, k) => xv + FLOW.dt * (a * v[k] - b.k * (xv - r[k])));
        t += FLOW.dt;
      }
    }
  }
  // Rest positions start the track, so the layer's base is its first key.
  pos.set(keys[0]);
  return keyTrack(keys[0], FLOW.start, FLOW.step, keys);
}

/** The demands' billows (one mesh): flow keys and a swell shape per demand. */
export function demandBillows(C) {
  const parts = [];
  const billows = [];
  let first = 0;
  for (const d of DEMANDS) {
    const c = demandCentre(C, d);
    const g = billowGeometry(c, d.r, { seed: d.seed, w: 40, h: 28 });
    gasPaint(g, d.hex);
    parts.push(g);
    const count = g.attributes.position.count;
    // Each billow parts away from him and the hatch, out toward the frame's edge.
    const away = norm([d.pos[0], d.pos[1] - 0.03, 0]).slice(0, 2);
    const part = addv(SR.map((v) => v * away[0] * 0.07), SU, away[1] * 0.07);
    billows.push({ first, count, centre: c, r: d.r, seed: d.seed, roll: 0.35 + 0.1 * (d.seed % 3), axis: [Math.sin(d.seed), 0.4, Math.cos(d.seed)], part, thin: 0.7, amp: 0.0045, k: 1.2 });
    first += count;
  }
  const geo = finish(merge(parts.map((g) => finish(g, false))));
  const track = flowKeys(geo, billows, 100);
  // The swell: out from its centre.
  const swells = DEMANDS.map((d, j) => {
    const b = billows[j];
    const out = new Float32Array(geo.attributes.position.count * 3);
    const p = geo.attributes.position.array;
    for (let i = b.first; i < b.first + b.count; i += 1) for (let k = 0; k < 3; k += 1) out[i * 3 + k] = 0.16 * (p[i * 3 + k] - b.centre[k]);
    return out;
  });
  return {
    geo,
    shapes: [...track.shapes, ...swells],
    weights: (t) => [...track.weights(t), ...DEMANDS.map((d) => pulse(d, t) * (1 - calm(t)))]
  };
}

/** The ambient gas: billows round C, clear of the corridor to the camera, of him, of the demands and of the mound. */
export function ambientBillows(C) {
  const R = rng(23);
  const colours = ['#f7c6b0', '#c0cbf7', '#f2d0e8', '#cdeee0', '#f5dcc0', '#d9d0f5', '#bfe6f0'];
  const parts = [];
  const billows = [];
  let first = 0;
  let tries = 0;
  const avoid = [...DEMANDS.map((d) => [demandCentre(C, d), d.r * 1.4]), [moundCentre(C), HATCH.rho * 1.15]];
  const him = (s) => C.map((v, k) => v + (anchorWorld(C, s)[k] - v) / s);
  const H = HATCH.centre(C);
  for (const [a, b, r, seed] of [[-0.02, 0.006, 0.03, 81], [0.021, 0.0, 0.032, 82], [0.0, -0.022, 0.028, 83], [0.002, 0.02, 0.026, 84]]) {
    const c = H.map((h, k) => h + a * HATCH.right[k] + b * HATCH.far[k] + 0.012 * HATCH.n[k]);
    const g = billowGeometry(c, r, { seed, w: 30, h: 20, squash: [1.25, 0.7, 1.25], puffs: 6 });
    gasPaint(g, '#ebdff1', { floor: 0.05, core: 0.99, tint: '#f8f0f6' });
    parts.push(g);
    const count = g.attributes.position.count;
    const away = norm(HATCH.right.map((v, k) => a * v + (b - 0.012) * HATCH.far[k]));
    billows.push({ first, count, centre: c, r, seed, roll: 0.12, axis: HATCH.n, part: away.map((v) => v * 0.075), thin: 0.75, amp: 0.004, k: 1 });
    first += count;
  }
  const veils = billows.length;
  while (billows.length < 13 + veils && tries < 6000) {
    tries += 1;
    const r = 0.06 + 0.1 * R();
    const dir = [R() * 2 - 1, R() * 2 - 1, R() * 2 - 1];
    if (len(dir) > 1 || len(dir) < 0.3) continue;
    const d = 0.16 + 0.62 * R();
    const c = addv(C, norm(dir), d);
    const rel = sub(c, C);
    const along = dot(rel, F);
    const off = len(rel.map((v, k) => v - along * F[k]));
    if (along > 0 && off < r * 1.3 + 0.04) continue; // the corridor to the camera
    if (d + r * 1.3 > 0.9) continue; // inside the skies' ball
    if (avoid.some(([q, rq]) => len(sub(c, q)) < rq + r * 1.1)) continue;
    if ([6, 9, 12].some((s) => len(sub(c, him(s))) < r * 1.3 + 0.35 / s)) continue;
    const g = billowGeometry(c, r, { seed: 50 + billows.length - veils, w: 26, h: 18, squash: [1.3, 0.8, 1.05], puffs: 5 });
    gasPaint(g, colours[billows.length % colours.length], { floor: 0.03, core: 0.85 });
    parts.push(g);
    const count = g.attributes.position.count;
    const out = norm(rel.map((v, k) => v - along * F[k]));
    billows.push({ first, count, centre: c, r, seed: 60 + billows.length, roll: 0.15 + 0.15 * R(), axis: [R() - 0.5, R() - 0.5, R() - 0.5], part: out.map((v) => v * 0.05), thin: 0.85, amp: 0.006, k: 0.9 });
    first += count;
  }
  const geo = finish(merge(parts.map((g) => finish(g, false))));
  const track = flowKeys(geo, billows, 300);
  return { geo, shapes: track.shapes, weights: track.weights };
}

/**
 * The bank and its mound, opaque. Round the hatch the mound is pressed flat
 * into the hatch's plane, with a clean square collar whose inner edge is the
 * opening; further out it roils slowly. Its inside is the lining (below).
 */
export function bank(C) {
  const Z = moundCentre(C);
  const H = HATCH.centre(C);
  const { n, right, far, half, rho } = HATCH;
  const g = new SphereGeometry(1, 72, 44);
  const pos = g.attributes.position;
  const n1 = noise3(72);
  const inPlane = (p) => {
    const rel = sub(p, H);
    return Math.max(Math.abs(dot(rel, right)), Math.abs(dot(rel, far)));
  };
  const flat = (p) => smooth(half * 1.9, half * 3.4, inPlane(p));
  for (let i = 0; i < pos.count; i += 1) {
    const d = [pos.getX(i), pos.getY(i), pos.getZ(i)];
    const bump = Math.max(0, 1.5 * n1(d[0] * 2.6, d[1] * 2.6, d[2] * 2.6) + 0.35);
    const lump = rho * (0.2 * bump * bump + 0.025 * n1(d[0] * 8, d[1] * 8, d[2] * 8));
    let q = addv(Z, d, rho);
    const f = flat(q);
    q = addv(Z, d, rho + lump * f);
    // Pressed up into the hatch's plane near the hatch (the sphere falls away below it).
    const below = -dot(sub(q, H), n);
    if (below > 0) q = addv(q, n, below * (1 - f));
    pos.setXYZ(i, ...q);
  }
  g.computeVertexNormals();
  gasPaint(g, '#e9d6ef', { floor: 1, core: 1, tint: '#f6ecf4' });
  // Cut a hole under the collar (its ragged edge is hidden by the collar).
  const idx = g.index.array;
  const keep = [];
  const P = (j) => [pos.getX(j), pos.getY(j), pos.getZ(j)];
  for (let i = 0; i < idx.length; i += 3) {
    const c = [0, 1, 2].map((k) => (P(idx[i])[k] + P(idx[i + 1])[k] + P(idx[i + 2])[k]) / 3);
    if (!(dot(sub(c, Z), n) > 0 && inPlane(c) < half * 1.55)) keep.push(idx[i], idx[i + 1], idx[i + 2]);
  }
  g.setIndex(keep);
  // The collar: a square annulus in the hatch's plane from the opening to 2.6 half-widths.
  const collar = (() => {
    const out = new BufferGeometry();
    const p = [];
    const ix = [];
    const ring = (k, lift) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => H.map((h, j) => h + k * half * (a * right[j] + b * far[j]) + lift * n[j]));
    const inner = ring(1, 0.0004);
    const outer = ring(1.75, -0.0006);
    for (let s = 0; s < 4; s += 1) {
      const b = p.length;
      p.push(inner[s], inner[(s + 1) % 4], outer[(s + 1) % 4], outer[s]);
      ix.push(b, b + 2, b + 1, b, b + 3, b + 2);
    }
    out.setAttribute('position', new Float32BufferAttribute(p.flat(), 3));
    out.setIndex(ix);
    out.computeVertexNormals();
    // Make it face up (the normal along n).
    if (dot([out.attributes.normal.getX(0), out.attributes.normal.getY(0), out.attributes.normal.getZ(0)], n) < 0) out.setIndex(ix.map((_, k) => ix[k - (k % 3) + [0, 2, 1][k % 3]]));
    out.computeVertexNormals();
    const one = Array.from(out.index.array);
    out.setIndex([...one, ...one.map((_, k) => one[k - (k % 3) + [0, 2, 1][k % 3]])]);
    gasPaint(out, '#e9d6ef', { floor: 1, core: 1, tint: '#f6ecf4' });
    return out;
  })();
  // The skirt: a broad, low bank spreading back and to the sides.
  const skirtC = addv(addv(Z, UP, -0.035), F, -0.06);
  const skirt = billowGeometry(skirtC, 0.2, { seed: 75, w: 56, h: 24, squash: [1.25, 0.22, 1.05], puffs: 12 });
  gasPaint(skirt, '#e4d3ee', { floor: 0.02, core: 0.98, edge: [0.02, 0.45], tint: '#f3e6f2' });
  const geo = merge([finish(g, false), finish(collar, false)]);
  const track = flowKeys(geo, [
    { first: 0, count: g.attributes.position.count, centre: Z, r: rho, seed: 3, roll: 0, axis: [0, 1, 0], part: [0, 0, 0], thin: 1, amp: 0.004, k: 1.2, mask: (p) => flat(p) }
  ], 500);
  const floorGeo = finish(skirt);
  const floorTrack = flowKeys(floorGeo, [
    { first: 0, count: skirt.attributes.position.count, centre: skirtC, r: 0.12, seed: 4, roll: 0.03, axis: [0, 1, 0], part: [0, 0, 0], thin: 1, amp: 0.007, k: 0.8 }
  ], 600);
  return { geo, shapes: track.shapes, weights: track.weights, floor: { geo: floorGeo, shapes: floorTrack.shapes, weights: floorTrack.weights } };
}

/** The inside of the mound: dark red, facing in (so unseen from outside), seen through the open hatch. */
export function lining(C) {
  const Z = moundCentre(C);
  const g = new SphereGeometry(HATCH.rho - 0.0025, 36, 24);
  g.translate(...Z);
  const pos = g.attributes.position;
  const idx = Array.from(g.index.array);
  const flipped = idx.map((_, k) => idx[k - (k % 3) + [0, 2, 1][k % 3]]);
  const top = lin('#5a1418');
  const bottom = lin('#1c0507');
  const col = [];
  for (let i = 0; i < pos.count; i += 1) {
    const u = clamp((pos.getY(i) - Z[1]) / (2 * HATCH.rho) + 0.5);
    col.push(...[0, 1, 2].map((k) => mix(bottom[k], top[k], u)), 1);
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(Array.from(pos.array), 3));
  out.setAttribute('color', new Float32BufferAttribute(col, 4));
  out.setIndex(flipped);
  return out;
}

// ---------------------------------------------------------------------------
// The tugs: a wisp reaches out of a demand's billow, catches one of his limbs
// and pulls; while he fights it snaps away, and when he lets go (21.5 s) the
// last three simply slacken and let go of him.

export const TUGS = [
  { demand: 'chime', limb: 'wristL', reach: 12.5, hold: 12.85, off: 14.3, snap: true },
  { demand: 'buzz', limb: 'ankleR', reach: 13.5, hold: 13.8, off: 15.4, snap: true },
  { demand: 'tick', limb: 'wristR', reach: 14.6, hold: 14.9, off: 16.3, snap: true },
  { demand: 'kettle', limb: 'ankleL', reach: 15.6, hold: 15.9, off: 17.7, snap: true },
  { demand: 'clatter', limb: 'wristL', reach: 16.6, hold: 16.85, off: 18.2, snap: true },
  { demand: 'buzz', limb: 'wristR', reach: 17.6, hold: 17.85, off: 19.3, snap: true },
  { demand: 'chime', limb: 'ankleR', reach: 18.5, hold: 18.75, off: 20.2, snap: true },
  { demand: 'kettle', limb: 'wristL', reach: 19.55, hold: 19.8, off: 23.3, snap: false },
  { demand: 'tick', limb: 'ankleL', reach: 20.2, hold: 20.45, off: 22.8, snap: false },
  { demand: 'buzz', limb: 'wristR', reach: 20.75, hold: 21.0, off: 22.3, snap: false }
];
/** How hard a tug holds its limb at t, 0..1. */
export const holdOf = (tug, t) => smooth(tug.hold - 0.12, tug.hold + 0.06, t) * (1 - smooth(tug.off, tug.off + (tug.snap ? 0.1 : 0.8), t));
/** A tug's billow centre (home units). */
export const tugCentre = (C, tug) => demandCentre(C, DEMANDS.find((d) => d.id === tug.demand));

/**
 * One wisp per tug, keyed every 0.1 s from the limb's recorded place
 * (`limbHome(t)`, gas home units): it reaches out of the billow, holds the
 * limb with a taut, whipping line, and on release retracts into its billow
 * (a snap tears it fast; a letting go slackens it slowly).
 */
export function wisp(C, tug, limbHome, seed) {
  const d = DEMANDS.find((x) => x.id === tug.demand);
  const c = demandCentre(C, d);
  const RINGS = 14;
  const SEGS = 7;
  const step = 0.1;
  const back = tug.snap ? 0.45 : 1.0;
  const times = keyTimes(tug.reach - 0.2, tug.off + back + 0.2, step);
  const n = noise3(seed);
  const line = (t) => {
    const B = limbHome(Math.min(Math.max(t, tug.reach), tug.off));
    const dir = norm(sub(B, c));
    const A = addv(c, dir, d.r * 0.7);
    const out = smooth(tug.reach, tug.hold, t);
    const ret = smooth(tug.off, tug.off + back, t);
    // The tip: out to the limb, held there, then back into the billow.
    const tipF = out * (1 - ret);
    const tip = addv(A, sub(B, A), tipF);
    const L = len(sub(tip, A));
    // Sideways whip: two noise fields across the line, strongest mid-way, slack when letting go.
    const side = norm(cross(dir, F));
    const up = cross(side, dir);
    const slack = tug.snap ? 0.18 : mix(0.18, 0.5, ret);
    const pts = [];
    for (let i = 0; i < RINGS; i += 1) {
      const u = i / (RINGS - 1);
      const env = Math.sin(PI * u) * L * slack;
      const a = n(u * 2.2, t * 1.7, 0.3) * env;
      const b = n(u * 2.2 + 5, t * 1.5, 1.7) * env;
      pts.push(addv(addv(addv(A, sub(tip, A), u), side, a), up, b));
    }
    const thick = out * (1 - smooth(tug.off, tug.off + back * 0.8, t));
    return { pts, r: (u) => thick * (0.013 * (1 - u) ** 1.3 + 0.0032) };
  };
  const keys = times.map((t) => {
    const { pts, r } = line(t);
    return tubePositions(pts, r, SEGS);
  });
  const base = keys[0];
  const geo = tubeGeometry(Array.from(base), RINGS, SEGS);
  const col = [];
  const cc = lin(d.hex).map((v) => v ** 1.35);
  for (let i = 0; i < RINGS; i += 1) for (let j = 0; j < SEGS; j += 1) col.push(...cc, mix(0.85, 0.55, i / (RINGS - 1)));
  col.push(...cc, 0.5);
  geo.setAttribute('color', new Float32BufferAttribute(col, 4));
  const track = keyTrack(base, times[0], step, keys);
  return { geo, shapes: track.shapes, weights: track.weights };
}

/** The hatch: a frame flush with the mound and a lid hinged on its far edge, keyed as it opens. */
export function hatch(C) {
  const H = HATCH.centre(C);
  const { n, right, far, half } = HATCH;
  // [centre (u, v, lift), size (u, v, thickness), colour]
  const boxes = [
    [[0, half * 1.06, 0.0005], [half * 2.25, half * 0.12, 0.002], '#8a7a5c'],
    [[0, -half * 1.06, 0.0005], [half * 2.25, half * 0.12, 0.002], '#8a7a5c'],
    [[half * 1.06, 0, 0.0005], [half * 0.12, half * 2.25, 0.002], '#8a7a5c'],
    [[-half * 1.06, 0, 0.0005], [half * 0.12, half * 2.25, 0.002], '#8a7a5c']
  ];
  const lidBoxes = [
    [[0, 0, 0.0012], [half * 2, half * 2, 0.0016], '#d8d0bd'],
    [[0, -half * 0.25, 0.0022], [half * 1.9, half * 0.1, 0.0006], '#b9ad92'],
    [[0, half * 0.35, 0.0022], [half * 1.9, half * 0.1, 0.0006], '#b9ad92'],
    [[0, -half * 0.82, 0.0026], [half * 0.7, half * 0.12, 0.0012], '#6f5f45']
  ];
  const box = ([u, v, w], [su, sv, sw], hex) => {
    const pos = [];
    for (const z of [-1, 1]) for (const y of [-1, 1]) for (const x of [-1, 1]) {
      const a = u + (x * su) / 2;
      const b = v + (y * sv) / 2;
      const c = w + (z * sw) / 2;
      pos.push(H.map((h, k) => h + a * right[k] + b * far[k] + c * n[k]));
    }
    const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
    const P = [];
    const I = [];
    for (const q of quads) {
      const s = P.length;
      for (const j of q) P.push(pos[j]);
      I.push(s, s + 2, s + 1, s, s + 3, s + 2);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(P.flat(), 3));
    g.setIndex(I);
    g.computeVertexNormals();
    const c = lin(hex);
    const nor = g.attributes.normal;
    const L = norm([0.2, 1, 0.5]);
    const col = [];
    for (let i = 0; i < nor.count; i += 1) {
      const k = 0.62 + 0.38 * Math.max(0, nor.getX(i) * L[0] + nor.getY(i) * L[1] + nor.getZ(i) * L[2]);
      col.push(c[0] * k, c[1] * k, c[2] * k, 1);
    }
    g.setAttribute('color', new Float32BufferAttribute(col, 4));
    return g;
  };
  const frame = merge(boxes.map((b) => box(...b)));
  const lid = merge(lidBoxes.map((b) => box(...b)));
  // The lid's track: rotated about the hinge (its far edge) by lidAngle, keyed every 0.05 s.
  const hinge = H.map((h, k) => h + half * far[k]);
  const base = Float32Array.from(lid.attributes.position.array);
  const rot = (p, th) => {
    const rel = sub(p, hinge);
    const c = Math.cos(th);
    const s = Math.sin(th);
    const ax = right.map((v) => -v); // near edge lifts up and over toward the far side
    const kx = cross(ax, rel);
    const kd = dot(ax, rel);
    return addv(hinge, rel.map((v, k) => v * c + kx[k] * s + ax[k] * kd * (1 - c)));
  };
  const times = keyTimes(24.1, 24.75, 0.05);
  const keys = times.map((t) => {
    const th = lidAngle(t);
    const out = new Float32Array(base.length);
    for (let i = 0; i < base.length; i += 3) out.set(rot([base[i], base[i + 1], base[i + 2]], th), i);
    return out;
  });
  const track = keyTrack(base, times[0], 0.05, keys);
  const lidAt = (t, u, v) => rot(H.map((h, k) => h + u * right[k] + v * far[k] + 0.003 * n[k]), lidAngle(t));
  return { frame, lid: { geo: lid, shapes: track.shapes, weights: track.weights }, lidAt, hinge };
}
