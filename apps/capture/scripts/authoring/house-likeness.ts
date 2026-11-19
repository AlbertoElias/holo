/**
 * The likeness check (slice 2c2 of docs/features/directed-performance.md): how close the house base
 * is to Astra's clay sheets, which the owner judged the base must look like.
 *
 *   node --conditions=development --import tsx scripts/authoring/house-likeness.ts [--glb file] [--sheets dir] [--out dir] [--blender path]
 *
 * `--sheets` is the folder that holds the sheets (clay-turnaround.png, clay-traits.png,
 * clay-expressions.png, clay-poem-pair.png; the owner's, not in the repository; default
 * `output/avatar-sheets/` in the main checkout, found through git's common directory, so a worktree
 * finds them too). `--glb` defaults to the medium wardrobe.
 *
 * 1. `house-base/likeness.py` (Blender, headless) renders the base with the turnaround's framing
 *    and writes the silhouette intersection over union per view (whole figure and head) to
 *    `likeness.json`, with each view's sheet crop, render and mask overlay.
 * 2. "Which is the drawing?" pairs for fresh readers: each view, whole figure and head, the sheet's
 *    crop and the base's render side by side in a seeded order, `pairs/pair-<n>.png`, and the
 *    answers in `pairs/key.json` (kept from the readers).
 * 3. A contact sheet of the base's views beside each sheet: `contact-<sheet>.jpg`.
 *
 * Writes into output/authoring/house-likeness/ unless `--out`. Exits 1 when Blender fails; the
 * pass numbers are judged in the brief, not here.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { wardrobeFile } from './lib/house-look.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const blender = arg('--blender') ?? process.env.BLENDER ?? '/Applications/Blender.app/Contents/MacOS/Blender';
const glb = resolve(arg('--glb') ?? wardrobeFile('medium'));
const mainCheckout = dirname(resolve(ROOT, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim()));
const sheets = resolve(arg('--sheets') ?? join(mainCheckout, 'output/avatar-sheets'));
const out = resolve(arg('--out') ?? join(ROOT, 'apps/capture/output/authoring/house-likeness'));
const VIEWS = ['front', 'threeQuarter', 'side', 'back'] as const;
const SHEETS = ['clay-turnaround', 'clay-traits', 'clay-expressions', 'clay-poem-pair'] as const;

await mkdir(join(out, 'pairs'), { recursive: true });
const log = execFileSync(blender, ['-b', '--python', join(HERE, 'house-base/likeness.py'), '--', glb, join(sheets, 'clay-turnaround.png'), out], {
  encoding: 'utf8',
  maxBuffer: 64 << 20,
});
if (!log.includes('HOUSE_LIKENESS_DONE')) throw new Error(`likeness.py did not finish:\n${log.slice(-4000)}`);
const report = JSON.parse(await readFile(join(out, 'likeness.json'), 'utf8')) as {
  meanIou: number;
  meanHeadIou: number;
  views: Record<string, { iou: number; headIou: number }>;
};

const magick = (...a: string[]) => execFileSync('magick', a, { stdio: ['ignore', 'ignore', 'inherit'] });

// The pairs: a fixed shuffle (a linear congruential sequence), so a re-run makes the same key.
let seed = 20261118;
const coin = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) < 0.5;
const key: { pair: number; view: string; crop: string; drawing: 'left' | 'right' }[] = [];
let n = 0;
for (const crop of ['figure', 'head'] as const) {
  for (const view of VIEWS) {
    n += 1;
    const sheet = join(out, `${view}-sheet.png`);
    const base = join(out, `${view}-base.png`);
    const drawingLeft = coin();
    const [l, r] = drawingLeft ? [sheet, base] : [base, sheet];
    // Head: the top quarter of each crop; both crops are the same size (likeness.py frames them alike).
    const cut = crop === 'head' ? ['-gravity', 'North', '-crop', '100%x26%+0+0', '+repage', '-resize', '480x'] : ['-resize', 'x720'];
    magick('(', l, ...cut, ')', '(', r, ...cut, ')', '-bordercolor', '#909090', '-border', '12', '+append', '-quality', '90', join(out, 'pairs', `pair-${n}.jpg`));
    key.push({ pair: n, view, crop, drawing: drawingLeft ? 'left' : 'right' });
  }
}
await writeFile(join(out, 'pairs', 'key.json'), `${JSON.stringify(key, null, 2)}\n`);

// The contact sheets: each sheet above the base's four views, lit, framed as the turnaround draws them.
const strip = join(out, 'base-views.png');
magick(...VIEWS.map((v) => join(out, `${v}-base.png`)), '-resize', 'x900', '+append', strip);
for (const name of SHEETS) {
  magick('(', join(sheets, `${name}.png`), '-resize', '2400x', ')', '(', strip, '-resize', '2400x', ')', '-background', '#909090', '-gravity', 'center', '-append', '-resize', '1600x', '-quality', '85', join(out, `contact-${name}.jpg`));
}

console.log(`likeness: mean IoU ${report.meanIou}, mean head IoU ${report.meanHeadIou}`);
for (const [view, v] of Object.entries(report.views)) console.log(`  ${view}: IoU ${v.iou}, head ${v.headIou}`);
console.log(`pairs: ${out}/pairs (key.json holds the answers); contact sheets: ${out}/contact-*.jpg`);
