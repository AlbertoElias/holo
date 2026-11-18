/**
 * Step 3 of slice 4a (docs/features/directed-performance.md): edits an
 * imported take by beat from a small edit file (`lib/edit.ts`), and plays the
 * result on an avatar.
 *
 *   node --conditions=development --import tsx scripts/authoring/edit-take.ts <edit.json> [--to <avatar>] [--out <dir>]
 *
 * Writes `<out>/<name>.edited.take.json`, the edited take on `<avatar>`
 * (default stock) as `<out>/<name>.edited.<avatar>.glb`, the unedited take on
 * the same avatar as `<out>/<name>.<avatar>.glb` for comparison, and
 * `<out>/<name>.edit.md` / `.edit.json`: the time map, each edit's result, and
 * the check that every frame outside the edits is the recording's own.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAvatar } from './lib/avatar.ts';
import { resolveAvatar } from './direct.ts';
import { applyEdits, type EditFile, type EditReport } from './lib/edit.ts';
import { recastTake } from './lib/recast.ts';
import type { Take } from './lib/take.ts';
import { writeTake } from './lib/write-glb.ts';
import { readTake } from './recast-take.ts';

export function editMarkdown(name: string, file: EditFile, take: Take, edited: Take, r: EditReport): string {
  const lines = [
    `# Edited take: ${name}`,
    '',
    file.intent ? `Intent: ${file.intent}` : '',
    '',
    `- source: ${take.source.file} (${take.duration} s); edited: ${edited.duration} s`,
    `- untouched: ${r.untouched.frames} frames outside every edit (${r.untouched.offGrid} between recorded frames); largest difference from the recording there: bones ${r.untouched.maxBoneDeg}°, hips ${r.untouched.maxHipsMm} mm, face ${r.untouched.maxFace}`,
    '',
    '## Time map',
    '',
    '| edited from | to | plays source from | to | edit |',
    '|---|---|---|---|---|',
    ...r.pieces.map((p) => `| ${p.outFrom} | ${p.outTo} | ${p.srcFrom} | ${p.srcTo} | ${p.edit === undefined ? '' : `${p.edit + 1} (${file.edits[p.edit]!.kind})`} |`),
    '',
    '## Edits',
    '',
    ...file.edits.map((e, i) => {
      if (e.kind === 'hold') { const h = r.holds.find((x) => x.edit === i + 1); return `${i + 1}. hold at ${e.at ?? e.beat} s for ${e.add} s more${e.life === false ? ', no life' : `, life: ${h?.glances ?? 0} glance(s), ${h?.sighs ?? 0} sigh(s), ${h?.blinks ?? 0} blink(s), breath`}`; }
      if (e.kind === 'retime') return `${i + 1}. retime ${e.beat ?? `${e.from}–${e.to} s`} to ${e.duration} s`;
      const l = r.looks.find((x) => x.edit === i + 1)!;
      return `${i + 1}. look ${e.beat ?? `${e.from}–${e.to} s`} toward yaw ${e.yaw}°, pitch ${e.pitch ?? 0}°: the head points yaw ${l.before.yaw}°, pitch ${l.before.pitch}° in the recording and yaw ${l.reached.yaw}°, pitch ${l.reached.pitch}° edited, at the span's middle`;
    }),
    '',
    '## Beats found in the edited take',
    '',
    '| beat | kind | from | to | look yaw° | look pitch° |',
    '|---|---|---|---|---|---|',
    ...edited.beats.map((b) => `| ${b.id} | ${b.kind} | ${b.from} | ${b.to} | ${b.look.yaw} | ${b.look.pitch} |`),
    ''
  ];
  return lines.join('\n');
}

const slug = (spec: string): string => basename(spec).replace(/^fixture:/, '').replace(/\.glb$/i, '').replace(/[^a-z0-9-]+/gi, '-');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const editFile = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  if (!editFile) throw new Error('usage: edit-take.ts <edit.json> [--to <avatar>] [--out <dir>]');
  const out = resolve(flag('--out') ?? 'output/take-input');
  const spec = flag('--to') ?? 'stock';
  const file = JSON.parse(await readFile(resolve(editFile), 'utf8')) as EditFile;
  const take = await readTake(resolve(dirname(resolve(editFile)), file.take));
  const name = basename(editFile).replace(/\.edit\.json$|\.json$/i, '');
  const { take: edited, report } = applyEdits(take, file);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, `${name}.edited.take.json`), JSON.stringify(edited));
  const a = await loadAvatar(await resolveAvatar(spec, resolve(editFile)));
  for (const [t, suffix, method] of [[take, '', 'imported take recast'], [edited, '.edited', 'imported take edited by beat']] as const) {
    const recast = recastTake(t, a, { avatarSpec: spec, title: `${name}${suffix} on ${spec}` });
    const written = await writeTake(recast.solved, { author: suffix ? 'recorded performer, edited by the authoring tool' : 'recorded performer, recast by the authoring tool', title: `${name}${suffix} on ${spec}`, method, source: take.source.file, sourceSha256: take.source.sha256, ...(suffix ? { edits: file.edits } : {}) });
    const glb = join(out, `${name}${suffix}.${slug(spec)}.glb`);
    await writeFile(glb, written.glb);
    console.log(`wrote ${glb}`);
  }
  const md = editMarkdown(name, file, take, edited, report);
  await writeFile(join(out, `${name}.edit.md`), md);
  await writeFile(join(out, `${name}.edit.json`), JSON.stringify({ edits: file.edits, report }, null, 2));
  console.log(md);
  if (report.untouched.offGrid > 0 || report.untouched.maxBoneDeg > 0.01 || report.untouched.maxHipsMm > 0.1 || report.untouched.maxFace > 1e-3) {
    console.error('frames outside the edits differ from the recording');
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
