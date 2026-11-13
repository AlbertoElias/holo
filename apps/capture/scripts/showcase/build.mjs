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
  'street', 'orion', 'corridor', 'mirror', 'dive', 'stairs', 'introspection', 'introspection2'
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
  const quickLook = quickLookLoad(glb);
  const written = await glb.write(file);
  const report = { scene: name, ...scene.meta, file, megabytes: +(written.bytes / 1e6).toFixed(2), clipSeconds: written.duration, quickLook };
  if (scene.budget?.quickLook && quickLook.pointFrames > scene.budget.quickLook) {
    console.error(`${name}: Quick Look load ${quickLook.pointFrames.toExponential(2)} moving points × frames is over the budget of ${scene.budget.quickLook.toExponential(2)}`);
    process.exitCode = 1;
  }
  if (sheet) {
    const sheetFile = path.join(outDir, `${scene.meta.slug}-sheet.jpg`);
    Object.assign(report, { sheet: sheetFile }, await renderSheet(file, sheetFile, { tiles: scene.tiles }));
  }
  console.log(JSON.stringify(report, null, 1));
}

/**
 * What the USDZ conversion has to bake: every point of a moving mesh (on an
 * animated node or below one, or with morph targets) at every distinct key
 * time in the clip. Measured before write(), which hands the channels over.
 */
function quickLookLoad(glb) {
  const { nodes, meshes, accessors } = glb.json;
  const times = new Set();
  for (const ch of glb.channels) for (const t of ch.times) times.add(Math.round(t * 1e5));
  const moving = new Set(glb.channels.filter((ch) => ch.path !== 'weights').map((ch) => ch.node));
  let points = 0;
  const walk = (i, under) => {
    const node = nodes[i];
    const here = under || moving.has(i);
    if (node.mesh !== undefined) {
      for (const prim of meshes[node.mesh].primitives) {
        if (here || prim.targets?.length) points += accessors[prim.attributes.POSITION].count;
      }
    }
    for (const c of node.children ?? []) walk(c, here);
  };
  for (const i of glb.json.scenes[0].nodes) walk(i, false);
  return { movingPoints: points, frames: times.size, pointFrames: points * times.size };
}
