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
  for (const kind of ['deformed', 'rigid']) {
    const limit = scene.budget?.[kind];
    if (limit && quickLook[kind] > limit) {
      console.error(`${name}: Quick Look ${kind} load ${quickLook[kind].toExponential(2)} points × frames is over the budget of ${limit.toExponential(2)}`);
      process.exitCode = 1;
    }
  }
  if (sheet) {
    const sheetFile = path.join(outDir, `${scene.meta.slug}-sheet.jpg`);
    Object.assign(report, { sheet: sheetFile }, await renderSheet(file, sheetFile, { tiles: scene.tiles }));
  }
  console.log(JSON.stringify(report, null, 1));
}

/**
 * What the USDZ conversion has to evaluate for its extents, split as the
 * converter splits it (apps/viewer-api/tools/glb_to_usdz.py): deformed
 * meshes (morph targets) cost their points at every frame of the whole
 * scene; rigid meshes cost their points at every frame of their own node
 * chain when the node or an ancestor is animated, and once otherwise. A
 * node's frames are the 30 Hz grid over the clip, its own key times, and a
 * pre-sample 10 µs before each of its STEP keys after the first; the
 * scene's are the union of all of them. Measured before write(), which
 * hands the channels over.
 */
function quickLookLoad(glb) {
  const { nodes, meshes, accessors } = glb.json;
  if (glb.channels.length === 0) return { deformed: 0, rigid: 0, frames: 1 };
  const key = (t) => Math.round(t * 1e5);
  const duration = glb.channels.reduce((most, ch) => Math.max(most, ch.times[ch.times.length - 1]), 0);
  const grid = new Set([key(duration)]);
  for (let i = 0; i * 30 < duration * 30 - 1e-6; i += 1) grid.add(key(i / 30));
  const own = new Map();
  for (const ch of glb.channels) {
    if (!own.has(ch.node)) own.set(ch.node, new Set());
    const times = own.get(ch.node);
    for (const t of ch.times) times.add(key(t));
    if (ch.interpolation === 'STEP') for (const t of [...ch.times].slice(1)) times.add(key(Math.max(0, t - 1e-5)));
  }
  const all = new Set(grid);
  for (const times of own.values()) for (const t of times) all.add(t);
  const frames = all.size;
  const moving = new Set(glb.channels.filter((ch) => ch.path !== 'weights').map((ch) => ch.node));
  let deformed = 0;
  let rigid = 0;
  const walk = (i, chain) => {
    const node = nodes[i];
    const here = moving.has(i) ? new Set([...(chain ?? grid), ...own.get(i)]) : chain;
    if (node.mesh !== undefined) {
      for (const prim of meshes[node.mesh].primitives) {
        const points = accessors[prim.attributes.POSITION].count;
        if (prim.targets?.length) deformed += points * frames;
        else rigid += points * (here ? here.size : 1);
      }
    }
    for (const c of node.children ?? []) walk(c, here);
  };
  for (const i of glb.json.scenes[0].nodes) walk(i, null);
  return { deformed, rigid, frames };
}
