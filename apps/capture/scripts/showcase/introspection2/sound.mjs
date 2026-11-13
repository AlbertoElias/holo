import { SAMPLE_RATE, add, lowpass, noise, normalize, pluck, track } from '../lib/audio.mjs';
import { sob } from './acting.mjs';
import { AMBIENT_WAVES, BEAT, GUSTS, WAVES } from './events.mjs';
import { HEARTS, LOOP, smooth } from './timeline.mjs';

// The way down II's sound (BEATS.md, "Sound"): background, sparse and
// succinct; it accompanies the picture and never leads it. Chip voices
// (pulse, triangle, stepped noise) on note grids. Seven 60 s mono loops, each
// a positional emitter in its layer: the stage's waltz and the man's heart
// (layer 0), the gas's notes and the traveller's racing heart, the sea's
// line, and the dark's sobs and lullaby with the child's heart. Every track
// runs the whole loop and is seamless at the loop point: notes that run past
// the end wrap to the start, and every steady tone and tempo turns a whole
// number of times a loop.

function toWav(samples, OUT_RATE = 16000) {
  const cut = 0.42 * OUT_RATE;
  const src = lowpass(lowpass(Float32Array.from(samples), cut), cut);
  const count = Math.round((src.length * OUT_RATE) / SAMPLE_RATE);
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i += 1) {
    const x = (i * SAMPLE_RATE) / OUT_RATE;
    const k = Math.floor(x);
    const f = x - k;
    const v = src[k % src.length] * (1 - f) + src[(k + 1) % src.length] * f;
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(OUT_RATE, 24);
  header.writeUInt32LE(OUT_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const TAU = 2 * Math.PI;
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const frac = (x) => x - Math.floor(x);

// --- The chip's voices ----------------------------------------------------------
const pulse = (f, duty = 0.5) => (t) => (frac(t * f) < duty ? 0.6 : -0.6);
const tri = (f) => (t) => 4 * Math.abs(frac(t * f) - 0.5) - 1;
/** Noise stepped at `rate` Hz (a chip's noise channel: higher rate, brighter). */
const stepNoise = (seed, rate) => {
  const n = noise(seed);
  let held = 0;
  let last = -1;
  return (t) => {
    const k = Math.floor(t * rate);
    if (k !== last) {
      last = k;
      held = n();
    }
    return held;
  };
};
/** A note's gate: instant on, a short decay to `sustain`, a clean release at `dur`. */
const gateEnv = (dur, sustain = 0.6, decay = 0.08) => (u) => (u >= dur ? 0 : (sustain + (1 - sustain) * Math.exp(-u / decay)) * Math.min(1, (dur - u) / 0.006) * Math.min(1, u / 0.002));
const note = (out, at, dur, wave, gain = 1, env = gateEnv(dur)) => add(out, at, dur + 0.01, wave, (u) => gain * env(u));
/** A pitch glide on any voice (phase-integrated), wrapping at the seam. */
function glide(out, at, dur, f0, f1, amp, env, shape = (p) => (frac(p) < 0.5 ? 0.6 : -0.6)) {
  const start = Math.round(at * SAMPLE_RATE);
  const count = Math.round(dur * SAMPLE_RATE);
  let ph = 0;
  for (let i = 0; i < count; i += 1) {
    const t = i / SAMPLE_RATE;
    ph += (f0 * (f1 / f0) ** (t / dur)) / SAMPLE_RATE;
    out[(start + i) % out.length] += amp * shape(ph) * env(t);
  }
}
/** A drum hit on the noise channel. */
const hit = (out, at, gain, rate, decay, seed) => add(out, at, decay * 6, stepNoise(seed, rate), (u) => gain * Math.exp(-u / decay));

// The tune: four bars of 3/4 in A minor as [beat, midi, length in beats]. Bar 4
// holds Eb over the E bass, a tritone off the tonic: the uneasy note. The
// lullaby resolves it up to E.
export const MOTIF = [
  [0, 76, 1], [1, 81, 1], [2, 79, 1],
  [3, 77, 1.5], [4.5, 76, 0.5], [5, 74, 1],
  [6, 72, 1], [7, 74, 1], [8, 76, 1],
  [9, 75, 3]
];
const MOTIF_RESOLVED = [...MOTIF.slice(0, 9), [9, 75, 1.5], [10.5, 76, 1.5]];
const BARS = [
  { bass: 45, chord: [60, 64, 69] }, // Am
  { bass: 38, chord: [62, 65, 69] }, // Dm
  { bass: 36, chord: [60, 64, 67] }, // C
  { bass: 40, chord: [59, 62, 68] } // E7
];

// ---------------------------------------------------------------------------
// stage (layer 0): the waltz, quiet, round the man all loop. 132 beats a
// minute, so the loop is 44 bars exactly. The tune comes twice, at 0 and 30 s
// (bars 1 and 23); between, only the bass on the downbeats and a chord blip
// every other bar.

const WALTZ_BEAT = 60 / 132;
function stage() {
  const out = track(LOOP);
  for (const bar0 of [0, 22]) {
    for (const [b, n, len] of MOTIF) {
      const t0 = (bar0 * 3 + b) * WALTZ_BEAT;
      note(out, t0, len * WALTZ_BEAT * 0.9, tri(hz(n)), 0.3, gateEnv(len * WALTZ_BEAT * 0.9, 0.45, 0.2));
    }
  }
  for (let bar = 0; bar < 44; bar += 1) {
    const { bass, chord } = BARS[bar % 4];
    const t0 = bar * 3 * WALTZ_BEAT;
    note(out, t0, WALTZ_BEAT * 0.9, tri(hz(bass)), 0.42, gateEnv(WALTZ_BEAT * 0.9, 0.4, 0.15));
    if (bar % 2 === 0) for (const n of chord) note(out, t0 + WALTZ_BEAT, 0.07, pulse(hz(n), 0.25), 0.06, gateEnv(0.07, 0.3, 0.03));
  }
  return toWav(normalize(out, 0.28));
}

// ---------------------------------------------------------------------------
// gas: a soft high note now and then all loop (an A-minor arpeggio with the
// Eb in it, one note every two beats), one note for every gust as it hits,
// and his long breath out (22.6–23.9) as a falling triangle.

const ARP = [57, 60, 64, 71, 63, 69, 64, 60];
function gas() {
  const out = track(LOOP);
  const busy = (t) => smooth(9, 12, t) * (1 - smooth(23.5, 25, t));
  for (let k = 0; k < LOOP / (2 * BEAT); k += 1) {
    const t = k * 2 * BEAT;
    note(out, t, 0.3, pulse(hz(ARP[k % ARP.length] + 12), 0.125), 0.05 + 0.04 * busy(t), gateEnv(0.3, 0.3, 0.08));
  }
  for (const e of GUSTS) {
    note(out, e.t, 0.18, pulse(hz(ARP[e.i % ARP.length] + 24), 0.25), 0.07 * e.power, gateEnv(0.18, 0.2, 0.05));
    hit(out, e.t, 0.05 * e.power, 6000, 0.03, 700 + e.i);
  }
  glide(out, 23.25, 1.1, 330, 110, 0.12, (u) => 1 - smooth(0.4, 1.1, u), (p) => 4 * Math.abs(frac(p) - 0.5) - 1);
  return toWav(normalize(out, 0.3));
}

// ---------------------------------------------------------------------------
// liquid: the sea's line, a triangle bass every second all loop, a soft
// swash for every wave (the ambient ones quieter), a two-note stab for the
// hardest blows, and a sub drop at the two peaks (30, 33).

const STABS = {
  cadmium: [57, 60, 64], orange: [58, 62, 65], lemon: [60, 64, 67], white: [64, 68, 71], viridian: [62, 65, 69],
  cobalt: [55, 59, 62], ultramarine: [53, 57, 60], violet: [56, 59, 63], magenta: [61, 64, 68], ochre: [59, 63, 66]
};
const LINE = [33, 33, 45, 33, 29, 29, 41, 29, 26, 26, 38, 26, 28, 28, 40, 39];
export const PEAKS = [30.0, 33.0];

function liquid() {
  const out = track(LOOP);
  const storm = (t) => smooth(26.6, 27.4, t) * (1 - smooth(35.2, 36.2, t));
  for (let k = 0; k < LOOP / (2 * BEAT); k += 1) {
    const t = k * 2 * BEAT;
    note(out, t, 0.85, tri(hz(LINE[k % LINE.length])), 0.22 + 0.1 * storm(t), gateEnv(0.85, 0.5, 0.2));
  }
  for (const e of [...WAVES, ...AMBIENT_WAVES]) {
    const g = e.ambient ? 0.3 : 1;
    add(out, e.t - 0.25, 0.9, stepNoise(3000 + e.i, 3000), (u) => 0.05 * g * e.power * smooth(0, 0.25, u) * Math.exp(-Math.max(0, u - 0.25) / 0.2));
    if (!e.ambient && e.power >= 0.85) for (const n of STABS[e.hue].slice(0, 2)) note(out, e.t, 0.22, pulse(hz(n + 12), 0.5), 0.05 * e.power, gateEnv(0.22, 0.35, 0.08));
  }
  for (const c of PEAKS) glide(out, c, 1.3, 70, 28, 0.25, (u) => Math.exp(-u / 0.5), (p) => 4 * Math.abs(frac(p) - 0.5) - 1);
  return toWav(normalize(out, 0.32));
}

// ---------------------------------------------------------------------------
// dark: a faint high note as he falls in (37–46), the child's sobs as falling
// blips on the picture's own sobs (acting.mjs), and the lullaby on a chip
// music box over the open fifth (45–55).

function dark() {
  const out = track(LOOP);
  note(out, 37.2, 8.6, pulse(hz(91), 0.5), 0.02, (u) => smooth(0, 2, u) * (1 - smooth(6, 8.6, u)));
  // A blip on every sob the child makes: each local peak of sob(t) over 0.2.
  const dt = 0.005;
  for (let t = dt; t < LOOP - dt; t += dt) {
    const v = sob(t);
    if (v > 0.2 && v >= sob(t - dt) && v > sob(t + dt)) glide(out, t, 0.16, 300 + 120 * v, 190, 0.12 * v, (u) => Math.exp(-u / 0.06), (p) => (frac(p) < 0.25 ? 0.6 : -0.6));
  }
  const beat = 2 * WALTZ_BEAT;
  const t0 = 45.4;
  const tb = (b) => t0 + beat * (b + 0.07 * Math.sin((TAU * b) / 5));
  const warm = (t) => smooth(45, 50, t) * (1 - smooth(53.5, 55.5, t));
  const box = (at, midi, g) => add(out, at, 1.6, (u) => 0.4 * pulse(hz(midi + 12), 0.5)(u) + 0.6 * tri(hz(midi))(u), (u) => g * pluck(0.002, 0.35)(u));
  MOTIF_RESOLVED.forEach(([b, n]) => box(tb(b), n, 0.22 * warm(tb(b))));
  for (let bar = 0; bar < 4; bar += 1) {
    [0, 7, 12].forEach((iv, k) => {
      const at = tb(bar * 3 + k);
      note(out, at, beat * 0.8, tri(hz(BARS[bar].bass + iv)), 0.14 * warm(at));
    });
  }
  return toWav(normalize(out, 0.3));
}

// ---------------------------------------------------------------------------
// The hearts: a soft triangle lub-dub, its tempo from timeline.mjs HEARTS,
// phase-integrated and scaled to a whole number of beats a loop.

function heart(bpm, { pitch = 70, gain = 1, decay = 0.05 } = {}) {
  const out = track(LOOP);
  const dt = 1 / SAMPLE_RATE;
  let total = 0;
  for (let i = 0; i < out.length; i += 1) total += (bpm(i * dt) / 60) * dt;
  const scale = Math.round(total) / total;
  const kick = (f) => (u) => tri(f * (0.6 + 0.4 * Math.exp(-u * 30)))(u);
  let phase = 0;
  let next = 0;
  for (let i = 0; i < out.length; i += 1) {
    const t = i * dt;
    if (phase >= next) {
      add(out, t, 0.25, kick(pitch), (u) => 0.8 * gain * pluck(0.002, decay)(u));
      const gap = Math.min(0.17, (60 / bpm(t)) * 0.32);
      add(out, t + gap, 0.2, kick(pitch * 1.15), (u) => 0.5 * gain * pluck(0.002, decay * 0.8)(u));
      next += 1;
    }
    phase += (bpm(t) / 60) * dt * scale;
  }
  return toWav(normalize(out, 0.5), 11025);
}

/** The seven loops, by emitter. */
export function layerSounds() {
  return {
    stage: stage(),
    'heart-man': heart(HEARTS.man, { pitch: 62, decay: 0.06 }),
    gas: gas(),
    'heart-gas': heart(HEARTS.gas, { pitch: 78, decay: 0.035 }),
    liquid: liquid(),
    dark: dark(),
    'heart-child': heart(HEARTS.child, { pitch: 96, decay: 0.035 })
  };
}
