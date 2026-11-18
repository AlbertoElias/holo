/**
 * Lips from a spoken line (sound brief slice 1a): the line's phones, from the
 * phonemiser the local voice uses, laid over the voiced time of the audio
 * itself, become the 15 Oculus visemes, which `@holoim/avatar-face` routes
 * onto any avatar (its own viseme shapes, else the fallbacks onto `jawOpen`
 * and the lip shapes). The mouth is open only while there is sound to say and
 * rests between phrases.
 *
 * Timing comes from the audio, never from the text alone: a phrase's phones
 * are spread over the voiced frames of its stretch of audio in proportion to
 * how long each kind of phone usually lasts, so a pause the voice makes is a
 * closed mouth, whatever the text says.
 */
import type { FaceChannel } from '@holoim/avatar-face';

export type Viseme = 'sil' | 'PP' | 'FF' | 'TH' | 'DD' | 'kk' | 'CH' | 'SS' | 'nn' | 'RR' | 'aa' | 'E' | 'I' | 'O' | 'U';

/** How the mouth leads the sound it makes (s): lips move a little before the voice is heard. */
export const LIP_LEAD = 0.04;
/** Crossfade between neighbouring phones, and the ramp in and out of a phrase (s). */
const RAMP = 0.06;
/** Envelope frame (s). */
export const FRAME = 0.01;
/** A frame is voiced above this share of the line's loud level (its 95th percentile RMS). */
export const VOICED = 0.08;
/** Silences shorter than this inside a phrase stay voiced (a stop's closure, a breath between words) (s). */
const BRIDGE = 0.09;
/** Silence at least this long ends a phrase group, wherever the text puts its punctuation (s). */
export const PAUSE = 0.18;

/** IPA phone to viseme and how long the phone usually lasts, relative to a vowel. */
const PHONES: Readonly<Record<string, { v: Viseme; w: number }>> = {
  p: { v: 'PP', w: 0.6 }, b: { v: 'PP', w: 0.6 }, m: { v: 'PP', w: 0.7 },
  f: { v: 'FF', w: 0.8 }, v: { v: 'FF', w: 0.7 },
  'θ': { v: 'TH', w: 0.8 }, 'ð': { v: 'TH', w: 0.5 },
  t: { v: 'DD', w: 0.55 }, d: { v: 'DD', w: 0.55 }, 'ɾ': { v: 'DD', w: 0.35 },
  k: { v: 'kk', w: 0.6 }, g: { v: 'kk', w: 0.6 }, 'ɡ': { v: 'kk', w: 0.6 }, 'ŋ': { v: 'kk', w: 0.7 },
  'tʃ': { v: 'CH', w: 0.9 }, 'dʒ': { v: 'CH', w: 0.85 }, 'ʃ': { v: 'CH', w: 0.85 }, 'ʒ': { v: 'CH', w: 0.75 },
  s: { v: 'SS', w: 0.85 }, z: { v: 'SS', w: 0.7 },
  n: { v: 'nn', w: 0.65 }, l: { v: 'nn', w: 0.65 }, 'ɫ': { v: 'nn', w: 0.65 },
  'ɹ': { v: 'RR', w: 0.6 }, r: { v: 'RR', w: 0.6 }, 'ɚ': { v: 'RR', w: 1 }, 'ɝ': { v: 'RR', w: 1.1 },
  a: { v: 'aa', w: 1 }, 'ɑ': { v: 'aa', w: 1.1 }, 'æ': { v: 'aa', w: 1.1 }, 'ʌ': { v: 'aa', w: 0.85 }, 'ɐ': { v: 'aa', w: 0.7 },
  e: { v: 'E', w: 1 }, 'ɛ': { v: 'E', w: 0.95 }, 'ə': { v: 'E', w: 0.55 },
  i: { v: 'I', w: 1 }, 'ɪ': { v: 'I', w: 0.75 }, 'ᵻ': { v: 'I', w: 0.6 }, j: { v: 'I', w: 0.45 },
  o: { v: 'O', w: 1 }, 'ɔ': { v: 'O', w: 1 }, 'ɒ': { v: 'O', w: 1 },
  u: { v: 'U', w: 1 }, 'ʊ': { v: 'U', w: 0.75 }, w: { v: 'U', w: 0.5 },
  h: { v: 'aa', w: 0.45 }
};
const TWO = ['tʃ', 'dʒ'];
/** How far each viseme opens: vowels follow the voice's loudness, a closure is always full. */
const OPEN: Readonly<Record<Viseme, 'vowel' | 'consonant' | 'closure'>> = {
  sil: 'consonant', PP: 'closure', FF: 'consonant', TH: 'consonant', DD: 'consonant', kk: 'consonant', CH: 'consonant', SS: 'consonant',
  nn: 'consonant', RR: 'consonant', aa: 'vowel', E: 'vowel', I: 'vowel', O: 'vowel', U: 'vowel'
};

export interface Phone { readonly ipa: string; readonly viseme: Viseme; readonly start: number; readonly end: number }
export interface LineLips {
  /** Phones in line time (s from the start of the audio). */
  readonly phones: readonly Phone[];
  /** Phrase groups in line time: the voiced stretches the mouth moves over. */
  readonly groups: readonly { start: number; end: number }[];
  /** RMS envelope per FRAME, normalised to the line's loud level. */
  readonly envelope: Float32Array;
}

/** IPA text to phones, in order; stress, length and word breaks dropped, unknown marks skipped. */
export function phonesOf(ipa: string): { ipa: string; v: Viseme; w: number }[] {
  const out: { ipa: string; v: Viseme; w: number }[] = [];
  const s = ipa.replace(/[ˈˌː\s.,;:!?'"-]/g, '');
  for (let i = 0; i < s.length;) {
    const two = s.slice(i, i + 2);
    const key = TWO.includes(two) ? two : s[i]!;
    i += key.length;
    const p = PHONES[key];
    if (p) out.push({ ipa: key, v: p.v, w: p.w });
  }
  return out;
}

/** RMS per FRAME of mono PCM, divided by the line's 95th percentile frame. */
export function envelopeOf(pcm: Float32Array, rate: number): Float32Array {
  const n = Math.max(1, Math.floor(pcm.length / (rate * FRAME)));
  const hop = Math.floor(rate * FRAME);
  const env = new Float32Array(n);
  for (let f = 0; f < n; f += 1) {
    let sum = 0;
    for (let i = f * hop; i < (f + 1) * hop && i < pcm.length; i += 1) sum += pcm[i]! * pcm[i]!;
    env[f] = Math.sqrt(sum / hop);
  }
  const sorted = Array.from(env).sort((x, y) => x - y);
  const loud = sorted[Math.floor(sorted.length * 0.95)] || 1;
  for (let f = 0; f < n; f += 1) env[f] = Math.min(1.5, env[f]! / loud);
  return env;
}

/** Voiced stretches of an envelope (s), with short silences bridged. */
export function voicedSpans(env: Float32Array, threshold = VOICED, bridge = BRIDGE): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let open = -1;
  for (let f = 0; f <= env.length; f += 1) {
    const on = f < env.length && env[f]! > threshold;
    if (on && open < 0) open = f;
    if (!on && open >= 0) { spans.push({ start: open * FRAME, end: f * FRAME }); open = -1; }
  }
  const merged: { start: number; end: number }[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start - last.end < bridge) last.end = s.end;
    else merged.push({ ...s });
  }
  return merged.filter((s) => s.end - s.start >= 0.04);
}

/**
 * The line's phones over its audio. `phrases` are the phonemiser's phrases
 * (IPA, one per stretch between punctuation). Voiced stretches split at
 * pauses of at least PAUSE; when there are as many such groups as phrases,
 * each phrase takes its own group, otherwise all phones spread over all the
 * voiced time.
 */
export function lineLips(phrases: readonly string[], pcm: Float32Array, rate: number): LineLips {
  const envelope = envelopeOf(pcm, rate);
  const spans = voicedSpans(envelope);
  const groups: { start: number; end: number; spans: { start: number; end: number }[] }[] = [];
  for (const s of spans) {
    const last = groups[groups.length - 1];
    if (last && s.start - last.end < PAUSE) { last.end = s.end; last.spans.push(s); } else groups.push({ start: s.start, end: s.end, spans: [s] });
  }
  const perPhrase = phrases.map(phonesOf).filter((p) => p.length);
  const assignments = groups.length === perPhrase.length
    ? groups.map((g, i) => ({ g: [g], phones: perPhrase[i]! }))
    : [{ g: groups, phones: perPhrase.flat() }];
  const phones: Phone[] = [];
  for (const { g, phones: ps } of assignments) {
    const voiced = g.flatMap((x) => x.spans);
    const total = voiced.reduce((sum, s) => sum + (s.end - s.start), 0);
    const weight = ps.reduce((sum, p) => sum + p.w, 0);
    if (!total || !weight) continue;
    // Voiced time `u` (s) into the group to line time.
    const at = (u: number): number => {
      for (const s of voiced) { const d = s.end - s.start; if (u <= d) return s.start + u; u -= d; }
      return voiced[voiced.length - 1]!.end;
    };
    let u = 0;
    for (const p of ps) {
      const d = (p.w / weight) * total;
      phones.push({ ipa: p.ipa, viseme: p.v, start: at(u), end: at(u + d) });
      u += d;
    }
  }
  return { phones, groups: groups.map(({ start, end }) => ({ start, end })), envelope };
}

const rampIn = (t: number, from: number): number => (t <= from - RAMP ? 0 : t >= from ? 1 : (t - (from - RAMP)) / RAMP);
const rampOut = (t: number, to: number): number => (t >= to + RAMP ? 0 : t <= to ? 1 : 1 - (t - to) / RAMP);

/** The line's viseme weights at line time `t` (the mouth leads by LIP_LEAD). */
export function visemesAt(lips: LineLips, t: number): Partial<Record<FaceChannel, number>> {
  const s = t + LIP_LEAD;
  const out: Partial<Record<FaceChannel, number>> = {};
  const f = Math.min(lips.envelope.length - 1, Math.max(0, Math.round(s / FRAME)));
  const loud = Math.min(1, lips.envelope[f] ?? 0);
  for (const p of lips.phones) {
    if (s < p.start - RAMP || s > p.end + RAMP) continue;
    const k = Math.min(rampIn(s, p.start), rampOut(s, p.end));
    if (k <= 0) continue;
    const kind = OPEN[p.viseme];
    const strength = kind === 'closure' ? 1 : kind === 'vowel' ? 0.55 + 0.45 * loud : 0.8;
    const ch = `viseme_${p.viseme}` as FaceChannel;
    out[ch] = Math.max(out[ch] ?? 0, k * strength);
  }
  return out;
}

/** 1 while the line is being said (its phrase groups, with ramps), else 0: other mouth movement yields to it. */
export function speakingAt(lips: LineLips, t: number): number {
  const s = t + LIP_LEAD;
  let k = 0;
  for (const g of lips.groups) k = Math.max(k, Math.min(rampIn(s, g.start), rampOut(s, g.end)));
  return k;
}
