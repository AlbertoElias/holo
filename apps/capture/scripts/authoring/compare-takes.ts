/**
 * Step 4 of slice 4a (docs/features/directed-performance.md): the same acting
 * report on a person's recorded take and on an agent-directed take of the same
 * action, side by side.
 *
 *   node --conditions=development --import tsx scripts/authoring/compare-takes.ts <person.glb> <agent.glb> [--out <dir>]
 *
 * Each take is read twice: by the acting report (`acting-report.ts`: what
 * moves and what is frozen, fingers, face, eyes) and as an imported take
 * (`lib/take.ts`: the beats found in its motion, how still its holds are, how
 * fast its hands go, how its head and body travel). Writes
 * `<out>/<person>-vs-<agent>.compare.md` and `.compare.json`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { measureMotion } from '../lib/motion-quality.ts';
import { actingReport, type PerformerReport } from './acting-report.ts';
import { parseGlb } from './lib/gltf-read.ts';
import { headTurnSpeed, importTake, jointSpeed, lookAt, takeMotion, type Take } from './lib/take.ts';

const round = (v: number, d = 2): number => Number(v.toFixed(d));
const quantile = (xs: number[], q: number): number => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : 0; };

export interface TakeReading {
  readonly file: string;
  readonly acting: { readonly changing: string; readonly bones: number; readonly face: string; readonly fingers: string; readonly eyes: string; readonly frozenSec: number; readonly verdict: string[] };
  readonly motion: Record<string, number | string>;
}

/** Motion numbers from an imported take: what a viewer sees as pacing, stillness and travel. */
export function motionNumbers(take: Take): Record<string, number | string> {
  const wrist: number[] = []; const head: number[] = [];
  for (let f = 0; f < take.frames; f += 1) {
    wrist.push(Math.max(jointSpeed(take, 'leftWrist', f), jointSpeed(take, 'rightWrist', f)));
    head.push(headTurnSpeed(take, f));
  }
  const holds = take.beats.filter((b) => b.kind === 'hold');
  const moves = take.beats.filter((b) => b.kind === 'move');
  const inHolds: number[] = [];
  for (const h of holds) for (let f = Math.round(h.from * take.fps); f <= Math.round(h.to * take.fps); f += 1) inHolds.push(wrist[f]!);
  // A hesitation: inside a move of at least 0.5 s, the hands slow below a third of that move's peak and speed up again.
  let hesitations = 0;
  for (const m of moves) {
    if (m.to - m.from < 0.5) continue;
    const a = Math.round(m.from * take.fps); const b = Math.round(m.to * take.fps);
    const seg = wrist.slice(a, b + 1); const peak = Math.max(...seg);
    let low = false; let rose = false;
    for (let i = 1; i < seg.length; i += 1) {
      if (!rose && seg[i]! > peak * 0.6) rose = true;
      if (rose && !low && seg[i]! < peak / 3) low = true;
      if (low && seg[i]! > peak * 0.6) { hesitations += 1; low = false; }
    }
  }
  const firstMove = wrist.findIndex((s) => s > 0.3);
  const yaws: number[] = []; const pitches: number[] = [];
  for (let f = 0; f < take.frames; f += 1) { const l = lookAt(take, f); yaws.push(l.yaw); pitches.push(l.pitch); }
  const travel = (joint: 'hips' | 'chest' | 'head'): number => {
    const t = take.joints[joint]; if (!t) return 0; let d = 0;
    for (let f = 1; f < take.frames; f += 1) d += Math.hypot(t[f * 3]! - t[f * 3 - 3]!, t[f * 3 + 1]! - t[f * 3 - 2]!, t[f * 3 + 2]! - t[f * 3 - 1]!);
    return d;
  };
  const hipsY = take.hips.filter((_, i) => i % 3 === 1);
  const m = measureMotion(takeMotion(take));
  return {
    'duration s': take.duration,
    'beats found (moves / holds)': `${moves.length} / ${holds.length}`,
    // A beat's `to` is its last frame's time, so a span is one frame longer than to − from.
    'share of time in holds': round(holds.reduce((s, h) => s + h.to - h.from + 1 / take.fps, 0) / (take.duration + 1 / take.fps)),
    'longest hold s': round(Math.max(0, ...holds.map((h) => h.to - h.from + 1 / take.fps))),
    'first hand move at s': firstMove < 0 ? 'never' : round(firstMove / take.fps),
    'hand speed peak m/s': round(Math.max(...wrist)),
    'hand speed p95 m/s': round(quantile(wrist, 0.95)),
    'hand speed in holds, median m/s': round(quantile(inHolds, 0.5), 3),
    'hesitations inside moves': hesitations,
    'head yaw range °': round(Math.max(...yaws) - Math.min(...yaws), 1),
    'head pitch range °': round(Math.max(...pitches) - Math.min(...pitches), 1),
    'head turn peak °/s': round(Math.max(...head), 0),
    'head travel m': round(travel('head')),
    'chest travel m': round(travel('chest')),
    'hips travel m': round(travel('hips')),
    'hips height below bind, median m': round((take.measures.bind.hips?.[1] ?? 0) - quantile(hipsY, 0.5), 3),
    'jitter p95 mm': m.jitterP95Mm === null ? 'n/a' : round(m.jitterP95Mm),
    'pop p99 m/s²': m.popP99MS2 === null ? 'n/a' : round(m.popP99MS2)
  };
}

function actingOf(p: PerformerReport): TakeReading['acting'] {
  return {
    changing: `${p.changing}/${p.channels}`,
    bones: p.bones.length,
    face: `${p.face.moving.length}/${p.faceShapeCount}`,
    fingers: `${p.fingers.moving.length}/${p.fingers.bones}`,
    eyes: `${p.eyes.moving ? 'move' : 'still'} (${p.eyes.by})`,
    frozenSec: round(p.frozenSec, 1),
    verdict: p.verdict
  };
}

export async function readTakeFile(file: string): Promise<TakeReading> {
  const doc = parseGlb(new Uint8Array(await readFile(file)));
  const r = actingReport(doc, basename(file));
  const p = r.performers[0];
  if (!p) throw new Error(`${file}: no skinned performer`);
  return { file: basename(file), acting: actingOf(p), motion: motionNumbers(await importTake(file)) };
}

export function compareMarkdown(a: TakeReading, b: TakeReading): string {
  const row = (label: string, x: unknown, y: unknown): string => `| ${label} | ${String(x)} | ${String(y)} |`;
  const lines = [
    `# Person and agent, same action: ${a.file} and ${b.file}`,
    '',
    '## Acting report',
    '',
    `| | person (${a.file}) | agent (${b.file}) |`,
    '|---|---|---|',
    row('channels that change', a.acting.changing, b.acting.changing),
    row('bones that move', a.acting.bones, b.acting.bones),
    row('face shapes that move', a.acting.face, b.acting.face),
    row('finger bones that move', a.acting.fingers, b.acting.fingers),
    row('eyes', a.acting.eyes, b.acting.eyes),
    row('frozen s (no channel moves for 1 s or more)', a.acting.frozenSec, b.acting.frozenSec),
    row('verdict', a.acting.verdict.join('; ') || 'none', b.acting.verdict.join('; ') || 'none'),
    '',
    '## Motion',
    '',
    `| | person | agent |`,
    '|---|---|---|',
    ...Object.keys(a.motion).map((k) => row(k, a.motion[k], b.motion[k])),
    ''
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const out = resolve(flag('--out') ?? 'output/take-input');
  const [person, agent] = args;
  if (!person || !agent) throw new Error('usage: compare-takes.ts <person.glb> <agent.glb> [--out <dir>]');
  const a = await readTakeFile(resolve(person));
  const b = await readTakeFile(resolve(agent));
  const name = `${basename(person, '.glb')}-vs-${basename(agent, '.glb')}`;
  await mkdir(out, { recursive: true });
  const md = compareMarkdown(a, b);
  await writeFile(join(out, `${name}.compare.md`), md);
  await writeFile(join(out, `${name}.compare.json`), JSON.stringify({ person: a, agent: b }, null, 2));
  console.log(md);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
