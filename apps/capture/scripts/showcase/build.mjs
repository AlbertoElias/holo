import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderSheet } from './lib/browser.mjs';

// Builds showcase holograms: authored (not recorded) GLBs that show what a
// hologram can do that a video cannot. Each scene module exports `meta`,
// `build()` (returns a Glb) and `tiles` (the views of its contact sheet).
//
//   node scripts/showcase/build.mjs <scene> [<scene> ...] [--no-sheet]
//
// Writes output/showcase/<slug>.glb and <slug>-sheet.jpg (output/ is
// ignored), and prints each scene's measured bounds, clips and size.

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../../../../output/showcase');
export const SCENES = [
  'light', 'door', 'murmuration', 'blue-hour',
  'words', 'seasons', 'hearts', 'rain', 'bath', 'strings',
  'street', 'orion', 'corridor', 'mirror', 'dive', 'stairs'
];

const args = process.argv.slice(2);
const sheet = !args.includes('--no-sheet');
const names = args.filter((arg) => !arg.startsWith('--'));
if (names.length === 0) {
  console.error(`usage: build.mjs <${SCENES.join('|')}> ... [--no-sheet]`);
  process.exit(1);
}

for (const name of names) {
  const scene = await import(`./${name}.mjs`);
  const glb = await scene.build();
  const file = path.join(outDir, `${scene.meta.slug}.glb`);
  const written = await glb.write(file);
  const report = { scene: name, ...scene.meta, file, megabytes: +(written.bytes / 1e6).toFixed(2), clipSeconds: written.duration };
  if (sheet) {
    const sheetFile = path.join(outDir, `${scene.meta.slug}-sheet.jpg`);
    Object.assign(report, { sheet: sheetFile }, await renderSheet(file, sheetFile, { tiles: scene.tiles }));
  }
  console.log(JSON.stringify(report, null, 1));
}
