/**
 * Directs a take from a beat sheet: solves it on each performer's avatar and
 * writes a hologram GLB (plus the sheet beside it and an acting report).
 *
 *   node --conditions=development --import tsx scripts/authoring/direct.ts <sheet.json> [--out take.glb] [--style flat|directed] [--against earlier.glb]
 *
 * A performer's `avatar` is a path relative to the sheet, `stock` (the shipped
 * avatar) or `fixture:<name>` (one of the generated avatar-format fixtures).
 * An object's `source` is a GLB path relative to the sheet or
 * `polyhaven:<id>` (packed by the API, cached under output/authoring/objects).
 * The build fails when a held object or a put lands off its mark: a grip more
 * than 1 cm or 5° off, a put more than 1 cm off or 3° from upright, or an aim
 * more than 10° off its target.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateAvatarFixtures, SHIPPED_AVATAR } from '../lib/avatar-fixtures.ts';
import { judgeMotion, measureMotion } from '../lib/motion-quality.ts';
import { actingReport, diffTakes, summarize } from './acting-report.ts';
import { loadAvatar, type LoadedAvatar } from './lib/avatar.ts';
import { validateSheet, type BeatSheet } from './lib/beats.ts';
import { solveTake, type ObjectReport, type SolvedTake } from './lib/direct.ts';
import { describeLife } from './lib/life.ts';
import { loadSources, type LoadedSource } from './lib/props.ts';
import { parseGlb } from './lib/gltf-read.ts';
import { writeTake } from './lib/write-glb.ts';

const OUTPUT = fileURLToPath(new URL('../../output/authoring/', import.meta.url));

export async function resolveAvatar(spec: string, sheetFile: string): Promise<string> {
  if (spec === 'stock') return SHIPPED_AVATAR;
  if (spec.startsWith('fixture:')) {
    const name = spec.slice('fixture:'.length);
    const file = join(OUTPUT, 'fixtures', `${name}.glb`);
    try { await readFile(file); } catch { await generateAvatarFixtures(join(OUTPUT, 'fixtures')); }
    return file;
  }
  return resolve(dirname(sheetFile), spec);
}

export async function loadSheet(sheetFile: string): Promise<{ sheet: BeatSheet; avatars: Map<string, LoadedAvatar>; sources: Map<string, LoadedSource> }> {
  const sheet = JSON.parse(await readFile(sheetFile, 'utf8')) as BeatSheet;
  const problems = validateSheet(sheet);
  if (problems.length) throw new Error(`${basename(sheetFile)}:\n  ${problems.join('\n  ')}`);
  const avatars = new Map<string, LoadedAvatar>();
  for (const p of sheet.performers) avatars.set(p.id, await loadAvatar(await resolveAvatar(p.avatar, sheetFile)));
  const sources = await loadSources(sheet.objects ?? {}, sheetFile, join(OUTPUT, 'objects'));
  return { sheet, avatars, sources };
}

/** What a build may miss by before it fails. */
export const OBJECT_LIMITS = { gripDistance: 0.01, gripAngle: 5, putDistance: 0.01, putTilt: 3, aimResidual: 10 } as const;

/** The lines of an object report, each with whether it is past its limit. */
export function objectLines(report: ObjectReport): { text: string; failed: boolean }[] {
  const L = OBJECT_LIMITS;
  return [
    ...report.grips.map((g) => ({ text: `${g.object} taken (${g.side}, beat ${g.beat}): fist ${(g.distance * 1000).toFixed(1)} mm from the grip, ${g.angle.toFixed(1)}° off its axis`, failed: g.distance > L.gripDistance || g.angle > L.gripAngle })),
    ...report.puts.map((p) => ({ text: `${p.object} put (${p.side}, beat ${p.beat}): ${(p.distance * 1000).toFixed(1)} mm from its place, ${p.tilt.toFixed(1)}° from upright`, failed: p.distance > L.putDistance || p.tilt > L.putTilt })),
    ...report.aims.map((a) => ({ text: `${a.object} aimed (${a.side}, beat ${a.beat}): ${a.residual.toFixed(1)}° off the target`, failed: a.residual > L.aimResidual }))
  ];
}

/** The authored source's body targets (feet, pops, joint limits, jitter) for one performer, one line. */
export function bodyLine(motion: Parameters<typeof measureMotion>[0]): string {
  const verdicts = judgeMotion(measureMotion(motion), 'authored');
  const failed = verdicts.filter((v) => !v.pass);
  return `${failed.length ? `FAIL ${failed.map((v) => v.metric).join(', ')}; ` : 'body targets pass; '}` +
    verdicts.map((v) => `${v.metric} ${v.value === null ? 'n/a' : Number(v.value.toFixed(v.metric.endsWith('Share') ? 3 : 2))}`).join(', ');
}

export interface BuildResult {
  readonly out: string;
  readonly take: SolvedTake;
  readonly channels: number;
  readonly seconds: number;
  readonly bytes: number;
}

export async function build(sheetFile: string, out?: string, style?: BeatSheet['style']): Promise<BuildResult> {
  const started = performance.now();
  const loaded = await loadSheet(sheetFile);
  const sheet: BeatSheet = style ? { ...loaded.sheet, style } : loaded.sheet;
  const { avatars, sources } = loaded;
  const take = solveTake(sheet, avatars, sources);
  const written = await writeTake(take, {
    author: 'HoloIM direction',
    title: sheet.title,
    method: `beat sheet ${basename(sheetFile)} solved on ${sheet.performers.map((p) => `${p.id} (${p.avatar})`).join(', ')}; ${sheet.style ?? 'directed'}`
  });
  const file = out ?? join(OUTPUT, `${basename(sheetFile, '.json')}.glb`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, written.glb);
  // The sheet as solved (with any --style override), beside the take.
  await writeFile(`${file.replace(/\.glb$/, '')}.beats.json`, `${JSON.stringify(sheet, null, 2)}\n`);
  if (take.props.length) await writeFile(`${file.replace(/\.glb$/, '')}.objects.json`, `${JSON.stringify(take.objects, null, 2)}\n`);
  return { out: file, take, channels: written.channels, seconds: (performance.now() - started) / 1000, bytes: written.glb.byteLength };
}

async function main(): Promise<void> {
  // Output piped into `head` closes early; that is not a failure.
  process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i === -1 ? undefined : args.splice(i, 2)[1]; };
  const out = flag('--out');
  const style = flag('--style') as BeatSheet['style'] | undefined;
  if (style && style !== 'flat' && style !== 'directed') { console.error('--style is flat or directed'); process.exit(2); }
  const against = flag('--against');
  const sheetFile = args[0];
  if (!sheetFile) {
    console.error('usage: direct.ts <sheet.json> [--out take.glb] [--style flat|directed] [--against earlier.glb]');
    process.exit(2);
  }
  const r = await build(sheetFile, out, style);
  console.log(`${basename(r.out)}: ${r.take.tracks.length} performer(s), ${r.take.times.length} frames at ${r.take.fps} fps, ${r.channels} channels, ${(r.bytes / 1e6).toFixed(1)} MB, built in ${r.seconds.toFixed(1)} s`);
  for (const t of r.take.tracks) for (const reach of t.reaches) {
    console.log(`  ${t.spec.id} reach ${reach.beat} (${reach.side}): palm ${(reach.targetDistance * 1000).toFixed(1)} mm from target, asked ${(reach.stopShort * 1000).toFixed(0)} mm` +
      (reach.targetDistance - reach.stopShort > 0.02 && reach.outOfReach > 0.01 ? `; out of reach even leaning: move the performers closer or add a step` : ''));
  }
  for (const t of r.take.tracks) {
    if (t.life) console.log(`  ${t.spec.id} life: ${describeLife(t.life, r.take.sheet.duration)}`);
    console.log(`  ${t.spec.id} body: ${bodyLine(t.motion)}`);
  }
  const lines = objectLines(r.take.objects);
  for (const l of lines) console.log(`  ${l.failed ? 'FAIL ' : ''}${l.text}`);
  const doc = parseGlb(new Uint8Array(await readFile(r.out)));
  console.log(summarize(actingReport(doc, basename(r.out))));
  if (against) {
    const diff = diffTakes(parseGlb(new Uint8Array(await readFile(against))), doc);
    console.log(`  against ${basename(against)}: ${diff.spans.length ? diff.spans.map((s) => `${s.fromSec}-${s.toSec} s (${s.channels} ch)`).join(', ') : 'no difference'}` +
      (diff.unmatched.length ? `; ${diff.unmatched.length} channels in one take only` : ''));
  }
  if (lines.some((l) => l.failed)) {
    console.error('an object misses its mark: change the reach, the palm or the object, or move the place');
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
