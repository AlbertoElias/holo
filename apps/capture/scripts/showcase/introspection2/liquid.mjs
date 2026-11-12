import { BufferGeometry, Float32BufferAttribute } from 'three';

import { lin } from '../introspection/common.mjs';
import { HITS, HUES } from './events.mjs';
import { fbm, noise3, tubeGeometry, tubePositions } from './flow.mjs';
import { rng } from './layers.mjs';
import { mix, smooth } from './timeline.mjs';
import { runs, worldMorph } from './world.mjs';

// The liquid, third pass (BEATS.md beat 5): no sea of one colour, no mould.
// He is waist-deep in a churning pool of marbled paint in ten colours, and
// paint is thrown at him from every side, rope after rope (events.mjs
// HITS), each bursting on him into droplets that rain back into the pool and
// send rings across it. Everything is authored in world space (world.mjs).

export const POOL = { drop: 0.25, R: 7.4, rings: 30, segs: 80 };
const UP = [0, 1, 0];
const POOL_ORDER = ['cadmium', 'ultramarine', 'viridian', 'magenta', 'cobalt', 'violet', 'orange', 'ultramarine', 'ochre', 'violet'];

/** The pool's surface height (world y offset from its rest) at horizontal offset (x, z) from its centre. */
function waves(x, z, t, calmness, open) {
  const rho = Math.hypot(x, z);
  let h = 0.035 * Math.sin(1.3 * x + 0.9 * t) + 0.03 * Math.sin(1.1 * z - 1.2 * t + 1) + 0.02 * Math.sin(0.7 * (x + z) + 2.1 * t);
  h *= 1 - 0.6 * calmness;
  for (const e of HITS) {
    const s = t - e.t;
    if (s <= 0 || s > 3) continue;
    const d = rho - 2.2 * s;
    h += 0.16 * e.power * Math.exp(-s / 1.1) * Math.sin(5 * d) * Math.exp(-((d / 0.55) ** 2));
  }
  // Under the opening the paint lies flat and sinks a little, swirling in.
  const m = Math.exp(-((rho / 1.6) ** 2)) * open;
  return h * (1 - m) - 0.12 * m;
}

/**
 * The pool and the streams, as world-space meshes.
 * ctx: { C, him(t) → his pelvis (world, no knocks), from (the switch into the
 * liquid), to (37), back: [t0, t1] (the way out), sLiq(t), open(t) }.
 */
export function liquid(ctx) {
  const { C } = ctx;
  const P0 = [C[0], C[1] - POOL.drop, C[2]];
  const warp = fbm(noise3(97), 3);
  const marble = fbm(noise3(311), 4);

  // --- The pool: a polar grid, finer near him. ---
  const { rings, segs, R } = POOL;
  const polar = [[0, 0]];
  for (let i = 1; i <= rings; i += 1) {
    const r = R * (i / rings) ** 1.6;
    for (let j = 0; j < segs; j += 1) polar.push([r, (j / segs) * 2 * Math.PI]);
  }
  // The pool is the deep pigments, in shadow, so he and the thrown paint read against it.
  const hues = POOL_ORDER.map((h) => lin(HUES[h]).map((v) => v * 0.36));
  const shadeN = fbm(noise3(733), 2);
  const sky = lin('#2a080b');
  const col = [];
  for (const [r, a] of polar) {
    const x = r * Math.cos(a);
    const z = r * Math.sin(a);
    const q = 1.6 * warp(x * 0.35 + 3, z * 0.35, 0.4);
    const v = marble(x * 0.28 + q, z * 0.28 - q, 1.3) * 0.5 + 0.5;
    const L = POOL_ORDER.length;
    const f = ((((v * 2.6 + r * 0.06) % 1) + 1) % 1) * L;
    const i0 = Math.floor(f);
    const k = smooth(0.7, 1, f - i0); // mostly flat bands, quick blends between them
    const sh = 0.75 + 0.5 * (shadeN(x * 0.5, z * 0.5, 4.2) * 0.5 + 0.5);
    const c = hues[i0 % L].map((u, m) => mix(u, hues[(i0 + 1) % L][m], k) * sh);
    const fade = smooth(0.55 * R, R, r); // the far edge sinks into the sky
    col.push(...c.map((u, m) => mix(u, sky[m], fade)));
  }
  const idx = [];
  for (let j = 0; j < segs; j += 1) idx.push(0, 1 + ((j + 1) % segs), 1 + j);
  for (let i = 0; i < rings - 1; i += 1) {
    for (let j = 0; j < segs; j += 1) {
      const a = 1 + i * segs + j;
      const b = 1 + i * segs + ((j + 1) % segs);
      idx.push(a, b, a + segs, b, b + segs, a + segs);
    }
  }
  // The churn: a slow swirl, faster near him, and a vortex into the opening.
  const churn = (r) => 0.32 / (1 + 0.5 * r);
  const OPEN = [0];
  for (let i = 1; i <= 6100; i += 1) OPEN.push(OPEN[i - 1] + 0.01 * ctx.open(i * 0.01));
  const openInt = (t) => OPEN[Math.max(0, Math.min(OPEN.length - 1, Math.round(t * 100)))];
  const poolAt = (t, back) => {
    const out = new Float32Array(polar.length * 3);
    // Coming in, the pool grows out of C with the zoom; going out, it shrinks back into it.
    const grow = back ? ctx.sLiq(t) / 7.5 : mix(0.04, 1, smooth(ctx.from, ctx.from + 0.9, t) ** 0.7);
    const calmness = back ? 1 : smooth(34.6, 35.6, t);
    const open = back ? 0 : ctx.open(t);
    polar.forEach(([r, a], i) => {
      const ang = a + churn(r) * (t - 25) * (back ? 0.4 : 1) + (back ? 0 : 3.2 * Math.exp(-r / 0.9) * openInt(t));
      const x = r * Math.cos(ang);
      const z = r * Math.sin(ang);
      const p = [P0[0] + x, P0[1] + waves(x, z, t, calmness, open), P0[2] + z];
      for (let k = 0; k < 3; k += 1) out[i * 3 + k] = C[k] + grow * (p[k] - C[k]);
    });
    return out;
  };
  const fwd = { start: ctx.from, step: 0.2, count: Math.ceil((ctx.to - ctx.from) / 0.2) + 1 };
  const bk = { start: ctx.back[0], step: 0.2, count: Math.ceil((ctx.back[1] - ctx.back[0]) / 0.2) + 1 };
  const track = runs([fwd, bk]);
  const hidden = new Float32Array(polar.length * 3);
  polar.forEach((_, i) => {
    for (let k = 0; k < 3; k += 1) hidden[i * 3 + k] = C[k] + (k === 1 ? 1e-5 * i : 0);
  });
  const keys = [hidden, ...track.times.map((t, i) => poolAt(t, i >= fwd.count))];
  const inside = (t) => (t >= ctx.from && t < ctx.to) || (t >= ctx.back[0] && t < ctx.back[1]);
  const poolWeights = (t) => (inside(t) ? [0, ...track.weights(t)] : [1, ...track.times.map(() => 0)]);
  // Base: a small copy of the rest pool round C (inside the skies' ball).
  const base = new Float32Array(polar.length * 3);
  polar.forEach(([r, a], i) => {
    const p = [P0[0] + r * Math.cos(a), P0[1], P0[2] + r * Math.sin(a)];
    for (let k = 0; k < 3; k += 1) base[i * 3 + k] = C[k] + 0.05 * (p[k] - C[k]);
  });
  const pool = new BufferGeometry();
  pool.setAttribute('position', new Float32BufferAttribute(base, 3));
  pool.setAttribute('color', new Float32BufferAttribute(col, 3));
  pool.setIndex(idx);
  worldMorph(pool, keys, poolWeights(0));

  // --- The streams: one rope of paint per hit, then its splash. ---
  const RINGS = 12;
  const SEGS = 6;
  const DROPS = 20;
  const faces = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]];
  const octa = (p, s) => [[s, 0, 0], [-s, 0, 0], [0, s, 0], [0, -s, 0], [0, 0, s], [0, 0, -s]].flatMap((o) => o.map((v, k) => p[k] + v));
  const streams = HITS.map((e, si) => {
    const r = rng(500 + si);
    const H = ctx.him(e.t);
    const target = [H[0] + 0.12 * e.d[0], H[1] + 0.28 + 0.12 * e.d[1], H[2] + 0.12 * e.d[2]];
    const src = [0, 1, 2].map((k) => target[k] + 4.4 * e.d[k] + UP[k] * 0.9);
    const Tf = 0.42;
    const tl = e.t - Tf;
    const path = (tau) => [0, 1, 2].map((k) => src[k] + (target[k] - src[k]) * tau + UP[k] * 0.9 * 4 * tau * (1 - tau));
    const R0 = 0.07 + 0.12 * e.power;
    const LAG = 0.3;
    const drops = Array.from({ length: DROPS }, () => {
      const spread = [r() - 0.5, r() * 0.8, r() - 0.5];
      const v = [0, 1, 2].map((k) => -e.d[k] * mix(0.6, 2.2, r()) + spread[k] * 3.2 + UP[k] * mix(1.2, 2.8, r()));
      return { v, size: mix(0.035, 0.11, r()) * (0.8 + 0.6 * e.power), delay: 0.06 * r() };
    });
    const rope = (t) => {
      const head = Math.min(1, Math.max(0, (t - tl) / Tf));
      const tail = Math.min(1, Math.max(0, (t - tl - LAG) / Tf));
      const squash = smooth(e.t - 0.02, e.t + 0.12, t);
      const thin = 1 - smooth(e.t + LAG - 0.1, e.t + LAG, t);
      const line = Array.from({ length: RINGS }, (_, i) => path(mix(tail, head, i / (RINGS - 1))));
      const live = head - tail > 1e-4 && head > 0;
      // Thick, lumpy paint: a fat head, a body that pinches and swells as it flies, a thin tail.
      const lump = (u) => 1 + 0.32 * Math.sin(17 * u - 26 * t + si) + 0.18 * Math.sin(31 * u + 41 * t);
      const fat = (u) => 1 + 0.9 * smooth(0.82, 1, u);
      return tubePositions(line, (u) => (live ? R0 * thin * (0.25 + 0.75 * u ** 0.6) * lump(u) * fat(u) * (1 + 1.8 * squash * u ** 4) : 0), SEGS);
    };
    const splash = (t) =>
      drops.flatMap((d) => {
        const x = t - e.t - d.delay;
        if (x <= 0) return octa(target, 0);
        const p = [0, 1, 2].map((k) => target[k] + d.v[k] * x - (k === 1 ? 3.5 * x * x : 0));
        return octa(p, p[1] < P0[1] ? 0 : d.size * smooth(0, 0.05, x));
      });
    const start = tl - 0.05;
    const track = runs([{ start, step: 0.05, count: Math.ceil((e.t + 1.0 - start) / 0.05) + 1 }]);
    const end = e.t + 1.0;
    const keys = track.times.map((t) => Float32Array.from([...rope(t), ...splash(t)]));
    // Geometry: the tube, then the droplets; a lit stripe down one side of the rope.
    const tube = tubeGeometry(keys[0], RINGS, SEGS);
    const c = lin(e.colour);
    const colours = [];
    for (let i = 0; i < RINGS; i += 1) {
      for (let j = 0; j < SEGS; j += 1) {
        const k = j === 0 ? 1.45 : j === 1 || j === SEGS - 1 ? 1.1 : 0.72;
        colours.push(...c.map((v) => Math.min(1, v * k + (j === 0 ? 0.08 : 0))));
      }
    }
    colours.push(...c);
    const index = Array.from(tube.index.array);
    const tubeN = RINGS * SEGS + 1;
    drops.forEach((_, di) => {
      const o = tubeN + di * 6;
      for (const f of faces) index.push(o + f[0], o + f[1], o + f[2]);
      for (let v = 0; v < 6; v += 1) colours.push(...c.map((u) => (v === 2 ? mix(u, 1, 0.35) : u * 0.9)));
    });
    // Base: a hair-thin cluster at C (each vertex apart); the keys carry the rest.
    const base = new Float32Array(keys[0].length);
    for (let i = 0; i < base.length / 3; i += 1) base[i * 3] = C[0] + 1e-5 * i;
    for (let i = 0; i < base.length / 3; i += 1) { base[i * 3 + 1] = C[1]; base[i * 3 + 2] = C[2]; }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(base, 3));
    geo.setAttribute('color', new Float32BufferAttribute(colours, 3));
    geo.setIndex(index);
    // Key 0 is the base itself (nothing shows); outside its flight and splash the stream is gone.
    const weights = (t) => (t >= start && t < end ? [0, ...track.weights(t)] : [1, ...track.times.map(() => 0)]);
    worldMorph(geo, [base, ...keys], weights(0));
    return { geo, weights, hit: e, target };
  });

  return { pool: { geo: pool, weights: poolWeights }, streams, P0 };
}
