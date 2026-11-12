import { SAMPLE_RATE, add, lowpass, noise, normalize, pluck, track } from '../lib/audio.mjs';
import { BEAT, GUSTS, HITS } from './events.mjs';
import { HEART, LOOP, smooth } from './timeline.mjs';

// The way down II, third pass: the music as a chip sequencer would play it
// (BEATS.md, "Sound"). Pulse and square leads, a triangle bass, stepped
// noise for the drums, everything on note grids, nothing natural. One 60 s
// mono loop per layer plus the heart, and one per demand: each demand's
// voice is its own short sequence, played from its gust as it gathers and
// hits (events.mjs), so the gas is heard where it comes from.

const OUT_RATE = 22050;
function toWav(samples) {
  const src = lowpass(lowpass(Float32Array.from(samples), 9500), 9500);
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
const gate = (out, a, b, gain = 0) => {
  for (let i = Math.round(a * SAMPLE_RATE); i < Math.round(b * SAMPLE_RATE); i += 1) out[i] *= gain;
};
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
// stage: the waltz on a thin pulse lead, triangle bass, square chord blips,
// sagging flat like a slowed cartridge from 7 to 12 s.

const WALTZ_BEAT = 60 / 132;
const bendAt = (t) => 2 * smooth(7, 12, t);
const tapeRate = (t) => 2 ** (-bendAt(t) / 12);
const waltzTimes = (() => {
  const times = [0];
  let t = 0;
  let b = 0;
  while (t < 13) {
    b += (0.001 * tapeRate(t)) / WALTZ_BEAT;
    t += 0.001;
    while (b >= times.length) times.push(t);
  }
  return times;
})();
const waltzAt = (beat) => {
  const i = Math.floor(beat);
  return waltzTimes[i] + (waltzTimes[i + 1] - waltzTimes[i]) * (beat - i);
};

function stage() {
  const out = track(LOOP);
  const thin = (t) => 1 - 0.75 * smooth(8.5, 12, t);
  for (const base of [0, 12]) {
    for (const [b, n, len] of MOTIF) {
      const t0 = waltzAt(base + b);
      if (t0 > 12.3) continue;
      const dur = waltzAt(base + b + len) - t0;
      const f = hz(n) * tapeRate(t0 + 0.1);
      note(out, t0, dur * 0.92, (u) => pulse(f * (1 + 0.006 * Math.sin(TAU * 6 * u) * Math.min(1, u / 0.25)), 0.125)(u), 0.36 * thin(t0));
    }
    BARS.forEach(({ bass, chord }, bar) => {
      const b0 = base + bar * 3;
      const t0 = waltzAt(b0);
      if (t0 > 12.3) return;
      note(out, t0, WALTZ_BEAT * 0.9, tri(hz(bass) * tapeRate(t0)), 0.5 * thin(t0));
      for (const k of [1, 2]) {
        const tk = waltzAt(b0 + k);
        if (tk > 12.3) continue;
        for (const n of chord) note(out, tk, 0.07, pulse(hz(n) * tapeRate(tk), 0.25), 0.12 * thin(tk), gateEnv(0.07, 0.3, 0.03));
      }
    });
  }
  // Pickup into the downbeat: A C D, then E at 0.
  [69, 72, 74].forEach((n, i) => note(out, LOOP - (3 - i) * WALTZ_BEAT, WALTZ_BEAT * 0.9, pulse(hz(n), 0.125), 0.34));
  // The tritone pedal, A1 on the triangle and Eb2 on a pulse, in with the pickup and out by 12.
  const pedal = (u) => {
    const T = (58.5 + u) % LOOP;
    return smooth(58.5, 60, T < 30 ? T + LOOP : T) * (T < 30 ? 1 - smooth(9.5, 12, T) : 1);
  };
  add(out, 58.5, 13.5, (u) => 0.32 * tri(hz(33))(u) + 0.07 * pulse(hz(39), 0.5)(u), pedal);
  gate(out, 12.6, 58.4, 0);
  return toWav(normalize(out, 0.4));
}

// ---------------------------------------------------------------------------
// gas: an arpeggio on the grid that tightens from eighths to sixteenths, a
// tritone bass, hats, and a crash and a falling square for every gust; then
// the calm, his long breath out as a falling triangle, and the opening.

const ARP = [57, 60, 64, 71, 63, 69, 64, 60]; // A minor with the Eb in it
function gas() {
  const out = track(LOOP);
  const level = (t) => smooth(10.5, 12, t) * (1 - smooth(21.2, 21.6, t));
  for (let k = 0; ; k += 1) {
    const t = 11 + k * (BEAT / 4);
    if (t > 21.6) break;
    const sixteenth = t > 16;
    if (!sixteenth && k % 2) continue;
    const g = level(t);
    if (g < 0.01) continue;
    note(out, t, BEAT / 4 - 0.02, pulse(hz(ARP[k % ARP.length] + 12), 0.25), 0.2 * g, gateEnv(BEAT / 4 - 0.02, 0.4, 0.04));
    if (k % 2 === 0) hit(out, t, (k % 4 ? 0.06 : 0.1) * g, 12000, 0.012, 300 + k);
    if (k % 4 === 0) note(out, t, BEAT * 0.9, tri(hz((k / 4) % 2 ? 39 : 33)), 0.5 * g);
  }
  // The gusts: a crash and a falling square, louder as they crowd in.
  for (const e of GUSTS) {
    hit(out, e.t, 0.5 * e.power, 6000, 0.09, 700 + e.i);
    glide(out, e.t, 0.3, 880, 110, 0.3 * e.power, (u) => Math.exp(-u / 0.12));
  }
  // The calm: his breath held (a rising triangle), then let out (a long fall).
  glide(out, 21.85, 0.45, 220, 330, 0.25, (u) => smooth(0, 0.3, u) * (1 - smooth(0.4, 0.45, u)), (p) => 4 * Math.abs(frac(p) - 0.5) - 1);
  glide(out, 22.35, 1.2, 330, 110, 0.35, (u) => (1 - smooth(0.4, 1.2, u)), (p) => 4 * Math.abs(frac(p) - 0.5) - 1);
  // The gas opening under him: an arpeggio climbing out of the grid.
  [57, 60, 64, 69, 72, 76, 81, 84].forEach((n, i) => note(out, 23.4 + i * (BEAT / 4), 0.11, pulse(hz(n), 0.5), 0.2, gateEnv(0.11, 0.5, 0.05)));
  // The way back: the gas passing, four soft notes (57.2 s).
  [69, 64, 60, 57].forEach((n, i) => note(out, 56.6 + i * BEAT * 0.6, 0.22, pulse(hz(n + 12), 0.125), 0.15));
  return toWav(normalize(out, 0.6));
}

// ---------------------------------------------------------------------------
// voices: each demand's own little sequence, faster and louder as its gust
// gathers, cut as it hits.

const VOICE = {
  chime: (out, t, g, k) => note(out, t, 0.12, pulse(hz(k % 2 ? 88 : 84), 0.5), 0.3 * g, gateEnv(0.12, 0.3, 0.05)),
  buzz: (out, t, g) => note(out, t, 0.07, pulse(hz(45), 0.125), 0.45 * g, gateEnv(0.07, 0.9, 0.2)),
  tick: (out, t, g, k) => {
    note(out, t, 0.04, pulse(hz(k % 2 ? 96 : 91), 0.125), 0.3 * g, gateEnv(0.04, 0.6, 0.01));
    hit(out, t, 0.25 * g, k % 2 ? 9000 : 15000, 0.008, 900 + k);
  },
  kettle: (out, t, g, k) => note(out, t, 0.05, pulse(hz(79 + (k % 12)), 0.25), 0.28 * g, gateEnv(0.05, 0.8, 0.1)),
  clatter: (out, t, g, k) => {
    note(out, t, 0.1, pulse(hz([74, 85, 79, 90, 72][k % 5]), 0.25), 0.3 * g, gateEnv(0.1, 0.7, 0.03));
    if (k % 2) hit(out, t, 0.2 * g, 4000, 0.02, 1100 + k);
  }
};
const GATHER = 1.4;

/** One 60 s track per demand: its gusts, each a run of its sequence. */
export function voices() {
  return Object.fromEntries(Object.keys(VOICE).map((id) => {
    const out = track(LOOP);
    let k = 0;
    for (const e of GUSTS.filter((g) => g.demand === id)) {
      // Eighths, then sixteenths for the last half second, on the grid that lands on the hit.
      for (let x = -GATHER; x <= 0.001; ) {
        const g = e.power * (0.35 + 0.65 * smooth(-GATHER, 0, x));
        VOICE[id](out, e.t + x, g, k);
        k += 1;
        x += x < -0.5 ? BEAT / 2 : BEAT / 4;
      }
    }
    return [id, toWav(normalize(out, 0.7))];
  }));
}

// ---------------------------------------------------------------------------
// liquid: a pulse bass running in eighths, a square stab for every rope of
// paint (its chord from its colour), a sub drop at the two peaks (30, 33),
// then the calm and a hard cut at 37 s.

const STABS = {
  cadmium: [57, 60, 64], orange: [58, 62, 65], lemon: [60, 64, 67], white: [64, 68, 71], viridian: [62, 65, 69],
  cobalt: [55, 59, 62], ultramarine: [53, 57, 60], violet: [56, 59, 63], magenta: [61, 64, 68], ochre: [59, 63, 66]
};
const LINE = [33, 33, 45, 33, 29, 29, 41, 29, 26, 26, 38, 26, 28, 28, 40, 39];
export const PEAKS = [30.0, 33.0];

function liquid() {
  const out = track(LOOP);
  const level = (t) => smooth(26.6, 27.4, t) * (1 - 0.6 * smooth(34.6, 36.2, t));
  for (let k = 0; ; k += 1) {
    const t = 27 + k * (BEAT / 2);
    if (t >= 37) break;
    const g = level(t);
    note(out, t, BEAT / 2 - 0.03, pulse(hz(LINE[k % LINE.length]), 0.25), 0.3 * g, gateEnv(BEAT / 2 - 0.03, 0.5, 0.06));
    if (k % 2 === 0) hit(out, t, 0.08 * g, 11000, 0.015, 2000 + k);
    if (k % 4 === 2) hit(out, t, 0.2 * g, 3500, 0.06, 2500 + k);
  }
  for (const e of HITS) {
    for (const n of STABS[e.hue]) note(out, e.t, 0.26, pulse(hz(n + 12), 0.5), 0.13 * e.power, gateEnv(0.26, 0.35, 0.08));
    hit(out, e.t, 0.35 * e.power, 7000, 0.07, 3000 + e.i);
  }
  for (const c of PEAKS) glide(out, c, 1.3, 70, 28, 0.9, (u) => Math.exp(-u / 0.5), (p) => 4 * Math.abs(frac(p) - 0.5) - 1);
  // The opening: the bass line falls away under him.
  glide(out, 35.6, 1.4, 220, 55, 0.25, (u) => 1 - smooth(1, 1.4, u));
  gate(out, 37, 54.6, 0);
  // The way back: the paint at rest, a slow triangle arpeggio.
  [45, 52, 57, 64, 57, 52].forEach((n, i) => note(out, 54.9 + i * BEAT, BEAT * 0.9, tri(hz(n)), 0.3, gateEnv(BEAT * 0.9, 0.4, 0.3)));
  return toWav(normalize(out, 0.85));
}

// ---------------------------------------------------------------------------
// dark: one high square note, a sob as falling pulse blips, then the lullaby
// on a chip music box over a fast-arpeggio open fifth.

function dark() {
  const out = track(LOOP);
  note(out, 37.2, 8.6, pulse(hz(91), 0.5), 0.03, (u) => smooth(0, 2, u) * (1 - smooth(6, 8.6, u)));
  // Sob: groups of short falling blips, slowing and fading.
  let seed = 5;
  const R = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const amp = (t) => smooth(41, 43.5, t) * (1 - smooth(47, 53, t));
  for (let t = 41; t < 53; ) {
    const spasms = 2 + Math.floor(R() * 2);
    for (let s = 0; s < spasms && t < 53; s += 1) {
      glide(out, t, 0.16, 300 + 40 * R(), 190, 0.22 * amp(t), (u) => Math.exp(-u / 0.06), (p) => (frac(p) < 0.25 ? 0.6 : -0.6));
      t += 0.17 + 0.06 * R();
    }
    t += (0.55 + 0.4 * R()) * (1 + 1.9 * smooth(47, 53, t));
  }
  // The lullaby: half tempo, rubato, the motif on a music box (square and triangle, struck), resolved.
  const beat = 2 * WALTZ_BEAT;
  const t0 = 45.4;
  const tb = (b) => t0 + beat * (b + 0.07 * Math.sin((TAU * b) / 5));
  const warm = (t) => smooth(45, 52.5, t) * (1 - smooth(55, 58.3, t));
  const box = (at, midi, g) => add(out, at, 1.6, (u) => 0.5 * pulse(hz(midi + 12), 0.5)(u) + 0.6 * tri(hz(midi))(u), (u) => g * pluck(0.002, 0.35)(u));
  MOTIF_RESOLVED.forEach(([b, n], j) => box(tb(b), n, 0.3 + 0.1 * warm(tb(b)) + (j === 10 ? 0.05 : 0)));
  for (let bar = 0; bar < 6; bar += 1) {
    const root = bar < 4 ? BARS[bar].bass : 45;
    [0, 7, 12].forEach((iv, k) => {
      const at = tb(bar * 3 + k);
      if (at < 58.3) note(out, at, beat * 0.8, tri(hz(root + iv)), 0.22 + 0.1 * warm(at));
    });
  }
  box(56.3, 72, 0.26);
  box(57.2, 74, 0.26);
  box(58.3, 76, 0.34);
  // The open fifth as a chip pad: A, E, A cycled in 32nds.
  const fifth = [57, 64, 69];
  add(out, 45, 13.5, (u) => pulse(hz(fifth[Math.floor(u / (BEAT / 8)) % 3]), 0.125)(u), (u) => 0.05 * warm(45 + u));
  return toWav(normalize(out, 0.5));
}

// ---------------------------------------------------------------------------
// heart: a triangle kick, tempo and level from HEART, phase integrated across the loop.

function heart() {
  const out = track(LOOP);
  const dt = 1 / SAMPLE_RATE;
  let total = 0;
  for (let i = 0; i < out.length; i += 1) total += (HEART.bpm(i * dt) / 60) * dt;
  const scale = Math.round(total) / total;
  const child = (t) => smooth(44.5, 45.5, t) * (1 - smooth(55, 58.5, t));
  let phase = 0;
  let next = 0;
  for (let i = 0; i < out.length; i += 1) {
    const t = i * dt;
    while (phase >= next) {
      const lvl = HEART.level(t);
      const c = child(t);
      if (lvl > 0.03) {
        const f = 70 + 40 * c;
        const g = lvl * (1 - 0.4 * c);
        const kick = (pitch) => (u) => tri(pitch * (0.6 + 0.4 * Math.exp(-u * 30)))(u);
        add(out, t, 0.25, kick(f), (u) => 0.8 * g * pluck(0.002, 0.05 - 0.012 * c)(u));
        const gap = Math.min(0.17, (60 / HEART.bpm(t)) * 0.32);
        add(out, t + gap, 0.2, kick(f * 1.15), (u) => 0.5 * g * pluck(0.002, 0.04 - 0.01 * c)(u));
      }
      next += 1;
    }
    phase += (HEART.bpm(t) / 60) * dt * scale;
  }
  return toWav(normalize(out, 0.8));
}

export function layerSounds() {
  return { stage: stage(), gas: gas(), liquid: liquid(), dark: dark(), heart: heart() };
}
