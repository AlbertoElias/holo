/**
 * Directs a take from a beat sheet: solves it on each performer's avatar and
 * writes a hologram GLB (plus the sheet beside it and an acting report).
 *
 *   node --conditions=development --import tsx scripts/authoring/direct.ts <sheet.json> [--out take.glb] [--style flat|directed] [--against earlier.glb] [--avatar spec]
 *
 * A performer's `avatar` is a path relative to the sheet, `stock` (the shipped
 * avatar), `fixture:<name>` (one of the generated avatar-format fixtures) or
 * `house:<finish>` (the house base in clay, ink or light, dressed in the performer's `look` card).
 * An object's `source` is a GLB path relative to the sheet or
 * `polyhaven:<id>` (packed by the API, cached under output/authoring/objects).
 * A beat's `say` and the sheet's `sounds` are written as `KHR_audio`, each
 * padded to the clip and looping with it; `--avatar <spec>` recasts every
 * performer onto one avatar (a one-performer sheet on another body).
 * The build fails when a held object or a put lands off its mark: a grip more
 * than 1 cm or 5° off, a put more than 1 cm off or 3° from upright, or an aim
 * more than 10° off its target.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CaptionsExtension } from '@holoim/contracts';
import { parseLook, type LookCard } from '@holoim/avatar-look';

import { generateAvatarFixtures, SHIPPED_AVATAR } from '../lib/avatar-fixtures.ts';
import { judgeMotion, measureMotion } from '../lib/motion-quality.ts';
import { actingReport, diffTakes, summarize } from './acting-report.ts';
import { loadAvatar, type LoadedAvatar } from './lib/avatar.ts';
import { houseFinish, parseSheetText, validateSheet, type BeatSheet } from './lib/beats.ts';
import { defaultLook, dressedFile, HOUSE_BASE } from './lib/house-look.ts';
import { solveTake, type ObjectReport, type SolveOptions, type SolvedTake } from './lib/direct.ts';
import { describeAttend, describeLife } from './lib/life.ts';
import { loadSources, type LoadedSource } from './lib/props.ts';
import { parseGlb } from './lib/gltf-read.ts';
import { addCaptions, takeCaptions } from './lib/captions.ts';
import { addAudio, padAndEncode, prepareEffects, prepareLine, probeSeconds, type AudioSource, type Effect, type Line } from './lib/sound.ts';
import { solveWorld } from './lib/world.ts';
import { writeTake } from './lib/write-glb.ts';
import { phaseLine, phaseMark, startPhases, type Phase } from './lib/phases.ts';

const OUTPUT = fileURLToPath(new URL('../../output/authoring/', import.meta.url));

export async function resolveAvatar(spec: string, sheetFile: string, look?: LookCard): Promise<string> {
  if (spec === 'stock') return SHIPPED_AVATAR;
  const finish = houseFinish(spec);
  if (finish === 'clay' && !look) return HOUSE_BASE;
  if (finish) return dressedFile(look ? parseLook(look) : await defaultLook(), finish);
  if (spec.startsWith('fixture:')) {
    const name = spec.slice('fixture:'.length);
    const file = join(OUTPUT, 'fixtures', `${name}.glb`);
    try { await readFile(file); } catch { await generateAvatarFixtures(join(OUTPUT, 'fixtures')); }
    return file;
  }
  return resolve(dirname(sheetFile), spec);
}

/**
 * Loaded avatars that a long-running process (pose-look.ts --watch) keeps between builds, so that
 * each avatar's eye view is measured one time. The key is the performer, the avatar file, its size
 * and its change time: a changed file or look loads again. Each build puts the avatar back at bind pose.
 */
export type AvatarCache = Map<string, LoadedAvatar>;

async function loadCached(performer: string, file: string, cache?: AvatarCache): Promise<LoadedAvatar> {
  if (!cache) return loadAvatar(file);
  const s = await stat(file);
  const key = `${performer}\0${file}\0${s.size}\0${s.mtimeMs}`;
  const known = cache.get(key);
  if (known) return known;
  for (const k of cache.keys()) if (k.startsWith(`${performer}\0`)) cache.delete(k);
  const loaded = await loadAvatar(file);
  cache.set(key, loaded);
  return loaded;
}

export async function loadSheet(sheetFile: string, avatarOverride?: string, cache?: AvatarCache): Promise<{ sheet: BeatSheet; avatars: Map<string, LoadedAvatar>; sources: Map<string, LoadedSource> }> {
  const parsed = parseSheetText(await readFile(sheetFile, 'utf8'), basename(sheetFile));
  // An override dresses every performer in it alone, so the take records what they wear.
  const sheet: BeatSheet = avatarOverride ? { ...parsed, performers: parsed.performers.map(({ look: _look, ...p }) => ({ ...p, avatar: avatarOverride })) } : parsed;
  const problems = validateSheet(sheet);
  if (problems.length) throw new Error(`${basename(sheetFile)}:\n  ${problems.join('\n  ')}`);
  const avatars = new Map<string, LoadedAvatar>();
  for (const p of sheet.performers) avatars.set(p.id, await loadCached(p.id, await resolveAvatar(p.avatar, avatarOverride ? join(process.cwd(), 'x') : sheetFile, p.look), cache));
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
  /** One line per world change (slice 1f). */
  readonly world: readonly string[];
  readonly channels: number;
  readonly seconds: number;
  readonly bytes: number;
  readonly lines: readonly Line[];
  readonly effects: readonly Effect[];
  /** Each audio source as written: its onset and the decoded length of the padded file (s). */
  readonly audio: readonly { name: string; onset: number; seconds: number; padded: number; bytes: number; file: string }[];
  /** The `HOLOIM_captions` the take carries, or null when nothing is said. */
  readonly captions: CaptionsExtension | null;
  /** Wall-clock seconds of each phase: setup, each solve pass, world and sound, export. */
  readonly phases: readonly Phase[];
}

export async function build(sheetFile: string, out?: string, style?: BeatSheet['style'], avatarOverride?: string, solve: SolveOptions = {}, cache?: AvatarCache): Promise<BuildResult> {
  const started = performance.now();
  const phases = startPhases();
  const loaded = await loadSheet(sheetFile, avatarOverride, cache);
  const sheet: BeatSheet = style ? { ...loaded.sheet, style } : loaded.sheet;
  const { avatars, sources } = loaded;
  const soundCache = join(OUTPUT, 'sound');
  const lines: Line[] = [];
  for (const b of sheet.beats) if (b.say) lines.push(await prepareLine(b, sheetFile, soundCache));
  const speech = new Map<string, { at: number; lips: Line['lips'] }[]>();
  for (const l of lines) speech.set(l.performer, [...(speech.get(l.performer) ?? []), { at: l.at, lips: l.lips }]);
  phaseMark('setup', started);
  const take = solveTake(sheet, avatars, sources, speech, solve);
  let since = performance.now();
  const world = solveWorld(sheet, take);
  const effects = await prepareEffects(take, sheetFile, soundCache);
  phaseMark('world and sound', since);
  since = performance.now();
  const written = await writeTake(take, {
    author: 'HoloIM direction',
    title: sheet.title,
    method: `beat sheet ${basename(sheetFile)} solved on ${sheet.performers.map((p) => `${p.id} (${p.avatar})`).join(', ')}; ${sheet.style ?? 'directed'}`
  }, world);
  const file = out ?? join(OUTPUT, `${basename(sheetFile).replace(/\.jsonc?$/, '')}.glb`);
  await mkdir(dirname(file), { recursive: true });
  // Sound: every source padded to the clip and looping with it (brief, decision 0).
  const clip = take.times[take.times.length - 1] ?? sheet.duration;
  const audioDir = `${file.replace(/\.glb$/, '')}.audio`;
  if (lines.length || effects.length) await mkdir(audioDir, { recursive: true });
  const sourcesOut: AudioSource[] = [];
  const audio: BuildResult['audio'][number][] = [];
  const nodeOf = (on: string): number => {
    const [who, part] = on.split('.');
    const n = part === 'head' ? written.heads.find((h) => h.id === who)?.node : written.objects.find((o) => o.id === on)?.node;
    if (n === undefined) throw new Error(`no node for a sound on ${on}`);
    return n;
  };
  for (const [name, src, onset, on, gain, kind] of [
    ...lines.map((l) => [`say-${l.beat}`, l, l.at, `${l.performer}.head`, l.gain, 'voice'] as const),
    ...effects.map((e) => [`sound-${e.id}`, e, e.at, e.on, e.gain, 'effect'] as const)
  ]) {
    const padded = join(audioDir, `${name}.webm`);
    const bytes = padAndEncode(src.file, onset, clip, padded);
    const seconds = probeSeconds(padded);
    if (Math.abs(seconds - clip) > 1 / take.fps) throw new Error(`${name}: the padded source is ${seconds.toFixed(3)} s, not the clip's ${clip.toFixed(3)} s`);
    if (onset + src.seconds > clip + 1e-3) console.warn(`  ${name} runs ${(onset + src.seconds - clip).toFixed(2)} s past the take's end: cut there`);
    sourcesOut.push({ name, bytes, node: nodeOf(on), gain, kind });
    audio.push({ name, onset, seconds: src.seconds, padded: seconds, bytes: bytes.byteLength, file: padded });
  }
  // Captions share the voice's lifecycle: written with it here, dropped with it by edit and recast (brief, slice 3).
  const speakerOf = (id: string): string => {
    const name = written.performers.find((p) => p.id === id)?.name;
    if (!name) throw new Error(`no performer ${id} for a caption`);
    return name;
  };
  const captions = takeCaptions(lines, clip, speakerOf);
  const glb = addCaptions(addAudio(written.glb, sourcesOut, [...lines.map((l) => l.credit), ...effects.map((e) => e.credit)]), captions);
  await writeFile(file, glb);
  // The sheet as solved (with any --style override), beside the take.
  await writeFile(`${file.replace(/\.glb$/, '')}.beats.json`, `${JSON.stringify(sheet, null, 2)}\n`);
  if (take.props.length) await writeFile(`${file.replace(/\.glb$/, '')}.objects.json`, `${JSON.stringify(take.objects, null, 2)}\n`);
  phaseMark('export', since);
  return { out: file, take, world: world.lines, channels: written.channels, seconds: (performance.now() - started) / 1000, bytes: glb.byteLength, lines, effects, audio, captions, phases };
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
  const avatar = flag('--avatar');
  const sheetFile = args[0];
  if (!sheetFile) {
    console.error('usage: direct.ts <sheet.json> [--out take.glb] [--style flat|directed] [--against earlier.glb] [--avatar spec]');
    process.exit(2);
  }
  const r = await build(sheetFile, out, style, avatar);
  console.log(`  phases: ${phaseLine(r.phases)}`);
  console.log(`${basename(r.out)}: ${r.take.tracks.length} performer(s), ${r.take.times.length} frames at ${r.take.fps} fps, ${r.channels} channels, ${(r.bytes / 1e6).toFixed(1)} MB, built in ${r.seconds.toFixed(1)} s`);
  for (const a of r.audio) console.log(`  ${a.name}: ${a.seconds.toFixed(2)} s from ${a.onset.toFixed(2)} s, padded to ${a.padded.toFixed(3)} s, ${(a.bytes / 1e3).toFixed(0)} KB`);
  for (const t of r.captions?.tracks ?? []) for (const c of t.cues) console.log(`  caption ${t.language} ${c.from.toFixed(2)}-${c.to.toFixed(2)} s (${c.speaker}): ${c.text}`);
  for (const t of r.take.tracks) for (const reach of t.reaches) {
    console.log(`  ${t.spec.id} reach ${reach.beat} (${reach.side}): palm ${(reach.targetDistance * 1000).toFixed(1)} mm from target, asked ${(reach.stopShort * 1000).toFixed(0)} mm` +
      (reach.targetDistance - reach.stopShort > 0.02 && reach.outOfReach > 0.01 ? `; out of reach even leaning: move the performers closer or add a step` : ''));
  }
  for (const t of r.take.tracks) {
    if (t.life) console.log(`  ${t.spec.id} life: ${describeLife(t.life, r.take.sheet.duration)}`);
    // Attending plays only facing someone: printed when there is someone who could be faced; the schedule, not what plays.
    if (t.attend && r.take.tracks.length > 1) console.log(`  ${t.spec.id} attending (plays only while facing another performer, within 55°): ${describeAttend(t.attend, r.take.sheet.duration)}`);
    console.log(`  ${t.spec.id} body: ${bodyLine(t.motion)}`);
  }
  const lines = objectLines(r.take.objects);
  for (const l of lines) console.log(`  ${l.failed ? 'FAIL ' : ''}${l.text}`);
  for (const l of r.world) console.log(`  ${l}`);
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
