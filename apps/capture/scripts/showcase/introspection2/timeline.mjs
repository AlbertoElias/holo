import { noise3 } from './flow.mjs';

// The way down II: one clock for picture and sound (see BEATS.md).

export const LOOP = 60;
export const FPS = 30;
export const PI = Math.PI;
export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const mix = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const wrap = (t) => ((t % LOOP) + LOOP) % LOOP;
/** Up over [a − r, a], down over [b, b + r]. */
export const win = (a, b, t, r) => smooth(a - r, a, t) * (1 - smooth(b, b + r, t));

/** Piecewise smootherstep through [t, value] keys, flat at each key and outside. */
export function K(keys) {
  return (t) => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 0; i < keys.length - 1; i += 1) {
      const [a, va] = keys[i];
      const [b, vb] = keys[i + 1];
      if (t <= b) {
        const x = clamp((t - a) / (b - a || 1));
        return va + (vb - va) * x * x * x * (x * (x * 6 - 15) + 10);
      }
    }
    return keys[keys.length - 1][1];
  };
}

export const BEATS = {
  man: [0, 7],
  enter: [7, 12],
  gas: [12, 24],
  portal: [24, 27],
  liquid: [27, 37],
  hole: [37, 40],
  dark: [40, 45],
  hug: [45, 55],
  out: [55, 58.5],
  home: [58.5, 60]
};

/**
 * The doors: where the traveller passes from one layer's rig to the next
 * (STEP scale keys, so every one is on the 30 Hz grid).
 */
export const DOORS = { in: { gas: 9.0, liquid: 25.2, dark: 37.0 }, out: { liquid: 56.0, gas: 56.8, man: 57.6 } };

/** A key time on the 30 Hz grid. */
export const onGrid = (t) => Math.abs(t * FPS - Math.round(t * FPS)) < 1e-6;

/**
 * Noise that loops with the clip: a seeded 3D noise read round a circle, so
 * n(t) at 0 and at LOOP agree. `rate` is roughly its speed (noise units a second).
 */
export function loopNoise(seed, rate = 0.35) {
  const n = noise3(seed);
  const R = (rate * LOOP) / (2 * PI);
  return (t, z = 0) => n(R * Math.cos((2 * PI * t) / LOOP), R * Math.sin((2 * PI * t) / LOOP), z);
}

/** An angular speed near `w` (rad/s) that turns a whole number of times a loop (at least once). */
export const loopRate = (w) => {
  const n = Math.round((w * LOOP) / (2 * PI));
  return ((n === 0 ? Math.sign(w) || 1 : n) * 2 * PI) / LOOP;
};

/**
 * The three hearts, each a tempo (bpm) over the loop: the man's, steady at
 * his chest; the traveller's racing in the gas; the child's in the dark,
 * quick while he sobs and slowing in the hug.
 */
export const HEARTS = {
  man: () => 66,
  gas: K([[0, 112], [9, 112], [12, 128], [20.5, 150], [23.2, 150], [24.5, 104], [57, 104], [60, 112]]),
  child: K([[0, 96], [4, 96], [6, 116], [46, 116], [50, 84], [55, 72], [58, 84], [60, 96]])
};
