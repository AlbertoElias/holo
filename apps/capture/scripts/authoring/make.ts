/**
 * One command from a beat sheet to a checked take: build, every bar the piece
 * must pass, the review pack, and what to fix in plain words. The way in for
 * an agent (`.agents/skills/hologram-authoring/SKILL.md`).
 *
 *   make.ts new <name>              copy sheets/starter.jsonc to output/authoring/pieces/<name>/sheet.jsonc
 *   make.ts words                   every choice a sheet can name: finishes, traits, expressions, gestures, …
 *   make.ts <sheet> [--quick]       build the next version (v1, v2, …) beside the sheet, check it, review it
 *   make.ts verdict <version dir>   the bars again, with the reader's comparison.json as filled in
 *
 * A `sheet.jsonc` under output/ keeps its versions beside it (`<its dir>/v<N>/`),
 * another sheet under output/ in `<its dir>/<sheet name>/v<N>/`, and any other
 * sheet's in output/authoring/pieces/<sheet name>/v<N>/. Each version
 * holds `take.glb` (and the files `direct.ts` writes beside it), `review/`
 * (the pack, `review.ts`) and `report.md` / `report.json`. A version after
 * the first is compared with the one before it (which spans changed).
 * `--quick` skips the review (about six minutes for an eight-second take)
 * and saves twelve stills instead (`viewer-check.ts --frames`, about a
 * minute); the face-box and reading bars stay pending.
 *
 * The bars, none of them loosened here: the sheet is valid; every grip, put
 * and aim lands on its mark (`OBJECT_LIMITS`); every reach is within reach;
 * each performer's dressed avatar file is at most 1.8 MB (`BAR.sizeBytes`);
 * the take is within the Quick Look budget (`validateTake`); each performer's
 * face is at least 40 device px brow to chin on the phone card
 * (`BAR.faceBoxDevicePx`); and a fresh reader reads every beat
 * (`comparison.json`, filled from their account). Exits 1 when a bar fails.
 */
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILDS, CLOTHING, EYES, FINISHES, GLASSES, HAIR_COLOUR, HAIR_STYLES, parseLook, SKIN } from '@holoim/avatar-look';

import { actingReport, diffTakes, summarize } from './acting-report.ts';
import { bodyLine, build, loadSheet, OBJECT_LIMITS, resolveAvatar } from './direct.ts';
import { BAR } from './lib/audition-bar.ts';
import { DEFAULT_TIMING, FACE_MIXES, GESTURES, houseFinish, parseSheetText, resolveTiming, STATES, validateSheet, type BeatSheet, type Place, type Point } from './lib/beats.ts';
import { solveTake } from './lib/direct.ts';
import { parseGlb } from './lib/gltf-read.ts';
import { HAND_SHAPES } from './lib/hands.ts';
import { LANDMARKS, MEASURES } from './lib/stage.ts';
import { validateTake } from './publish.ts';
import { review, type OnScreen } from './review.ts';

const CAPTURE = fileURLToPath(new URL('../../', import.meta.url));
const OUTPUT = join(CAPTURE, 'output');
const PIECES = join(OUTPUT, 'authoring', 'pieces');
const STARTER = fileURLToPath(new URL('./sheets/starter.jsonc', import.meta.url));
const ROOT = join(CAPTURE, '../..');

/** One bar: `pass` is null while it waits on something (the review, the reader). */
export interface Row {
  readonly id: string;
  readonly bar: string;
  readonly value: string;
  readonly pass: boolean | null;
  /** What to change, in plain words, when it fails or is pending. */
  readonly fix?: string;
  /** Reported, not a bar. */
  readonly advisory?: boolean;
}

const rel = (p: string): string => relative(process.cwd(), p) || '.';
const mb = (bytes: number): string => `${(bytes / 1e6).toFixed(2)} MB`;

/** `make.ts words`: every name a sheet can use, from the code. */
function words(): string {
  const list = (xs: readonly string[]) => xs.join(' | ');
  return [
    'avatar      house:clay | house:ink | house:light   (also stock, fixture:<name>, or a GLB path)',
    `finish      ${list(FINISHES)}`,
    'look card   (a performer\'s "look"; every field is required)',
    `  build     ${list(BUILDS)}`,
    `  skin      ${list(Object.keys(SKIN))}`,
    `  eyes      ${list(Object.keys(EYES))}`,
    `  hair      style: ${list(HAIR_STYLES)}`,
    `            colour: ${list(Object.keys(HAIR_COLOUR))}`,
    `  glasses   ${list(GLASSES)}`,
    `  clothing  ${Object.entries(CLOTHING).map(([k, v]) => `${k} (top rgb ${v.top.join(',')}, trousers rgb ${v.trousers.join(',')})`).join('\n            ')}`,
    '            fixed outfits: no other colours',
    `directions  ${list(Object.keys(DEFAULT_TIMING))}`,
    `expression  ${list(Object.keys(FACE_MIXES))}   (or face channels; at card size smile and sad read best)`,
    `gesture     ${list(Object.keys(GESTURES))}   (wave takes side, count, at)`,
    `state       ${list(Object.keys(STATES))}`,
    `hand shape  ${list(Object.keys(HAND_SHAPES))}`,
    `bend        amount 0..1 (forward from the waist; reach and look are solved on the bent body)`,
    `measures    ${list(MEASURES)}; landmark heights ${list(LANDMARKS)}   (e.g. "0.5 step", "hanging-hand")`,
    'timing      anticipation, attack, hold, settle (seconds) on any direction; delay shifts it in the beat',
  ].join('\n');
}

/** The version directory for a sheet's next build, and the one before it. */
async function versionDir(sheetFile: string): Promise<{ dir: string; previous?: string }> {
  const abs = resolve(sheetFile);
  const name = basename(abs).replace(/\.jsonc?$/, '');
  const home = !abs.startsWith(OUTPUT + sep) ? join(PIECES, name) : name === 'sheet' ? dirname(abs) : join(dirname(abs), name);
  await mkdir(home, { recursive: true });
  const taken = (await readdir(home)).map((n) => /^v(\d+)$/.exec(n)?.[1]).filter((n): n is string => !!n).map(Number);
  const n = taken.length ? Math.max(...taken) + 1 : 1;
  return { dir: join(home, `v${n}`), ...(n > 1 ? { previous: join(home, `v${n - 1}`) } : {}) };
}

/** A mark a hand reaches to during [from, to], with its side; the aim's hand position comes from it. */
function reachMarkDuring(sheet: BeatSheet, performer: string, side: string, from: number, to: number): string | undefined {
  for (const b of sheet.beats) {
    if (b.performer !== performer) continue;
    for (const d of b.directions) {
      if (d.kind !== 'reach' || d.side !== side || typeof d.at !== 'string' || !Object.hasOwn(sheet.marks ?? {}, d.at)) continue;
      const r = resolveTiming(b, d);
      if (r.start < to && r.end > from) return d.at;
    }
  }
  return undefined;
}

type Axis = { key: string; get: (p: Point) => number; set: (p: Point, v: number) => Point };

/** The numeric axes of a mark that a nudge may move. */
function axesOf(p: Point): Axis[] {
  if (Array.isArray(p)) return [0, 1, 2].map((i) => ({ key: ['x', 'y', 'z'][i]!, get: (q) => (q as number[])[i]!, set: (q, v) => (q as number[]).map((x, j) => (j === i ? v : x)) as unknown as Point }));
  if (typeof p !== 'object' || p === null) return [];
  const place = p as Place;
  return (['right', 'forward', 'height', 'up'] as const).filter((k) => k !== 'up' || place.height === undefined).map((k) => ({
    key: k,
    get: (q: Point) => { const v = (q as Place)[k]; return typeof v === 'number' ? v : 0; },
    set: (q: Point, v: number) => ({ ...(q as Place), [k]: Math.round(v * 100) / 100 }) as Point
  })).filter((a) => place[a.key as keyof Place] === undefined || typeof place[a.key as keyof Place] === 'number');
}

/**
 * For an aim that misses: moves the mark the hand reaches to (one axis at a
 * time, then the best two together) and solves again, so the build can say
 * which nudge makes the aim land. Solving only, about half a second each.
 */
async function fitAim(sheetFile: string, beat: string, side: string): Promise<string> {
  const { sheet, avatars, sources } = await loadSheet(sheetFile);
  const b = sheet.beats.find((x) => x.id === beat)!;
  const aim = b.directions.find((d) => d.kind === 'aim' && d.side === side)!;
  const r = resolveTiming(b, aim);
  const mark = reachMarkDuring(sheet, b.performer, side, r.start, r.end);
  if (!mark) return `no reach with the ${side} hand to a named mark during beat ${beat}: add one ("kind": "reach", "side": "${side}", "at": "<mark>", "stopShort": 0), with the mark beside and above what it pours on, so the hand is somewhere it can tip the tool from`;
  const original = sheet.marks![mark]!;
  const residual = (p: Point): number => {
    const trial: BeatSheet = { ...sheet, marks: { ...sheet.marks, [mark]: p } as NonNullable<BeatSheet['marks']> };
    if (validateSheet(trial).length) return Infinity;
    try {
      const take = solveTake(trial, avatars, sources);
      const a = take.objects.aims.find((x) => x.beat === beat && x.side === side);
      const reachMiss = take.tracks.flatMap((t) => t.reaches).some((x) => x.targetDistance - x.stopShort > 0.02 && x.outOfReach > 0.01);
      return (a?.residual ?? Infinity) + (reachMiss ? 100 : 0);
    } catch { return Infinity; }
  };
  const start = residual(original);
  const axes = axesOf(original);
  if (!axes.length) return `mark ${mark} is not numbers, so it cannot be nudged: give it as [x, y, z] or a place with numbers`;
  const tried: { p: Point; e: number; what: string }[] = [];
  for (const a of axes) for (const step of [-0.2, -0.15, -0.1, -0.05, 0.05, 0.1, 0.15, 0.2]) {
    const p = a.set(original, a.get(original) + step);
    tried.push({ p, e: residual(p), what: `${a.key} ${a.get(original)} → ${a.get(p)}` });
  }
  tried.sort((x, y) => x.e - y.e);
  let best = tried[0]!;
  if (best.e > OBJECT_LIMITS.aimResidual) {
    // Two axes together, around the best single nudge.
    const base = best;
    for (const a of axes) for (const step of [-0.1, -0.05, 0.05, 0.1]) {
      if (base.what.startsWith(`${a.key} `)) continue;
      const p = a.set(base.p, a.get(base.p) + step);
      const e = residual(p);
      if (e < best.e) best = { p, e, what: `${base.what}, ${a.key} ${a.get(original)} → ${a.get(p)}` };
    }
  }
  if (best.e >= start) return `no nudge of mark ${mark} within 20 cm helps (still ${start.toFixed(1)}°): move what it pours on nearer the hand's side and lower, or take the reach out and let the aim turn the hand where it is`;
  const lands = best.e <= OBJECT_LIMITS.aimResidual;
  return `${lands ? 'lands' : 'best found'} with marks.${mark} ${best.what} (${best.e.toFixed(1)}° off${lands ? '' : `, limit ${OBJECT_LIMITS.aimResidual}°`}): ${JSON.stringify(best.p)}`;
}

/** The face-box fix: what widens the card's frame. */
const FACE_FIX = 'the card frames the performers, every object and everything that moves, so the face gets smaller as that grows: '
  + 'keep objects within about 0.6 m of the performer and no higher than the head, leave out objects nobody acts on, '
  + 'avoid steps and wide reaches, and use one performer where the idea allows (two halve the face)';

/** The reading bar from a filled comparison.json; pending while any beat is unread. */
async function readingRow(reviewDir: string): Promise<Row> {
  const file = join(reviewDir, 'comparison.json');
  let c: { beats: { beat: string; intent: string | null; seen: string | null; reads: boolean | null; revise: string | null }[]; piece?: { reads: boolean | null } };
  try { c = JSON.parse(await readFile(file, 'utf8')); } catch { return { id: 'reading', bar: 'a fresh reader reads every beat', value: 'no review', pass: null, fix: 'run without --quick to make the review pack' }; }
  const beats = c.beats.filter((b) => b.intent);
  const unread = beats.filter((b) => b.reads === null);
  const missed = beats.filter((b) => b.reads === false);
  if (unread.length) {
    return { id: 'reading', bar: 'a fresh reader reads every beat', value: `${beats.length - unread.length} of ${beats.length} graded`, pass: null,
      fix: `give a fresh reader only ${rel(join(reviewDir, 'reader'))}/ (its README.md says what to answer), save the account as ${rel(join(reviewDir, 'reader.md'))}, have a fresh grader fill seen/reads/revise in ${rel(file)} from it, then run make.ts verdict ${rel(dirname(reviewDir))}` };
  }
  return { id: 'reading', bar: 'a fresh reader reads every beat', value: `${beats.length - missed.length} of ${beats.length} beats read${c.piece?.reads === false ? '; the piece as a whole did not' : ''}`,
    pass: missed.length === 0 && c.piece?.reads !== false,
    ...(missed.length ? { fix: missed.map((b) => `${b.beat}: ${b.revise ?? `the reader saw "${b.seen}"; make "${b.intent}" plainer`}`).join('; ') } : {}) };
}

/** The card names performers by their GLB node (the first is `RecordedAvatar`); the sheet's ids are in the same order. */
function faceRows(onScreen: OnScreen, ids: readonly string[]): Row[] {
  const rows: Row[] = [];
  for (const [i, perf] of onScreen.performers.entries()) {
    const p = { ...perf, name: onScreen.performers.length === ids.length ? ids[i]! : perf.name };
    rows.push({ id: `faceBox.${p.name}`, bar: `face ≥ ${BAR.faceBoxDevicePx} device px brow to chin on the phone card`, value: `${p.faceDevicePx} px (${p.faceMmOnPhone} mm)`, pass: p.faceDevicePx >= BAR.faceBoxDevicePx, ...(p.faceDevicePx < BAR.faceBoxDevicePx ? { fix: FACE_FIX } : {}) });
    const still = p.travelPerSecond.filter((s) => s.still).map((s) => `${s.from}–${s.from + 1} s`);
    if (still.length) rows.push({ id: `still.${p.name}`, bar: 'something moves every second at card size', value: `frozen ${still.join(', ')}`, pass: false, advisory: true, fix: 'give that second a direction (a look, a breath expression, a small weight shift) or shorten the hold' });
  }
  for (const o of onScreen.objects) if (o.wholeOnCard < 1) rows.push({ id: `onCard.${o.name}`, bar: 'each object wholly on the card', value: `${Math.round(o.wholeOnCard * 100)} % of the take`, pass: false, advisory: true, fix: `move ${o.name} nearer the performer` });
  return rows;
}

function formatRows(rows: readonly Row[]): string {
  const mark = (r: Row) => (r.pass === true ? 'pass' : r.pass === null ? 'wait' : r.advisory ? 'note' : 'FAIL');
  return rows.map((r) => `  ${mark(r).padEnd(4)} ${r.id}: ${r.value}  [${r.bar}]${r.fix && r.pass !== true ? `\n         fix: ${r.fix}` : ''}`).join('\n');
}

function verdictLine(rows: readonly Row[]): { text: string; failed: boolean } {
  const failed = rows.filter((r) => r.pass === false && !r.advisory);
  const waiting = rows.filter((r) => r.pass === null);
  if (failed.length) return { text: `NOT YET: ${failed.length} bar${failed.length > 1 ? 's' : ''} failed (${failed.map((r) => r.id).join(', ')}). Fix those in the sheet and run make.ts again.`, failed: true };
  if (waiting.length) return { text: `BUILT, bars pass so far; waiting on ${waiting.map((r) => r.id).join(', ')}.`, failed: false };
  return { text: 'DONE: every bar passes. Pick it, or publish with publish.ts (production by default; --check validates only).', failed: false };
}

async function writeReport(dir: string, sheetFile: string, rows: readonly Row[], notes: readonly string[]): Promise<string> {
  const v = verdictLine(rows);
  await writeFile(join(dir, 'report.json'), `${JSON.stringify({ sheet: resolve(sheetFile), verdict: v.text, rows, notes }, null, 2)}\n`);
  const md = [`# ${basename(dir)} of ${rel(sheetFile)}`, '', v.text, '', '```', formatRows(rows), '```', '', ...notes.map((n) => `- ${n}`), ''].join('\n');
  await writeFile(join(dir, 'report.md'), md);
  return v.text;
}

async function make(sheetFile: string, quick: boolean): Promise<boolean> {
  const notes: string[] = [];
  const rows: Row[] = [];
  // 1. The sheet: read it and check it before anything is solved.
  let sheet: BeatSheet;
  try { sheet = parseSheetText(await readFile(sheetFile, 'utf8'), rel(sheetFile)); } catch (e) { console.error(`FIX THE SHEET: ${(e as Error).message}`); return false; }
  const problems = validateSheet(sheet);
  for (const p of sheet.performers ?? []) {
    if (houseFinish(p.avatar) && p.look) { try { parseLook(p.look, `performer ${p.id} look`); } catch (e) { problems.push(`${(e as Error).message} (make.ts words lists every value)`); } }
    else if (houseFinish(p.avatar)) notes.push(`performer ${p.id} has no look: it wears the house default; add a "look" card to customise it (make.ts words)`);
  }
  for (const b of sheet.beats ?? []) if (!b.intent) notes.push(`beat ${b.id} has no intent: the reader cannot be checked against it`);
  if (problems.length) {
    console.error(`FIX THE SHEET (${rel(sheetFile)}):\n  ${problems.join('\n  ')}`);
    return false;
  }
  const { dir, previous } = await versionDir(sheetFile);
  await mkdir(dir, { recursive: true });
  const take = join(dir, 'take.glb');
  console.log(`${rel(sheetFile)} → ${rel(dir)}/`);

  // 2. Build.
  let built;
  try { built = await build(sheetFile, take); } catch (e) { console.error(`THE BUILD STOPPED: ${(e as Error).message}`); return false; }
  await copyFile(sheetFile, join(dir, basename(sheetFile)));
  console.log(`  built: ${built.take.times.length} frames, ${(built.take.times.length / built.take.fps).toFixed(1)} s, ${mb(built.bytes)}`);
  const glb = new Uint8Array(await readFile(take));
  const doc = parseGlb(glb);
  const looks = ((doc.json.asset as { extras?: { holoim?: { looks?: unknown[] } } }).extras?.holoim?.looks ?? []) as { performer?: string; card?: unknown; finish?: string }[];
  for (const l of looks) console.log(`  look: ${JSON.stringify(l)}`);

  // 3. Objects on their marks; reaches within reach.
  const L = OBJECT_LIMITS;
  for (const g of built.take.objects.grips) rows.push({ id: `grip.${g.beat}`, bar: `fist within ${L.gripDistance * 1000} mm and ${L.gripAngle}° of the grip`, value: `${(g.distance * 1000).toFixed(1)} mm, ${g.angle.toFixed(1)}°`, pass: g.distance <= L.gripDistance && g.angle <= L.gripAngle, fix: `${g.object} is out of the hand's comfortable reach or turned awkwardly: put it within about 0.5 m of the performer, at waist to chest height, or give the take a palm (up, down, in, toward)` });
  for (const p of built.take.objects.puts) rows.push({ id: `put.${p.beat}`, bar: `within ${L.putDistance * 1000} mm and ${L.putTilt}° of upright`, value: `${(p.distance * 1000).toFixed(1)} mm, ${p.tilt.toFixed(1)}°`, pass: p.distance <= L.putDistance && p.tilt <= L.putTilt, fix: `the place for ${p.object} is out of reach or not level: put it on an object's top ("on") within about 0.5 m of the performer` });
  for (const a of built.take.objects.aims) {
    const pass = a.residual <= L.aimResidual;
    rows.push({ id: `aim.${a.beat}`, bar: `${a.object}'s tool within ${L.aimResidual}° of its target`, value: `${a.residual.toFixed(1)}°`, pass, ...(pass ? {} : { fix: await fitAim(sheetFile, a.beat, a.side) }) });
  }
  for (const t of built.take.tracks) for (const r of t.reaches) {
    const out = r.targetDistance - r.stopShort > 0.02 && r.outOfReach > 0.01;
    rows.push({ id: `reach.${r.beat}`, bar: 'the palm gets to its point (within 2 cm, leaning allowed)', value: `${(r.targetDistance * 1000).toFixed(0)} mm from it`, pass: !out, ...(out ? { fix: `the point is beyond the arm even leaning: move it (or the performer) about ${(r.outOfReach * 100).toFixed(0)} cm nearer, add a step, or a bend for a low point` } : {}) });
  }
  for (const t of built.take.tracks) {
    const line = bodyLine(t.motion);
    rows.push({ id: `body.${t.spec.id}`, bar: 'feet planted, joints in range, no pops', value: line.split(';')[0]!, pass: !line.startsWith('FAIL'), advisory: true, ...(line.startsWith('FAIL') ? { fix: 'a step or a bend is too big or too quick: make it smaller or give it more attack time' } : {}) });
  }

  // 4. Size per avatar file, and the Quick Look budget.
  for (const p of built.take.sheet.performers) {
    const file = await resolveAvatar(p.avatar, sheetFile, p.look);
    const bytes = (await stat(file)).size;
    rows.push({ id: `size.${p.id}`, bar: `avatar file ≤ ${mb(BAR.sizeBytes)}`, value: mb(bytes), pass: bytes <= BAR.sizeBytes, ...(bytes > BAR.sizeBytes ? { fix: 'this avatar is over the budget: use a house: avatar, which is within it' } : {}) });
  }
  const checked = validateTake(glb, { quickLook: true });
  const ql = checked.facts?.quickLook;
  rows.push({ id: 'quickLook', bar: 'fit to publish, within the Quick Look budget', value: ql ? `deformed ${ql.deformed.toExponential(2)}, rigid ${ql.rigid.toExponential(2)} point-frames` : 'unreadable', pass: checked.problems.length === 0, ...(checked.problems.length ? { fix: `${checked.problems.join('; ')} (a shorter take, or fewer performers or objects)` } : {}) });

  // 5. Against the version before.
  if (previous) {
    try {
      const diff = diffTakes(parseGlb(new Uint8Array(await readFile(join(previous, 'take.glb')))), doc);
      notes.push(`against ${basename(previous)}: ${diff.spans.length ? diff.spans.map((s) => `${s.fromSec}–${s.toSec} s changed (${s.channels} ch)`).join(', ') : 'no difference'}`);
    } catch { /* the previous version did not build */ }
  }
  console.log(summarize(actingReport(doc, 'take.glb')).split('\n').map((l) => `  ${l}`).join('\n'));

  // 6. Review: the card, the face box, the reader's pack.
  const staticFailed = rows.some((r) => r.pass === false && !r.advisory);
  if (quick || staticFailed) {
    if (staticFailed && !quick) notes.push('review skipped: a bar above failed, so fix it first');
    const frames = join(dir, 'frames');
    const r = spawnSync('node', ['--conditions=development', '--import', 'tsx', fileURLToPath(new URL('./viewer-check.ts', import.meta.url)), take, '--frames', frames], { cwd: CAPTURE, encoding: 'utf8' });
    if (r.status === 0) {
      spawnSync('node', ['packages/tooling-testing/src/preview.mjs', frames], { cwd: ROOT, encoding: 'utf8' });
      notes.push(`twelve stills: ${rel(frames)}-sheet.jpg (look at it before the full review)`);
    } else notes.push(`stills failed: ${(r.stderr || r.stdout).split('\n').slice(-3).join(' ')}`);
    rows.push({ id: 'faceBox', bar: `face ≥ ${BAR.faceBoxDevicePx} device px on the card`, value: 'not measured', pass: null, fix: 'run without --quick (the review measures it)' });
    rows.push(await readingRow(join(dir, 'review')));
  } else {
    console.log('  reviewing (real time, a few minutes)…');
    const { onScreen } = await review(take, { sheet: join(dir, 'take.beats.json'), out: join(dir, 'review') });
    rows.push(...faceRows(onScreen, built.take.sheet.performers.map((p) => p.id)));
    const reviewDir = join(dir, 'review');
    spawnSync('node', ['packages/tooling-testing/src/preview.mjs', join(reviewDir, 'reader')], { cwd: ROOT, encoding: 'utf8' });
    notes.push(`watch: ${rel(join(reviewDir, 'reader', 'review.mp4'))}; card stills: ${rel(join(reviewDir, 'reader'))}/sheet-card-NN.jpg (preview with node packages/tooling-testing/src/preview.mjs <file>)`);
    rows.push(await readingRow(reviewDir));
  }

  const verdict = await writeReport(dir, sheetFile, rows, notes);
  console.log(`\n${formatRows(rows)}\n`);
  for (const n of notes) console.log(`  - ${n}`);
  console.log(`\n${verdict}\n  report: ${rel(join(dir, 'report.md'))}`);
  return !verdictLine(rows).failed;
}

async function verdict(dir: string): Promise<boolean> {
  const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as { sheet: string; rows: Row[]; notes: string[] };
  const rows = [...report.rows.filter((r) => r.id !== 'reading'), await readingRow(join(dir, 'review'))];
  const text = await writeReport(dir, report.sheet, rows, report.notes);
  console.log(`${formatRows(rows)}\n\n${text}`);
  return !verdictLine(rows).failed;
}

async function main(): Promise<void> {
  process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
  const args = process.argv.slice(2);
  const quick = args.includes('--quick');
  const rest = args.filter((a) => a !== '--quick');
  const usage = 'usage: make.ts new <name> | make.ts words | make.ts <sheet.jsonc> [--quick] | make.ts verdict <version dir>';
  if (rest[0] === 'words') { console.log(words()); return; }
  if (rest[0] === 'new') {
    const name = rest[1];
    if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) { console.error(`${usage}\n  a name is lower-case letters, digits and dashes, e.g. gardener-hello`); process.exit(2); }
    const home = join(PIECES, name);
    const file = join(home, 'sheet.jsonc');
    try { await stat(file); console.error(`${rel(file)} already exists: edit it, or pick another name`); process.exit(2); } catch { /* new */ }
    await mkdir(home, { recursive: true });
    await copyFile(STARTER, file);
    console.log(`${rel(file)}\n  edit it (every choice is listed in its comments), then: node --conditions=development --import tsx scripts/authoring/make.ts ${rel(file)}`);
    return;
  }
  if (rest[0] === 'verdict') {
    if (!rest[1]) { console.error(usage); process.exit(2); }
    process.exit((await verdict(resolve(rest[1]))) ? 0 : 1);
  }
  if (!rest[0]) { console.error(usage); process.exit(2); }
  process.exit((await make(rest[0], quick)) ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
