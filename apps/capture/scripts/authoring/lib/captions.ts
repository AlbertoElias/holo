/**
 * Captions of a take's spoken lines (docs/features/sound-voice-captions.md,
 * slice 3): a `HOLOIM_captions` root extension written from the beat sheet's
 * `say` lines, timed by the voiced sound, not the file start.
 */
import { CAPTIONS_EXTENSION, CAPTIONS_EXTENSION_VERSION, SPEECH_CUE_KIND, endsSentence, parseCaptions, splitCaptionText, type CaptionCue, type CaptionsExtension } from '@holoim/contracts';
import { parseGlb } from './gltf-read.ts';
import type { Line } from './sound.ts';

/** A gap between two cues shorter than this is bridged, so the chip does not blink between pieces of one line (s). */
const BRIDGE = 0.6;
/** The shortest a cue shows, to be read (s); longer only within the clip and before the next cue. */
const MIN_SHOW = 0.8;

/**
 * The BCP-47 tag of a line's language: Kokoro's `a…` voices are American, `b…` British (as `speak.mjs` phonemises them);
 * every other voice, a `file:` one included, is spoken and phonemised as English and tagged `en`, since a sheet has no
 * language field yet.
 */
export function lineLanguage(voice: string): string {
  if (voice.startsWith('local:a')) return 'en-US';
  if (voice.startsWith('local:b')) return 'en-GB';
  return 'en';
}

/**
 * The cues for a take's lines. A line longer than one chip line is split at
 * sentence and clause ends (choice 5). When every piece but the last ends a
 * sentence and there are as many voiced groups (a pause per sentence end), each
 * piece takes its group; otherwise a count that matches by chance (a clause
 * pause against a word-wrapped piece) would put words out of step with the
 * voice, so the pieces share the voiced span by length.
 */
export function captionCues(lines: readonly Line[], clip: number, speakerOf: (performer: string) => string): CaptionCue[] {
  const cues: CaptionCue[] = [];
  for (const line of lines) {
    const groups = line.lips.groups;
    if (!groups.length) continue;
    const start = line.at + groups[0]!.start;
    const end = line.at + groups[groups.length - 1]!.end;
    const pieces = splitCaptionText(line.text);
    const speaker = speakerOf(line.performer);
    const bySentence = pieces.length === groups.length && pieces.slice(0, -1).every(endsSentence);
    const spans = bySentence
      ? groups.map((g) => [line.at + g.start, line.at + g.end] as const)
      : byLength(pieces, start, end);
    pieces.forEach((text, i) => {
      const [from, to] = spans[i]!;
      cues.push({ from, to, text, kind: SPEECH_CUE_KIND, speaker });
    });
  }
  cues.sort((a, b) => a.from - b.from);
  const out: CaptionCue[] = [];
  cues.forEach((cue, i) => {
    const next = cues.slice(i + 1).find((c) => c.speaker === cue.speaker)?.from ?? Infinity;
    let to = Math.max(cue.to, cue.from + MIN_SHOW);
    if (next - cue.to < BRIDGE) to = next;
    to = Math.min(to, next, clip);
    const from = Math.min(Math.max(0, cue.from), clip);
    if (to - from > 1e-3) out.push({ ...cue, from: round(from), to: round(to) });
  });
  return out;
}

function byLength(pieces: readonly string[], start: number, end: number): (readonly [number, number])[] {
  const total = pieces.reduce((n, p) => n + p.length, 0) || 1;
  let t = start;
  return pieces.map((p) => {
    const from = t;
    t += ((end - start) * p.length) / total;
    return [from, t] as const;
  });
}

const round = (s: number): number => Math.round(s * 1000) / 1000;

/** The extension for a take's lines, or null when nothing is said. */
export function takeCaptions(lines: readonly Line[], clip: number, speakerOf: (performer: string) => string): CaptionsExtension | null {
  // One track: a take's lines are one language today; a mixed take keeps the first line's tag.
  const cues = captionCues(lines, clip, speakerOf);
  if (!cues.length) return null;
  return { version: CAPTIONS_EXTENSION_VERSION, tracks: [{ language: lineLanguage(lines[0]!.voice), cues }] };
}

/**
 * Adds `HOLOIM_captions` to a GLB's JSON (the binary chunk is untouched),
 * listed in `extensionsUsed` only. Reads it back with the viewer's parser
 * and fails if any cue would be dropped.
 */
export function addCaptions(glb: Uint8Array, captions: CaptionsExtension | null): Uint8Array {
  if (!captions) return glb;
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = view.getUint32(12, true);
  type Json = { extensions?: Record<string, unknown>; extensionsUsed?: string[]; extensionsRequired?: string[] };
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as Json;
  json.extensions = { ...(json.extensions ?? {}), [CAPTIONS_EXTENSION]: captions };
  json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), CAPTIONS_EXTENSION])];
  const text = JSON.stringify(json);
  const jsonBytes = new TextEncoder().encode(text + ' '.repeat((4 - (Buffer.byteLength(text) % 4)) % 4));
  const rest = glb.subarray(20 + jsonLength);
  const total = 20 + jsonBytes.byteLength + rest.byteLength;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true); v.setUint32(4, 2, true); v.setUint32(8, total, true);
  v.setUint32(12, jsonBytes.byteLength, true); v.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  out.set(rest, 20 + jsonBytes.byteLength);
  const back = readCaptions(out);
  const written = captions.tracks.reduce((n, t) => n + t.cues.length, 0);
  const read = back?.tracks.reduce((n, t) => n + t.cues.length, 0) ?? 0;
  if (read !== written) throw new Error(`HOLOIM_captions: wrote ${written} cues, the viewer's parser reads ${read}`);
  return out;
}

/** The captions a GLB carries, as a viewer reads them, or null. */
export function readCaptions(glb: Uint8Array): CaptionsExtension | null {
  const raw = (parseGlb(glb).json as { extensions?: Record<string, unknown> }).extensions?.[CAPTIONS_EXTENSION];
  if (raw === undefined) return null;
  const parsed = parseCaptions(raw);
  return parsed.ok ? parsed.value : null;
}
