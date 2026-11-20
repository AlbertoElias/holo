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
import { DEFAULT_TIMING, FACE_MIXES, GESTURES, houseFinish, parseSheetText, resolveTiming, STATES, validateSheet, type BeatSheet, type ObjectSpec, type Place, type Point } from './lib/beats.ts';
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

/** One number in the sheet a fit may move, read and written on a copy. */
interface Knob { readonly label: string; readonly steps: readonly number[]; get(s: BeatSheet): number; set(s: BeatSheet, v: number): BeatSheet }

const MOVE = [-0.2, -0.15, -0.1, -0.05, 0.05, 0.1, 0.15, 0.2];
const LIFT = [-0.12, -0.08, -0.04, -0.02, 0.02, 0.04, 0.08, 0.12];
const r2 = (v: number) => Math.round(v * 100) / 100;

/** The numeric axes of a point (a mark or an object's `at`), at `read`/`write` in the sheet. */
function pointKnobs(name: string, read: (s: BeatSheet) => Point | undefined, write: (s: BeatSheet, p: Point) => BeatSheet, start: BeatSheet): Knob[] {
  const p = read(start);
  if (Array.isArray(p)) {
    return [0, 1, 2].map((i) => ({ label: `${name}[${i}]`, steps: MOVE,
      get: (s) => (read(s) as readonly number[])[i]!,
      set: (s, v) => write(s, (read(s) as readonly number[]).map((x, j) => (j === i ? r2(v) : x)) as unknown as Point) }));
  }
  if (typeof p !== 'object' || p === null) return [];
  const place = p as Place;
  const keys = (['forward', 'right', place.height !== undefined ? 'height' : 'up'] as const).filter((k) => place[k] === undefined || typeof place[k] === 'number');
  return keys.map((k) => ({ label: `${name}.${k}`, steps: MOVE,
    get: (s) => { const v = (read(s) as Place)[k]; return typeof v === 'number' ? v : 0; },
    set: (s, v) => write(s, { ...(read(s) as Place), [k]: r2(v) } as Point) }));
}

function markKnobs(sheet: BeatSheet, mark: string): Knob[] {
  return pointKnobs(`marks.${mark}`, (s) => s.marks?.[mark], (s, p) => ({ ...s, marks: { ...s.marks, [mark]: p } as NonNullable<BeatSheet['marks']> }), sheet);
}

/** An object's place and, for a single box or cylinder, its height: the knobs that move where it is reached. */
function objectKnobs(sheet: BeatSheet, id: string): Knob[] {
  const o = sheet.objects?.[id];
  if (!o) return [];
  const put = (s: BeatSheet, next: ObjectSpec): BeatSheet => ({ ...s, objects: { ...s.objects, [id]: next } });
  const knobs = o.at === undefined || typeof o.at === 'string' ? [] : pointKnobs(`objects.${id}.at`, (s) => s.objects?.[id]?.at, (s, p) => put(s, { ...s.objects![id]!, at: p }), sheet);
  if (Array.isArray(o.size) && typeof o.size[1] === 'number') {
    knobs.push({ label: `objects.${id}.size[1] (its height)`, steps: LIFT,
      get: (s) => (s.objects![id]!.size as readonly number[])[1]!,
      set: (s, v) => { const z = s.objects![id]!.size as readonly number[]; return put(s, { ...s.objects![id]!, size: [z[0]!, r2(v), z[2]!] } as ObjectSpec); } });
  }
  return knobs;
}

type Miss = { kind: 'aim' | 'put' | 'grip'; beat: string; side: string };

/** How far a solve is from the bar for this miss: 1 or less lands, and the words for it. */
function missScore(take: ReturnType<typeof solveTake>, m: Miss): { e: number; words: string } {
  const L = OBJECT_LIMITS;
  const reachMiss = take.tracks.flatMap((t) => t.reaches).some((x) => x.targetDistance - x.stopShort > 0.02 && x.outOfReach > 0.01);
  const pen = reachMiss ? 100 : 0;
  if (m.kind === 'aim') {
    const a = take.objects.aims.find((x) => x.beat === m.beat && x.side === m.side);
    return a ? { e: a.residual / L.aimResidual + pen, words: `${a.residual.toFixed(1)}°` } : { e: Infinity, words: 'no aim' };
  }
  if (m.kind === 'put') {
    const p = take.objects.puts.find((x) => x.beat === m.beat && x.side === m.side);
    return p ? { e: Math.max(p.distance / L.putDistance, p.tilt / L.putTilt) + pen, words: `${(p.distance * 1000).toFixed(1)} mm, ${p.tilt.toFixed(1)}°` } : { e: Infinity, words: 'no put' };
  }
  const g = take.objects.grips.find((x) => x.beat === m.beat && x.side === m.side);
  return g ? { e: Math.max(g.distance / L.gripDistance, g.angle / L.gripAngle) + pen, words: `${(g.distance * 1000).toFixed(1)} mm, ${g.angle.toFixed(1)}°` } : { e: Infinity, words: 'no grip' };
}

/** The knobs that move where the hand has to be for this miss. */
function knobsFor(sheet: BeatSheet, m: Miss): { knobs: Knob[]; none?: string } {
  const b = sheet.beats.find((x) => x.id === m.beat)!;
  const kind = m.kind === 'grip' ? 'take' : m.kind;
  const d = b.directions.find((x) => x.kind === kind && 'side' in x && x.side === m.side) ?? b.directions.find((x) => x.kind === kind);
  if (!d) return { knobs: [], none: `beat ${m.beat} has no ${kind} direction to fit` };
  if (m.kind === 'aim') {
    const r = resolveTiming(b, d);
    const mark = reachMarkDuring(sheet, b.performer, m.side, r.start, r.end);
    if (!mark) return { knobs: [], none: `no reach with the ${m.side} hand to a named mark during beat ${m.beat}: add one ("kind": "reach", "side": "${m.side}", "at": "<mark>", "stopShort": 0) with the mark beside and above what it pours on, so the hand is somewhere it can tip the tool from` };
    return { knobs: markKnobs(sheet, mark) };
  }
  const knobs: Knob[] = [];
  const target = d as { at?: Point; on?: string; object?: string };
  if (m.kind === 'put') {
    if (target.on) knobs.push(...objectKnobs(sheet, target.on));
    else if (typeof target.at === 'string' && Object.hasOwn(sheet.marks ?? {}, target.at)) knobs.push(...markKnobs(sheet, target.at));
    else if (typeof target.at === 'string' && target.at.includes('.')) knobs.push(...objectKnobs(sheet, target.at.split('.')[0]!));
  } else {
    const id = target.object;
    if (id) {
      knobs.push(...objectKnobs(sheet, id).filter((k) => !k.label.includes('size')));
      const on = sheet.objects?.[id]?.on;
      if (on) knobs.push(...objectKnobs(sheet, on));
    }
  }
  return knobs.length ? { knobs } : { knobs, none: 'nothing in the sheet places it by numbers: give the surface or the mark a place ({ "of": "<performer>", "forward": … }) so it can be nudged' };
}

/**
 * For a grip, put or aim that misses: moves the numbers that decide where the
 * hand must go (a mark, the object's place, the surface's place and height),
 * one at a time and then the best two together, and solves again (about half
 * a second each), so the build can print the edit that lands it.
 */
async function fitMiss(sheetFile: string, m: Miss): Promise<string> {
  try { return await fitMissOrThrow(sheetFile, m); } catch (e) { return `(the fit could not run: ${(e as Error).message})`; }
}

/** For a take: the same sheet with the take's palm set each other way. */
function palmChoices(sheet: BeatSheet, m: Miss): { s: BeatSheet; edit: string }[] {
  if (m.kind !== 'grip') return [];
  const out: { s: BeatSheet; edit: string }[] = [];
  for (const palm of ['up', 'down', 'in', 'toward', undefined] as const) {
    let changed = false;
    const beats = sheet.beats.map((b) => b.id !== m.beat ? b : { ...b, directions: b.directions.map((d) => {
      if (d.kind !== 'take' || d.side !== m.side || d.palm === palm) return d;
      changed = true;
      const { palm: _old, ...rest } = d;
      return palm ? { ...rest, palm } : rest;
    }) });
    if (changed) out.push({ s: { ...sheet, beats }, edit: palm ? `the take's "palm": "${palm}"` : 'no "palm" on the take' });
  }
  return out;
}

async function fitMissOrThrow(sheetFile: string, m: Miss): Promise<string> {
  const { sheet, avatars, sources } = await loadSheet(sheetFile);
  const { knobs, none } = knobsFor(sheet, m);
  if (none && !palmChoices(sheet, m).length) return none;
  const score = (s: BeatSheet) => {
    if (validateSheet(s).length) return { e: Infinity, words: 'invalid' };
    try { return missScore(solveTake(s, avatars, sources), m); } catch { return { e: Infinity, words: 'did not solve' }; }
  };
  const start = score(sheet);
  type Try = { s: BeatSheet; e: number; words: string; edits: string[] };
  const tried: Try[] = [];
  for (const k of knobs) for (const step of k.steps) {
    const v = k.get(sheet) + step;
    const s = k.set(sheet, v);
    tried.push({ s, ...score(s), edits: [`${k.label} ${k.get(sheet)} → ${r2(v)}`] });
  }
  for (const c of palmChoices(sheet, m)) tried.push({ s: c.s, ...score(c.s), edits: [c.edit] });
  tried.sort((a, b) => a.e - b.e);
  let best = tried[0]!;
  if (best.e > 1) {
    const base = best;
    const second = [...knobs.map((k) => ({ k })), ...palmChoices(base.s, m).map((c) => ({ c }))];
    for (const c of second.filter((x): x is { c: { s: BeatSheet; edit: string } } => 'c' in x).map((x) => x.c)) {
      if (base.edits[0]!.includes('palm')) break;
      const t = score(c.s);
      if (t.e < best.e) best = { s: c.s, ...t, edits: [...base.edits, c.edit] };
    }
    for (const k of knobs) {
      if (base.edits[0]!.startsWith(`${k.label} `)) continue;
      for (const step of k.steps.filter((_, i) => i % 2 === 1)) {
        const v = k.get(base.s) + step;
        const s = k.set(base.s, v);
        const t = score(s);
        if (t.e < best.e) best = { s, ...t, edits: [...base.edits, `${k.label} ${k.get(sheet)} → ${r2(v)}`] };
      }
    }
  }
  if (!tried.length || best.e >= start.e) return `no nudge within 20 cm helps (still ${start.words}): move the performer or the object so the hand meets it in front of the body, between waist and chest height`;
  return `${best.e <= 1 ? 'lands' : 'best found'} with ${best.edits.join(' and ')} (${best.words})`;
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
  let { dir, previous } = await versionDir(sheetFile);
  // A full run after a --quick one of the same sheet finishes that version rather than making an identical next one.
  if (!quick && previous && !(await stat(join(previous, 'review')).then(() => true, () => false))) {
    const before = await readFile(join(previous, basename(sheetFile)), 'utf8').catch(() => null);
    if (before === (await readFile(sheetFile, 'utf8'))) {
      dir = previous;
      const n = Number(basename(previous).slice(1));
      previous = n > 1 ? join(dirname(previous), `v${n - 1}`) : undefined;
      notes.push(`the sheet is unchanged since the --quick build, so this run finishes ${basename(dir)}`);
    }
  }
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
  for (const g of built.take.objects.grips) {
    const pass = g.distance <= L.gripDistance && g.angle <= L.gripAngle;
    rows.push({ id: `grip.${g.beat}`, bar: `fist within ${L.gripDistance * 1000} mm and ${L.gripAngle}° of the grip`, value: `${(g.distance * 1000).toFixed(1)} mm, ${g.angle.toFixed(1)}°`, pass, ...(pass ? {} : { fix: await fitMiss(sheetFile, { kind: 'grip', beat: g.beat, side: g.side }) }) });
  }
  for (const p of built.take.objects.puts) {
    const pass = p.distance <= L.putDistance && p.tilt <= L.putTilt;
    rows.push({ id: `put.${p.beat}`, bar: `within ${L.putDistance * 1000} mm and ${L.putTilt}° of upright`, value: `${(p.distance * 1000).toFixed(1)} mm, ${p.tilt.toFixed(1)}°`, pass, ...(pass ? {} : { fix: await fitMiss(sheetFile, { kind: 'put', beat: p.beat, side: p.side }) }) });
  }
  for (const a of built.take.objects.aims) {
    const pass = a.residual <= L.aimResidual;
    rows.push({ id: `aim.${a.beat}`, bar: `${a.object}'s tool within ${L.aimResidual}° of its target`, value: `${a.residual.toFixed(1)}°`, pass, ...(pass ? {} : { fix: await fitMiss(sheetFile, { kind: 'aim', beat: a.beat, side: a.side }) }) });
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
