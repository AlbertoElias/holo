import { BufferGeometry, Float32BufferAttribute } from 'three';

import { lin } from '../introspection/common.mjs';
import { WAVES } from './events.mjs';
import { fbm, noise3 } from './flow.mjs';
import { SCREEN } from './zoom.mjs';
import { rng } from './layers.mjs';
import { mix, smooth } from './timeline.mjs';
import { runs, worldMorph } from './world.mjs';

// The liquid, fourth pass (BEATS.md, "Decided for the fourth pass"): a sea of
// paint. He stands chest-deep in a dark marbled sea that heaves in long
// swells, and the waves (events.mjs WAVES) roll in from every side, each one
// colour, building as they come, curling and breaking on him two and three
// at once, throwing up spray in their colour and sinking back into the sea.
// When he lets go the sea falls still and rises over him and the camera.
// Everything is authored in world space (world.mjs).

/** The sea: its rest level sits `drop` below C (above it when negative), R across. */
export const POOL = { drop: 0.1, R: 8, rings: 34, segs: 88 };

/** The sea's surface height (world y offset from its rest) at offset (x, z) from its centre. */
function swell(x, z, t, calmness) {
  let h =
    0.075 * Math.sin(0.55 * x + 0.35 * z - 1.1 * t) +
    0.06 * Math.sin(-0.3 * x + 0.62 * z - 0.95 * t + 1.7) +
    0.045 * Math.sin(0.48 * x - 0.5 * z - 1.3 * t + 4.1) +
    0.02 * Math.sin(1.7 * x + 1.1 * z - 2.4 * t) +
    0.015 * Math.sin(-1.3 * x + 1.9 * z - 2.9 * t + 2);
  h *= 1 - 0.85 * calmness;
  // Each wave that breaks on him sends a ring out across the sea.
  const rho = Math.hypot(x, z);
  for (const e of WAVES) {
    const s = t - e.t;
    if (s <= 0 || s > 3) continue;
    const d = rho - 1.8 * s;
    h += 0.1 * e.power * Math.exp(-s / 1.1) * Math.sin(4 * d) * Math.exp(-((d / 0.5) ** 2));
  }
  return h;
}

/**
 * The sea and its waves, as world-space meshes.
 * ctx: { C, him(t) → his pelvis (world, no knocks), from (the switch into the
 * liquid), to (37), back: [t0, t1] (the way out), sLiq(t), rise(t) (metres
 * the sea climbs as he sinks), calm(t) (0..1) }.
 */
export function liquid(ctx) {
  const { C } = ctx;
  const P0 = [C[0], C[1] - POOL.drop, C[2]];
  const seaAt = (x, z, t) => P0[1] + ctx.rise(t) + swell(x - P0[0], z - P0[2], t, ctx.calm(t));
  const warp = fbm(noise3(97), 3);
  const marble = fbm(noise3(311), 4);

  // --- The sea: a polar grid round him, finer near him. ---
  const { rings, segs, R } = POOL;
  const polar = [[0, 0]];
  for (let i = 1; i <= rings; i += 1) {
    const r = R * (i / rings) ** 1.5;
    for (let j = 0; j < segs; j += 1) polar.push([r, (j / segs) * 2 * Math.PI]);
  }
  // The still sea is a Rothko: soft-edged fields of colour stacked away from the camera, a dark
  // oxblood at our feet, a glowing red where he stands, a band of plum, a luminous vermilion and
  // saffron toward the horizon. Their edges are feathered and their faces scumbled, never marbled.
  const TWs = (() => {
    const n = Math.hypot(SCREEN.toward[0], SCREEN.toward[2]);
    return [SCREEN.toward[0] / n, SCREEN.toward[2] / n];
  })();
  const FIELDS = [
    [-9, '#2c070c'],
    [-2.4, '#420c12'],
    [-0.9, '#6e1918'],
    [0.9, '#7c2018'],
    [2.0, '#4a1430'],
    [3.6, '#3d1230'],
    [4.8, '#a83a1a'],
    [6.4, '#cf7a2a'],
    [9, '#cf7a2a']
  ].map(([u, hex]) => [u, lin(hex)]);
  const field = (u) => {
    let i = 0;
    while (i < FIELDS.length - 2 && u > FIELDS[i + 1][0]) i += 1;
    const [u0, c0] = FIELDS[i];
    const [u1, c1] = FIELDS[i + 1];
    const k = smooth(0, 1, (u - u0) / (u1 - u0));
    return c0.map((v, m) => mix(v, c1[m], k));
  };
  const sky = lin('#2a080b');
  const col = [];
  for (const [r, a] of polar) {
    const x = r * Math.cos(a);
    const z = r * Math.sin(a);
    const u = -(x * TWs[0] + z * TWs[1]) + 0.55 * warp(x * 0.35 + 3, z * 0.35, 0.4); // feathered edges
    const scumble = 0.78 + 0.4 * (marble(x * 0.45, z * 0.9, 1.3) * 0.5 + 0.5); // brushed, along the fields
    const c = field(u).map((v) => v * scumble);
    const fade = smooth(0.8 * R, R, r); // the far edge sinks into the sky
    col.push(...c.map((v, m) => mix(v, sky[m], fade)));
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
  // The fields barely drift (they are the painting).
  const drift = (r) => 0.012 / (1 + 0.3 * r);
  const poolAt = (t, back) => {
    const out = new Float32Array(polar.length * 3);
    // Coming in, the sea grows out of C with the zoom; going out, it shrinks back into it.
    const grow = back ? ctx.sLiq(t) / 7.5 : mix(0.04, 1, smooth(ctx.from, ctx.from + 0.9, t) ** 0.7);
    polar.forEach(([r, a], i) => {
      const ang = a + drift(r) * (t - 25) * (back ? 0.4 : 1);
      const x = r * Math.cos(ang);
      const z = r * Math.sin(ang);
      const y = back ? P0[1] + 0.25 * swell(x, z, t, 1) : seaAt(P0[0] + x, P0[2] + z, t);
      const p = [P0[0] + x, y, P0[2] + z];
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
  // Base: a small copy of the rest sea round C (inside the skies' ball).
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

  // --- The waves: one coloured swell per wave, right across the sea, rolling in, curling where it meets him. ---
  const NA = 36; // along the crest
  const NS = 10; // across: back foot, up the back, crest, down the face, front foot
  const DROPS = 18;
  const UC = 0.68; // where the crest sits across the profile
  const SPEED = 2.3;
  const LEAD = 2.8; // seconds from rising far out to breaking on him
  const LH = 5.5; // half the crest's length: each wave spans the sea
  const faces = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]];
  const octa = (p, s) => [[s, 0, 0], [-s, 0, 0], [0, s, 0], [0, -s, 0], [0, 0, s], [0, 0, -s]].flatMap((o) => o.map((v, k) => p[k] + v));
  // The profile: a long back rising to a sharp crest, a short steep face.
  const TW = (() => {
    const n = Math.hypot(SCREEN.toward[0], SCREEN.toward[2]);
    return [SCREEN.toward[0] / n, 0, SCREEN.toward[2] / n];
  })();
  const CREAM = lin('#f1dcb4');
  const SEA_RED = lin('#6e1918');
  const bump = (u) => (u < UC ? 0.5 - 0.5 * Math.cos(Math.PI * (u / UC)) : Math.cos((Math.PI / 2) * ((u - UC) / (1 - UC))) ** 0.6);

  const waves = WAVES.map((e, wi) => {
    const r = rng(900 + wi);
    const H = ctx.him(e.t);
    const travel = e.d.map((v) => -v); // the way it rolls: toward him and on past
    const side = [-travel[2], 0, travel[0]];
    const start = Math.max(e.t - LEAD, ctx.from + 0.9);
    const end = e.t + 1.0;
    const Amax = 0.28 + 0.32 * e.power;
    const sheet = (t) => {
      const x = t - e.t;
      const centre = [H[0] - travel[0] * SPEED * x, 0, H[2] - travel[2] * SPEED * x];
      const born = smooth(start, start + 0.7, t);
      // A low swell far out that steepens as it nears him, breaks, and sinks back into the sea.
      const A = x < 0 ? Amax * (0.3 + 0.7 * smooth(-1.4, -0.2, x) ** 1.3) * born : Amax * Math.exp(-x / 0.3);
      const curl = x < 0 ? smooth(-0.7, 0.04, x) : 1;
      const sink = 0.3 * smooth(0, 0.8, x);
      const widen = 1 + 1.2 * smooth(0, 1.2, x);
      const out = [];
      for (let i = 0; i < NA; i += 1) {
        const a = (i / (NA - 1)) * 2 - 1;
        const w = a * LH; // metres along the crest from where it meets him
        const near = Math.exp(-((w / 1.8) ** 2));
        const env = (0.3 + 0.7 * near) * (1 - a * a) ** 0.5;
        const lead = 0.3 * Math.exp(-((w / 2) ** 2)); // the crest bows forward where it meets him
        const c = curl * Math.exp(-((w / 1.5) ** 2)); // and only there it curls
        for (let j = 0; j < NS; j += 1) {
          const u = j / (NS - 1);
          let s = mix(-1.4, 0.45, u) * widen;
          const f = bump(u) * env;
          let h = A * f - 0.06;
          // Curling: the top of the wave pitches forward over its face and the lip droops.
          s += c * A * (0.6 * f ** 2.2 + (u > UC ? 0.35 * f : 0));
          h -= c * A * 0.35 * f ** 4;
          let px = centre[0] + travel[0] * (s + lead) + side[0] * w - P0[0];
          let pz = centre[2] + travel[2] * (s + lead) + side[2] * w - P0[2];
          // Out at the sea's edge it is held inside the sea and lies down into it.
          const rho = Math.hypot(px, pz);
          const edge = 0.9 * POOL.R;
          if (rho > edge) {
            const k = (edge + 0.1 * (rho - edge)) / rho;
            px *= k;
            pz *= k;
          }
          h = mix(h, -0.06, smooth(0.75 * POOL.R, POOL.R, rho));
          // Between him and the camera the sea stays low: the waves rise behind and beside him,
          // break on him, and sink as they roll on toward us, so he is never hidden.
          const depth = (P0[0] + px - H[0]) * TW[0] + (P0[2] + pz - H[2]) * TW[2];
          h = mix(h, -0.3, smooth(-0.1, 0.9, depth));
          out.push(P0[0] + px, seaAt(P0[0] + px, P0[2] + pz, t) + h - sink, P0[2] + pz);
        }
      }
      return out;
    };
    // Spray where it breaks on him, in its own colour, falling back into the sea.
    const crest = [H[0], P0[1] + 0.75 * Amax, H[2]];
    const drops = Array.from({ length: DROPS }, () => {
      const lat = (r() - 0.5) * 2;
      const v = [0, 1, 2].map((k) => travel[k] * mix(0.6, 2.2, r()) + side[k] * lat * 1.6 + (k === 1 ? mix(1.4, 3.4, r()) : 0));
      return { v, size: mix(0.03, 0.075, r()) * (0.8 + 0.6 * e.power), delay: 0.08 * r() };
    });
    const spray = (t) =>
      drops.flatMap((d) => {
        const x = t - e.t - d.delay;
        if (x <= 0) return octa(crest, 0);
        const p = [0, 1, 2].map((k) => crest[k] + d.v[k] * x - (k === 1 ? 4.5 * x * x : 0));
        return octa(p, p[1] < P0[1] ? 0 : d.size * smooth(0, 0.06, x));
      });
    const track = runs([{ start, step: 0.1, count: Math.ceil((end - start) / 0.1) + 1 }]);
    const keys = track.times.map((t) => Float32Array.from([...sheet(t), ...spray(t)]));
    // Colour: the sea's own dark at the foot and the ends, so it rises out of the sea; the full colour
    // up the face; a pale lip.
    const c = lin(e.colour);
    const colours = [];
    for (let i = 0; i < NA; i += 1) {
      const a = (i / (NA - 1)) * 2 - 1;
      const end = (1 - a * a) ** 0.35;
      for (let j = 0; j < NS; j += 1) {
        const u = j / (NS - 1);
        const f = bump(u);
        const lip = smooth(0.8, 1, f) * (u >= UC ? 0.45 : 0.2) * (0.3 + 0.7 * Math.exp(-(((a * LH) / 1.8) ** 2))); // palest where it breaks
        // Out of the sea's own red at the foot and the ends into the wave's colour up its face.
        const k = 0.88 * Math.min(1, (f * end) ** 0.8 * 1.1);
        colours.push(...c.map((v, m) => Math.min(1, mix(mix(SEA_RED[m], v * 0.95, k), CREAM[m], lip * 0.35))));
      }
    }
    const index = [];
    for (let i = 0; i < NA - 1; i += 1) {
      for (let j = 0; j < NS - 1; j += 1) {
        const a = i * NS + j;
        index.push(a, a + NS, a + 1, a + 1, a + NS, a + NS + 1);
      }
    }
    const sheetN = NA * NS;
    drops.forEach((_, di) => {
      const o = sheetN + di * 6;
      for (const f of faces) index.push(o + f[0], o + f[1], o + f[2]);
      for (let v = 0; v < 6; v += 1) colours.push(...c.map((u) => (v === 2 ? mix(u, 1, 0.35) : u * 0.95)));
    });
    // Base: a hair-thin cluster at C (each vertex apart); the keys carry the rest.
    const base = new Float32Array(keys[0].length);
    for (let i = 0; i < base.length / 3; i += 1) {
      base[i * 3] = C[0] + 1e-5 * i;
      base[i * 3 + 1] = C[1];
      base[i * 3 + 2] = C[2];
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(base, 3));
    geo.setAttribute('color', new Float32BufferAttribute(colours, 3));
    geo.setIndex(index);
    // Key 0 is the base itself (nothing shows); outside its run the wave is gone.
    const weights = (t) => (t >= start && t < end ? [0, ...track.weights(t)] : [1, ...track.times.map(() => 0)]);
    worldMorph(geo, [base, ...keys], weights(0));
    return { geo, weights, wave: e };
  });

  return { pool: { geo: pool, weights: poolWeights }, waves, P0 };
}
