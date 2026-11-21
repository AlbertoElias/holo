/**
 * The face bar with marked face-away seconds (owner decision, 2026-11-21).
 *
 * The 40 px face bar (`BAR.faceBoxDevicePx`) does not apply to a performer in
 * the seconds its beat sheet marks as "head down or away on purpose"
 * (`faceAway` on the performer, each span with a reason). It applies in all
 * other seconds, unchanged. No mark means the bar applies.
 */

/** The most of the piece one performer may mark face-away. A proposal to the owner (2026-11-21); change it here only. */
export const FACE_AWAY_MAX_SHARE = 1 / 3;

/** Seconds where the head is turned down or away on purpose, and why ("looks down", "walks away"). */
export interface FaceAway {
  readonly from: number;
  readonly to: number;
  readonly why: string;
}

/** Seconds covered by the spans (overlaps count once). */
export function faceAwaySeconds(spans: readonly FaceAway[]): number {
  const sorted = [...spans].sort((a, b) => a.from - b.from);
  let total = 0;
  let end = -Infinity;
  for (const s of sorted) {
    const start = Math.max(s.from, end);
    if (s.to > start) total += s.to - start;
    end = Math.max(end, s.to);
  }
  return total;
}

/** Problems with one performer's marks: bad spans, a missing reason, or more than `FACE_AWAY_MAX_SHARE` of the piece. */
export function faceAwayProblems(performer: string, spans: unknown, duration: number): string[] {
  if (spans === undefined) return [];
  if (!Array.isArray(spans)) return [`${performer}: faceAway is a list of { "from", "to", "why" }`];
  const problems: string[] = [];
  for (const [i, s] of (spans as Partial<FaceAway>[]).entries()) {
    const at = `${performer}: faceAway[${i}]`;
    if (typeof s?.from !== 'number' || typeof s.to !== 'number' || !Number.isFinite(s.from) || !Number.isFinite(s.to)) { problems.push(`${at}: "from" and "to" are seconds`); continue; }
    if (s.from < 0 || s.to > duration || s.to <= s.from) problems.push(`${at}: ${s.from}–${s.to} s is not a span inside the ${duration} s piece`);
    if (typeof s.why !== 'string' || !s.why.trim()) problems.push(`${at}: give a reason in "why" (for example "looks down", "walks away")`);
  }
  if (problems.length) return problems;
  const marked = faceAwaySeconds(spans as FaceAway[]);
  if (marked > FACE_AWAY_MAX_SHARE * duration + 1e-9) {
    problems.push(`${performer}: faceAway marks ${round(marked)} s, more than ${round(FACE_AWAY_MAX_SHARE * 100)} % of the ${duration} s piece (${round(FACE_AWAY_MAX_SHARE * duration)} s): keep the face to the viewer for longer`);
  }
  return problems;
}

/** True when time `t` (s) is inside a marked span. */
export function isFaceAway(t: number, spans: readonly FaceAway[]): boolean {
  return spans.some((s) => t >= s.from && t < s.to);
}

export interface FaceSplit {
  /** Median face height (device px) over the frames outside the marks: the bar reads this. Null when no such frame has a face. */
  readonly unmarked: number | null;
  /** Median over the marked frames; null when nothing is marked or no marked frame has a face. Reported, not barred. */
  readonly marked: number | null;
}

/** The face's median height inside and outside the marks, from per-frame heights (null: no face on that frame). */
export function splitFace(frames: readonly { readonly t: number; readonly px: number | null }[], spans: readonly FaceAway[]): FaceSplit {
  const inside: number[] = [];
  const outside: number[] = [];
  for (const f of frames) if (f.px !== null) (isFaceAway(f.t, spans) ? inside : outside).push(f.px);
  return { unmarked: outside.length ? round(median(outside)) : null, marked: inside.length ? round(median(inside)) : null };
}

/** The bar: the unmarked median meets it. A performer with no unmarked face fails (nothing shows the face). */
export function faceBarPasses(split: FaceSplit, barPx: number): boolean {
  return split.unmarked !== null && split.unmarked >= barPx;
}

function median(v: readonly number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}
