/**
 * The six-second test (slice 3 of docs/features/directed-performance.md) as a
 * repeatable command. Two phases around the readers, who are subagents and so
 * are launched by the author's session, not by this script:
 *
 *   node --conditions=development --import tsx scripts/authoring/six-second-test.ts prepare <sheet.json> [--avatars stock,house-base] [--out dir] [--until 6] [--orbit 90]
 *   node --conditions=development --import tsx scripts/authoring/six-second-test.ts score <dir>
 *
 * `prepare` builds the sheet flat and directed on each avatar, renders the
 * first `--until` seconds of each take muted at the feed card's framing and
 * again from a camera swung `--orbit` degrees about the cast (`review.ts`, its
 * `--until`, `--card-only` and `--orbit` options), and writes
 * `<dir>/../readers/<code>/{card,orbit}/` (frames only) for fresh readers,
 * `prompts.md` (what to give readers and graders), the beat table and the
 * pass bar in `manifest.json` (the key from code to avatar and style).
 * `score` reads `answers/<code>/reader-N.json` ({ card, orbit }: the
 * readers' words) and `grades/<code>.json` (the blind grader's marks, below)
 * and writes `report.json` and `report.md`: each take against the sheet's
 * intent and the pass bar.
 *
 * A sheet needs a sidecar `<sheet>.six-second.json`:
 * `{ "hesitation": [beat ids], "feeling": [beat ids] }`: the beats that are
 * the point of the piece. Grades: `{ readers: { "1": { card: { beats: { <id>:
 * "yes"|"partly"|"no" }, evidence: { <id>: "the reader's words" } }, orbit: … } } }`.
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beatSpan, type BeatSheet } from './lib/beats.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(HERE, '../../output/authoring/six-second');
const HOUSE_BASE = join(HERE, '../../public/gltf/models/house-base.glb');
/** Readers per take unless `--readers` says otherwise: the bar's reader counts are for this many and scale with it. */
const DEFAULT_READERS = 3;
const GRADE = { yes: 1, partly: 0.5, no: 0 } as const;
type Grade = keyof typeof GRADE;

/** The pass bar, fixed in the brief before the first run. */
/** A reader sheet smaller than this is a black render, not a scene (real sheets are ~100-300 KB). */
const MIN_SHEET_BYTES = 30_000;

export const PASS_BAR = {
  hesitationReaders: 2,
  feelingReaders: 2,
  directedOverFlat: 0.15,
  directedMinimum: 0.5,
  orbitMaxDrop: 0.15
} as const;

export interface Sidecar { readonly hesitation: string[]; readonly feeling: string[] }
export interface Manifest {
  readonly sheet: string;
  readonly intent: string | null;
  readonly until: number;
  readonly orbit: number;
  readonly readers: number;
  readonly question: string;
  readonly blind: string;
  readonly sidecar: Sidecar;
  readonly beats: { id: string; performer: string; from: number; to: number; intent: string | null }[];
  readonly takes: { code: string; avatar: string; style: 'flat' | 'directed'; take: string; pack: string }[];
  readonly passBar: typeof PASS_BAR;
}

const questionFor = (performers: number): string => `What is happening, and what ${performers > 1 ? 'do the people' : 'does the person'} feel?`;

const avatarPath = (avatar: string): string => (avatar === 'house-base' ? HOUSE_BASE : avatar);

/** A cast is `label` (everyone is that avatar, each performer's own `look` dropped) or `label=her:house:clay,him:stock` (separate casts with `;` on the command line; an avatar per performer, `look` kept; a performer left out keeps the sheet's). */
export function castOf(entry: string, performers: readonly { id: string; avatar?: string }[]): { label: string; avatarOf: (p: { id: string; avatar?: string }) => string | undefined; keepLook: boolean } {
  const eq = entry.indexOf('=');
  if (eq === -1) return { label: entry, avatarOf: () => avatarPath(entry), keepLook: false };
  const per = new Map(entry.slice(eq + 1).split(',').map((pair) => { const c = pair.indexOf(':'); return [pair.slice(0, c), pair.slice(c + 1)] as const; }));
  for (const id of per.keys()) if (!performers.some((p) => p.id === id)) throw new Error(`cast ${entry}: no performer ${id} in the sheet`);
  return { label: entry.slice(0, eq), avatarOf: (p) => (per.has(p.id) ? avatarPath(per.get(p.id)!) : p.avatar), keepLook: true };
}

/** The bar's reader counts are written for DEFAULT_READERS; with more readers the same share is needed (2 of 3 is 4 of 6), never fewer. */
export const readersNeeded = (bar: number, readers: number): number => Math.ceil((bar * readers) / DEFAULT_READERS - 1e-9);

export async function prepare(sheetFile: string, options: { avatars?: string[]; out?: string; until?: number; orbit?: number; readers?: number } = {}): Promise<string> {
  const sheetPath = resolve(sheetFile);
  const avatars = options.avatars ?? ['stock', 'house-base'];
  const until = options.until ?? 6;
  const orbit = options.orbit ?? 90;
  const readers = options.readers ?? DEFAULT_READERS;
  if (!Number.isInteger(readers) || readers < 1) throw new Error(`--readers must be a whole number of readers per take, got ${readers}`);
  if (!Number.isFinite(until) || until <= 0) throw new Error(`--until must be a positive number of seconds, got ${until}`);
  if (!Number.isFinite(orbit)) throw new Error(`--orbit must be a number of degrees, got ${orbit}`);
  const out = resolve(options.out ?? join(OUTPUT, basename(sheetPath, '.json')));
  const sidecarName = basename(sheetPath).replace(/\.json$/, '.six-second.json');
  const sidecar = await readFile(join(dirname(sheetPath), sidecarName), 'utf8').then((t) => JSON.parse(t) as Sidecar, () => {
    throw new Error(`no sidecar ${sidecarName}: name the beats that are the point of the piece ({ "hesitation": [...], "feeling": [...] })`);
  });
  const sheet = JSON.parse(await readFile(sheetPath, 'utf8')) as BeatSheet;
  const ids = new Set(sheet.beats.map((b) => b.id));
  for (const id of [...sidecar.hesitation, ...sidecar.feeling]) {
    const beat = sheet.beats.find((b) => b.id === id);
    if (!beat) throw new Error(`sidecar names beat ${id}, which the sheet lacks (${[...ids].join(', ')})`);
    if (beatSpan(beat).from >= until) throw new Error(`sidecar beat ${id} starts at ${beatSpan(beat).from} s, after the first ${until} s`);
    if (!beat.intent) throw new Error(`sidecar beat ${id} has no intent in the sheet`);
  }
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, 'sheets'), { recursive: true });

  const takes: Manifest['takes'] = [];
  // Loaded here, once, so `score` runs without the renderer's dependencies built.
  const { build } = await import('./direct.ts');
  const { review } = await import('./review.ts');
  for (const avatar of avatars) {
    const cast = castOf(avatar, sheet.performers);
    for (const style of ['flat', 'directed'] as const) {
      const label = `${cast.label.replace(/[^\w-]+/g, '_')}-${style}`;
      const derived = join(out, 'sheets', `${label}.json`);
      const objects = sheet.objects
        ? Object.fromEntries(Object.entries(sheet.objects).map(([k, o]) => [k, typeof (o as { source?: unknown }).source === 'string' && !isAbsolute((o as { source: string }).source) ? { ...o, source: resolve(dirname(sheetPath), (o as { source: string }).source) } : o]))
        : undefined;
      await writeFile(derived, `${JSON.stringify({ ...sheet, style, performers: sheet.performers.map((p) => { const { look, ...rest } = p as typeof p & { look?: unknown }; const avatar = cast.avatarOf(p); return { ...rest, ...(cast.keepLook && look && avatar?.startsWith('house:') ? { look } : {}), avatar }; }), ...(objects ? { objects } : {}) }, null, 2)}\n`);
      const built = await build(derived, join(out, 'takes', `${label}.glb`), style);
      const pack = join(out, 'packs', label);
      // The headless renderer sometimes returns a black sheet (seen once: a take's first card sheet, 8 KB against ~300 KB). A reader would
      // then be graded on frames that show nothing, so render again, and refuse after three tries.
      for (let attempt = 1; ; attempt++) {
        await review(built.out, { sheet: derived, out: pack, until, cardOnly: true, orbit, step: 0.5 });
        const sheets = (await readdir(join(pack, 'reader'))).filter((f) => f.endsWith('.jpg'));
        const blank = [];
        for (const f of sheets) if ((await stat(join(pack, 'reader', f))).size < MIN_SHEET_BYTES) blank.push(f);
        if (!blank.length) break;
        if (attempt === 3) throw new Error(`${label}: reader sheet(s) ${blank.join(', ')} are blank after 3 renders`);
        console.warn(`${label}: blank reader sheet(s) ${blank.join(', ')}, rendering again`);
      }
      const code = `t${createHash('sha1').update(`${basename(sheetPath)}|${label}`).digest('hex').slice(0, 5)}`;
      takes.push({ code, avatar: cast.label, style, take: built.out, pack });
    }
  }

  // The readers' folders: frames only, under a code that says nothing about the take, and outside the sheet's folder so neither the path
  // (it names the piece) nor the neighbours (the key, the derived sheets) reach a reader.
  const blind = join(dirname(out), 'readers');
  for (const t of takes) {
    const files = await readdir(join(t.pack, 'reader'));
    await mkdir(join(blind, t.code, 'card'), { recursive: true });
    await mkdir(join(blind, t.code, 'orbit'), { recursive: true });
    for (const f of files) {
      if (f.startsWith('sheet-card-')) await cp(join(t.pack, 'reader', f), join(blind, t.code, 'card', f));
      else if (f.startsWith('sheet-orbit-')) await cp(join(t.pack, 'reader', f), join(blind, t.code, 'orbit', f));
    }
  }

  const window = sheet.beats.filter((b) => beatSpan(b).from < until).map((b) => ({ id: b.id, performer: b.performer, from: beatSpan(b).from, to: beatSpan(b).to, intent: b.intent ?? null }));
  const manifest: Manifest = { sheet: sheetPath, intent: sheet.intent ?? null, until, orbit, readers, question: questionFor(sheet.performers.length), blind, sidecar, beats: window, takes: takes.sort((a, b) => a.code.localeCompare(b.code)), passBar: PASS_BAR };
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(out, 'prompts.md'), prompts(manifest, out));
  console.log(`prepared ${takes.length} takes in ${out}\nreaders: ${takes.length * readers}; see ${join(out, 'prompts.md')}`);
  return out;
}

function prompts(m: Manifest, out: string): string {
  const codes = m.takes.map((t) => t.code);
  return [
    '# Prompts',
    '',
    `Run, for each code (${codes.join(', ')}), ${m.readers} fresh Sonnet readers. Give a reader only the paths below, never the sheet, the manifest, the intent or the style.`,
    '',
    '## Reader, question 1 (card framing)',
    '',
    `> Read the images in \`${join(m.blind, '<code>', 'card')}\` (frame sheets of a short, silent animation of people, as it would show on a phone, one still every 0.5 s with the time on each). You have been told nothing else; do not guess what the author intended. Answer: ${m.question} Then: what does each person do, in order, with the time? Use only what you see. Write the answer, and nothing else, in a few short paragraphs.`,
    '',
    '## Reader, question 2 (after the orbit), sent as a follow-up to the same reader once question 1 is answered and recorded',
    '',
    `> Now read the images in \`${join(m.blind, '<code>', 'orbit')}\`: the same moments, the camera swung ${m.orbit} degrees around the people. Answer the same: ${m.question} What does each person do, in order, with the time? Say whether anything you said before changes.`,
    '',
    '## Grader (one per code, blind to the style and the avatar)',
    '',
    `> You are given a reader's two accounts of a short silent animation and a list of what happens in it. For each reader and each account (card, orbit) and each beat listed, mark \`yes\` if the account names what the beat describes in any words (the right person, the right action, the right feeling where the beat has one), \`partly\` if it names part of it or only the right kind of thing, \`no\` if it does not or says something contrary. Quote the reader's words as evidence. Judge only what is written. Beats:`,
    '',
    ...m.beats.map((b) => `> - \`${b.id}\` (${b.from.toFixed(1)}–${b.to.toFixed(1)} s): ${b.intent ?? '(no intent)'}`),
    '',
    `> Write \`${join(out, 'grades', '<code>.json')}\` as { "readers": { "1": { "card": { "beats": { "<id>": "yes|partly|no" }, "evidence": { "<id>": "words" } }, "orbit": { … } }, … } }.`,
    '',
    `Save each reader's words to \`${join(out, 'answers', '<code>', 'reader-<n>.json')}\` as { "card": "…", "orbit": "…" }.`,
    ''
  ].join('\n');
}

export interface ViewScore { readonly beatScore: number; readonly beatScoreExact: number; readonly hesitation: number; readonly feeling: number; readonly readers: number }
export interface TakeScore { readonly code: string; readonly avatar: string; readonly style: 'flat' | 'directed'; readonly card: ViewScore; readonly orbit: ViewScore }
export interface Row { readonly id: string; readonly avatar: string; readonly pass: boolean; readonly detail: string }

type ReaderGrade = { beats: Record<string, Grade> };
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (x: number): number => Math.round(x * 100) / 100;
/** A comparison with the bar that floating-point error cannot flip. */
const atLeast = (x: number, bar: number): boolean => x >= bar - 1e-9;

/** One reader's score for one account: the beat score, and whether the two named points of the piece read. */
function scoreReader(g: ReaderGrade, m: Manifest): { beatScore: number; hesitation: boolean; feeling: boolean } {
  const mark = (id: string): number => {
    const v = g.beats[id];
    if (!v || !(v in GRADE)) throw new Error(`grade for beat ${id} is "${String(v)}": yes, partly or no`);
    return GRADE[v];
  };
  const hes = m.sidecar.hesitation.map(mark);
  const fee = m.sidecar.feeling.map(mark);
  return { beatScore: mean(m.beats.map((b) => mark(b.id))), hesitation: mean(hes) >= 0.5 && hes.some((x) => x === 1), feeling: mean(fee) >= 0.5 };
}

export function scoreTake(grades: { readers: Record<string, { card: ReaderGrade; orbit: ReaderGrade }> }, m: Manifest, view: 'card' | 'orbit'): ViewScore {
  const readers = Object.values(grades.readers).map((r) => scoreReader(r[view], m));
  const exact = mean(readers.map((r) => r.beatScore));
  return { beatScore: round(exact), beatScoreExact: exact, hesitation: readers.filter((r) => r.hesitation).length, feeling: readers.filter((r) => r.feeling).length, readers: readers.length };
}

/** The pass bar, per avatar. */
export function evaluate(takes: TakeScore[]): Row[] {
  const rows: Row[] = [];
  for (const avatar of [...new Set(takes.map((t) => t.avatar))]) {
    const directed = takes.find((t) => t.avatar === avatar && t.style === 'directed');
    const flat = takes.find((t) => t.avatar === avatar && t.style === 'flat');
    if (!directed || !flat) throw new Error(`${avatar}: needs both a flat and a directed take`);
    const row = (id: string, pass: boolean, detail: string) => rows.push({ id, avatar, pass, detail });
    const need = (bar: number): number => readersNeeded(bar, directed.card.readers);
    row('directed names the hesitation', directed.card.hesitation >= need(PASS_BAR.hesitationReaders), `${directed.card.hesitation} of ${directed.card.readers} readers (bar ${need(PASS_BAR.hesitationReaders)}); flat: ${flat.card.hesitation}`);
    row('directed names the feeling', directed.card.feeling >= need(PASS_BAR.feelingReaders), `${directed.card.feeling} of ${directed.card.readers} readers (bar ${need(PASS_BAR.feelingReaders)}); flat: ${flat.card.feeling}`);
    row('directed scores above flat', atLeast(directed.card.beatScoreExact - flat.card.beatScoreExact, PASS_BAR.directedOverFlat), `directed ${directed.card.beatScore}, flat ${flat.card.beatScore}, margin ${round(directed.card.beatScore - flat.card.beatScore)} (bar ${PASS_BAR.directedOverFlat})`);
    row('directed scores at least the minimum', atLeast(directed.card.beatScoreExact, PASS_BAR.directedMinimum), `${directed.card.beatScore} (bar ${PASS_BAR.directedMinimum})`);
    row('orbiting keeps the reading', atLeast(PASS_BAR.orbitMaxDrop, directed.card.beatScoreExact - directed.orbit.beatScoreExact), `card ${directed.card.beatScore}, orbit ${directed.orbit.beatScore} (drop at most ${PASS_BAR.orbitMaxDrop})`);
  }
  return rows;
}

export async function score(dir: string): Promise<{ rows: Row[]; takes: TakeScore[] }> {
  const out = resolve(dir);
  const m = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')) as Manifest;
  const takes: TakeScore[] = [];
  for (const t of m.takes) {
    const grades = JSON.parse(await readFile(join(out, 'grades', `${t.code}.json`), 'utf8').catch(() => { throw new Error(`no grades for ${t.code}: run the grader (prompts.md)`); })) as { readers: Record<string, { card: ReaderGrade; orbit: ReaderGrade }> };
    const n = Object.keys(grades.readers).length;
    if (n !== m.readers) throw new Error(`${t.code}: ${n} graded readers, ${m.readers} expected`);
    for (const r of Object.keys(grades.readers)) await readFile(join(out, 'answers', t.code, `reader-${r}.json`), 'utf8').catch(() => { throw new Error(`no answers/${t.code}/reader-${r}.json: a grade needs the words it grades`); });
    takes.push({ code: t.code, avatar: t.avatar, style: t.style, card: scoreTake(grades, m, 'card'), orbit: scoreTake(grades, m, 'orbit') });
  }
  const rows = evaluate(takes);
  const passed = rows.every((r) => r.pass);
  await writeFile(join(out, 'report.json'), `${JSON.stringify({ sheet: m.sheet, until: m.until, passBar: m.passBar, takes, rows, passed, note: `${m.readers} readers per take: 2 of 3 is a reading, not a measurement` }, null, 2)}\n`);
  const md = [
    `# Six-second test: ${basename(m.sheet)}`,
    '',
    `Intent: ${m.intent ?? '(none)'}`,
    `First ${m.until} s, muted, card framing, then the camera swung ${m.orbit} degrees. Question: ${m.question} ${m.readers} fresh readers per take; the bar is in \`manifest.json\`. ${m.readers} readers is a reading, not a measurement.`,
    '',
    '| avatar | style | beat score (card) | hesitation | feeling | beat score (orbit) |',
    '|---|---|---|---|---|---|',
    ...takes.map((t) => `| ${t.avatar} | ${t.style} | ${t.card.beatScore} | ${t.card.hesitation}/${t.card.readers} | ${t.card.feeling}/${t.card.readers} | ${t.orbit.beatScore} |`),
    '',
    '| avatar | row | | detail |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.avatar} | ${r.id} | ${r.pass ? 'pass' : '**FAIL**'} | ${r.detail} |`),
    '',
    passed ? 'All rows pass.' : 'Some rows fail; nothing was loosened.',
    ''
  ].join('\n');
  await writeFile(join(out, 'report.md'), md);
  for (const r of rows) console.log(`${r.pass ? 'ok  ' : 'FAIL'} ${r.avatar}: ${r.id}: ${r.detail}`);
  return { rows, takes };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i === -1 ? undefined : args.splice(i, 2)[1]; };
  const avatars = flag('--avatars'); const readers = flag('--readers'); const out = flag('--out'); const until = flag('--until'); const orbit = flag('--orbit');
  const [command, target] = args;
  if ((command !== 'prepare' && command !== 'score') || !target) {
    console.error('usage: six-second-test.ts prepare <sheet.json> [--avatars stock,house-base] [--out dir] [--until 6] [--orbit 90] [--readers 3]\n       six-second-test.ts score <dir>');
    process.exit(2);
  }
  try {
    if (command === 'prepare') await prepare(target, { ...(avatars ? { avatars: avatars.split(avatars.includes('=') ? ';' : ',') } : {}), ...(out ? { out } : {}), ...(until ? { until: Number(until) } : {}), ...(orbit ? { orbit: Number(orbit) } : {}), ...(readers ? { readers: Number(readers) } : {}) });
    else if (!(await score(target)).rows.every((r) => r.pass)) process.exit(1);
  } catch (e) {
    console.error(`six-second-test: ${(e as Error).message}`);
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
