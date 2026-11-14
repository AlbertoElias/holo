/**
 * Directs a take from a beat sheet: solves it on each performer's avatar and
 * writes a hologram GLB (plus the sheet beside it and an acting report).
 *
 *   node --conditions=development --import tsx scripts/authoring/direct.ts <sheet.json> [--out take.glb] [--style flat|directed] [--against earlier.glb]
 *
 * A performer's `avatar` is a path relative to the sheet, `stock` (the shipped
 * avatar) or `fixture:<name>` (one of the generated avatar-format fixtures).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateAvatarFixtures, SHIPPED_AVATAR } from '../lib/avatar-fixtures.ts';
import { actingReport, diffTakes, summarize } from './acting-report.ts';
import { loadAvatar, type LoadedAvatar } from './lib/avatar.ts';
import type { BeatSheet } from './lib/beats.ts';
import { solveTake, type SolvedTake } from './lib/direct.ts';
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

export async function loadSheet(sheetFile: string): Promise<{ sheet: BeatSheet; avatars: Map<string, LoadedAvatar> }> {
  const sheet = JSON.parse(await readFile(sheetFile, 'utf8')) as BeatSheet;
  const avatars = new Map<string, LoadedAvatar>();
  for (const p of sheet.performers) avatars.set(p.id, await loadAvatar(await resolveAvatar(p.avatar, sheetFile)));
  return { sheet, avatars };
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
  const { avatars } = loaded;
  const take = solveTake(sheet, avatars);
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
    console.log(`  ${t.spec.id} reach ${reach.beat} (${reach.side}): palm ${(reach.targetDistance * 1000).toFixed(1)} mm from target, asked ${(reach.stopShort * 1000).toFixed(0)} mm`);
  }
  const doc = parseGlb(new Uint8Array(await readFile(r.out)));
  console.log(summarize(actingReport(doc, basename(r.out))));
  if (against) {
    const diff = diffTakes(parseGlb(new Uint8Array(await readFile(against))), doc);
    console.log(`  against ${basename(against)}: ${diff.spans.length ? diff.spans.map((s) => `${s.fromSec}-${s.toSec} s (${s.channels} ch)`).join(', ') : 'no difference'}` +
      (diff.unmatched.length ? `; ${diff.unmatched.length} channels in one take only` : ''));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
