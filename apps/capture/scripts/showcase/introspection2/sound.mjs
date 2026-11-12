import { SAMPLE_RATE, add, lowpass, noise, normalize, pluck, track } from '../lib/audio.mjs';
import { HEART, LOOP, PI, clamp, smooth } from './timeline.mjs';

// Five 60 s mono loops for "The way down II", one per layer plus the heart.
// Each (except the heart) plays from an emitter that flies in while its layer
// is on screen, so each track carries content in its own beats and a few
// notes for the way back. All synth, no natural textures. The tune is shared:
// the stage plays it as a minor waltz over a tritone, the dark as a lullaby
// over an open fifth, with the uneasy held note finally resolved.

const OUT_RATE = 22050; // ten 60 s tracks come to about 26 MB
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
// gas: the turbulence itself, a roiling hiss that calms when he lets go, and his
// long breath out. The demands' voices are their own tracks (voices()).

/** Band-limited noise: lowpass minus a lower lowpass. */
function band(samples, lo, hi) {
  const a = lowpass(Float32Array.from(samples), hi);
  const b = lowpass(Float32Array.from(samples), lo);
  for (let i = 0; i < a.length; i += 1) a[i] -= b[i];
  return a;
}

function gas() {
  const out = track(LOOP);
  const n = noise(19);
  const raw = Float32Array.from(out, () => n());
  // Two bands, each swelling in slow, uneven gusts: the billows rolling over each other.
  const gust = (t, k) => 0.55 + 0.25 * sin(TAU * 0.23 * t + k) + 0.2 * sin(TAU * 0.61 * t + 2 * k);
  const rough = (t) => smooth(7.5, 12, t) * (1 - 0.8 * smooth(21.5, 24, t)) * (1 - smooth(25.5, 27.5, t));
  const low = band(raw, 120, 700);
  const high = band(raw, 900, 4200);
  for (let i = 0; i < out.length; i += 1) {
    const t = i / SAMPLE_RATE;
    out[i] = rough(t) * (0.9 * low[i] * gust(t, 0) + 0.35 * high[i] * gust(t, 1.7) * (0.6 + 0.4 * smooth(12, 20, t)));
  }
  // His breath: a held one in (21.9), then the long one out (22.3-23.4).
  const bn = noise(23);
  const breath = track(LOOP);
  add(breath, 21.85, 0.5, () => 0.22 * bn(), (u) => smooth(0, 0.35, u) * (1 - smooth(0.4, 0.5, u)));
  add(breath, 22.35, 1.3, () => 0.4 * bn(), (u) => smooth(0, 0.12, u) * (1 - smooth(0.3, 1.3, u)) ** 1.2);
  lowpass(breath, (t) => 1600 - 900 * smooth(22.35, 23.6, t));
  lowpass(breath, 2200);
  for (let i = 0; i < out.length; i += 1) out[i] += breath[i];
  // The way back: the settled gas, a soft breath of hiss as it passes (57.2 s).
  for (let i = Math.round(56.6 * SAMPLE_RATE); i < Math.round(58.2 * SAMPLE_RATE); i += 1) {
    const t = i / SAMPLE_RATE;
    out[i] += 0.25 * low[i] * Math.sin((PI * (t - 56.6)) / 1.6) ** 2;
  }
  return toWav(normalize(out, 0.6));
}

// ---------------------------------------------------------------------------
// voices: each demand nags from its own billow, on the same events that make
// it pulse (gas.mjs), out of time with the others.

const VOICE = {
  // a two-note door chime: ding, dong
  chime: (out, [t, , a], j) => add(out, t, 2.2, (u) => 0.32 * a * bell(hz(j % 2 ? 76 : 80))(u), pluck(0.002, 0.9)),
  // a phone vibrating on a table: a rattly 150 Hz buzz
  buzz: (out, [t, d, a]) => add(out, t, d, (u) => 0.3 * a * (Math.sign(sin(TAU * 151 * u)) * 0.6 + sin(TAU * 302 * u) * 0.4) * (0.7 + 0.3 * sin(TAU * 31 * u)), (u) => smooth(0, 0.01, u) * (1 - smooth(d - 0.03, d, u))),
  // a clock: tick, tock
  tick: (out, [t, , a], j) => {
    const f = j % 2 ? 1900 : 2500;
    add(out, t, 0.05, (u) => 0.5 * a * (sin(TAU * f * u) + 0.6 * sin(TAU * f * 1.47 * u)), pluck(0.0005, 0.012));
  },
  // a kettle coming to the boil: breathy whistle rising, then cut
  kettle: (out, [t, d, a]) => {
    const n = noise(Math.round(t * 100));
    glide(out, t, d, 900, 2100, 0.16 * a, (u) => smooth(0, d * 0.8, u) * clamp((d - u) / 0.02), (p) => sin(TAU * p) + 0.15 * n());
  },
  // dishes, keys, something dropped
  clatter: (out, [t, d, a], j) => {
    const f = [610, 870, 1330, 520][j % 4];
    add(out, t, d + 0.3, (u) => 0.24 * a * fm(f, 1.41 + 0.13 * (j % 3), 4, 0.06)(u), pluck(0.001, 0.12));
    add(out, t, 0.04, (u) => 0.12 * a * Math.sign(sin(TAU * 3100 * u)), pluck(0.0005, 0.008));
  }
};

/** One 60 s track per demand. */
export function voices(demands) {
  return Object.fromEntries(demands.map((d) => {
    const out = track(LOOP);
    d.events.forEach((e, j) => VOICE[d.id](out, e, j));
    return [d.id, toWav(normalize(out, 0.7))];
  }));
}

// ---------------------------------------------------------------------------
// liquid: his "proper" tune, the waltz, huge, slowed and heavy, pressing down
// from above, with a sub-bass clamp as each mould closes over him; a hard cut
// at 37 s when he lets go.

export const CLAMPS = [30.0, 33.0];

function liquid() {
  const out = track(LOOP);
  const level = (t) => smooth(24.5, 28, t) * (0.55 + 0.45 * smooth(28, 33, t)) * (1 - 0.45 * smooth(34.6, 36.2, t));
  // The waltz at a crawl, two octaves down, on a detuned organ of saws and a choir pad.
  const beat = 0.92;
  const t0 = 25.4;
  const at = (b) => t0 + beat * b;
  for (let rep = 0; rep < 2; rep += 1) {
    MOTIF.forEach(([b, n, len]) => {
      const s0 = at(rep * 12 + b);
      if (s0 > 37) return;
      const d = len * beat + 0.6;
      const g = level(s0);
      for (const [dn, dt, k] of [[-24, 1, 0.16], [-24, 1.006, 0.14], [-12, 0.997, 0.08], [-36, 1, 0.1]]) {
        add(out, s0, d, (u) => k * g * saw(hz(n + dn) * dt, 7)(u), (u) => smooth(0, 0.18, u) * (1 - smooth(d - 0.5, d, u)));
      }
    });
    BARS.forEach(({ bass, chord }, k) => {
      const s0 = at(rep * 12 + k * 3);
      if (s0 > 37) return;
      const d = 3 * beat + 0.5;
      const g = level(s0);
      add(out, s0, d, (u) => 0.32 * g * (sin(TAU * hz(bass - 12) * u) + 0.4 * sin(TAU * hz(bass) * u)), (u) => smooth(0, 0.08, u) * Math.exp(-u / 2.2));
      for (const n of chord) add(out, s0 + beat, 2 * beat, (u) => 0.05 * g * pad(hz(n - 12), 0.008)(u), (u) => Math.sin((PI * u) / (2 * beat)) ** 2);
    });
  }
  // Each wave rearing: a slow rumble rising under it.
  for (const c of CLAMPS) glide(out, c - 2.0, 2.0, 30, 46, 0.35, (u) => smooth(0, 1.9, u) ** 2 * (1 - smooth(1.9, 2.0, u)));
  // The clamps: a sub drop and a dull slam as the mould closes.
  const sn = noise(61);
  for (const c of CLAMPS) {
    const g = c === 33 ? 1 : 0.8;
    glide(out, c, 1.6, 52, 26, 0.95 * g, (u) => Math.min(1, u / 0.004) * Math.exp(-u / 0.55), (p) => Math.tanh(1.8 * sin(TAU * p)));
    const slam = track(2);
    add(slam, 0, 0.6, () => sn(), (u) => Math.exp(-u / 0.09));
    lowpass(slam, 260);
    lowpass(slam, 260);
    normalize(slam, 0.7 * g);
    add(out, c, 0.6, (u) => slam[Math.round(u * SAMPLE_RATE)] ?? 0);
  }
  gate(out, 37, 54.6, 0); // the hard cut on his surrender
  // Way back: the paint at rest, a calm low pad.
  for (const n of [33, 40, 45, 52]) add(out, 54.8, 3.4, (u) => 0.1 * pad(hz(n))(u), (u) => Math.sin((PI * u) / 3.4) ** 2);
  return toWav(normalize(lowpass(out, 5200), 0.85));
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
