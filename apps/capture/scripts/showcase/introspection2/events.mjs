import { SCREEN } from './zoom.mjs';

// The way down II: one list of blows for picture, acting and sound (see
// BEATS.md). The blows aimed at the traveller keep the beat sheet's times on
// a 120 bpm grid; the sea's ambient waves roll the rest of the loop.

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

// The gas: each demand gathers into a gust that blasts him, closer and closer together, and from
// 16 s in pairs from two sides, so two to four are always gathering or landing at once.
export const GUSTS = [
  [12.5, 'chime', 'left'],
  [13.25, 'buzz', 'right'],
  [13.75, 'tick', 'top'],
  [14.25, 'kettle', 'camera'],
  [14.75, 'clatter', 'low'],
  [15.25, 'chime', 'upRight'],
  [15.5, 'buzz', 'behind'],
  [16.0, 'tick', 'left'],
  [16.0, 'kettle', 'right'],
  [16.5, 'clatter', 'top'],
  [17.0, 'chime', 'camera'],
  [17.0, 'buzz', 'low'],
  [17.5, 'tick', 'upLeft'],
  [17.75, 'kettle', 'upRight'],
  [18.0, 'clatter', 'left'],
  [18.25, 'chime', 'right'],
  [18.5, 'buzz', 'top'],
  [18.5, 'tick', 'camera'],
  [18.75, 'kettle', 'behind'],
  [19.0, 'clatter', 'upLeft'],
  [19.25, 'chime', 'low'],
  [19.5, 'buzz', 'right'],
  [19.5, 'kettle', 'left'],
  [19.75, 'tick', 'upRight'],
  [20.0, 'clatter', 'camera'],
  [20.0, 'chime', 'top'],
  [20.25, 'buzz', 'left'],
  [20.5, 'kettle', 'right'],
  [20.5, 'tick', 'low'],
  [20.75, 'clatter', 'upLeft'],
  [21.0, 'chime', 'upRight'],
  [21.0, 'buzz', 'left']
].map(([t, demand, from], i, all) => ({ i, t, demand, from, d: screenDir(...FROM[from]), power: 0.75 + 0.25 * (i / (all.length - 1)) }));

// The liquid: a sea of paint. Each wave is one colour, rolling in from its own side and breaking on
// him; two or three are always building, and at the peaks (30, 33) they clash on him at once.
// Rothko's colours (the Seagram and late-fifties fields): reds, oxblood, vermilion, saffron, plum and
// a deep blue-black, kept in one warm family so the sea reads as one painting; the names stay the
// pigments the music knows.
export const HUES = {
  cadmium: '#b5241d',
  orange: '#d4561f',
  ultramarine: '#1f2a50',
  viridian: '#5a1424',
  magenta: '#97203c',
  ochre: '#c4602a',
  white: '#e8c9a0',
  lemon: '#d98a2b',
  cobalt: '#4a1838',
  violet: '#4e1d48'
}
/** A level direction toward where a wave comes from: az 0 behind the camera, 90 screen right, 180 far side.
 * None come from the camera's side, where they would hide him: they roll toward the camera, faces lit. */
const seaDir = (az) => {
  const a = (az * Math.PI) / 180;
  const v = screenDir(Math.sin(a), 0, Math.cos(a));
  const n = Math.hypot(v[0], v[2]);
  return [v[0] / n, 0, v[2] / n];
};
export const WAVES = [
  [27.5, 250, 'cadmium', 0.6],
  [28.0, 110, 'ultramarine', 0.65],
  [28.5, 190, 'viridian', 0.7],
  [29.0, 230, 'magenta', 0.75],
  [29.25, 140, 'lemon', 0.7],
  [29.75, 265, 'cobalt', 0.8],
  [30.0, 95, 'orange', 1],
  [30.0, 265, 'violet', 1],
  [30.5, 175, 'ochre', 0.8],
  [31.0, 120, 'cadmium', 0.85],
  [31.25, 215, 'viridian', 0.85],
  [31.5, 150, 'magenta', 0.85],
  [32.0, 245, 'ultramarine', 0.9],
  [32.25, 100, 'lemon', 0.9],
  [32.5, 195, 'orange', 0.9],
  [33.0, 255, 'cobalt', 1],
  [33.0, 100, 'magenta', 1],
  [33.0, 180, 'viridian', 1],
  [33.5, 140, 'violet', 0.8],
  [34.0, 230, 'cadmium', 0.6],
  [34.5, 160, 'ultramarine', 0.45]
].map(([t, az, hue, power], i) => ({ i, t, az, hue, colour: HUES[hue], power, d: seaDir(az) }));

/**
 * The sea's own waves, rolling the whole loop where none is aimed at him:
 * smaller, from the far side, every ~1.6 s (none spans the loop point).
 */
export const AMBIENT_WAVES = (() => {
  const out = [];
  const hues = Object.keys(HUES);
  let i = 0;
  const add = (t) => {
    const az = 100 + ((i * 67) % 160);
    const hue = hues[(i * 3) % hues.length];
    out.push({ i: 100 + i, t, az, hue, colour: HUES[hue], power: 0.35 + 0.2 * (((i * 7) % 5) / 4), d: seaDir(az), ambient: true });
    i += 1;
  };
  for (let t = 4.0; t <= 24.01; t += 1.6) add(Math.round(t * 4) / 4);
  for (let t = 40.0; t <= 54.01; t += 1.6) add(Math.round(t * 4) / 4);
  return out;
})();

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
