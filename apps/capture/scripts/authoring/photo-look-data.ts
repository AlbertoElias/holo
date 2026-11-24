/**
 * Data for the photo choice in capture's look step
 * (docs/features/directed-performance.md, slice 5b).
 *
 *   photo-look-data.ts outlines [--from <.styles/key.json>]
 *     Writes the six hair styles' outlines that a full `photo-look.ts` run
 *     keeps in `output/authoring/photo-look/.styles/` into
 *     `src/avatar/photoLookOutlines.ts`, with `outlinesKey()`: the hash of
 *     the default look, its wardrobe and the dressing and read code. The phone
 *     e2e fails when that key no longer matches. To refresh: run
 *     `photo-look.ts <any photo>` once, then this.
 *
 *   photo-look-data.ts key
 *     Prints \`outlinesKey()\`, for the e2e to compare with \`OUTLINES_KEY\`.
 *
 *   photo-look-data.ts fixture [--finish clay|ink|light] [--out <file.jpg>]
 *     Renders the house base close up in `FIXTURE_CARD`, as a photo of a face
 *     for the e2e: no photo of a real person goes into the repository.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';

import { FINISHES, HAIR_STYLES, type Finish, type HairGrid, type HairStyle, type LookCard } from '@holoim/avatar-look';
import { tokens } from '@holoim/design-tokens';

import { build } from './direct.ts';
import { defaultLook, dressedFile, wardrobeFile } from './lib/house-look.ts';
import { REVIEW_PAGE } from './lib/review-page.ts';
import { openTake, startViewer } from './lib/viewer-session.ts';

const APP = fileURLToPath(new URL('../../', import.meta.url));
const STYLE_CACHE = join(APP, 'output/authoring/photo-look/.styles');
export const OUTLINES_FILE = join(APP, 'src/avatar/photoLookOutlines.ts');
const AVATAR_LOOK_SRC = fileURLToPath(new URL('../../../../packages/avatar-look/src/', import.meta.url));
export const FIXTURE_FILE = join(APP, '../viewer-web/e2e/fixtures/photo-look/house-face.jpg');

/** The fixture's look: far from the shipped default in skin, hair and eyes, so a read changes several rows. */
export const FIXTURE_CARD: LookCard = {
  build: 'medium',
  skin: 'linen',
  eyes: 'coolGrey',
  hair: { style: 'wavyBob', colour: 'wheat' },
  glasses: 'none',
  clothing: 'oatmealSlate'
};

/** What the outlines depend on: the default look, its wardrobe, and the code that dresses and reads. */
export async function outlinesKey(): Promise<string> {
  const defaults = await defaultLook();
  const hash = createHash('sha256').update(JSON.stringify(defaults)).update(await readFile(wardrobeFile(defaults.build)));
  for (const file of ['dress.ts', 'photo.ts', 'read.ts', 'traits.ts']) hash.update(await readFile(join(AVATAR_LOOK_SRC, file)));
  return hash.digest('hex').slice(0, 16);
}

/** One grid as a string of its cells, 0, 1 or 2 (`HairGrid`), row by row. */
const packGrid = (grid: HairGrid): string => grid.cells.join('');

async function outlines(from: string | undefined): Promise<void> {
  let source = from ? resolve(from) : undefined;
  if (!source) {
    const kept = existsSync(STYLE_CACHE) ? readdirSync(STYLE_CACHE).filter((f) => f.endsWith('.json')).map((f) => join(STYLE_CACHE, f)) : [];
    kept.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    source = kept[0];
  }
  if (!source) throw new Error(`no outlines in ${STYLE_CACHE}: run photo-look.ts <photo> once (without --read-only)`);
  const kept = JSON.parse(await readFile(source, 'utf8')) as { grids: Record<HairStyle, HairGrid> };
  const first = kept.grids[HAIR_STYLES[0]];
  const key = await outlinesKey();
  const grids = HAIR_STYLES.map((style) => `  ${style}: '${packGrid(kept.grids[style])}'`).join(',\n');
  await writeFile(
    OUTLINES_FILE,
    `// Made by scripts/authoring/photo-look-data.ts outlines from a photo-look.ts run; do not edit.
// The six hair styles' outlines in the face's frame (\`GRID\`), each cell 0, 1 or 2 (\`HairGrid\`), row by row.
// See docs/features/directed-performance.md, slice 5b.
import type { HairStyle } from '@holoim/avatar-look';

/** \`outlinesKey()\` in photo-look-data.ts when these were made: the e2e fails when it no longer matches. */
export const OUTLINES_KEY = '${key}';
export const OUTLINES_SIZE = { w: ${first.w}, h: ${first.h} } as const;
export const OUTLINES: Record<HairStyle, string> = {
${grids}
};
`
  );
  const out = { key };
  console.log(`wrote ${OUTLINES_FILE} (key ${out.key}) from ${source}`);
}

/** The fixture view: the head from the eyes' height, close enough that the face is about 400 px wide. */
const FIXTURE = { size: 1024, top: 0.36, bottom: -0.18, ahead: 0.04, fov: 20 } as const;

type Review = Record<string, (...a: unknown[]) => unknown>;
const call = (page: Page, fn: string, ...a: unknown[]) => page.evaluate(([f, args]) => (window as unknown as { __review: Review }).__review[f as string]!(...(args as unknown[])), [fn, a] as const);

async function fixture(finish: Finish, out: string): Promise<void> {
  const work = join(APP, 'output/authoring/photo-look-data');
  await mkdir(work, { recursive: true });
  const avatar = await dressedFile(FIXTURE_CARD, finish);
  const sheetFile = join(work, 'fixture.json');
  await writeFile(sheetFile, `${JSON.stringify({ title: 'Photo look fixture', intent: 'One performer stands still, facing us, with a neutral face.', duration: 1, life: false, performers: [{ id: 'p0', avatar, at: [0, 0], facing: 0 }], beats: [] }, null, 2)}\n`);
  const take = (await build(sheetFile, join(work, 'fixture.glb'))).out;
  const servers = await startViewer();
  try {
    const open = await openTake(servers, take, { viewport: { width: 600, height: 600 }, title: 'Photo look fixture' });
    try {
      const { page } = open;
      await page.addScriptTag({ content: REVIEW_PAGE });
      await call(page, 'init', open.url);
      await call(page, 'seek', 0.5);
      const bodies = (await call(page, 'bodies')) as { performers: { head: [number, number, number] }[] };
      const head = bodies.performers[0]!.head;
      const distance = (FIXTURE.top - FIXTURE.bottom) / 2 / Math.tan(((FIXTURE.fov / 2) * Math.PI) / 180);
      const target: [number, number, number] = [head[0], head[1] + (FIXTURE.top + FIXTURE.bottom) / 2, head[2] + FIXTURE.ahead];
      const background = Number.parseInt(tokens.color.ground.mid.slice(1), 16);
      const shot = (await call(page, 'close', 0, { position: [target[0], target[1], target[2] + distance], target, fov: FIXTURE.fov, width: FIXTURE.size, height: FIXTURE.size, background, far: distance + 0.6 })) as { image: string };
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, Buffer.from(shot.image.slice(shot.image.indexOf(',') + 1), 'base64'));
      console.log(`wrote ${out} (${finish}, ${JSON.stringify(FIXTURE_CARD)})`);
    } finally {
      await open.close();
    }
  } finally {
    await servers.close();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...args] = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (command === 'outlines') await outlines(flag('--from'));
  else if (command === 'key') console.log(await outlinesKey());
  else if (command === 'fixture') {
    const finish = (flag('--finish') ?? 'clay') as Finish;
    if (!FINISHES.includes(finish)) throw new Error(`--finish: one of ${FINISHES.join(', ')}`);
    await fixture(finish, resolve(flag('--out') ?? FIXTURE_FILE));
  } else {
    console.error('photo-look-data.ts outlines [--from <file>] | key | fixture [--finish clay|ink|light] [--out <file.jpg>]');
    process.exitCode = 1;
  }
}
