import { BufferGeometry, Float32BufferAttribute } from 'three';

import { lin } from '../introspection/common.mjs';
import { GUSTS } from './events.mjs';
import { noise3 } from './flow.mjs';
import { rng } from './layers.mjs';
import { LOOP, PI, loopNoise, loopRate, mix, smooth, win } from './timeline.mjs';
import { SCREEN } from './zoom.mjs';
import { gridKeys, pngRGBA, slotMeshes, worldMorph } from './world.mjs';

// The gas (BEATS.md, "The gas"): soft puffs blown across the frame by a wind
// that runs all loop, rising to a gale while the traveller is in it (gusts
// 12.5–21 s), and the five demands as gusts that blast him. When he lets go
// the wind drops and the puffs part round the knot under him. Everything is
// authored in view metres round the gas layer's origin (the old framing: the
// camera 6.979 vm out along Follow) and scaled into gas units by the scene.
//
// Every puff is a quad facing Follow on one soft-puff texture, tinted by its
// vertex colour. The ambient puffs loop: each drifts a whole number of
// crossings and spins a whole number of turns a loop.

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

const at = (a, b, c) => [0, 1, 2].map((k) => a * SR[k] + b * SU[k] + c * SF[k]);

// The wind: right to left across the frame; a breeze, a gale by 20.5 s, dropping when he lets go.
export const speed = (t) => mix(0.27, 1.35, smooth(10, 20.5, t) * (1 - smooth(23.5, 24.3, t)));
const integral = (f) => {
  const out = [0];
  for (let i = 1; i <= LOOP * 100; i += 1) out.push(out[i - 1] + 0.01 * f((i - 0.5) * 0.01));
  return (t) => {
    const x = Math.max(0, Math.min(LOOP * 100, t * 100));
    const i = Math.floor(x);
    return i >= LOOP * 100 ? out[i] : out[i] + (out[i + 1] - out[i]) * (x - i);
  };
};
const windX = integral(speed);
const W_TOTAL = windX(LOOP);
const turnX = integral((t) => 1 + 0.6 * speed(t));
const TH_TOTAL = turnX(LOOP);

const BOX = { a: 6.8, b: 3.1, c0: -3.8, c1: 4.3 };
const wrapA = (a) => {
  const w = 2 * BOX.a;
  return ((((a + BOX.a) % w) + w) % w) - BOX.a;
};

/**
 * The gas's puffs as one mesh, keyed every 0.3 s round the loop (200
 * targets, cyclic). ctx (view metres): near(t) the centre the near puffs
 * ride round (him while he is in the gas), knot the knot's centre, knotR its
 * radius (puffs keep clear of it), k his size against the 72 cm the gas was
 * first drawn for.
 */
export function gasSprites(ctx) {
  const r = rng(7171);
  const wobble = loopNoise(23, 0.35);
  const sway = loopNoise(29, 0.3);
  const puffs = [];
  // Ambient puffs, more of them far than near; a few faint big ones close to the camera.
  for (let i = 0; i < 120; i += 1) {
    const near = i < 14;
    const c = near ? mix(2.6, BOX.c1, r()) : BOX.c0 + (2.6 - BOX.c0) * r() ** 1.3;
    const depth = (c - BOX.c0) / (BOX.c1 - BOX.c0);
    const drift = 0.7 + 0.6 * r() + 0.5 * depth; // nearer puffs cross faster (parallax)
    const spin = (r() - 0.5) * 0.8;
    puffs.push({
      kind: 'ambient',
      a0: mix(-BOX.a, BOX.a, r()),
      b0: mix(-BOX.b, BOX.b, r()),
      c,
      // A whole number of crossings and turns a loop.
      drift: (Math.max(1, Math.round((drift * W_TOTAL) / (2 * BOX.a))) * 2 * BOX.a) / W_TOTAL,
      spin: (Math.round((spin * TH_TOTAL) / (2 * PI)) * 2 * PI) / TH_TOTAL,
      size: (near ? mix(0.9, 1.5, r()) : mix(0.55, 1.25, r())) * (1 + 0.12 * (2.6 - c)),
      angle: r() * 6.28,
      seed: r() * 100,
      colour: lin(PASTELS[Math.floor(r() * PASTELS.length)]),
      alpha: near ? 0.22 : mix(0.4, 0.62, r())
    });
  }
  // Round him: puffs that ride with him, so he is always among the gas, not in front of it.
  const k = ctx.k;
  for (let i = 0; i < 36; i += 1) {
    const ring = mix(0.55, 1.5, r() ** 0.7) * k;
    const sf = (r() - 0.45) * 1.2 * k;
    puffs.push({
      kind: 'near',
      ring,
      sf,
      c: 0.5 + sf,
      phase: r() * 6.28,
      orbit: loopRate((r() < 0.5 ? -1 : 1) * mix(0.25, 0.6, r())),
      tilt: mix(0.45, 1, r()),
      size: mix(0.3, 0.62, r()) * k ** 0.7,
      spin: loopRate((r() - 0.5) * 1.2),
      angle: r() * 6.28,
      seed: r() * 100,
      colour: lin(PASTELS[Math.floor(r() * PASTELS.length)]),
      alpha: mix(0.32, 0.5, r())
    });
  }
  // Far first, so the blend draws nearer puffs over farther ones.
  puffs.sort((p, q) => p.c - q.c);

  // He breathes (acting: in 22.6, out 23.2–23.9), the gas calms, and it parts round the knot as he
  // sinks into it (24–25.2); it closes again by 28 s.
  const calm = (t) => win(23.9, 30, t, 0.8);
  const open = (t) => win(24.4, 25.6, t, 0.6) + 0.6 * win(56.6, 57.4, t, 0.4);
  const keep = (p, h) => {
    // Clear of the knot: a puff never covers it.
    const d = p.map((v, j) => v - ctx.knot[j]);
    const l = Math.hypot(...d) || 1;
    const min = 1.2 * ctx.knotR + h;
    return l < min ? p.map((v, j) => ctx.knot[j] + (d[j] / l) * min) : p;
  };
  const part = (p, o) => {
    if (o <= 0) return p;
    const d = p.map((v, j) => v - ctx.knot[j]);
    const along = d[0] * SF[0] + d[1] * SF[1] + d[2] * SF[2];
    const flat = d.map((v, j) => v - along * SF[j]);
    const l = Math.hypot(...flat) || 1;
    return p.map((v, j) => v + (flat[j] / l) * 2.2 * o * Math.exp(-l / 3));
  };

  function ambientAt(pf, t) {
    const a = wrapA(pf.a0 - windX(t) * pf.drift);
    const env = Math.sin((PI * (a + BOX.a)) / (2 * BOX.a)) ** 0.6;
    const b = pf.b0 + 0.35 * mix(1, 0.4, calm(t)) * wobble(t, pf.seed);
    const c = pf.c + 0.3 * sway(t, pf.seed + 9);
    let h = pf.size * env * (1 - 0.35 * calm(t));
    const o = open(t);
    h *= 1 - 0.45 * o;
    const p = keep(part(at(a, b, c), o), h);
    return { p, h, th: pf.angle + pf.spin * turnX(t), a };
  }
  // A puff round him at t: orbiting slowly, and on his breath out thrown outward in a ring.
  function nearAt(pf, t) {
    const H = ctx.near(t);
    const a = pf.phase + pf.orbit * t + 0.25 * wobble(t, pf.seed + 40);
    const o = open(t);
    const breath = 1 - 0.4 * win(22.6, 23.2, t, 0.35) + 0.35 * win(23.3, 23.95, t, 0.35);
    const R = pf.ring * breath * (1 + 0.15 * sway(t, pf.seed + 3)) * (1 + 2.8 * o ** 1.4);
    const p = [0, 1, 2].map((j) => H[j] + R * (Math.cos(a) * SR[j] + pf.tilt * Math.sin(a) * SU[j]) + pf.sf * SF[j]);
    const h = pf.size * (1 - smooth(0.35, 1, o));
    return { p: keep(p, h), h, th: pf.angle + pf.spin * t };
  }
  const state = (pf, t) => (pf.kind === 'near' ? nearAt(pf, t) : ambientAt(pf, t));

  const count = puffs.length * 4;
  const uv = [];
  const col = [];
  const idx = [];
  puffs.forEach((pf, i) => {
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let j = 0; j < 4; j += 1) col.push(...pf.colour, pf.alpha);
    const o = i * 4;
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  const C = [0, 0, 0];
  // Keys every 0.3 s (9 frames) round the loop; the last blends back into the first at 60 s.
  const keyT = Array.from({ length: LOOP / 0.3 }, (_, i) => (i * 9) / 30);
  const states = keyT.map((t) => puffs.map((pf) => state(pf, t)));
  // A puff that wraps from the left edge back to the right between two keys is
  // collapsed to a point at both, so it never streaks across the frame.
  const n = keyT.length;
  states.forEach((row, i) => {
    const next = states[(i + 1) % n];
    puffs.forEach((pf, j) => {
      if (pf.kind === 'ambient' && next[j].a > row[j].a) {
        row[j] = { ...row[j], h: 0 };
        next[j] = { ...next[j], h: 0 };
      }
    });
  });
  const keys = states.map((row) => {
    const out = new Float32Array(count * 3);
    row.forEach((st, i) => writeQuad(out, i, st, C));
    return out;
  });
  const times = [...keyT, LOOP];
  const values = times.flatMap((_, i) => keyT.map((__, j) => (j === i % keyT.length ? 1 : 0)));
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(keys[0], 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new Float32BufferAttribute(col, 4));
  geo.setIndex(idx);
  worldMorph(geo, keys, values.slice(0, keyT.length));
  return { geo, times, values, puffs: puffs.length };
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
// A gust (events.mjs GUSTS): a demand's colour gathers out where it comes
// from, swirling, then shoots at him in a streak, bursts on him in a spray,
// and blows on past. Gusts are packed into a few meshes (world.mjs slotMeshes).

const GUST_BODY = 28;
const GUST_SPRAY = 8;
const G0 = -1.5;
const G1 = 1.4;

function gustEvent(ctx, g) {
  const C = [0, 0, 0];
  const r = rng(9100 + g.i);
  const rc = rng(9900 + DEMANDS.findIndex((d) => d.id === g.demand)); // colours shared by the demand's gusts
  const k = ctx.k; // his size against the 72 cm the gusts were drawn for
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
    const shade = mix(0.78, 1, rc());
    const alpha = spray ? 0.95 : mix(0.8, 0.95, rc());
    puffs.push({
      spray,
      off: o.map((v) => (v / ol) * rad),
      size: (spray ? mix(0.12, 0.26, r()) : mix(0.32, 0.8, r())) * (0.85 + 0.3 * g.power) * k ** 0.7,
      spin: (r() - 0.5) * 2,
      angle: (r() - 0.5) * 1.2,
      swirl: (r() - 0.5) * 3,
      speed: mix(2.2, 4.2, r()) * k ** 0.7,
      colour: spray ? hex.map((v) => mix(v, 1, 0.45)) : hex.map((v) => v * shade),
      alpha
    });
  }
  const reach = 3.6 * k ** 0.5;
  const at = (pf, t) => {
    const x = t - g.t;
    if (x < G0 || x > G1) return null;
    if (pf.spray) {
      if (x < 0) return { p: H, h: 0 };
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
  // Every 0.1 s (3 frames) on the 30 Hz grid. The first and last keys draw
  // nothing (every quad a point), since the mesh holds them between gusts.
  const times = gridKeys(Math.ceil((g.t + G0) * 30) / 30, Math.floor((g.t + G1) * 30) / 30, 3);
  const frame = (t, j) => {
    const out = new Float32Array(puffs.length * 12);
    const edge = j === 0 || j === times.length - 1;
    puffs.forEach((pf, i) => {
      const st = at(pf, t) ?? { p: H, h: 0 };
      writeQuad(out, i, edge ? { ...st, h: 0 } : st, C);
    });
    return out;
  };
  return { group: g.demand, times, keys: times.map(frame), puffs };
}

/** The gusts packed into a few meshes (one colour set per demand), in view metres round the origin. */
export function gusts(ctx) {
  const events = GUSTS.map((g) => gustEvent(ctx, g));
  const template = (demand) => {
    const e = events.find((x) => x.group === demand);
    const n = e.puffs.length;
    const uv = [];
    const col = [];
    const idx = [];
    e.puffs.forEach((pf, i) => {
      uv.push(0, 0, 1, 0, 1, 1, 0, 1);
      for (let k = 0; k < 4; k += 1) col.push(...pf.colour, pf.alpha);
      idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    });
    const base = new Float32Array(n * 12);
    for (let i = 0; i < n * 4; i += 1) for (let m = 0; m < 3; m += 1) base[i * 3 + m] = 1e-4 * i * SF[m] + (m === 0 ? 1e-3 * (i % 4) : 0);
    return { base, colour: [col, 4], uv, index: idx };
  };
  return slotMeshes(events, template);
}

function rotateAbout(v, axis, a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const d = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
  const x = [axis[1] * v[2] - axis[2] * v[1], axis[2] * v[0] - axis[0] * v[2], axis[0] * v[1] - axis[1] * v[0]];
  return [0, 1, 2].map((k) => v[k] * c + x[k] * s + axis[k] * d * (1 - c));
}

