/**
 * Quick-builds the pieces in sheets/regression/ and fails when an arm or hand row gets worse than its pin.
 *
 *   node --conditions=development --import tsx scripts/authoring/solver-regression.ts [case…] [--write-pins]
 *
 * verify:pr runs it when a change touches the arm solve (scripts/authoring/lib/, make.ts or this folder),
 * so a solver fix for one piece cannot break the held grip of another piece before the merge (B-102).
 *
 * The failure modes it guards, written before the cases:
 * 1. A row that passed now fails (crouch v43 or pinch v14 lose a bar).
 * 2. A row that already failed gets worse (stone sD jump.props 5.7 → 15 m/s, goodbye v35 grip 0.4 → 14 mm):
 *    a pass/fail check alone cannot see this, so each pinned number is a ceiling (or, for a share, a floor).
 * 3. A pinned row is missing from the report (the bar was renamed or the beat stopped being checked).
 * 4. The build stops, hangs in the fit search, or writes no report. MAKE_NO_FIT=1 skips the fit search,
 *    and each build has a time limit.
 * 5. The build writes beside the tracked sheet. Each case is copied to the ignored output/ first.
 * 6. Two rows share an id (two reaches of one beat): each keeps its own pin (`reach.offer#2`).
 * 7. A pin is loosened to let a regression through. The pins change only with --write-pins, and the
 *    diff of pins.json shows each number that moved.
 * Exits 1 when a case gets worse.
 */
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..', '..');
const cases = join(here, 'sheets', 'regression');
const pinsFile = join(cases, 'pins.json');
const out = join(app, 'output', 'authoring', 'solver-regression');
/** Rows of the arm solve: grips, reaches, motion and the arm-against-object bars. */
const ROW = /^(grip|reach|put|aim|smooth|jump|turn|arms)\./;
/** A number may be this much worse (rounding between builds on different machines). */
const SLACK = { relative: 0.05, absolute: { mm: 0.5, '°': 0.5, 'm/s': 0.05, '°/s': 5, '%': 1 } as Record<string, number> };
const LIMIT_MS = 15 * 60_000;

interface Row { id: string; value: string; pass: boolean | null; advisory?: boolean }
interface Pin { pass: boolean; numbers: Array<[number, string]> }
type Pins = Record<string, Record<string, Pin>>;

/** The numbers of a row value with their units, e.g. "0.3 mm, 2.7°" → [[0.3, 'mm'], [2.7, '°']]. Times ("at 4.77 s") are left out. */
export function numbers(value: string): Array<[number, string]> {
  const found: Array<[number, string]> = [];
  for (const m of value.replace(/at [0-9.]+ s/g, '').matchAll(/(-?[0-9]+(?:\.[0-9]+)?) ?(mm|cm|m\/s|°\/s|°|%)/g)) {
    const unit = m[2] === 'cm' ? 'mm' : m[2]!;
    found.push([m[2] === 'cm' ? Number(m[1]) * 10 : Number(m[1]), unit]);
  }
  return found.slice(0, 2);
}

/** Why `now` is worse than `pin`, or null. A share (%) must not fall; every other number must not rise. */
export function worse(pin: Pin, now: Row | undefined): string | null {
  if (!now) return 'the row is missing from the report';
  if (pin.pass && now.pass === false) return `passed at the pin, now fails (${now.value})`;
  const got = numbers(now.value);
  for (const [i, [want, unit]] of pin.numbers.entries()) {
    const n = got[i];
    if (!n || n[1] !== unit) return `"${now.value}" has no ${unit} number where the pin has ${want} ${unit}`;
    const slack = Math.max(Math.abs(want) * SLACK.relative, SLACK.absolute[unit] ?? 0);
    if (unit === '%' ? n[0] < want - slack : n[0] > want + slack) return `${n[0]} ${unit} against the pin ${want} ${unit}`;
  }
  return null;
}

function build(sheet: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', join(here, 'make.ts'), sheet, '--quick'], {
      cwd: app,
      env: { ...process.env, MAKE_NO_FIT: '1' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), LIMIT_MS);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code ?? 1); });
    child.once('error', () => { clearTimeout(timer); resolve(1); });
  });
}

async function report(name: string, file: string): Promise<Row[] | null> {
  const dir = join(out, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  // Named sheet.<ext>, make.ts writes v1/ beside it (another name gets a folder of its own).
  const sheet = join(dir, `sheet${extname(file)}`);
  await cp(file, sheet);
  await build(sheet);
  const versions = (await readdir(dir)).filter((d) => /^v[0-9]+$/.test(d));
  if (versions.length === 0) return null;
  try { return (JSON.parse(await readFile(join(dir, versions[0]!, 'report.json'), 'utf8')) as { rows: Row[] }).rows; } catch { return null; }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const write = args.includes('--write-pins');
  const only = args.filter((a) => !a.startsWith('--'));
  const files = (await readdir(cases)).filter((f) => /\.jsonc?$/.test(f) && f !== 'pins.json');
  const pins: Pins = JSON.parse(await readFile(pinsFile, 'utf8').catch(() => '{}'));
  let failed = 0;
  for (const f of files) {
    const name = f.replace(/\.jsonc?$/, '');
    if (only.length && !only.includes(name)) continue;
    const started = Date.now();
    const rows = await report(name, join(cases, f));
    const took = `${((Date.now() - started) / 1000).toFixed(0)} s`;
    if (!rows) { failed += 1; console.log(`  FAIL ${name}: the build wrote no report (${took}); see output/authoring/solver-regression/${name}/`); continue; }
    const seen = new Map<string, number>();
    const solve = rows.filter((r) => ROW.test(r.id) && !r.advisory).map((r) => {
      const n = (seen.get(r.id) ?? 0) + 1;
      seen.set(r.id, n);
      return n === 1 ? r : { ...r, id: `${r.id}#${n}` };
    });
    if (write) {
      pins[name] = Object.fromEntries(solve.map((r) => [r.id, { pass: r.pass === true, numbers: numbers(r.value) }]));
      console.log(`  pin  ${name}: ${solve.length} rows (${took})`);
      continue;
    }
    const want = pins[name];
    if (!want) { failed += 1; console.log(`  FAIL ${name}: no pins; run with --write-pins and commit pins.json`); continue; }
    const problems = Object.entries(want).flatMap(([id, pin]) => {
      const why = worse(pin, solve.find((r) => r.id === id));
      return why ? [`${id}: ${why}`] : [];
    });
    if (problems.length === 0) console.log(`  ok   ${name}: ${Object.keys(want).length} rows at or under their pins (${took})`);
    else { failed += 1; console.log(`  FAIL ${name} (${took}):\n${problems.map((p) => `         ${p}`).join('\n')}`); }
  }
  if (write && failed) { console.log('pins not written: a case wrote no report'); process.exitCode = 1; return; }
  if (write) { await writeFile(pinsFile, `${JSON.stringify(pins, null, 2)}\n`); console.log(`wrote ${pinsFile}`); return; }
  if (failed) { console.log(`solver regression: ${failed} case(s) worse than the pins`); process.exitCode = 1; }
  else console.log('solver regression: every case at or under its pins');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
