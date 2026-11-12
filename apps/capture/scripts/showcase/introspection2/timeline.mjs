// The way down II: one clock for picture and sound (see BEATS.md).
//
// S is the world's zoom: 1 while the man fills the dome, growing as we go
// in. Each layer has a unit U: it is drawn at s = S / U times its built
// size, so a layer built to fit the dome is seen from inside at s ≈ 6–12.

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

// Layer units: S at which the layer is drawn at its built size. Each layer
// waits inside the one before (its knot, its hole) small enough to hide there:
// gas fits the torso (×16.7), liquid the gas knot (×40), and the dark is a
// seam about 2 cm wide in the liquid's hole at t = 37 (s = 0.02).
export const U = { man: 1, gas: 100 / 6, liquid: 4000 / 6, dark: 300000 };
// The hug frame already starts 5× (she grew through the door); this is the zoom on top.
// The feed samples motion at 52.5 s, so the pair stays inside the sky then (×8.5,
// about 1 m from C) and swells to the climax in the unsampled stretch after it.
export const HUG_ZOOM = 16;
const S_KEYS = [
  [0, 1], [7, 1], [12, 100], [24, 200], [27, 6 * U.liquid], [37, 9 * U.liquid],
  // In the dark the world grows round her: a lone light at 40, the child readable by 44.6, the hug filling the frame by 55.
  [40, 6 * U.dark], [42, 6 * U.dark], [44.6, 6 * U.dark * 2], [47.5, 6 * U.dark * 5], [52.5, 6 * U.dark * 8.5], [55, 6 * U.dark * HUG_ZOOM], [55.5, 6 * U.dark * HUG_ZOOM],
  // The way back pauses on each calmed layer: the liquid, then the gas.
  [56.3, 7 * U.liquid], [57.2, 8 * U.gas], [58.5, 1], [60, 1]
];
const logS = K(S_KEYS.map(([t, s]) => [t, Math.log(s)]));
/** The world's zoom at time t. */
export const S = (t) => Math.exp(logS(wrap(t)));
export const S_MAX = 6 * U.dark * HUG_ZOOM;
/** A layer's own zoom (1 = its built size). */
export const sOf = (layer, t) => S(t) / U[layer];

/** The heartbeat's tempo (bpm) and level (0..1) at time t: one voice through the piece. */
export const HEART = {
  bpm: K([[0, 66], [7, 66], [12, 100], [24, 140], [37, 150], [40, 150], [45, 48], [55, 60], [58.5, 66], [60, 66]]),
  level: K([[0, 0.5], [7, 0.5], [11, 0.9], [24, 0.9], [33, 1], [35.5, 0.25], [37, 0], [45.5, 0], [48, 0.55], [55, 0.6], [58.5, 0.5], [60, 0.5]])
};
