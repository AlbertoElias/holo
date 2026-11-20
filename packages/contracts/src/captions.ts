// Captions of what is said in a take (docs/features/sound-voice-captions.md,
// slice 3): a `HOLOIM_captions` root extension, JSON only, listed in
// `extensionsUsed` and never in `extensionsRequired`, so an older viewer and
// the Quick Look converter ignore it (decision 3: no text in Quick Look).
//
// A caption is a reading of the event offered to a viewer (the meaning
// layer), not part of it. Plain TS with zod and no three, so the authoring
// writer and the viewer check the same shape.

import { z } from "zod";

export const CAPTIONS_EXTENSION = "HOLOIM_captions";
export const CAPTIONS_EXTENSION_VERSION = 1;
/** The kind of cue a viewer shows today: speech (titles are out, decision 7). */
export const SPEECH_CUE_KIND = "speech";
/**
 * The most characters a cue holds, so it fits one line on the card's chip
 * (decision recorded 2026-11-19, choice 5): the writer splits a longer line
 * into timed pieces. A reader accepts longer cues and lets the chip wrap.
 */
export const CAPTION_LINE_CHARS = 42;
/** The first performer's wrapper node name, the speaker of a cue that names none. */
export const FIRST_PERFORMER = "RecordedAvatar";
/** A cue's text cap for readers: anything longer is not a caption. */
export const CAPTION_TEXT_MAX = 500;

export type CaptionCue = {
  /** Take time the cue shows from (s). */
  from: number;
  /** Take time it ends (s), after `from`. */
  to: number;
  text: string;
  /** Any string, so a later kind does not void a file; viewers show `speech` only. */
  kind: string;
  /** The performer's wrapper node name (`RecordedAvatar` for the first); absent means the first performer. */
  speaker?: string;
};

export type CaptionTrack = {
  /** BCP-47 language tag, e.g. `en-US`. */
  language: string;
  /** Sorted by `from`. */
  cues: CaptionCue[];
};

export type CaptionsExtension = { version: 1; tracks: CaptionTrack[] };

const cueSchema = z
  .object({
    from: z.number().finite().nonnegative(),
    to: z.number().finite(),
    text: z.string().trim().min(1).max(CAPTION_TEXT_MAX),
    kind: z.string().min(1),
    speaker: z.string().min(1).optional()
  })
  .refine((cue) => cue.to > cue.from, { message: "to must be after from" });

const trackShape = z.object({ language: z.string().min(2).max(35), cues: z.array(z.unknown()) });
const extensionShape = z.object({ version: z.literal(CAPTIONS_EXTENSION_VERSION), tracks: z.array(z.unknown()) });

export type CaptionsParseResult = { ok: true; value: CaptionsExtension; dropped: string[] } | { ok: false; errors: string[] };

/**
 * Reads a `HOLOIM_captions` value. A bad cue or track is dropped (and named
 * in `dropped`), not the whole extension; only an unknown version or a
 * shape with no tracks array fails it. Cues come back sorted by `from`.
 */
export function parseCaptions(input: unknown): CaptionsParseResult {
  const root = extensionShape.safeParse(input);
  if (!root.success) return { ok: false, errors: root.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  const dropped: string[] = [];
  const tracks: CaptionTrack[] = [];
  root.data.tracks.forEach((rawTrack, t) => {
    const track = trackShape.safeParse(rawTrack);
    if (!track.success) {
      dropped.push(`tracks.${t}: ${track.error.issues[0]?.message ?? "invalid"}`);
      return;
    }
    const cues: CaptionCue[] = [];
    track.data.cues.forEach((rawCue, c) => {
      const cue = cueSchema.safeParse(rawCue);
      if (cue.success) {
        const { speaker, ...rest } = cue.data;
        cues.push(speaker === undefined ? rest : { ...rest, speaker });
      }
      else dropped.push(`tracks.${t}.cues.${c}: ${cue.error.issues.map((i) => `${i.path.join(".") || "cue"} ${i.message}`).join(", ")}`);
    });
    cues.sort((a, b) => a.from - b.from);
    tracks.push({ language: track.data.language, cues });
  });
  return { ok: true, value: { version: CAPTIONS_EXTENSION_VERSION, tracks }, dropped };
}

/**
 * The speech cue showing at `time` on a track, or null. When cues overlap
 * (two speakers at once) the one that began last wins, so the newest words
 * show; `speaker` narrows it to one performer.
 */
export function activeCue(track: CaptionTrack | null | undefined, time: number, speaker?: string): CaptionCue | null {
  if (!track) return null;
  let found: CaptionCue | null = null;
  for (const cue of track.cues) {
    if (cue.from > time) break;
    if (cue.kind !== SPEECH_CUE_KIND || time >= cue.to) continue;
    if (speaker !== undefined && (cue.speaker ?? FIRST_PERFORMER) !== speaker) continue;
    found = cue;
  }
  return found;
}

/** The track a viewer reads: the first one (a language choice comes with a second language). */
export function primaryTrack(captions: CaptionsExtension | null | undefined): CaptionTrack | null {
  return captions?.tracks.find((track) => track.cues.length > 0) ?? null;
}

/**
 * Splits a spoken line into pieces that each fit one chip line: at sentence
 * ends first, then clause marks, then word boundaries. Pure text; the writer
 * times the pieces.
 */
export function splitCaptionText(text: string, maxChars = CAPTION_LINE_CHARS): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];
  // A sentence ends at its punctuation and the space after it, so "3.50" and a leading "…" stay whole.
  const sentences = joinAbbreviations(clean.split(/(?<=[.!?…]["'”’)]*)\s+/).filter(Boolean));
  return sentences.flatMap((sentence) => (sentence.length <= maxChars ? [sentence] : wrapAtClauses(sentence, maxChars)));
}

/** A period that ends a title, a common abbreviation or an initial ("Mr.", "e.g.", "J.") ends no sentence. */
const NOT_A_SENTENCE_END = /(?:^|\s)(?:mr|mrs|ms|dr|prof|st|sr|jr|vs|etc|no|e\.g|i\.e|[a-z])\.$/i;

/** Joins a piece the sentence match cut at such a period to the piece after it. */
function joinAbbreviations(pieces: string[]): string[] {
  const out: string[] = [];
  for (const piece of pieces) {
    const last = out[out.length - 1];
    if (last !== undefined && NOT_A_SENTENCE_END.test(last)) out[out.length - 1] = `${last} ${piece}`;
    else out.push(piece);
  }
  return out;
}

/** Whether a piece ends a sentence (its writer may then give it a voiced group of its own). */
export function endsSentence(piece: string): boolean {
  return /[.!?…]["'”’)]*$/.test(piece) && !NOT_A_SENTENCE_END.test(piece);
}

/**
 * Fills each piece word by word; on overflow it breaks after the last clause
 * mark in the piece when that leaves the piece at least 40 % full, else at
 * the word, so no piece is a lone fragment like "yesterday,".
 */
function wrapAtClauses(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let words: string[] = [];
  const length = (list: string[]) => list.join(" ").length;
  for (const word of text.split(" ")) {
    if (words.length && length([...words, word]) > maxChars) {
      let cut = words.length;
      for (let i = words.length - 1; i > 0; i -= 1) {
        if (/[,;:—–]$/.test(words[i - 1] ?? "") && length(words.slice(0, i)) >= maxChars * 0.4) {
          cut = i;
          break;
        }
      }
      out.push(words.slice(0, cut).join(" "));
      words = words.slice(cut);
    }
    words.push(word);
  }
  if (words.length) out.push(words.join(" "));
  return out;
}
