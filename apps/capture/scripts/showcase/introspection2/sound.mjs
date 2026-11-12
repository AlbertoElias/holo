import { SAMPLE_RATE, add, lowpass, noise, normalize, pluck, track } from '../lib/audio.mjs';
import { HEART, LOOP, clamp, smooth } from './timeline.mjs';

// Five 60 s mono loops for "The way down II", one per layer plus the heart.
// Each (except the heart) plays from an emitter that flies in while its layer
// is on screen, so each track carries content in its own beats and a few
// notes for the way back. All synth, no natural textures. The tune is shared:
// the stage plays it as a minor waltz over a tritone, the dark as a lullaby
// over an open fifth, with the uneasy held note finally resolved.

const OUT_RATE = 22050; // five tracks must fit about 13 MB
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
const sin = Math.sin;
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const saw = (f, n = 6) => (t) => {
  let s = 0;
  for (let k = 1; k <= n; k += 1) s += sin(TAU * f * k * t) / k;
  return s * 0.55;
};
const bell = (f) => (t) => sin(TAU * f * t) + 0.35 * sin(TAU * 2.76 * f * t) * Math.exp(-t * 2) + 0.15 * sin(TAU * 5.4 * f * t) * Math.exp(-t * 4);
const celesta = (f) => (t) => sin(TAU * f * t) + 0.3 * sin(TAU * 4 * f * t) * Math.exp(-t * 7) + 0.12 * sin(TAU * 7.1 * f * t) * Math.exp(-t * 14);
const pad = (f, detune = 0.004) => (t) => (sin(TAU * f * t) + sin(TAU * f * (1 + detune) * t + 1) + 0.5 * sin(TAU * f * 2 * (1 - detune) * t)) / 2.5;
/** A soft, muted clarinet: odd harmonics only, slow vibrato after the attack. */
const clarinet = (f, dur) => (t) => {
  const v = 1 + 0.004 * smooth(0.25, 0.7, t) * sin(TAU * 4.8 * t);
  const p = TAU * f * v * t;
  const e = Math.min(1, t / 0.07) * clamp((dur - t) / 0.14);
  return (sin(p) + 0.3 * sin(3 * p) + 0.14 * sin(5 * p) + 0.06 * sin(7 * p)) * e;
};
/** FM voice with a metallic (inharmonic) ratio and a decaying index. */
const fm = (fc, ratio, index, decay) => (t) => sin(TAU * fc * t + index * Math.exp(-t / decay) * sin(TAU * fc * ratio * t));
const rng = (seed) => {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
};
/** Writes a pitch glide (phase-integrated) into `out`, wrapping at the seam. */
function glide(out, at, dur, f0, f1, amp, env, shape = (p) => sin(TAU * p)) {
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
  const i0 = Math.round(a * SAMPLE_RATE);
  const i1 = Math.round(b * SAMPLE_RATE);
  for (let i = i0; i < i1; i += 1) out[i] *= typeof gain === 'function' ? gain(i / SAMPLE_RATE) : gain;
};

// The tune: four bars of 3/4 in A minor as [beat, midi, length in beats]. Bar 4
// holds Eb over the E bass, a tritone off the tonic: the uneasy note. The
// lullaby resolves it up to E (see MOTIF_RESOLVED).
export const MOTIF = [
  [0, 76, 1], [1, 81, 1], [2, 79, 1],
  [3, 77, 1.5], [4.5, 76, 0.5], [5, 74, 1],
  [6, 72, 1], [7, 74, 1], [8, 76, 1],
  [9, 75, 3]
];
export const MOTIF_RESOLVED = [...MOTIF.slice(0, 9), [9, 75, 1.5], [10.5, 76, 1.5]];
const BARS = [
  { bass: 45, chord: [60, 64, 69] }, // Am
  { bass: 38, chord: [62, 65, 69] }, // Dm
  { bass: 36, chord: [60, 64, 67] }, // C
  { bass: 40, chord: [59, 62, 68] } // E7
];

// ---------------------------------------------------------------------------
// stage: the waltz, 132 bpm, bending flat like stretched tape from 7 to 12 s.

const WALTZ_BEAT = 60 / 132;
const BEND = 2; // semitones of sag by 12 s
const bendAt = (t) => BEND * smooth(7, 12, t);
const tapeRate = (t) => 2 ** (-bendAt(t) / 12);
// Beat -> time, integrating the tape-speed tempo.
const waltzTimes = (() => {
  const times = [0];
  let t = 0;
  let b = 0;
  const dt = 0.001;
  while (t < 13) {
    b += (dt * tapeRate(t)) / WALTZ_BEAT;
    t += dt;
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
  const voice = (beat, midi, len, gain = 1, lowerClarinet = true) => {
    const t0 = waltzAt(beat);
    if (t0 > 12.3) return;
    const bend = 2 ** (-bendAt(t0 + 0.2) / 12);
    const dur = waltzAt(beat + len) - t0;
    add(out, t0, 1.6 + dur * 0.5, (t) => 0.3 * celesta(hz(midi) * bend)(t), (t) => pluck(0.003, 0.55)(t) * gain * thin(t0));
    if (lowerClarinet) {
      const g = (1 - smooth(8.2, 10.5, t0)) * gain;
      if (g > 0.01) add(out, t0, dur + 0.15, (t) => 0.2 * clarinet(hz(midi - 12) * bend, dur)(t), () => g);
    }
  };
  // Two statements; the second sags into the tape bend. Statement 3 never arrives.
  for (const base of [0, 12]) {
    for (const [b, n, len] of MOTIF) voice(base + b + 0, n, len);
    for (let bar = 0; bar < 4; bar += 1) {
      const { bass, chord } = BARS[bar];
      const b0 = base + bar * 3;
      const t0 = waltzAt(b0);
      if (t0 > 12.3) continue;
      const bend = 2 ** (-bendAt(t0) / 12);
      add(out, t0, 0.7, (t) => 0.3 * (sin(TAU * hz(bass) * bend * t) + 0.35 * sin(TAU * hz(bass + 12) * bend * t)), (t) => pluck(0.006, 0.22)(t) * thin(t0));
      for (const k of [1, 2]) {
        const tk = waltzAt(b0 + k);
        if (tk > 12.3) continue;
        const bk = 2 ** (-bendAt(tk) / 12);
        for (const n of chord) add(out, tk, 0.35, (t) => 0.07 * (sin(TAU * hz(n) * bk * t) + 0.3 * sin(3 * TAU * hz(n) * bk * t)), (t) => pluck(0.006, 0.1)(t) * thin(tk));
      }
    }
  }
  // Pickup into the downbeat: A C D, then E at 0.
  [69, 72, 74].forEach((n, i) => {
    const t0 = LOOP - (3 - i) * WALTZ_BEAT;
    add(out, t0, 1.2, (t) => 0.26 * celesta(hz(n))(t), pluck(0.003, 0.4));
    add(out, t0, WALTZ_BEAT * 0.95, (t) => 0.14 * clarinet(hz(n - 12), WALTZ_BEAT * 0.95)(t));
  });
  // The tritone pedal: A1 and Eb2, slowly beating, in with the pickup and out by 12.
  const pedal = (t) => {
    const T = (58.5 + t) % LOOP;
    return smooth(58.5, 60, T < 30 ? T + LOOP : T) * (T < 30 ? 1 - smooth(9.5, 12, T) : 1);
  };
  add(out, 58.5, 13.5, (t) => 0.2 * (sin(TAU * hz(33) * t) + sin(TAU * hz(33) * 1.004 * t) + 0.9 * sin(TAU * hz(39) * 1.006 * t) + 0.35 * sin(TAU * hz(45) * t)), pedal);
  gate(out, 12.6, 58.4, 0);
  // Stem peaks follow the intensity curve: the calm opening under the gas, the storm loudest, the dark faint.
  return toWav(normalize(lowpass(out, 5200), 0.4));
}

// ---------------------------------------------------------------------------
// gas: 5 against 7, ticks, sirens, then a smear, then a sparse way back.

function gas() {
  const out = track(LOOP);
  const R = rng(11);
  const cycle = (t) => 1.5 * (1 - 0.4 * smooth(12, 24, t)); // seconds for 5 notes (A) or 7 (B)
  const level = (t) => 0.22 + 0.78 * smooth(7, 12, t) * (0.55 + 0.45 * smooth(12, 24, t));
  const trans = (t) => Math.round(12 * smooth(12, 24, t));
  const pentA = [0, 2, 4, 7, 9];
  const setB = [0, 3, 5, 7, 10, 12, 15];
  const ticks = [];
  // Pattern A: five-note cycle, pastel pentatonic, enters at 7.
  let i = 0;
  for (let t = 7; t < 24; t += cycle(t) / 5, i += 1) {
    const n = 72 + pentA[(i * 2) % 5] + (i % 5 > 2 ? 12 : 0) + trans(t);
    const g = (i % 5 === 0 ? 0.26 : 0.16) * level(t);
    add(out, t, 0.5, (u) => g * (sin(TAU * hz(n) * u) + 0.3 * sin(TAU * hz(n) * 3.99 * u) * Math.exp(-u * 25)), pluck(0.002, 0.13));
    if (t >= 12) ticks.push([t, 2300, 0.1]);
  }
  // Pattern B: seven-note cycle, a fifth up, enters at 10.
  i = 0;
  for (let t = 10; t < 24; t += cycle(t) / 7, i += 1) {
    const n = 79 + setB[(i * 3) % 7] - (i % 7 > 4 ? 12 : 0) + trans(t);
    const g = (i % 7 === 0 ? 0.2 : 0.12) * level(t) * smooth(10, 13, t);
    add(out, t, 0.4, (u) => g * (sin(TAU * hz(n) * u) + 0.4 * sin(TAU * hz(n) * 2 * u)), pluck(0.002, 0.09));
    if (t >= 12) ticks.push([t, 3300, 0.07]);
  }
  // A third, quickened figure for density after 18.
  for (let t = 18; t < 24; t += cycle(t) / 10) {
    const n = 91 + pentA[Math.floor(R() * 5)] + trans(t) - 6;
    add(out, t, 0.2, (u) => 0.07 * sin(TAU * hz(n) * u), pluck(0.002, 0.05));
  }
  // Synthetic ticking clicks on both grids.
  for (const [t, f, g] of ticks) add(out, t, 0.012, (u) => g * Math.sign(sin(TAU * f * u)), pluck(0.0005, 0.003));
  // Sirens: slow rising glides, each starting a little higher.
  for (let k = 0; k < 4; k += 1) {
    const a = 12 + k * 3;
    glide(out, a, 3.4, hz(74 + 2 * k), hz(86 + 2 * k), 0.07 * level(a), (u) => Math.sin((Math.PI * u) / 3.4) ** 2, (p) => sin(TAU * p + 1.5 * sin(TAU * p * 0.01)) + 0.25 * sin(TAU * 2 * p));
    glide(out, a + 1.5, 3.4, hz(81 + 2 * k), hz(91 + 2 * k), 0.04 * level(a), (u) => Math.sin((Math.PI * u) / 3.4) ** 2);
  }
  glide(out, 9, 3, hz(79), hz(88), 0.035, (u) => Math.sin((Math.PI * u) / 3) ** 2);
  // 24-26.8: the arpeggios smear upward, then cut.
  const smearEnd = 26.8;
  [0, 7, 14, 4, 11, 2].forEach((d, j) => {
    const a = 24 + j * 0.12;
    const dur = smearEnd - a;
    const f0 = hz(81 + d);
    glide(out, a, dur, f0, f0 * 4.2, 0.12, (u) => smooth(0, 0.5, u) * clamp((dur - u) / 0.03));
  });
  gate(out, smearEnd, 55.9, 0);
  // Way back: a gentle, sparse slow version.
  [[56.1, 88], [56.8, 91], [57.35, 95], [58.0, 91]].forEach(([t, n], j) => {
    add(out, t, 1.6, (u) => 0.12 * (sin(TAU * hz(n) * u) + 0.2 * sin(TAU * hz(n) * 2.01 * u)), pluck(0.01, 0.35 + 0.05 * j));
  });
  return toWav(normalize(lowpass(out, 7500), 0.85));
}

// ---------------------------------------------------------------------------
// liquid: a storm at sea in synths alone.

function liquid() {
  const out = track(LOOP);
  const intensity = (t) => 0.3 + 0.7 * smooth(27, 33, t) - 0.2 * smooth(35, 37, t);
  // Sub-bass surges, every 3-4 s.
  [[24.3, 3.6, 41], [27.6, 3.6, 44], [31, 3.4, 46], [34.2, 2.9, 49]].forEach(([a, d, f]) => {
    const g = a < 27 ? 0.5 : 0.9 * intensity(a + d / 2);
    glide(out, a, d, f * 1.12, f * 0.92, g, (u) => Math.sin((Math.PI * u) / d) ** 2);
    glide(out, a, d, f * 2.24, f * 1.84, g * 0.25, (u) => Math.sin((Math.PI * u) / d) ** 2);
  });
  // Detuned saw swells, a minor second apart.
  [[27.4, 4.2, 33], [30.6, 4, 34], [33.4, 3.6, 36]].forEach(([a, d, n]) => {
    for (const [dn, dt, g] of [[0, 1, 0.1], [0, 1.007, 0.1], [1, 0.995, 0.08], [7, 1.004, 0.05]]) {
      add(out, a, d, (u) => g * saw(hz(n + dn) * dt, 5)(u), (u) => Math.sin((Math.PI * u) / d) ** 1.5 * intensity(a + u));
    }
  });
  // Metallic FM crashes.
  [28.5, 30, 31.5, 33, 34, 35, 36].forEach((t, j) => {
    const g = 0.4 * intensity(t) * (t >= 33 && t <= 35 ? 1.25 : 1);
    const f = 92 + 14 * (j % 3);
    add(out, t, 1.6, (u) => g * fm(f, 1.414, 5, 0.35)(u), pluck(0.002, 0.7));
    add(out, t, 1, (u) => g * 0.35 * fm(f * 2.76, 2.1, 3, 0.2)(u), pluck(0.002, 0.3));
    add(out, t, 0.4, (u) => g * 0.16 * fm(f * 11.3, 1.37, 4, 0.05)(u), pluck(0.001, 0.08));
  });
  gate(out, 37, 54.6, 0); // the hard cut
  // Way back: the sea at rest, a calm low pad.
  for (const n of [33, 40, 45, 52]) add(out, 54.8, 3.4, (u) => 0.1 * pad(hz(n))(u), (u) => Math.sin((Math.PI * u) / 3.4) ** 2);
  return toWav(normalize(out, 0.78)); // 0.9 clipped on the 33 s crash with the heart at full
}

// ---------------------------------------------------------------------------
// dark: near silence, a sob, then the lullaby.

function dark() {
  const out = track(LOOP);
  // High sine, barely there.
  add(out, 37, 9, (t) => 0.02 * sin(TAU * 3136 * t), (t) => smooth(0, 2, t) * (1 - smooth(6.5, 9, t)));
  // Sob-like breath: irregular filtered bursts in groups, slowing and fading.
  const R = rng(5);
  const breath = track(LOOP);
  const nz = noise(77);
  const amp = (t) => smooth(41, 43.5, t) * (1 - smooth(47, 53, t));
  for (let t = 41; t < 53; ) {
    const spasms = 2 + Math.floor(R() * 2);
    for (let s = 0; s < spasms && t < 53; s += 1) {
      const a = amp(t);
      const f0 = 230 + 40 * R();
      add(breath, t, 0.22, (u) => a * 0.25 * ((0.45 + 0.55 * nz()) * 0.8 + sin(TAU * (f0 - 70 * u) * u) + 0.3 * sin(TAU * 2 * (f0 - 70 * u) * u)), (u) => Math.min(1, u / 0.03) * Math.exp(-u / 0.07));
      t += 0.17 + 0.06 * R();
    }
    // the in-breath: a quieter rise before the next group
    const a = amp(t);
    add(breath, t + 0.1, 0.35, (u) => a * 0.12 * (0.6 * nz() + sin(TAU * 420 * u)), (u) => smooth(0, 0.3, u) * (1 - smooth(0.3, 0.35, u)));
    t += (0.55 + 0.4 * R()) * (1 + 1.9 * smooth(47, 53, t));
  }
  lowpass(breath, (t) => 900 + 300 * sin(t));
  lowpass(breath, 1400);
  for (let i = 0; i < out.length; i += 1) out[i] += breath[i];
  // The lullaby: half tempo, rubato, the motif on a music box, resolved.
  const beat = 2 * WALTZ_BEAT;
  const t0 = 45.4;
  const tb = (b) => t0 + beat * (b + 0.07 * sin((TAU * b) / 5));
  const warm = (t) => smooth(45, 52.5, t) * (1 - smooth(55, 58.3, t));
  const box = (at, midi, len, g) => add(out, at, 2.4 + len, (u) => g * bell(hz(midi))(u), pluck(0.004, 0.9));
  MOTIF_RESOLVED.forEach(([b, n, len], j) => box(tb(b), n, len, 0.3 + 0.1 * warm(tb(b)) + (j === 10 ? 0.05 : 0)));
  // Left hand in 3/4: root, fifth, octave, one chord to a bar, then on in A.
  for (let bar = 0; bar < 6; bar += 1) {
    const root = bar < 4 ? BARS[bar].bass : 45;
    [0, 7, 12].forEach((iv, k) => {
      const at = tb(bar * 3 + k);
      if (at < 58.3) box(at, root + 12 + iv, 1, 0.12 + 0.06 * warm(at));
    });
  }
  // Coda: C, D, then the E the waltz begins on.
  box(56.3, 72, 1, 0.26);
  box(57.2, 74, 1, 0.26);
  box(58.3, 76, 2, 0.34);
  // Soft pad on an open fifth (A, E), warming to full around 52-55.
  for (const [n, g] of [[45, 0.1], [52, 0.09], [57, 0.07], [64, 0.045]]) {
    add(out, 45, 13.5, (u) => g * pad(hz(n))(u), (u) => warm(45 + u));
  }
  for (const n of [60, 69]) add(out, 49, 9.3, (u) => 0.035 * pad(hz(n))(u), (u) => warm(49 + u) ** 2);
  return toWav(normalize(lowpass(out, 6500), 0.5));
}

// ---------------------------------------------------------------------------
// heart: one voice, tempo and level from HEART, phase integrated across the loop.

function heart() {
  const out = track(LOOP);
  const dt = 1 / SAMPLE_RATE;
  let total = 0;
  for (let i = 0; i < out.length; i += 1) total += HEART.bpm(i * dt) / 60 * dt;
  const scale = Math.round(total) / total; // nudge so a whole number of beats fits the loop
  const child = (t) => smooth(44.5, 45.5, t) * (1 - smooth(55, 58.5, t));
  let phase = 0;
  let next = 0;
  for (let i = 0; i < out.length; i += 1) {
    const t = i * dt;
    while (phase >= next) {
      const lvl = HEART.level(t);
      const period = 60 / HEART.bpm(t);
      const c = child(t);
      if (lvl > 0.03) {
        const f = 62 + 38 * c;
        const g = lvl * (1 - 0.4 * c);
        const thump = (pitch) => (u) => sin(TAU * (pitch * 0.62 + pitch * 0.38 * Math.exp(-u * 28)) * u) + 0.25 * sin(TAU * pitch * 2.1 * u) * Math.exp(-u * 40);
        add(out, t, 0.3, thump(f), (u) => 0.8 * g * pluck(0.003, 0.055 - 0.015 * c)(u));
        const gap = Math.min(0.17, period * 0.32);
        add(out, t + gap, 0.25, thump(f * 1.15), (u) => 0.5 * g * pluck(0.003, 0.045 - 0.012 * c)(u));
      }
      next += 1;
    }
    phase += HEART.bpm(t) / 60 * dt * scale;
  }
  return toWav(normalize(out, 0.8));
}

export function layerSounds() {
  return { stage: stage(), gas: gas(), liquid: liquid(), dark: dark(), heart: heart() };
}
