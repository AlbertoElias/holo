/**
 * The face likeness check (slice 2c3 of docs/features/directed-performance.md): how close the house
 * base's face is to Astra's clay expression sheet, expression by expression.
 *
 *   node --conditions=development --import tsx scripts/authoring/house-face-likeness.ts [--glb file] [--sheet file] [--out dir] [--blender path]
 *
 * `--sheet` is the round 2 clay expression sheet (the owner's, not in the repository; default
 * `output/avatar-sheets/round-2/clay-expressions.png` in the main checkout, found through git's common
 * directory, so a worktree finds it too). `--glb` defaults to the medium wardrobe.
 *
 * `house-base/face-likeness.py` (Blender, headless) poses the base in each of the sheet's first seven
 * faces with the shared mixes (`EXPRESSIONS` in `lib/beats.ts`; the eyeLook channels turn the eye
 * bones, as `direct.ts` does), frames the sheet's head and the base's alike (top to chin) and writes
 * `face-likeness.json`: per face, the intersection over union of the features (brows, lashes, irises
 * and mouth as "dark"; the eyes' whites and the teeth as "white") and the boxes of each eye, brow and
 * the mouth in head heights, with `<face>-sheet.png`, `<face>-base.png` and `<face>-mask.png`.
 * `contact.jpg` is every face's three images in a row.
 *
 * Writes into output/authoring/house-face-likeness/ unless `--out`. Exits 1 when Blender fails; the
 * pass numbers are judged in the brief, not here.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_PITCH, MAX_YAW, type FaceChannel } from '@holoim/avatar-face';

import { EXPRESSIONS, type ExpressionName } from './lib/beats.ts';
import { wardrobeFile } from './lib/house-look.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** The sheet's faces, left to right, that have a shared mix. */
const SHEET_FACES: readonly (readonly [string, ExpressionName | null])[] = [
  ['neutral', null], ['smile', 'smile'], ['sad', 'sad'], ['held', 'held'], ['resolve', 'resolve'], ['hope', 'hope'], ['eyes-down', 'eyes-down']
];

const blender = arg('--blender') ?? process.env.BLENDER ?? '/Applications/Blender.app/Contents/MacOS/Blender';
const glb = resolve(arg('--glb') ?? wardrobeFile('medium'));
const mainCheckout = dirname(resolve(ROOT, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim()));
const sheet = resolve(arg('--sheet') ?? join(mainCheckout, 'output/avatar-sheets/round-2/clay-expressions.png'));
const out = resolve(arg('--out') ?? join(ROOT, 'apps/capture/output/authoring/house-face-likeness'));

await mkdir(out, { recursive: true });
const deg = (rad: number) => (rad * 180) / Math.PI;
const faces = SHEET_FACES.map(([name, mixName], sheetIndex) => {
  const mix: Partial<Record<FaceChannel, number>> = mixName ? EXPRESSIONS[mixName] : {};
  const w = (c: FaceChannel) => mix[c] ?? 0;
  return {
    name, sheetIndex,
    mix: Object.fromEntries(Object.entries(mix).filter(([c]) => !c.startsWith('eyeLook'))),
    // Both eyes alike (the sheet's faces look straight or down); down and the image's right are positive.
    eyePitchDeg: deg((w('eyeLookDownLeft') - w('eyeLookUpLeft')) * MAX_PITCH),
    eyeYawDeg: deg((w('eyeLookOutLeft') - w('eyeLookInLeft')) * MAX_YAW)
  };
});
const mixes = join(out, 'mixes.json');
await writeFile(mixes, `${JSON.stringify({ faces }, null, 2)}\n`);
const log = execFileSync(blender, ['-b', '--python', join(HERE, 'house-base/face-likeness.py'), '--', glb, sheet, mixes, out], { encoding: 'utf8', maxBuffer: 64 << 20 });
if (!log.includes('HOUSE_FACE_LIKENESS_DONE')) throw new Error(`face-likeness.py did not finish:\n${log.slice(-4000)}`);

interface Report { mean: Record<string, number>; faces: Record<string, { iou: Record<string, number> }> }
const report = JSON.parse(await readFile(join(out, 'face-likeness.json'), 'utf8')) as Report;
const magick = (...a: string[]) => execFileSync('magick', a, { stdio: ['ignore', 'ignore', 'inherit'] });
const rows = faces.map((f) => join(out, `${f.name}-row.png`));
faces.forEach((f, i) => magick(join(out, `${f.name}-sheet.png`), join(out, `${f.name}-base.png`), join(out, `${f.name}-mask.png`), '+append', rows[i]!));
magick(...rows, '-append', '-resize', '900x', '-quality', '88', join(out, 'contact.jpg'));
for (const r of rows) magick(r, '-quality', '90', r.replace(/-row\.png$/, '-row.jpg'));

const line = (v: Record<string, number>) => Object.entries(v).map(([k, x]) => `${k} ${x}`).join(', ');
console.log(`face likeness (IoU), mean of ${faces.length} faces: ${line(report.mean)}`);
for (const [name, f] of Object.entries(report.faces)) console.log(`  ${name}: ${line(f.iou)}`);
console.log(`rows (sheet, base, features overlaid): ${out}/contact.jpg`);
