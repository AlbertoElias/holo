import { BufferGeometry, Float32BufferAttribute } from 'three';

import { lin } from '../introspection/common.mjs';
import { AMBIENT_WAVES, WAVES } from './events.mjs';
import { fbm, noise3 } from './flow.mjs';
import { SCREEN } from './zoom.mjs';
import { rng } from './layers.mjs';
import { FPS, LOOP, PI, mix, smooth, win } from './timeline.mjs';
import { gridKeys, linearRows, slotMeshes, worldMorph } from './world.mjs';

// The liquid (BEATS.md, "The liquid"): a sea of paint that heaves all loop.
// He stands chest-deep in it while the waves (events.mjs WAVES) roll in from
// every side, each one colour, curling and breaking on him and throwing up
// spray in their colour; the rest of the loop the sea's own smaller waves
// (AMBIENT_WAVES) roll in from the far side. When he lets go the sea falls
// still. Authored in view metres round the liquid layer's origin and scaled
// into liquid units by the scene.

/** The sea: its rest level sits `drop` below the origin, R across. */
export const POOL = { drop: 0.1, R: 8, rings: 34, segs: 88 };

// The swell: five travelling waves, each a whole number of periods a loop.
const SWELL = [
  { a: 0.075, kx: 0.55, kz: 0.35, n: 11, ph: 0 },
  { a: 0.06, kx: -0.3, kz: 0.62, n: 9, ph: 1.7 },
  { a: 0.045, kx: 0.48, kz: -0.5, n: 12, ph: 4.1 },
  { a: 0.02, kx: 1.7, kz: 1.1, n: 23, ph: 0 },
  { a: 0.015, kx: -1.3, kz: 1.9, n: 28, ph: 2 }
].map((c) => ({ ...c, w: (2 * PI * c.n) / LOOP }));

/** The sea falls still when he lets go, and again on the way out. */
export const calm = (t) => Math.max(win(36.1, 38.5, t, 0.6), win(55.0, 58.5, t, 0.8));
const heave = (t) => 1 - 0.85 * calm(t);

/** The sea's surface height (y offset from its rest) at (x, z) from its centre. */
export function swell(x, z, t) {
  let h = 0;
  for (const c of SWELL) h += c.a * Math.sin(c.kx * x + c.kz * z - c.w * t + c.ph);
  return h * heave(t);
}

/**
 * The sea and its waves, in view metres round the origin.
 * ctx: him(t) → where a wave breaks at t (his pelvis while he is in the sea,
 * else where he would stand).
 * Returns { pool: { geo, times, values }, waves: [{ group, geo, times, values }], P0 }.
 */
export function liquid(ctx) {
  const P0 = [0, -POOL.drop, 0];
  const seaAt = (x, z, t) => P0[1] + swell(x - P0[0], z - P0[2], t);
  const warp = fbm(noise3(97), 3);
  const marble = fbm(noise3(311), 4);

  // --- The sea: a polar grid round the origin, finer near him. ---
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
  // The swell as harmonics: per component, its offsets a·sin θ and a·cos θ (θ = k·x + φ), so the
  // surface is Σ (a sin θ · cos ωt − a cos θ · sin ωt). Weights stay non-negative: each sign is
  // its own target.
  const base = new Float32Array(polar.length * 3);
  polar.forEach(([r, a], i) => {
    base[i * 3] = P0[0] + r * Math.cos(a);
    base[i * 3 + 1] = P0[1];
    base[i * 3 + 2] = P0[2] + r * Math.sin(a);
  });
  const keys = [];
  for (const c of SWELL) {
    for (const f of [Math.sin, Math.cos]) {
      for (const sign of [1, -1]) {
        const k = Float32Array.from(base);
        polar.forEach(([r, a], i) => {
          k[i * 3 + 1] += sign * c.a * f(c.kx * r * Math.cos(a) + c.kz * r * Math.sin(a) + c.ph);
        });
        keys.push(k);
      }
    }
  }
  const poolRow = (t) => {
    const m = heave(t);
    return SWELL.flatMap((c) => {
      const co = Math.cos(c.w * t);
      const si = Math.sin(c.w * t);
      return [Math.max(0, co) * m, Math.max(0, -co) * m, Math.max(0, -si) * m, Math.max(0, si) * m];
    });
  };
  const grid = Array.from({ length: LOOP * FPS + 1 }, (_, i) => i / FPS);
  const poolTrack = linearRows(grid, grid.map(poolRow));
  const pool = new BufferGeometry();
  pool.setAttribute('position', new Float32BufferAttribute(base, 3));
  pool.setAttribute('color', new Float32BufferAttribute(col, 3));
  pool.setIndex(idx);
  worldMorph(pool, keys, poolRow(0));

  // --- The waves: one coloured swell per wave, right across the sea, rolling in, curling where it meets him. ---
  const NA = 28; // along the crest
  const NS = 8; // across: back foot, up the back, crest, down the face, front foot
  const DROPS = 18;
  const UC = 0.68; // where the crest sits across the profile
  const SPEED = 2.3;
  const LEAD = 2.8; // seconds from rising far out to breaking on him
  const TAIL = 1.0; // and from breaking to gone
  const LH = 5.5; // half the crest's length: each wave spans the sea
  const faces = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]];
  const octa = (p, s) => [[s, 0, 0], [-s, 0, 0], [0, s, 0], [0, -s, 0], [0, 0, s], [0, 0, -s]].flatMap((o) => o.map((v, k) => p[k] + v));
  const TW = (() => {
    const n = Math.hypot(SCREEN.toward[0], SCREEN.toward[2]);
    return [SCREEN.toward[0] / n, 0, SCREEN.toward[2] / n];
  })();
  const CREAM = lin('#f1dcb4');
  const SEA_RED = lin('#6e1918');
  // The profile: a long back rising to a sharp crest, a short steep face.
  const bump = (u) => (u < UC ? 0.5 - 0.5 * Math.cos(Math.PI * (u / UC)) : Math.cos((Math.PI / 2) * ((u - UC) / (1 - UC))) ** 0.6);
  const points = NA * NS + DROPS * 6;

  const events = [...WAVES, ...AMBIENT_WAVES].map((e) => {
    const r = rng(900 + e.i);
    const H = ctx.him(e.t);
    const travel = e.d.map((v) => -v); // the way it rolls: toward him and on past
    const side = [-travel[2], 0, travel[0]];
    const times = gridKeys(Math.ceil((e.t - LEAD) * FPS) / FPS, Math.floor((e.t + TAIL) * FPS) / FPS, 5);
    const start = times[0];
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
    // The first and last keys draw nothing (every vertex at one point under the sea), since the
    // mesh holds them between its waves.
    const hide = new Float32Array(points * 3);
    for (let i = 0; i < points; i += 1) hide.set([H[0], P0[1] - 0.4, H[2]], i * 3);
    const keys = times.map((t, j) => (j === 0 || j === times.length - 1 ? hide : Float32Array.from([...sheet(t), ...spray(t)])));
    return { group: e.hue, times, keys, colour: e.colour };
  });

  // Colour: the sea's own red at the foot and the ends, so it rises out of the sea; the full colour
  // up the face; a pale lip. One set per hue (its waves share a mesh).
  const template = (hue) => {
    const c = lin(events.find((x) => x.group === hue).colour);
    const colours = [];
    for (let i = 0; i < NA; i += 1) {
      const a = (i / (NA - 1)) * 2 - 1;
      const end = (1 - a * a) ** 0.35;
      for (let j = 0; j < NS; j += 1) {
        const u = j / (NS - 1);
        const f = bump(u);
        const lip = smooth(0.8, 1, f) * (u >= UC ? 0.45 : 0.2) * (0.3 + 0.7 * Math.exp(-(((a * LH) / 1.8) ** 2))); // palest where it breaks
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
    for (let di = 0; di < DROPS; di += 1) {
      const o = sheetN + di * 6;
      for (const f of faces) index.push(o + f[0], o + f[1], o + f[2]);
      for (let v = 0; v < 6; v += 1) colours.push(...c.map((u) => (v === 2 ? mix(u, 1, 0.35) : u * 0.95)));
    }
    // Base: a hair-thin cluster under the sea (each vertex apart); the keys carry the rest.
    const base = new Float32Array(points * 3);
    for (let i = 0; i < points; i += 1) base.set([1e-5 * i, P0[1] - 0.4, 0], i * 3);
    return { base, colour: [colours, 3], index };
  };

  return { pool: { geo: pool, times: poolTrack.times, values: poolTrack.values }, waves: slotMeshes(events, template), P0 };
}
