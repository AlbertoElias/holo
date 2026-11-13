import { SAMPLE_RATE, add, lowpass, noise, normalize, pluck, track } from '../lib/audio.mjs';
import { CRASH_AT, CRASH_PERIOD, HUG, LOOP, PI, clamp, smooth, window, wrap } from './common.mjs';
import { GAS_PAIRS } from './rooms.mjs';

// One 60 s loop per layer. Each plays from its own room, so wherever you
// are in the piece you hear that layer. All four share one motif: the
// stage's tune, which comes back in the core slow and in a minor key, and
// then, at the hug, whole and in major.

// Four minute-long tracks at the library's 32 kHz would take most of the
// upload limit; these are written at 24 kHz, which loses nothing they use.
const OUT_RATE = 24000;
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

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const TAU = 2 * PI;

const sin = Math.sin;
/** A band-limited saw from `n` harmonics. */
const saw = (f, n = 8) => (t) => {
  let s = 0;
  for (let k = 1; k <= n; k += 1) s += sin(TAU * f * k * t) / k;
  return s * 0.55;
};
const vibe = (f) => (t) => (sin(TAU * f * t) + 0.22 * sin(TAU * 4 * f * t) * Math.exp(-t * 6)) * (1 + 0.28 * sin(TAU * 5.5 * t));
const bell = (f) => (t) => sin(TAU * f * t) + 0.35 * sin(TAU * 2.76 * f * t) * Math.exp(-t * 2) + 0.15 * sin(TAU * 5.4 * f * t) * Math.exp(-t * 4);
const pad = (f, detune = 0.004) => (t) => (sin(TAU * f * t) + sin(TAU * f * (1 + detune) * t + 1) + 0.5 * sin(TAU * f * 2 * (1 - detune) * t)) / 2.5;

// The motif: the stage tune's first two bars, in scale steps of C major.
const MOTIF = [[0, 76, 1], [1, 79, 0.5], [1.5, 77, 0.5], [2, 76, 1], [3, 72, 1], [4, 74, 1.5], [5.5, 72, 0.5], [6, 71, 2]];

// ---------------------------------------------------------------------------
// Layer 1: a cheerful little 1950s tune, too cheerful, on top of a low drone
// that does not belong to it, and a clock.

function stage() {
  const out = track(LOOP);
  const beat = 0.5; // 120 bpm, 30 bars
  const chords = [[48, 52, 55, 60], [45, 52, 57, 60], [50, 53, 57, 62], [43, 50, 55, 59]];
  const relief = (t) => window(49.6, 56.8, t, 1.2);
  for (let bar = 0; bar < 30; bar += 1) {
    const c = chords[bar % 4];
    const at = bar * 4 * beat;
    // Walking bass: root, fifth, octave, approach.
    const walk = [c[0], c[0] + 7, c[0] + 12, chords[(bar + 1) % 4][0] - 1];
    walk.forEach((n, i) => add(out, at + i * beat, 0.6, (t) => sin(TAU * hz(n - 12) * t) + 0.4 * sin(TAU * hz(n) * t), pluck(0.008, 0.25)));
    // Off-beat chord stabs, brushed.
    for (const i of [1, 3]) {
      for (const n of c.slice(1)) add(out, at + i * beat, 0.3, (t) => 0.18 * sin(TAU * hz(n + 12) * t), pluck(0.004, 0.09));
    }
    // Brush: soft noise on 2 and 4.
    const nz = noise(bar + 1);
    for (const i of [1, 3]) add(out, at + i * beat, 0.12, () => 0.05 * nz(), pluck(0.002, 0.04));
    // Vibraphone melody: the motif, then answers built from the chord.
    const phrase = bar % 8;
    if (phrase === 0 || phrase === 4) {
      for (const [b, n, len] of MOTIF) {
        // Every other time, one note goes a little flat. Nobody mentions it.
        const sour = bar % 16 === 4 && b === 4 ? 2 ** (-0.55 / 12) : 1;
        add(out, at + b * beat, len * beat + 0.8, (t) => 0.32 * vibe(hz(n) * sour)(t), pluck(0.006, 0.9));
      }
    } else if (phrase === 2 || phrase === 6) {
      const notes = [c[1] + 24, c[2] + 24, c[3] + 12, c[2] + 24, c[1] + 24, c[3] + 24];
      notes.forEach((n, i) => add(out, at + i * beat * 0.66, 1.2, (t) => 0.22 * vibe(hz(n))(t), pluck(0.006, 0.7)));
    }
  }
  // The drone: an A flat under C major, beating slowly, never resolving.
  add(out, 0, LOOP, (t) => {
    const k = 0.12 * (1 - 0.8 * relief(t)) * (0.7 + 0.3 * sin((TAU * t) / 20));
    return k * (sin(TAU * hz(32) * t) + sin(TAU * hz(32) * 1.006 * t) + 0.4 * sin(TAU * hz(39) * 1.003 * t));
  });
  // A heartbeat, under everything, a touch fast.
  for (let t0 = 0; t0 < LOOP; t0 += 0.75) {
    for (const [d, g] of [[0, 1], [0.16, 0.6]]) add(out, t0 + d, 0.25, (t) => 0.22 * g * sin(TAU * (48 - 40 * t) * t), pluck(0.004, 0.06));
  }
  // The watch: a clock ticking each time he looks at it.
  const tick = noise(99);
  for (const [a, b] of [[9.2, 10.6], [27.0, 28.2], [40.2, 42.6]]) {
    for (let t0 = a; t0 < b; t0 += 0.25) add(out, t0, 0.03, () => 0.25 * tick() * (t0 % 0.5 < 0.01 ? 1 : 0.6), pluck(0.0005, 0.006));
  }
  // At the hug, the tune stops pretending: one long warm chord.
  for (const n of [60, 64, 67, 71, 74]) add(out, 49.6, 7.4, (t) => 0.1 * pad(hz(n))(t), (t) => smooth(0, 1.2, t) * (1 - smooth(5.4, 7.4, t)));
  // Duck the band while that chord rings.
  for (let i = 0; i < out.length; i += 1) {
    const t = i / SAMPLE_RATE;
    out[i] *= 1 - 0.45 * relief(t);
  }
  return toWav(normalize(lowpass(out, 6500), 0.62));
}

// ---------------------------------------------------------------------------
// Layer 2: busy, anxious, pastel. Quick arpeggios that never settle on a
// key, in three against four; a high whine; a breathy rush at every
// collision of gases.

function gas() {
  const out = track(LOOP);
  const whole = [0, 2, 4, 6, 8, 10];
  const rand = (() => { let s = 7; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); })();
  // Marimba-ish sixteenths (150 bpm): a whole-tone scale, drifting up.
  const six = 60 / 150 / 4;
  for (let i = 0; i * six < LOOP; i += 1) {
    const t0 = i * six;
    const deg = whole[(i * 5 + Math.floor(i / 7)) % 6];
    const oct = 72 + (Math.floor(i / 16) % 3) * 2;
    const n = oct + deg + (i % 4 === 0 ? 0 : 12 * (i % 2));
    const g = i % 4 === 0 ? 0.22 : 0.12 + 0.05 * rand();
    add(out, t0, 0.35, (t) => g * (sin(TAU * hz(n) * t) + 0.3 * sin(TAU * hz(n) * 3.9 * t) * Math.exp(-t * 30)), pluck(0.002, 0.11));
  }
  // Against it, triplets on a minor-second pair.
  const trip = 60 / 150 / 3;
  for (let i = 0; i * trip < LOOP; i += 1) {
    const n = i % 2 ? 67 : 68;
    add(out, i * trip, 0.25, (t) => 0.08 * sin(TAU * hz(n) * t), pluck(0.003, 0.07));
  }
  // A pulsing low pedal, restless.
  add(out, 0, LOOP, (t) => 0.09 * sin(TAU * hz(43) * t) * (0.6 + 0.4 * sin(TAU * 2.5 * t)));
  // High whine, wavering.
  add(out, 0, LOOP, (t) => 0.025 * sin(TAU * (hz(96) + 9 * sin(TAU * 0.5 * t)) * t));
  // Rushes: swelling filtered noise into each collision, then a soft chime.
  const rush = [];
  for (const p of GAS_PAIRS) for (let t0 = p.when; t0 < p.when + LOOP; t0 += p.period) rush.push(wrap(t0));
  const air = track(LOOP);
  rush.forEach((t0, i) => {
    const nz = noise(500 + i);
    add(air, t0 - 0.9, 1.6, () => nz(), (t) => 0.5 * (t < 0.9 ? (t / 0.9) ** 2 : Math.exp(-(t - 0.9) / 0.15)));
    const n = [79, 83, 86, 88][i % 4];
    add(out, t0, 1.2, (t) => 0.1 * (sin(TAU * hz(n) * t) + sin(TAU * hz(n + 1) * t)), pluck(0.003, 0.4));
  });
  lowpass(air, 2200);
  for (let i = 0; i < out.length; i += 1) out[i] += air[i] * 0.55;
  return toWav(normalize(out, 0.6));
}

// ---------------------------------------------------------------------------
// Layer 3: a storm, without water. Synthetic swells that run at each other
// and break in a great detuned chord; a churning ostinato underneath.

function liquid() {
  const out = track(LOOP);
  // Ostinato: D minor eighths in low saws, never stopping.
  const e8 = 60 / 132 / 2;
  const line = [38, 38, 41, 38, 45, 38, 44, 41];
  for (let i = 0; i * e8 < LOOP; i += 1) {
    const n = line[i % 8];
    add(out, i * e8, e8 * 1.2, (t) => 0.2 * saw(hz(n), 10)(t), pluck(0.01, 0.12));
  }
  // The surge and the crash, every CRASH_PERIOD.
  const crashes = [];
  for (let t0 = CRASH_AT; t0 < LOOP; t0 += CRASH_PERIOD) crashes.push(t0);
  crashes.forEach((t0, i) => {
    // Two swells, one from each side, rising in pitch toward each other.
    for (const [base, dir] of [[26, 1], [50, -1]]) {
      add(out, t0 - 2.2, 2.25, (t) => {
        const f = hz(base + dir * 12 * (t / 2.2) ** 2);
        return 0.18 * saw(f, 12)(t);
      }, (t) => (t / 2.2) ** 2.2);
    }
    // The break: a cluster of detuned saws, a sub boom, a fall.
    for (const n of [26, 33, 38, 39, 45, 50]) {
      const det = 1 + 0.008 * ((n * 7) % 5 - 2);
      add(out, t0, 3.2, (t) => 0.2 * saw(hz(n) * det * (1 - 0.06 * t), 9)(t), pluck(0.01, 1.0));
    }
    add(out, t0, 2.0, (t) => 0.9 * sin(TAU * (60 * Math.exp(-t * 2.2) + 26) * t), pluck(0.004, 0.6));
    const nz = noise(700 + i);
    add(out, t0, 1.4, () => 0.35 * nz(), pluck(0.002, 0.25));
  });
  // Under it all, a tide: a slow LFO swell of a low minor cluster.
  add(out, 0, LOOP, (t) => 0.12 * (0.5 + 0.5 * sin((TAU * t) / CRASH_PERIOD - 1)) * (pad(hz(26))(t) + pad(hz(29))(t)));
  lowpass(out, (t) => 900 + 2600 * Math.exp(-(wrap(t - CRASH_AT) % CRASH_PERIOD) / 0.5));
  // Soft clip: overwhelming, but no crackle.
  for (let i = 0; i < out.length; i += 1) out[i] = Math.tanh(out[i] * 1.6);
  return toWav(normalize(out, 0.72));
}

// ---------------------------------------------------------------------------
// Layer 4: cold and nearly empty; the motif alone, slow, in minor, like a
// music box in another room. At the hug, a warm major chord opens, the
// motif plays whole, bells; then the dark closes again for the next loop.

function core() {
  const out = track(LOOP);
  const warm = (t) => smooth(HUG.hold - 0.6, HUG.hold + 2.4, t) * (1 - smooth(HUG.fade, HUG.gone + 0.4, t));
  // Cold air: two high sines beating, very quiet, and a deep hum.
  add(out, 0, LOOP, (t) => (1 - warm(t)) * (0.035 * (sin(TAU * 1318 * t) + sin(TAU * 1321.5 * t)) + 0.1 * sin(TAU * hz(29) * t)));
  // The motif in minor, slow: the music box, out of tune and wound down.
  const minor = (n) => (n % 12 === 4 || n % 12 === 11 ? n - 1 : n);
  for (const start of [4, 20, 34]) {
    MOTIF.forEach(([b, n, len], i) => {
      const slow = 0.9 + 0.08 * i;
      add(out, start + b * slow, len * slow + 1.8, (t) => 0.16 * bell(hz(minor(n)) * (1 - 0.004 * i))(t), pluck(0.003, 1.2));
    });
  }
  // A sob-like catch in the hum: little falls in pitch, irregular.
  for (const t0 of [5.2, 11.8, 16.4, 23.1, 29.6, 31.0, 36.5, 41.8, 43.3]) {
    add(out, t0, 0.8, (t) => 0.06 * sin(TAU * (hz(57) - 30 * t) * t), (t) => Math.sin(PI * clamp(t / 0.8)) ** 2);
  }
  // The hug: a warm chord opens and the motif plays as written.
  for (const n of [48, 55, 60, 64, 67, 71, 74]) add(out, HUG.hold - 0.6, 12, (t) => 0.1 * pad(hz(n), 0.003)(t), (t) => warm(HUG.hold - 0.6 + t));
  MOTIF.forEach(([b, n, len]) => add(out, HUG.hold + 1.2 + b * 0.6, len * 0.6 + 2.5, (t) => 0.16 * bell(hz(n))(t), pluck(0.004, 1.6)));
  for (const [t0, n] of [[HUG.peak - 0.5, 84], [HUG.peak + 0.7, 88], [HUG.peak + 1.6, 91]]) add(out, t0, 3, (t) => 0.1 * bell(hz(n))(t), pluck(0.003, 1.4));
  return toWav(normalize(lowpass(out, 5200), 0.6));
}

export function layerSounds() {
  return { stage: stage(), gas: gas(), liquid: liquid(), core: core() };
}
