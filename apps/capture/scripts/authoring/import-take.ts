/**
 * Step 1 of slice 4a (docs/features/directed-performance.md): a capture-recorded
 * GLB becomes the authoring tool's own take (`lib/take.ts`).
 *
 *   node --conditions=development --import tsx scripts/authoring/import-take.ts <recorded.glb> [--out <dir>] [--fps <n>]
 *
 * Writes `<out>/<name>.take.json` and `<out>/<name>.import.md` (default out:
 * output/take-input). The report states what the recording carries (bones,
 * face channels of 52, frames), the performer's measures, and the beats found
 * in the motion with where each looks.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARKIT_BLENDSHAPES, FACE_CHANNELS } from '@holoim/avatar-face';

import { measureMotion } from '../lib/motion-quality.ts';
import { importTake, SNAP_SPEED, takeMotion, type Take } from './lib/take.ts';

const fmt = (v: number | null): string => (v === null ? 'n/a' : v.toFixed(2));
const round3 = (v: number): number => Number(v.toFixed(3));

export function importReport(take: Take): string {
  const s = take.source;
  const moving = Object.entries(take.face).filter(([, w]) => Math.max(...w!) - Math.min(...w!) > 0.02).map(([c]) => c);
  const hipsY = take.hips.filter((_, i) => i % 3 === 1);
  let travel = 0;
  for (let f = 1; f < take.frames; f += 1) travel += Math.hypot(take.hips[f * 3]! - take.hips[f * 3 - 3]!, take.hips[f * 3 + 2]! - take.hips[f * 3 - 1]!);
  const motion = measureMotion(takeMotion(take));
  const arkit = Object.keys(take.face).filter((c) => (ARKIT_BLENDSHAPES as readonly string[]).includes(c)).length;
  const lines = [
    `# Imported take: ${s.file}`,
    '',
    `- source: ${s.file} (sha256 ${s.sha256.slice(0, 12)}…, ${s.generator ?? 'unknown generator'}), ${s.duration} s at ${s.fps} fps`,
    `- take: ${take.frames} frames at ${take.fps} fps; ${Object.keys(take.bones).length} humanoid bones; ${Object.keys(take.joints).length}/18 motion joints`,
    `- face: ${s.faceChannels}/${FACE_CHANNELS.length} canonical channels (${arkit}/${ARKIT_BLENDSHAPES.length} ARKit) have a shape on the recording avatar; ${moving.length} of them move (${moving.join(', ') || 'none'})`,
    `- measures: hips ${take.measures.hipHeight} m, leg ${take.measures.legLength} m, arm ${take.measures.armLength} m`,
    `- hips: ${travel.toFixed(2)} m travelled on the floor, height ${Math.min(...hipsY).toFixed(3)}–${Math.max(...hipsY).toFixed(3)} m`,
    `- trimmed: ${s.trimmed.from} s from the start and ${round3(s.duration - s.trimmed.to)} s from the end, where a bone jumps faster than ${SNAP_SPEED} m/s (the recorder starting or stopping)`,
    `- contacts: foot skate worst ${fmt(motion.footSkateMaxCm)} cm, share ${fmt(motion.footSkateShare)}, float p95 ${fmt(motion.footFloatP95Cm)} cm, penetration ${fmt(motion.footPenetrationCm)} cm`,
    '',
    '## Beats found in the motion',
    '',
    '| beat | kind | from | to | look yaw° (+ left) | look pitch° | peak wrist m/s |',
    '|---|---|---|---|---|---|---|',
    ...take.beats.map((b) => `| ${b.id} | ${b.kind} | ${b.from} | ${b.to} | ${b.look.yaw} | ${b.look.pitch} | ${b.peakWristSpeed} |`),
    ''
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  if (!file) throw new Error('usage: import-take.ts <recorded.glb> [--out <dir>] [--fps <n>]');
  const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const out = resolve(flag('--out') ?? 'output/take-input');
  const fps = flag('--fps') ? Number(flag('--fps')) : undefined;
  const take = await importTake(resolve(file), fps === undefined ? {} : { fps });
  const name = basename(file).replace(/\.glb$/i, '');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, `${name}.take.json`), JSON.stringify(take));
  const report = importReport(take);
  await writeFile(join(out, `${name}.import.md`), report);
  console.log(report);
  console.log(`wrote ${join(out, `${name}.take.json`)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
