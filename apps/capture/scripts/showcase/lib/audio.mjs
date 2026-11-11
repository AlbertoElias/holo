// Procedural sound for showcase holograms: build a mono Float32Array, then
// encode it as 16-bit PCM WAV. WAV loops without the gap an MP3 or AAC
// encoder pads in, and the viewer loops the buffer with the clip.

export const SAMPLE_RATE = 32000;

export function track(seconds) {
  return new Float32Array(Math.round(seconds * SAMPLE_RATE));
}

/**
 * Adds a voice to `out` starting at `at` seconds. `wave(t)` returns the
 * sample at local time t; `env(t)` its gain. A voice that runs past the end
 * wraps to the start, so tails cross the loop point instead of being cut.
 */
export function add(out, at, seconds, wave, env = () => 1) {
  const start = Math.round(at * SAMPLE_RATE);
  const count = Math.round(seconds * SAMPLE_RATE);
  for (let i = 0; i < count; i += 1) {
    const t = i / SAMPLE_RATE;
    const index = (((start + i) % out.length) + out.length) % out.length;
    out[index] += wave(t) * env(t);
  }
}

export const sine = (hz, phase = 0) => (t) => Math.sin(2 * Math.PI * hz * t + phase);

/** Attack then exponential decay: a struck or plucked sound. */
export const pluck = (attack, decay) => (t) => (t < attack ? t / attack : Math.exp(-(t - attack) / decay));

/** Smooth rise and fall over the whole voice. */
export const swell = (seconds) => (t) => Math.sin((Math.PI * t) / seconds) ** 2;

/** Deterministic white noise in [-1, 1]. */
export function noise(seed = 1) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x7fffffff - 1;
  };
}

/** One-pole low-pass in place; `hz` may be a function of time for a moving filter. */
export function lowpass(samples, hz) {
  let y = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const cutoff = typeof hz === 'function' ? hz(i / SAMPLE_RATE) : hz;
    const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SAMPLE_RATE);
    y += a * (samples[i] - y);
    samples[i] = y;
  }
  return samples;
}

/** Scales so the loudest sample sits at `peak`. */
export function normalize(samples, peak = 0.8) {
  let max = 0;
  for (const s of samples) max = Math.max(max, Math.abs(s));
  if (max > 0) for (let i = 0; i < samples.length; i += 1) samples[i] *= peak / max;
  return samples;
}

export function toWav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
