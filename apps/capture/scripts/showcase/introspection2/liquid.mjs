import { BufferGeometry, Float32BufferAttribute } from 'three';

import { lin } from '../introspection/common.mjs';
import { fbm, keyTimes, keyTrack, noise3 } from './flow.mjs';
import { K, PI, mix, smooth } from './timeline.mjs';
import { FOLLOW, SCREEN } from './zoom.mjs';

// The liquid, "The mould" (BEATS.md beats 5-6). Everything here is in the
// liquid's home units round C (the layer is drawn at s = S/U.liquid, 6 to 9
// while he is in it). A sea of thick paint rolls in heavy Gerstner waves,
// calmer round him so the feed always sees him. Twice a wave rears up behind
// him and its crest holds for half a second as a relief bust of the man (hat,
// head, shoulders, lapels) in the paint's colours, then folds over onto him
// and presses him into the same outline at his own size. He breaks out of the
// first; in the second he stops fighting and goes limp, the paint relaxes,
// and the sea parts round C over a black well: the trap door down.

const addv = (a, b, k = 1) => a.map((v, i) => v + k * b[i]);
const UP = [0, 1, 0];
const FH = (() => {
  const h = [FOLLOW[0], 0, FOLLOW[2]];
  const l = Math.hypot(...h);
  return h.map((v) => v / l);
})(); // toward the camera, level
const RH = SCREEN.right; // level already

/** The sea's rest level above C (home units). C itself is under the paint, where the dark waits. */
export const SEA_TOP = 0.05;
const SEA_R = 0.68;

// Heavy, slow waves: wavelength, amplitude, direction (radians in the xz plane), period, steepness.
const WAVES = [
  { l: 0.42, a: 0.024, dir: 0.5, T: 3.4, q: 0.75 },
  { l: 0.27, a: 0.014, dir: 2.2, T: 2.6, q: 0.7 },
  { l: 0.16, a: 0.007, dir: 1.1, T: 1.9, q: 0.6 },
  { l: 0.1, a: 0.0035, dir: -0.6, T: 1.4, q: 0.5 }
];
// The swell builds to the peak at 33 s and relaxes once he goes limp.
const ENV = K([[0, 0.15], [25.3, 0.35], [27, 0.6], [30, 0.85], [33, 1], [34.6, 0.95], [36, 0.35], [37, 0.2], [60, 0.2]]);
// Round him the swell is calmer, so crests in front of him never hide him.
const near = (r) => 0.3 + 0.7 * smooth(0.07, 0.3, r);

// The moulds: when each wave closes over him (T), how long it holds him, and how it lets go.
export const MOULDS = [
  { T: 30.0, hold: 1.1, rise: 2.0, out: 0.6 }, // he breaks out, gasping
  { T: 33.0, hold: 1.6, rise: 2.0, out: 1.3, limp: true } // he goes limp and it slumps away
];
/** 1 while a mould holds him (for the acting and the sound). */
export const pressed = (t) => Math.max(...MOULDS.map((m) => smooth(m.T - 0.12, m.T, t) * (1 - smooth(m.T + m.hold, m.T + m.hold + 0.3, t))));
// Each close sends a ring of swell out from him.
const RINGS = MOULDS.map((m) => ({ T: m.T, a: m.limp ? 0.016 : 0.012 }));

/** Sea surface displacement at rest point (x, z) relative to C, at t: [dx, dy, dz]. */
function seaAt(x, z, t) {
  const r = Math.hypot(x, z);
  const e = ENV(t) * near(r);
  let dx = 0;
  let dy = 0;
  let dz = 0;
  for (const w of WAVES) {
    const k = (2 * PI) / w.l;
    const d = [Math.cos(w.dir), Math.sin(w.dir)];
    const ph = k * (d[0] * x + d[1] * z) - ((2 * PI) / w.T) * t;
    const a = w.a * e;
    dy += a * Math.cos(ph);
    // Gerstner: points slide toward the crests, sharpening them.
    dx -= w.q * a * d[0] * Math.sin(ph);
    dz -= w.q * a * d[1] * Math.sin(ph);
  }
  for (const g of RINGS) {
    const age = t - g.T;
    if (age < 0 || age > 4) continue;
    const front = 0.03 + 0.13 * age;
    const fall = Math.exp(-age * 0.8);
    dy += g.a * fall * Math.exp(-(((r - front) / 0.05) ** 2)) * Math.cos(((r - front) / 0.05) * 2);
  }
  return [dx, dy, dz];
}
/** The sea's height over C (home units, relative to C.y) at t, where he floats. */
export const seaHeight = (t) => SEA_TOP + seaAt(0, 0, t)[1];

// The part: the sea opens round C into a trough over a black well (36.4-37), and closes on the way back (58.3-59.4).
export const PART = K([[0, 0], [36.1, 0], [36.85, 1], [58.3, 1], [59.4, 0], [60, 0]]);

const PAINT = ['#6e1b17', '#8c2420', '#d4601c', '#4a2140', '#7a1d1a', '#b8441c'].map(lin);
function paintAt(nx, nz, x, z) {
  // Streaks of poured paint: bands along a warped direction.
  const w = nx(x * 5, 0.3, z * 5) * 1.6;
  const u = (x * Math.cos(0.7) + z * Math.sin(0.7)) * 9 + w;
  const b = u + 0.6 * nz(x * 3, 1.7, z * 3) + 60;
  const i = Math.floor(b);
  const f = smooth(0.35, 0.65, b - i); // soft edges between the poured bands
  const c0 = PAINT[i % PAINT.length];
  const c1 = PAINT[(i + 1) % PAINT.length];
  const c = c0.map((v, k) => mix(v, c1[k], f));
  const g = 0.86 + 0.14 * nz(x * 22, 2.4, z * 22);
  return c.map((v) => v * g);
}

/**
 * The sea: a polar grid round C. Its four inner rings sit collapsed at the
 * centre, going down: when the sea parts they open into the black well.
 * Returns { geo, shapes, weights } (the keyed swell, then the part).
 */
export function sea(C) {
  const WELL = [-0.16, -0.09, -0.04, -0.012];
  const segs = 72;
  const radii = [];
  for (let i = 0; i < 30; i += 1) radii.push(0.006 + (SEA_R - 0.006) * (i / 29) ** 1.55);
  const rings = WELL.length + radii.length;
  const pos = [];
  const col = [];
  const nx = fbm(noise3(41), 3);
  const nz = fbm(noise3(42), 3);
  const rest = [];
  for (let i = 0; i < rings; i += 1) {
    const well = i < WELL.length;
    const r = well ? 0.004 : radii[i - WELL.length];
    for (let j = 0; j < segs; j += 1) {
      const a = ((j + 0.5 * (i % 2)) / segs) * 2 * PI;
      const x = r * Math.cos(a);
      const z = r * Math.sin(a);
      const y = SEA_TOP + (well ? WELL[i] : 0);
      rest.push({ x, z, y, a, well, i });
      pos.push(C[0] + x, C[1] + y, C[2] + z);
      if (well) col.push(...lin(i === WELL.length - 1 ? '#1a0405' : '#030102'));
      else {
        // Darker toward the rim, so the sea falls away into the sky.
        const fade = 1 - 0.45 * smooth(0.35, SEA_R, r);
        col.push(...paintAt(nx, nz, x, z).map((v) => v * fade));
      }
    }
  }
  const idx = [];
  for (let i = 0; i < rings - 1; i += 1) {
    for (let j = 0; j < segs; j += 1) {
      const a = i * segs + j;
      const b = i * segs + ((j + 1) % segs);
      const c = a + segs;
      const d = b + segs;
      idx.push(a, d, c, a, b, d);
    }
  }
  // Point the faces up.
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  let ups = 0;
  for (let i = 0; i < g.attributes.normal.count; i += 1) ups += g.attributes.normal.getY(i);
  if (ups < 0) {
    for (let k = 0; k < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]];
    g.setIndex(idx);
  }
  const normalsOf = (positions) => {
    const h = new BufferGeometry();
    h.setAttribute('position', new Float32BufferAttribute(positions, 3));
    h.setIndex(g.index);
    h.computeVertexNormals();
    return h.attributes.normal.array;
  };

  // The swell, keyed every 0.2 s while he is in it (25.3-37.2); before and after it holds.
  const step = 0.2;
  const times = keyTimes(25.3, 37.2, step);
  const keyAt = (t) => {
    const out = new Float32Array(pos.length);
    rest.forEach((p, v) => {
      const d = seaAt(p.x, p.z, t);
      out.set([C[0] + p.x + d[0], C[1] + p.y + d[1], C[2] + p.z + d[2]], v * 3);
    });
    return out;
  };
  const base = Float32Array.from(pos);
  const keys = times.map(keyAt);
  const track = keyTrack(base, times[0], step, keys);
  // The paint is lit: each key carries its own normals.
  const n0 = normalsOf(base);
  g.setAttribute('normal', new Float32BufferAttribute(Array.from(n0), 3));
  const normals = keys.map((k) => normalsOf(k).map((v, i) => v - n0[i]));
  // The part: the inner rings open into a well 0.11 across, the sea round it sags into a trough.
  const part = new Float32Array(pos.length);
  rest.forEach((p, v) => {
    const r = Math.hypot(p.x, p.z);
    const u = p.well ? 1 : Math.max(0, 1 - (r - 0.006) / 0.26);
    const push = p.well ? 0.11 : 0.11 * u * u;
    const dip = p.well ? -0.025 : -0.04 * u;
    part.set([Math.cos(p.a) * push, dip, Math.sin(p.a) * push], v * 3);
  });
  const weights = (t) => [...track.weights(t), PART(t)];
  return { geo: g, shapes: [...track.shapes, part], weights, normals: [...normals, new Float32Array(pos.length)] };
}

// ---------------------------------------------------------------------------
// The mould: a relief bust of the man as a sheet of paint. In rig metres:
// its rows run from his chest (0.84) to his hat's crown (1.95), each row's
// width following his silhouette (so the brim, the neck and the shoulders are
// in the topology), and its depth is his relief toward the camera.

// Half-widths of his silhouette by height (rig metres).
const PROFILE = [
  [0.84, 0.27], [1.36, 0.27], [1.42, 0.25], [1.47, 0.18], [1.5, 0.08], [1.56, 0.07], [1.6, 0.092], [1.7, 0.1],
  [1.755, 0.098], [1.765, 0.18], [1.79, 0.18], [1.8, 0.112], [1.9, 0.104], [1.935, 0.075], [1.95, 0.03]
];
const halfWidth = (y) => {
  for (let i = 1; i < PROFILE.length; i += 1) {
    const [y0, w0] = PROFILE[i - 1];
    const [y1, w1] = PROFILE[i];
    if (y <= y1) return mix(w0, w1, Math.min(1, Math.max(0, (y - y0) / (y1 - y0))));
  }
  return PROFILE[PROFILE.length - 1][1];
};
const ROWS = (() => {
  const ys = new Set(PROFILE.map(([y]) => y));
  for (let y = 0.84; y < 1.95; y += 0.035) ys.add(Math.round(y * 1000) / 1000);
  return [...ys].sort((a, b) => a - b);
})();
const COLS = 25;
const ell = (x, y, cx, cy, rx, ry) => {
  const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
  return d < 1 ? Math.sqrt(1 - d) : 0;
};
/** His relief toward the camera at (x, y), rig metres. */
function relief(x, y) {
  let z = 0.07 * ell(x, y, 0, 1.15, 0.3, 0.42); // chest and shoulders
  z = Math.max(z, 0.05 * ell(x, y, 0.2, 1.38, 0.1, 0.08), 0.05 * ell(x, y, -0.2, 1.38, 0.1, 0.08));
  // Lapels: two ridges from the shoulders down to the button.
  for (const s of [1, -1]) {
    const t = (1.46 - y) / 0.38;
    if (t > 0 && t < 1) {
      const lx = s * mix(0.11, 0.0, t);
      z += 0.022 * Math.exp(-(((x - lx) / 0.025) ** 2));
    }
  }
  z = Math.max(z, 0.04 * ell(x, y, 0, 1.53, 0.075, 0.05)); // neck
  z = Math.max(z, 0.1 * ell(x, y, 0, 1.67, 0.1, 0.11)); // head
  const nose = ell(x, y, 0, 1.655, 0.022, 0.035);
  if (nose > 0) z = Math.max(z, 0.1 + 0.025 * nose); // nose
  if (y > 1.755 && y < 1.8) z = Math.max(z, 0.11 * ell(x, y, 0, 1.775, 0.18, 0.06)); // brim
  z = Math.max(z, 0.085 * ell(x, y, 0, 1.86, 0.112, 0.11)); // crown
  return z;
}

/** The sheet's vertices in rig metres for a form between a plain wave (f = 0) and his bust (f = 1). */
function sheetLocal(f, lip) {
  const out = [];
  for (const y of ROWS) {
    const v = (y - 0.84) / (1.95 - 0.84);
    const hw = mix(0.62, halfWidth(y), f);
    for (let c = 0; c < COLS; c += 1) {
      const u = (c / (COLS - 1)) * 2 - 1;
      const x = u * hw;
      // As a wave its top is a lip curling toward the camera.
      const zWave = 0.05 * (1 - u * u) + lip * 0.35 * v ** 2.2;
      const yWave = 0.84 + (y - 0.84) * (0.9 + 0.1 * Math.cos(u * PI * 0.5));
      out.push([x, mix(yWave, y, f), mix(zWave, relief(x, y), f)]);
    }
  }
  return out;
}

function sheetIndex() {
  const idx = [];
  for (let r = 0; r < ROWS.length - 1; r += 1) {
    for (let c = 0; c < COLS - 1; c += 1) {
      const a = r * COLS + c;
      idx.push(a, a + 1, a + COLS + 1, a, a + COLS + 1, a + COLS);
    }
  }
  return idx;
}

/**
 * One mould. `place(t)` gives his pelvis (a home point, C included) and his scale (home
 * per rig metre). Returns { geo, shapes, weights } keyed every 0.1 s round
 * its wave.
 */
export function mould(C, m, place, seed) {
  const n = noise3(seed);
  const HUGE = 0.42; // home per rig metre: the bust is about 3.6 times his height
  const hidden = -0.07; // under the surface
  const back = 0.26; // the crest rears this far behind him
  const local0 = sheetLocal(1, 0);
  // Colour: the paint's own, lighter where the relief faces the light, with streaks down it.
  const Lt = [0.25, 0.75, 0.6];
  const lt = Math.hypot(...Lt);
  const nx = fbm(noise3(seed + 7), 3);
  const col = [];
  ROWS.forEach((y, r) => {
    for (let c = 0; c < COLS; c += 1) {
      const [x, , z] = local0[r * COLS + c];
      const dzx = (relief(x + 0.004, y) - relief(x - 0.004, y)) / 0.008;
      const dzy = (relief(x, y + 0.004) - relief(x, y - 0.004)) / 0.008;
      const nrm = [-dzx, -dzy, 1];
      const nl = Math.hypot(...nrm);
      const lit = Math.max(0, (nrm[0] * Lt[0] + nrm[1] * Lt[1] + nrm[2] * Lt[2]) / (nl * lt));
      const streak = nx(x * 9, y * 2.2, 0.5);
      const hue = streak > 0.12 ? lin('#e07a2a') : streak < -0.15 ? lin('#8c2420') : lin('#c95a1e');
      const k = 0.42 + 0.68 * lit + 0.6 * z;
      col.push(...hue.map((v) => Math.min(1, v * k)));
    }
  });
  const toHome = (local, B, k, tilt, wrap = 0) => {
    // Tilt forward about the base line: up leans toward the camera.
    const U = UP.map((v, i) => Math.cos(tilt) * v + Math.sin(tilt) * FH[i]);
    const D = FH.map((v, i) => Math.cos(tilt) * v - Math.sin(tilt) * UP[i]);
    return local.map(([x, y, z]) => {
      const zz = z + wrap * x * x;
      return [0, 1, 2].map((i) => B[i] + k * (x * RH[i] + (y - 0.84) * U[i] + zz * D[i]));
    });
  };
  const shapeAt = (t) => {
    const { p, k } = place(Math.min(Math.max(t, 27), 36));
    const surf = C[1] + SEA_TOP;
    const at = (t - m.T);
    // Where the huge crest stands: behind him, its base under the surface.
    const Bh = [p[0] - back * FH[0], surf - 0.035, p[2] - back * FH[2]];
    // Where it presses him: its chest row at his chest, just behind his back.
    const Bp = addv(addv(p, UP, (0.84 - 0.93) * k * 1.1), FH, -0.05 * k);
    let local;
    let pts;
    const sway = 0.02 * n(t * 1.3, 0, 0);
    if (at < -m.rise) {
      pts = toHome(sheetLocal(0, 0).map(([x, y, z]) => [x * 1.2, 0.84 + (y - 0.84) * 0.05, z]), addv(Bh, UP, hidden), HUGE, 0);
    } else if (at < -1.0) {
      // Rearing: a wave swelling out of the sea, its lip curling, taking his form.
      const u = smooth(-m.rise, -1.0, at);
      const f = smooth(-m.rise + 0.5, -1.0, at);
      local = sheetLocal(f, 1 - f).map(([x, y, z]) => [x, 0.84 + (y - 0.84) * (0.08 + 0.92 * u), z]);
      pts = toHome(local, addv(Bh, UP, hidden * (1 - u)), HUGE, -0.25 * (1 - u) + sway);
    } else if (at < -0.45) {
      // The hold: the bust stands, sagging a little under its own weight.
      const u = smooth(-1.0, -0.45, at);
      local = sheetLocal(1, 0).map(([x, y, z]) => [x * (1 + 0.04 * u), 0.84 + (y - 0.84) * (1 - 0.05 * u), z]);
      pts = toHome(local, Bh, HUGE, sway + 0.08 * u);
    } else if (at < 0) {
      // The fold: it topples toward him, shrinking as it comes down.
      const u = smooth(-0.45, 0, at);
      local = sheetLocal(1, 0.4 * u).map(([x, y, z]) => [x * (1 + 0.1 * u), 0.84 + (y - 0.84) * (1 - 0.15 * u), z]);
      const B = Bh.map((v, i) => mix(v, Bp[i], u * u));
      pts = toHome(local, B, mix(HUGE, k * 1.1, u * u), 0.08 + 1.25 * Math.sin(u * PI), 0.9 * u);
    } else if (at < m.hold) {
      // Pressed: his outline round him, squeezing.
      const sq = 1 - 0.03 * Math.sin(at * 9) * smooth(0, 0.3, at);
      pts = toHome(sheetLocal(1, 0).map(([x, y, z]) => [x * sq, y, z]), Bp, k * 1.1, 0, 0.9);
    } else {
      // It lets go: slumps and sinks back into the sea (slowly if he went limp).
      const u = smooth(m.hold, m.hold + m.out, at);
      local = sheetLocal(1, 0).map(([x, y, z]) => {
        const v = (y - 0.84) / 1.11;
        return [x * (1 + 0.8 * u), 0.84 + (y - 0.84) * (1 - u) ** (m.limp ? 1.3 : 2), z * (1 - u) + 0.05 * u * v];
      });
      pts = toHome(local, addv(Bp, UP, -0.12 * k * u), k * 1.1, 0.3 * u, 0.9 * (1 - u));
    }
    return Float32Array.from(pts.flat());
  };
  const step = 0.1;
  const times = keyTimes(m.T - m.rise - 0.3, m.T + m.hold + m.out + 0.3, step);
  const keys = times.map(shapeAt);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(Array.from(keys[0]), 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setIndex(sheetIndex());
  const track = keyTrack(keys[0], times[0], step, keys);
  return { geo: g, shapes: track.shapes, weights: track.weights };
}
