/**
 * Checks the face bar with marked face-away seconds (lib/face-bar.ts, owner decision 2026-11-21).
 *
 *   node --conditions=development --import tsx scripts/authoring/face-bar-check.ts
 *
 * The failure modes it guards, written before the cases:
 * 1. An unmarked small face passes (the rule turned into a loophole). Must fail.
 * 2. A small face only inside marked seconds still fails (the marks do nothing).
 * 3. A small face outside the marks passes because the marked big seconds lift the median.
 * 4. Marks over the limit, a mark with no reason, or a span outside the piece are accepted.
 * 5. Overlapping marks count twice, so a sheet under the limit is refused.
 * 6. A performer whose every face frame is marked passes with no face shown.
 * 7. A sheet marking face-away gets through validateSheet but not review (or the reverse).
 * 8. The pair bar (36 px, owner decision 2026-11-21) leaks: a pair under 36 px passes, or one
 *    performer (or three) under 40 px passes because the 36 px bar reaches them.
 * 9. make.ts's face row reads the solo bar for a pair (the pair bar does nothing there).
 * Exits 1 on the first wrong answer.
 */
import { BAR } from './lib/audition-bar.ts';
import { validateSheet, type BeatSheet } from './lib/beats.ts';
import { FACE_AWAY_MAX_SHARE, PAIR_FACE_BAR_PX, faceAwayProblems, faceBarPasses, faceBarPx, splitFace, type FaceAway } from './lib/face-bar.ts';
import { faceBoxRow } from './make.ts';

const bar = BAR.faceBoxDevicePx;
let failed = 0;
function expect(name: string, got: boolean, want: boolean): void {
  if (got === want) console.log(`  ok   ${name}`);
  else { failed += 1; console.log(`  FAIL ${name}: got ${got}, want ${want}`); }
}

/** 10 s at 5 frames a second; `px(t)` gives the face height. */
const frames = (px: (t: number) => number | null) => Array.from({ length: 50 }, (_, i) => ({ t: i / 5, px: px(i / 5) }));
const down: FaceAway[] = [{ from: 2, to: 4, why: 'looks down' }];
const small = bar - 8;
const big = bar + 6;

// 1. No marks: a face under the bar fails, as before the rule.
expect('unmarked small face fails', faceBarPasses(splitFace(frames(() => small), []), bar), false);
expect('unmarked small face fails when marks exist elsewhere', faceBarPasses(splitFace(frames((t) => (t >= 2 && t < 4 ? big : small)), down), bar), false);
// 2. Small only where marked: passes.
expect('small face only in marked seconds passes', faceBarPasses(splitFace(frames((t) => (t >= 2 && t < 4 ? 10 : big)), down), bar), true);
// 3. Big marked seconds do not lift a small unmarked median.
expect('big marked seconds do not lift the unmarked median', splitFace(frames((t) => (t >= 2 && t < 4 ? 200 : small)), down).unmarked === small, true);
// 6. Every face frame marked: no unmarked face, fails.
expect('no face outside the marks fails', faceBarPasses(splitFace(frames((t) => (t >= 2 && t < 4 ? big : null)), down), bar), false);
// 4. Sheet marks.
const limit = FACE_AWAY_MAX_SHARE * 10;
expect('marks at the limit are accepted', faceAwayProblems('her', [{ from: 0, to: limit, why: 'looks down' }], 10).length === 0, true);
expect('marks over the limit are refused', faceAwayProblems('her', [{ from: 0, to: limit + 0.1, why: 'looks down' }], 10).length > 0, true);
expect('a mark with no reason is refused', faceAwayProblems('her', [{ from: 1, to: 2, why: ' ' }], 10).length > 0, true);
expect('a span outside the piece is refused', faceAwayProblems('her', [{ from: 9, to: 11, why: 'walks away' }], 10).length > 0, true);
// 5. Overlaps count once: 0–3 and 2–3.3 cover 3.3 s, under the limit.
expect('overlapping marks count once', faceAwayProblems('her', [{ from: 0, to: 3, why: 'a' }, { from: 2, to: 3.3, why: 'b' }], 10).length === 0, true);
// 7. validateSheet refuses the same over-limit sheet.
const sheet = { title: 't', duration: 10, beats: [], performers: [{ id: 'her', avatar: 'stock', at: [0, 0], facing: 0, faceAway: [{ from: 0, to: 4, why: 'looks down' }] }] } as unknown as BeatSheet;
expect('validateSheet refuses marks over the limit', validateSheet(sheet).some((p) => p.includes('faceAway')), true);

// 8. The pair bar: 36 px for two performers only.
expect('the pair bar is 36 px and under the solo bar', PAIR_FACE_BAR_PX === 36 && PAIR_FACE_BAR_PX < bar, true);
const at = (px: number, n: number) => faceBarPasses(splitFace(frames(() => px), []), faceBarPx(n, bar));
expect('a pair at 35 px fails', at(35, 2), false);
expect('a pair at 36 px passes', at(36, 2), true);
expect('one performer at 39 px fails', at(39, 1), false);
expect('one performer at 37 px fails', at(37, 1), false);
expect('one performer at 40 px passes', at(40, 1), true);
expect('three performers at 37 px fail', at(37, 3), false);
expect('a pair at 35 px outside the marks fails though marked seconds are big', faceBarPasses(splitFace(frames((t) => (t >= 2 && t < 4 ? big : 35)), down), faceBarPx(2, bar)), false);
// 9. make.ts's face row, as the review gives it.
const performer = (px: number) => ({ name: 'her', faceSplitDevicePx: { unmarked: px, marked: null }, faceAway: [], faceMmOnPhone: 5, travelPerSecond: [{ from: 0, head: 1, hands: 1, still: false, faceDevicePx: px, faceAway: false }] }) as unknown as Parameters<typeof faceBoxRow>[0];
expect('the face row passes a pair at 37 px', faceBoxRow(performer(37), 2).pass === true, true);
expect('the face row fails a pair at 35 px', faceBoxRow(performer(35), 2).pass === false, true);
expect('the face row fails one performer at 37 px', faceBoxRow(performer(37), 1).pass === false, true);
expect('the face row names the 36 px pair bar', faceBoxRow(performer(35), 2).bar.includes('36 device px'), true);

if (failed) { console.log(`face bar check: ${failed} wrong`); process.exit(1); }
console.log('face bar check: all pass');
