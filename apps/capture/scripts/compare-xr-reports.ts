// Compares two runs of the capture XR checks: every JSON report and sample
// file under the two output directories, and each check's log in
// xr-checks/<name>.log (written when checks run in parallel). Timings and
// paths are dropped; numbers must agree within the tolerances below. Used to
// show a port of the checks still proves the same thing (slice 0 of
// docs/features/ui-redesign.md).
// Usage: node --import tsx scripts/compare-xr-reports.ts <before-output> <after-output> [summary.json]
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Wall-clock fields, which change with host speed and say nothing about the check.
const DROPPED_KEYS = new Set(['durationMs', 'elapsedMs', 'exportMs', 'totalMs', 'startedAt', 'finishedAt', 'generatedAt', 'timestamp']);

// Numbers agree when |a - b| <= ABSOLUTE + RELATIVE * max(|a|, |b|). The checks
// run on a frozen page clock with fixed fixtures, so the defaults only absorb
// float formatting; a file rule below needs a reason.
const ABSOLUTE = 1e-9;
const RELATIVE = 1e-9;
type Tolerance = { absolute: number; relative: number };
interface FileRule {
  reason: string;
  // Keys left out of this file's comparison.
  droppedKeys?: readonly string[];
  // Tolerances for this file's keys; `*` applies to every number, including log numbers.
  keys: Record<string, Tolerance>;
}

// Files whose numbers differ between two runs of the same commit, measured
// by running main twice (2026-10-24): the tolerance is about twice that spread.
const FILE_RULES: Record<string, FileRule> = {
  'ci-face/face-samples.json': {
    reason: "The voice jaw follows Chromium's fake microphone, which beeps in real time, not on the frozen page clock; jawOpen differs by up to 0.44 and is omitted when zero.",
    droppedKeys: ['jawOpen'],
    keys: {}
  },
  'ci-face/face-report.json': {
    reason: 'The same real-time voice jaw sets the peak and the exported animation size (up to 0.03% apart on main).',
    keys: { voiceJawMax: { absolute: 0.01, relative: 0 }, bytes: { absolute: 0, relative: 0.005 } }
  },
  'xr-checks/face.log': {
    reason: 'Prints the export size above.',
    keys: { '*': { absolute: 0, relative: 0.005 } }
  },
  'ci-xr-height/height-report.json': {
    reason: 'Positions differ by up to 0.45 mm between two runs of main.',
    keys: { x: { absolute: 1e-3, relative: 0 }, y: { absolute: 1e-3, relative: 0 }, z: { absolute: 1e-3, relative: 0 }, baseWorldY: { absolute: 1e-3, relative: 0 }, translation: { absolute: 1e-3, relative: 0 } }
  }
};

const PATH_LIKE = /^(\/|[A-Za-z]:\\)|\.(glb|png|jpe?g|json|webm|mp4|log)$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface Difference {
  at: string;
  before: unknown;
  after: unknown;
}

function normalizeString(value: string): string {
  if (PATH_LIKE.test(value)) return '<path>';
  if (ISO_TIME.test(value)) return '<time>';
  return value;
}

function numbersAgree(rule: FileRule | undefined, key: string, before: number, after: number): boolean {
  if (Number.isNaN(before) && Number.isNaN(after)) return true;
  const tolerance = rule?.keys[key] ?? rule?.keys['*'] ?? { absolute: ABSOLUTE, relative: RELATIVE };
  return Math.abs(before - after) <= tolerance.absolute + tolerance.relative * Math.max(Math.abs(before), Math.abs(after));
}

function compareJson(rule: FileRule | undefined, before: Json, after: Json, at: string, key: string, out: Difference[]): void {
  if (out.length >= 20) return;
  if (typeof before === 'number' && typeof after === 'number') {
    if (!numbersAgree(rule, key, before, after)) out.push({ at, before, after });
    return;
  }
  if (typeof before === 'string' && typeof after === 'string') {
    if (normalizeString(before) !== normalizeString(after)) out.push({ at, before, after });
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) out.push({ at: `${at}.length`, before: before.length, after: after.length });
    for (let index = 0; index < Math.min(before.length, after.length); index += 1) compareJson(rule, before[index]!, after[index]!, `${at}[${index}]`, key, out);
    return;
  }
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)].filter((name) => !DROPPED_KEYS.has(name) && !rule?.droppedKeys?.includes(name)));
    for (const name of keys) {
      if (!(name in before) || !(name in after)) out.push({ at: `${at}.${name}`, before: before[name] ?? '<missing>', after: after[name] ?? '<missing>' });
      else compareJson(rule, before[name]!, after[name]!, `${at}.${name}`, name, out);
    }
    return;
  }
  if (before !== after) out.push({ at, before, after });
}

// Log lines: durations ("in 7.3s", "goto 1.1s", "in 947 ms"), which the
// checks only print as wall-clock phase timings, and paths are masked; the
// remaining numbers are compared like report numbers.
function tokenizeLine(line: string): Array<string | number> {
  const masked = line
    .replace(/\b\d+(\.\d+)?\s?(ms|s)\b/g, '<time>')
    .replace(/(\/[\w.@-]+)+\/?/g, '<path>')
    .replace(/[\w.-]+\.(glb|png|jpe?g|webm|mp4|json)\b/g, '<file>');
  return masked.split(/(-?\d+(?:\.\d+)?(?:e-?\d+)?)/).filter(Boolean).map((part) => (/^-?\d/.test(part) ? Number(part) : part));
}

function compareLogs(rule: FileRule | undefined, before: string, after: string, out: Difference[]): void {
  const beforeLines = before.trimEnd().split('\n');
  const afterLines = after.trimEnd().split('\n');
  if (beforeLines.length !== afterLines.length) out.push({ at: 'lines', before: beforeLines.length, after: afterLines.length });
  for (let index = 0; index < Math.min(beforeLines.length, afterLines.length) && out.length < 20; index += 1) {
    const left = tokenizeLine(beforeLines[index]!);
    const right = tokenizeLine(afterLines[index]!);
    const agree = left.length === right.length && left.every((part, at) => {
      const other = right[at]!;
      return typeof part === 'number' && typeof other === 'number' ? numbersAgree(rule, '*', part, other) : part === other;
    });
    if (!agree) out.push({ at: `line ${index + 1}`, before: beforeLines[index], after: afterLines[index] });
  }
}

function listFiles(root: string, relative = ''): string[] {
  const files: string[] = [];
  for (const name of readdirSync(path.join(root, relative))) {
    const entry = path.join(relative, name);
    if (statSync(path.join(root, entry)).isDirectory()) files.push(...listFiles(root, entry));
    else if (name.endsWith('.json') || (relative === 'xr-checks' && name.endsWith('.log'))) files.push(entry);
  }
  return files.sort();
}

const [beforeDir, afterDir, summaryPath] = process.argv.slice(2);
if (!beforeDir || !afterDir) {
  console.error('Usage: compare-xr-reports.ts <before-output> <after-output> [summary.json]');
  process.exit(2);
}

const beforeFiles = listFiles(beforeDir);
const afterFiles = new Set(listFiles(afterDir));
const results: Array<{ file: string; status: 'same' | 'differs' | 'missing-after' | 'only-after'; differences?: Difference[] }> = [];
for (const file of beforeFiles) {
  if (!afterFiles.has(file)) {
    results.push({ file, status: 'missing-after' });
    continue;
  }
  afterFiles.delete(file);
  const before = readFileSync(path.join(beforeDir, file), 'utf8');
  const after = readFileSync(path.join(afterDir, file), 'utf8');
  const differences: Difference[] = [];
  const rule = FILE_RULES[file.split(path.sep).join('/')];
  if (file.endsWith('.json')) compareJson(rule, JSON.parse(before) as Json, JSON.parse(after) as Json, '$', '', differences);
  else compareLogs(rule, before, after, differences);
  results.push(differences.length > 0 ? { file, status: 'differs', differences } : { file, status: 'same' });
}
for (const file of afterFiles) results.push({ file, status: 'only-after' });

for (const result of results) {
  console.log(`${result.status.padEnd(13)} ${result.file}`);
  for (const difference of result.differences ?? []) {
    console.log(`  ${difference.at}: ${JSON.stringify(difference.before)?.slice(0, 160)} -> ${JSON.stringify(difference.after)?.slice(0, 160)}`);
  }
}
const failing = results.filter((result) => result.status !== 'same');
const summary = {
  tolerances: { absolute: ABSOLUTE, relative: RELATIVE, droppedKeys: [...DROPPED_KEYS], files: FILE_RULES },
  compared: results.length,
  same: results.length - failing.length,
  results
};
if (summaryPath) writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`[compare-xr-reports] ${summary.same}/${summary.compared} files agree`);
if (failing.length > 0) process.exitCode = 1;
