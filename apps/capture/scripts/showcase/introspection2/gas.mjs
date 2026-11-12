import { BufferGeometry, Float32BufferAttribute } from 'three';

import { lin } from '../introspection/common.mjs';
import { GUSTS } from './events.mjs';
import { noise3 } from './flow.mjs';
import { rng } from './layers.mjs';
import { mix, smooth } from './timeline.mjs';
import { SCREEN } from './zoom.mjs';
import { pngRGBA, runs, worldMorph } from './world.mjs';

// The gas, third pass (BEATS.md beats 3–4): not billows at the size of a
// sky but soft puffs close to the camera, blown across the frame by a wind
// that strengthens, and the five demands as gusts. Each gust gathers at an
// edge in its demand's colour, blasts through him and is gone; they come
// closer and closer together. When he lets go the wind drops, the puffs
// part round the opening under him and thin away.
//
// Every puff is a camera-facing quad (the feed's camera never moves) on one
// soft-puff texture, tinted by its vertex colour, authored in world space
// key by key (world.mjs).

const { right: SR, up: SU, toward: SF } = SCREEN;

export const DEMANDS = [
  { id: 'chime', hex: '#f27fb0' },
  { id: 'buzz', hex: '#5fd99a' },
  { id: 'tick', hex: '#9f86ee' },
  { id: 'kettle', hex: '#f5c64f' },
  { id: 'clatter', hex: '#5fb4f0' }
];
const DEMAND = Object.fromEntries(DEMANDS.map((d) => [d.id, d]));
const PASTELS = ['#e3d3f6', '#f7d6c4', '#d2efe3', '#f6d3e6', '#f6eedb', '#d3e3f7', '#efe2f7'];

/** The soft puff: a lumpy round cloud, white, alpha falling off to the edge. */
export function puffTexture(size = 128) {
  const n = noise3(41);
  return pngRGBA(size, size, (u, v) => {
    const x = 2 * u - 1;
    const y = 2 * v - 1;
    const r = Math.hypot(x, y);
    const ang = Math.atan2(y, x);
    const lobes = 0.78 + 0.12 * n(Math.cos(ang) * 1.6, Math.sin(ang) * 1.6, 0.5) + 0.06 * n(x * 4, y * 4, 2.1);
    const edge = 1 - smooth(0.35 * lobes, lobes, r);
    const body = 0.75 + 0.25 * n(x * 3.1, y * 3.1, 7.7);
    const light = 0.88 + 0.12 * Math.max(0, -0.6 * x + 0.8 * y);
    return [light, light, light, edge * body];
  });
}

const at = (C, a, b, c) => [0, 1, 2].map((k) => C[k] + a * SR[k] + b * SU[k] + c * SF[k]);

// The wind: right to left across the frame, from a breeze to a gale by 20.5 s, dropping when he lets go.
const win = (a, b, t, r) => smooth(a - r, a, t) * (1 - smooth(b, b + r, t));
const speed = (t) => mix(0.25, 1.35, smooth(10, 20.5, t)) * (1 - 0.8 * smooth(23.5, 24.3, t)); // calms after his breath out
const WIND = (() => {
  const out = [0];
  for (let i = 1; i <= 6100; i += 1) out.push(out[i - 1] + 0.01 * speed(i * 0.01));
  return out;
})();
const windX = (t) => WIND[Math.max(0, Math.min(WIND.length - 1, Math.round(t * 100)))];

const BOX = { a: 6.8, b: 3.1, c0: -3.8, c1: 4.3 };
const wrapA = (a) => {
  const w = 2 * BOX.a;
  return ((((a + BOX.a) % w) + w) % w) - BOX.a;
};

/**
 * The gas's puffs as one world-space mesh.
 * ctx: { C, him(t) world point of him (no knocks), iris(t) world centre of
 * the opening, S(t), from (first visible time), back: [t0, t1] (the way out),
 * k his size against the 72 cm the gas was first drawn for }.
 */
export function gasSprites(ctx) {
  const { C } = ctx;
  const r = rng(7171);
  const n = noise3(23);
  const puffs = [];
  // Ambient puffs, more of them far than near; a few faint big ones close to the camera.
  for (let i = 0; i < 120; i += 1) {
    const near = i < 14;
    const c = near ? mix(2.6, BOX.c1, r()) : BOX.c0 + (2.6 - BOX.c0) * r() ** 1.3;
    const depth = (c - BOX.c0) / (BOX.c1 - BOX.c0);
    puffs.push({
      kind: 'ambient',
      a0: mix(-BOX.a, BOX.a, r()),
      b0: mix(-BOX.b, BOX.b, r()),
      c,
      drift: 0.7 + 0.6 * r() + 0.5 * depth, // nearer puffs cross faster (parallax)
      size: (near ? mix(0.9, 1.5, r()) : mix(0.55, 1.25, r())) * (1 + 0.12 * (2.6 - c)),
      spin: (r() - 0.5) * 0.8,
      angle: r() * 6.28,
      seed: r() * 100,
      colour: lin(PASTELS[Math.floor(r() * PASTELS.length)]),
      alpha: near ? 0.22 : mix(0.4, 0.62, r())
    });
  }
  // Round him: puffs that ride with him, so he is always among the gas, not in front of it.
  const k = ctx.k ?? 1;
  for (let i = 0; i < 36; i += 1) {
    const ring = mix(0.55, 1.5, r() ** 0.7) * k;
    const sf = (r() - 0.45) * 1.2 * k;
    puffs.push({
      kind: 'near',
      ring,
      sf,
      c: 0.5 + sf,
      phase: r() * 6.28,
      orbit: (r() < 0.5 ? -1 : 1) * mix(0.25, 0.6, r()),
      tilt: mix(0.45, 1, r()),
      size: mix(0.3, 0.62, r()) * k ** 0.7,
      spin: (r() - 0.5) * 1.2,
      angle: r() * 6.28,
      seed: r() * 100,
      colour: lin(PASTELS[Math.floor(r() * PASTELS.length)]),
      alpha: mix(0.32, 0.5, r())
    });
  }
  // Far first, so the blend draws nearer puffs over farther ones.
  puffs.sort((p, q) => p.c - q.c);

  const entry = (t) => Math.min(1, ctx.S(t) / 100) ** 0.6;
  // He breathes (acting: in 22.6, out 23.2–23.9), then the gas calms, then it opens under him.
  const calm = (t) => smooth(23.5, 24.3, t);
  const open = (t) => smooth(24.0, 24.7, t);
  const gone = (t) => smooth(24.5, 25.4, t);

  // One puff at t: { p: centre, h: half size, th: angle } (h 0 hides it).
  function ambientAt(pf, t, back) {
    const w = back ? windX(24.3) + 0.08 * (t - 56) : windX(t);
    const a = wrapA(pf.a0 - w * pf.drift);
    const env = Math.sin((Math.PI * (a + BOX.a)) / (2 * BOX.a)) ** 0.6;
    const wob = 0.35 * mix(1, 0.4, back ? 1 : calm(t));
    const b = pf.b0 + wob * n(pf.seed, t * 0.35, 0.3);
    const c = pf.c + 0.3 * n(pf.seed + 9, t * 0.3, 1.7);
    let p = at([0, 0, 0], a, b, c);
    let h = pf.size * env;
    if (!back) {
      p = p.map((v) => v * entry(t));
      h *= entry(t) * smooth(ctx.from, ctx.from + 0.6, t) * (1 - 0.35 * calm(t)) * (1 - gone(t));
      // Parting round the opening.
      const o = open(t);
      if (o > 0) {
        const I = ctx.iris(t).map((v, k) => v - C[k]);
        const d = p.map((v, k) => v - I[k]);
        const along = d[0] * SF[0] + d[1] * SF[1] + d[2] * SF[2];
        const flat = d.map((v, k) => v - along * SF[k]);
        const l = Math.hypot(...flat) || 1;
        p = p.map((v, k) => v + (flat[k] / l) * 2.6 * o);
        h *= 1 - 0.45 * o;
      }
    } else {
      // The way out: the calm gas shrinking back into him with the zoom.
      const f = ctx.S(t) / ctx.S(22.6);
      p = p.map((v) => v * f);
      h *= f * smooth(ctx.back[0], ctx.back[0] + 0.1, t) * (1 - smooth(ctx.back[1] - 0.1, ctx.back[1], t));
    }
    return { p: p.map((v, k) => v + C[k]), h, th: pf.angle + pf.spin * t * (1 + 0.6 * speed(t)) };
  }

  // A puff round him at t: orbiting slowly, buffeted harder while the gusts blow, and on his
  // breath out thrown outward in a ring, the gas thinning away from him.
  function nearAt(pf, t, back) {
    if (back) return { p: C, h: 0, th: 0 };
    const H = ctx.him(t);
    const a = pf.phase + pf.orbit * t + 0.25 * n(pf.seed, t * 0.5, 0.2);
    const o = open(t);
    // His big breath moves the gas round him: drawn in as he breathes in, pushed out as he breathes out.
    const breath = 1 - 0.4 * win(22.6, 23.2, t, 0.35) + 0.35 * win(23.3, 23.95, t, 0.35);
    const R = pf.ring * breath * (1 + 0.15 * n(pf.seed + 3, t * 0.8, 0.5)) * (1 + 2.8 * o ** 1.4);
    const p = [0, 1, 2].map((j) => H[j] + R * (Math.cos(a) * SR[j] + pf.tilt * Math.sin(a) * SU[j]) + pf.sf * SF[j]);
    const h = pf.size * smooth(ctx.from + 0.8, ctx.from + 1.8, t) * (1 - smooth(0.35, 1, o)) * (1 - gone(t));
    return { p, h, th: pf.angle + pf.spin * t };
  }
  const state = (pf, t, back) => (pf.kind === 'near' ? nearAt(pf, t, back) : ambientAt(pf, t, back));

  // Geometry: four corners per puff, uv, RGBA.
  const count = puffs.length * 4;
  const uv = [];
  const col = [];
  const idx = [];
  puffs.forEach((pf, i) => {
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let k = 0; k < 4; k += 1) col.push(...pf.colour, pf.alpha);
    const o = i * 4;
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  const quads = (t, back, hidden) => {
    const out = new Float32Array(count * 3);
    puffs.forEach((pf, i) => writeQuad(out, i, hidden ? null : state(pf, t, back), C));
    return out;
  };

  const step = 0.15;
  const fwd = { start: ctx.from, step, count: Math.ceil((25.6 - ctx.from) / step) + 1 };
  const bstep = 0.1;
  const bk = { start: ctx.back[0], step: bstep, count: Math.ceil((ctx.back[1] - ctx.back[0]) / bstep) + 1 };
  const track = runs([fwd, bk]);
  // Key 0 is the hidden pose; outside its windows (switch times, so the cut is exact) the gas is gone.
  const keys = [quads(0, false, true), ...track.times.map((t, i) => quads(t, i >= fwd.count, false))];
  const inside = (t) => (t >= ctx.from && t < 25.6) || (t >= ctx.back[0] && t < ctx.back[1]);
  const weights = (t) => (inside(t) ? [0, ...track.weights(t)] : [1, ...track.times.map(() => 0)]);

  // Base: every puff a small quad round C (inside the skies' ball, apart so no vertices merge).
  const base = new Float32Array(count * 3);
  puffs.forEach((pf, i) => {
    for (let k = 0; k < 4; k += 1) {
      const a = (k * Math.PI) / 2 + i * 0.01;
      for (let j = 0; j < 3; j += 1) base[(i * 4 + k) * 3 + j] = C[j] + 0.01 * (Math.cos(a) * SR[j] + Math.sin(a) * SU[j]) + 1e-4 * i * SF[j];
    }
  });
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(base, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new Float32BufferAttribute(col, 4));
  geo.setIndex(idx);
  worldMorph(geo, keys, weights(0));
  const gusts = GUSTS.map((g) => gustMesh(ctx, g));
  return { geo, weights, puffs: puffs.length, keys: keys.length, gusts };
}

/**
 * Writes puff i's quad into out: centre p, half size h, angle th, stretched L
 * times along th (and thinned by 1/sqrt(L) across it). s null hides it at C.
 */
function writeQuad(out, i, s, C) {
  const p = s?.p ?? C;
  const h = s ? Math.max(0, s.h) : 0;
  const th = s?.th ?? 0;
  const L = s?.L ?? 1;
  const W = 1 / Math.sqrt(L);
  const E = [0, 1, 2].map((j) => Math.cos(th) * SR[j] + Math.sin(th) * SU[j]);
  const N = [0, 1, 2].map((j) => -Math.sin(th) * SR[j] + Math.cos(th) * SU[j]);
  [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([cx, cy], k) => {
    for (let j = 0; j < 3; j += 1) out[(i * 4 + k) * 3 + j] = p[j] + h * (L * cx * E[j] + W * cy * N[j]);
  });
}

// ---------------------------------------------------------------------------
// A gust (events.mjs GUSTS): its own mesh, keyed every 0.05 s so the blast
// keeps its snap. A demand's colour gathers out where it comes from,
// swirling, then shoots at him in a streak, bursts on him in a spray, and
// blows on past.

const GUST_BODY = 28;
const GUST_SPRAY = 8;
const G0 = -1.5;
const G1 = 1.4;

function gustMesh(ctx, g) {
  const { C } = ctx;
  const r = rng(9100 + g.i);
  const k = ctx.k ?? 1; // his size against the 72 cm the gusts were drawn for
  const hex = lin(DEMAND[g.demand].hex);
  const H = ctx.him(g.t);
  // On screen the blast runs along -d.
  const ex = -(g.d[0] * SR[0] + g.d[1] * SR[1] + g.d[2] * SR[2]);
  const ey = -(g.d[0] * SU[0] + g.d[1] * SU[1] + g.d[2] * SU[2]);
  const onScreen = Math.hypot(ex, ey);
  const dirA = Math.atan2(ey, ex);
  const puffs = [];
  for (let j = 0; j < GUST_BODY + GUST_SPRAY; j += 1) {
    const spray = j >= GUST_BODY;
    const o = [r() - 0.5, r() - 0.5, r() - 0.5].map((v) => 2 * v);
    const ol = Math.hypot(...o) || 1;
    const rad = spray ? 1 : r() ** 0.5;
    const shade = mix(0.78, 1, r());
    puffs.push({
      spray,
      off: o.map((v) => (v / ol) * rad),
      size: (spray ? mix(0.12, 0.26, r()) : mix(0.32, 0.8, r())) * (0.85 + 0.3 * g.power) * k ** 0.7,
      spin: (r() - 0.5) * 2,
      angle: (r() - 0.5) * 1.2,
      swirl: (r() - 0.5) * 3,
      speed: mix(2.2, 4.2, r()) * k ** 0.7,
      colour: spray ? hex.map((v) => mix(v, 1, 0.45)) : hex.map((v) => v * shade),
      alpha: spray ? 0.95 : mix(0.8, 0.95, r())
    });
  }
  const reach = 3.6 * k ** 0.5;
  const at = (pf, t) => {
    const x = t - g.t;
    if (x < G0 || x > G1) return null;
    if (pf.spray) {
      if (x < 0) return null;
      // Thrown out round him on impact, slowing, and gone in half a second.
      const k = 1 - Math.exp(-x / 0.12);
      const p = [0, 1, 2].map((m) => H[m] + pf.off[m] * pf.speed * 0.45 * k - g.d[m] * 0.5 * k);
      return { p, h: pf.size * (1 - smooth(0.2, 0.55, x)), th: dirA + pf.angle, L: 1 + 1.5 * Math.exp(-x / 0.1) };
    }
    // λ along the line from the source (0) through him (1) and a little past him.
    let lam;
    if (x < -0.4) lam = mix(-0.12, 0.05, smooth(G0, -0.4, x));
    else if (x < 0) lam = 0.05 + 0.95 * ((x + 0.4) / 0.4) ** 3;
    else lam = 1 + 0.7 * (1 - (1 - Math.min(1, x / 1.1)) ** 2);
    // Gathered tight before the blast; burst wide on impact.
    const spread = k * (x < -0.4 ? mix(1.4, 0.6, smooth(G0, -0.4, x)) : x < 0 ? mix(0.6, 0.35, (x + 0.4) / 0.4) : mix(0.35, 2.3, 1 - (1 - Math.min(1, x / 0.5)) ** 3));
    const o = rotateAbout(pf.off, g.d, pf.swirl * (x - G0));
    const p = [0, 1, 2].map((m) => H[m] + g.d[m] * reach * (1 - lam) + o[m] * spread);
    const blast = smooth(-0.42, -0.22, x) * (1 - smooth(0.02, 0.2, x));
    const L = 1 + 2.6 * onScreen * blast;
    const h = pf.size * smooth(G0, G0 + 0.45, x) * (1 + 0.6 * smooth(0, 0.4, x)) * (1 - smooth(0.4, G1 - 0.1, x));
    return { p, h, th: dirA + (pf.angle + pf.spin * x) * (1 - Math.min(1, (L - 1) / 0.5)), L };
  };
  const n = puffs.length;
  const uv = [];
  const col = [];
  const idx = [];
  puffs.forEach((pf, i) => {
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let k = 0; k < 4; k += 1) col.push(...pf.colour, pf.alpha);
    idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
  });
  const frame = (t) => {
    const out = new Float32Array(n * 12);
    puffs.forEach((pf, i) => writeQuad(out, i, t === null ? null : at(pf, t), C));
    return out;
  };
  const step = 0.05;
  const track = runs([{ start: g.t + G0, step, count: Math.ceil((G1 - G0) / step) + 1 }]);
  const keys = [frame(null), ...track.times.map(frame)];
  const inside = (t) => t >= g.t + G0 && t < g.t + G1;
  const weights = (t) => (inside(t) ? [0, ...track.weights(t)] : [1, ...track.times.map(() => 0)]);
  const base = new Float32Array(n * 12);
  for (let i = 0; i < n * 4; i += 1) for (let m = 0; m < 3; m += 1) base[i * 3 + m] = C[m] + 1e-4 * i * SF[m] + (m === 0 ? 1e-3 * (i % 4) : 0);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(base, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new Float32BufferAttribute(col, 4));
  geo.setIndex(idx);
  worldMorph(geo, keys, weights(0));
  return { geo, weights, gust: g };
}

function rotateAbout(v, axis, a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const d = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
  const x = [axis[1] * v[2] - axis[2] * v[1], axis[2] * v[0] - axis[0] * v[2], axis[0] * v[1] - axis[1] * v[0]];
  return [0, 1, 2].map((k) => v[k] * c + x[k] * s + axis[k] * d * (1 - c));
}

/**
 * The gas inside the man before the way in: puffs in his torso (box: its bounds), facing the feed,
 * still at home size. Two shapes: a swirl round his spine and a bob.
 */
export function innerPuffs({ box, n, door, nDoor }) {
  const r = rng(4242);
  const c = [0, 1, 2].map((k) => (box.min.getComponent(k) + box.max.getComponent(k)) / 2);
  const h = [0, 1, 2].map((k) => (box.max.getComponent(k) - box.min.getComponent(k)) / 2);
  const hues = [...DEMANDS.map((d) => d.hex), ...PASTELS.slice(0, 4)];
  const pos = [];
  const uv = [];
  const col = [];
  const idx = [];
  const swirl = [];
  const bob = [];
  for (let i = 0; i < n + nDoor; i += 1) {
    let p;
    let size;
    if (i < n) {
      let q;
      do q = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
      while (q[0] ** 2 + q[1] ** 2 + q[2] ** 2 > 1);
      p = [c[0] + 0.55 * h[0] * q[0], c[1] + 0.72 * h[1] * q[1], c[2] + 0.5 * h[2] * q[2]];
      size = mix(0.045, 0.1, r());
    } else {
      // Behind the spot the zoom goes in at: small ones, nearer the shirt the smaller, so the view
      // keeps filling with gas until the switch.
      const d = 0.006 + 0.1 * r() ** 1.6;
      const a = r() * Math.PI * 2;
      const l = 0.6 * d * Math.sqrt(r());
      p = [0, 1, 2].map((j) => door[j] - SF[j] * d + l * (Math.cos(a) * SR[j] + Math.sin(a) * SU[j]));
      size = 0.35 * d + 0.005;
    }
    const a = 0.7 * (r() < 0.5 ? 1 : -1) * mix(0.6, 1, r());
    const dx = p[0] - c[0];
    const dz = p[2] - c[2];
    const turn = [c[0] + dx * Math.cos(a) - dz * Math.sin(a) - p[0], 0.03 * (r() - 0.5), c[2] + dx * Math.sin(a) + dz * Math.cos(a) - p[2]];
    const up = 0.025 * (r() - 0.5);
    const colour = lin(i < n ? hues[i % hues.length] : DEMANDS[i % DEMANDS.length].hex);
    const alpha = mix(0.7, 0.95, r());
    const spin = r() * Math.PI * 2;
    for (let k = 0; k < 4; k += 1) {
      const ang = spin + (k * Math.PI) / 2 + Math.PI / 4;
      for (let j = 0; j < 3; j += 1) pos.push(p[j] + size * (Math.cos(ang) * SR[j] + Math.sin(ang) * SU[j]));
      col.push(...colour, alpha);
      swirl.push(...turn);
      bob.push(0, up, 0);
    }
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    const o = i * 4;
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new Float32BufferAttribute(col, 4));
  geo.setIndex(idx);
  return { geo, shapes: [Float32Array.from(swirl), Float32Array.from(bob)] };
}
