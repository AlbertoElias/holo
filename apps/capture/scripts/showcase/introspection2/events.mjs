import { SCREEN } from './zoom.mjs';

// The way down II, third pass: one list of blows for picture, acting and
// sound (see BEATS.md, "Decided for the third pass"). The music runs on a
// 120 bpm grid, so every gust and hit lands on a quarter of a beat.

export const BPM = 120;
export const BEAT = 60 / BPM;

/** A world direction from screen terms: a right, b up, c toward the camera. */
export const screenDir = (a, b, c) => {
  const v = [0, 1, 2].map((k) => a * SCREEN.right[k] + b * SCREEN.up[k] + c * SCREEN.toward[k]);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

// Where a blow comes from, in screen terms (unit after screenDir).
const FROM = {
  left: [-1, 0.15, 0.1],
  right: [1, 0.1, 0.05],
  top: [0.2, 1, 0.15],
  low: [-0.25, -0.8, 0.3],
  camera: [0.35, 0.25, 1],
  behind: [-0.3, 0.2, -1],
  upLeft: [-0.8, 0.7, 0.2],
  upRight: [0.8, 0.7, 0.1]
};

// The gas: each demand gathers into a gust that blasts him, closer and closer together.
export const GUSTS = [
  [12.5, 'chime', 'left'],
  [13.75, 'buzz', 'right'],
  [14.75, 'tick', 'top'],
  [15.75, 'kettle', 'camera'],
  [16.5, 'clatter', 'low'],
  [17.25, 'chime', 'right'],
  [18.0, 'buzz', 'behind'],
  [18.5, 'tick', 'left'],
  [19.0, 'kettle', 'right'],
  [19.5, 'clatter', 'top'],
  [20.0, 'chime', 'camera'],
  [20.5, 'buzz', 'low'],
  [20.75, 'tick', 'upLeft'],
  [21.0, 'kettle', 'upRight']
].map(([t, demand, from], i) => ({ i, t, demand, from, d: screenDir(...FROM[from]), power: 0.75 + 0.25 * (i / 13) }));

// The liquid: paint thrown at him from every side, ten colours, on every eighth, pairs and fours at the peaks (30, 33).
export const HUES = {
  cadmium: '#e3261b',
  orange: '#ff7a1a',
  ultramarine: '#2338c9',
  viridian: '#0f8a6a',
  magenta: '#d81b8c',
  ochre: '#d9a514',
  white: '#f4efe4',
  lemon: '#f2e14a',
  cobalt: '#1f6fe0',
  violet: '#7a2bc8'
};
export const HITS = [
  [27.5, 'left', 'cadmium', 0.6],
  [28.5, 'right', 'ultramarine', 0.65],
  [29.25, 'upLeft', 'lemon', 0.7],
  [30.0, 'left', 'magenta', 1],
  [30.0, 'right', 'viridian', 1],
  [30.0, 'top', 'orange', 1],
  [30.75, 'behind', 'white', 0.7],
  [31.25, 'upRight', 'cobalt', 0.8],
  [31.25, 'camera', 'ochre', 0.8],
  [31.75, 'left', 'violet', 0.75],
  [32.25, 'right', 'cadmium', 0.85],
  [32.25, 'upLeft', 'viridian', 0.85],
  [32.5, 'top', 'lemon', 0.8],
  [33.0, 'left', 'ultramarine', 1],
  [33.0, 'right', 'orange', 1],
  [33.0, 'top', 'magenta', 1],
  [33.0, 'camera', 'white', 1],
  [33.5, 'upRight', 'violet', 0.8],
  [33.5, 'behind', 'ochre', 0.8],
  [34.0, 'left', 'cobalt', 0.6],
  [34.5, 'upLeft', 'cadmium', 0.45],
  // the off-beats between them, so the paint never lets up
  [28.0, 'camera', 'viridian', 0.55],
  [28.75, 'top', 'magenta', 0.55],
  [29.5, 'right', 'cobalt', 0.6],
  [29.75, 'behind', 'orange', 0.6],
  [30.25, 'upLeft', 'ochre', 0.7],
  [30.5, 'right', 'violet', 0.7],
  [31.0, 'left', 'lemon', 0.7],
  [31.5, 'top', 'ultramarine', 0.75],
  [32.0, 'camera', 'magenta', 0.8],
  [32.75, 'upRight', 'white', 0.8],
  [33.25, 'left', 'viridian', 0.85],
  [33.75, 'right', 'cadmium', 0.7],
  [34.25, 'top', 'orange', 0.55]
]
  .sort((a, b) => a[0] - b[0])
  .map(([t, from, hue, power], i) => ({ i, t, from, hue, colour: HUES[hue], power, d: screenDir(...FROM[from]) }));

/** A blow's push: rises in ~0.12 s, dies away over ~1 s (x = time since the blow). */
export const knockCurve = (x) => (x <= 0 ? 0 : (1 - Math.exp(-x / 0.12)) * Math.exp(-x / 1.1));
/** The peak of knockCurve, to normalise it to 0..1. */
export const KNOCK_PEAK = (() => {
  let m = 0;
  for (let x = 0; x < 2; x += 0.001) m = Math.max(m, knockCurve(x));
  return m;
})();

/** Summed displacement (world, metres) from `events` at t: away from where each came from. */
export function knock(events, t, P) {
  const out = [0, 0, 0];
  for (const e of events) {
    const k = (P * e.power * knockCurve(t - e.t)) / KNOCK_PEAK;
    for (let j = 0; j < 3; j += 1) out[j] -= k * e.d[j];
  }
  return out;
}

/** How hard he is being knocked at t (0..~1), and the direction of the strongest blow. */
export function knocked(events, t) {
  let best = null;
  let sum = 0;
  for (const e of events) {
    const k = (e.power * knockCurve(t - e.t)) / KNOCK_PEAK;
    sum += k;
    if (!best || k > best.k) best = { k, d: e.d, e };
  }
  return { amount: Math.min(1, sum), best };
}
