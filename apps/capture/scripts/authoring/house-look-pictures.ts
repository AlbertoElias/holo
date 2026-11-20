/**
 * The look sheet's pictures (docs/features/your-look.md, "Picture picker"):
 * one picture per value of each look row, the house base in its default
 * look (base.json `defaultLook`, clay finish) with only that row changed,
 * drawn by the real viewer's renderer and lights.
 *
 *   node --conditions=development --import tsx scripts/authoring/house-look-pictures.ts [--only <row>] [--out <dir>]
 *
 * One still take per row holds each value as its own performer, side by
 * side; the viewer opens it once and renders a close view of each performer,
 * framed for the row (`FRAMES`). Writes `<row>-<value>.jpg` (SIZE px square)
 * into `public/look-pictures/` (the capture app serves them; the look sheet
 * names them with `lookPicture`), or into `--out`. Re-run after a change to
 * the house base, the dressing or the finishes.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';

import { BUILDS, CLOTHING, EYES, FINISHES, GLASSES, HAIR_COLOUR, HAIR_STYLES, SKIN, type Finish, type LookCard } from '@holoim/avatar-look';
import { tokens } from '@holoim/design-tokens';

import { LOOK_ROWS, lookPicture, type LookRow } from '../../src/ui/lookPictures.ts';
import { build } from './direct.ts';
import { defaultLook, dressedFile } from './lib/house-look.ts';
import { REVIEW_PAGE } from './lib/review-page.ts';
import { openTake, startViewer } from './lib/viewer-session.ts';

type Vec3 = [number, number, number];
type Review = Record<string, (...a: unknown[]) => unknown>;
const call = (page: Page, fn: string, ...a: unknown[]) => page.evaluate(([f, args]) => (window as unknown as { __review: Review }).__review[f as string]!(...(args as unknown[])), [fn, a] as const);

const PUBLIC = fileURLToPath(new URL('../../public/', import.meta.url));
const WORK = fileURLToPath(new URL('../../output/authoring/house-look-pictures/', import.meta.url));
/** Output px: three device px per CSS px of the sheet's picture (styleguide 9.3, "Capture look sheet"). */
const SIZE = 216;
/** Metres between performers, so one performer's close view never shows another. */
const SPACING = 3;
const FOV = 20;
/** Metres of stage behind the view's target that the picture keeps: the body, not the stage's sky or ribbons. */
const DEPTH = 0.6;
/** The ground's middle colour, as the review's renders use: the stage the hologram stands on. */
const BACKGROUND = Number.parseInt(tokens.color.ground.mid.slice(1), 16);

/**
 * A row's framing: the span of the body the picture shows, as heights (m)
 * from the head bone (`top`, `bottom`), and how far in front of the head
 * bone the view aims (`ahead`, m).
 */
interface Frame { readonly top: number; readonly bottom: number; readonly ahead: number }
const HEAD: Frame = { top: 0.34, bottom: -0.1, ahead: 0.05 };
const FRAMES: Record<LookRow, Frame> = {
  finish: { top: 0.32, bottom: -0.62, ahead: 0.02 },
  build: { top: 0.36, bottom: -0.7, ahead: 0 },
  skin: HEAD,
  hair: HEAD,
  hairColour: HEAD,
  eyes: { top: 0.25, bottom: 0.07, ahead: 0.06 },
  glasses: HEAD,
  clothing: { top: 0.32, bottom: -0.8, ahead: 0.02 }
};

/** Each row's values and the look a value puts on stage (the default look with only that row changed). */
function rowLooks(row: LookRow, card: LookCard): { value: string; look: LookCard; finish: Finish }[] {
  const with_ = (patch: Partial<LookCard>) => ({ ...card, ...patch });
  switch (row) {
    case 'finish': return FINISHES.map((value) => ({ value, look: card, finish: value }));
    case 'build': return BUILDS.map((value) => ({ value, look: with_({ build: value }), finish: 'clay' }));
    case 'skin': return (Object.keys(SKIN) as (keyof typeof SKIN)[]).map((value) => ({ value, look: with_({ skin: value }), finish: 'clay' }));
    case 'hair': return HAIR_STYLES.map((value) => ({ value, look: with_({ hair: { ...card.hair, style: value } }), finish: 'clay' }));
    case 'hairColour': return (Object.keys(HAIR_COLOUR) as (keyof typeof HAIR_COLOUR)[]).map((value) => ({ value, look: with_({ hair: { ...card.hair, colour: value } }), finish: 'clay' }));
    case 'eyes': return (Object.keys(EYES) as (keyof typeof EYES)[]).map((value) => ({ value, look: with_({ eyes: value }), finish: 'clay' }));
    case 'glasses': return GLASSES.map((value) => ({ value, look: with_({ glasses: value }), finish: 'clay' }));
    case 'clothing': return (Object.keys(CLOTHING) as (keyof typeof CLOTHING)[]).map((value) => ({ value, look: with_({ clothing: value }), finish: 'clay' }));
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const only = flag('--only');
  if (only && !LOOK_ROWS.includes(only as LookRow)) throw new Error(`--only: one of ${LOOK_ROWS.join(', ')}`);
  const out = flag('--out') ? resolve(flag('--out')!) : PUBLIC;
  const rows = only ? [only as LookRow] : [...LOOK_ROWS];
  const card = await defaultLook();

  const servers = await startViewer();
  try {
    for (const row of rows) {
      const looks = rowLooks(row, card);
      const dir = join(WORK, row);
      await mkdir(dir, { recursive: true });
      const sheetFile = join(dir, 'still.json');
      const performers = await Promise.all(looks.map(async (l, i) => ({ id: `p${i}`, avatar: await dressedFile(l.look, l.finish), at: [i * SPACING, 0], facing: 0 })));
      await writeFile(sheetFile, `${JSON.stringify({ title: `Look pictures: ${row}`, intent: 'Each performer stands still, facing us, with a neutral face.', duration: 3, life: false, performers, beats: [] }, null, 2)}\n`);
      const take = (await build(sheetFile, join(dir, 'still.glb'))).out;
      const open = await openTake(servers, take, { viewport: { width: 600, height: 600 }, title: `Look pictures: ${row}` });
      try {
        const { page } = open;
        await page.addScriptTag({ content: REVIEW_PAGE });
        await call(page, 'init', open.url);
        await call(page, 'seek', 1.5);
        const bodies = await call(page, 'bodies') as { performers: { head: Vec3 }[] };
        const frame = FRAMES[row];
        for (const [i, l] of looks.entries()) {
          const head = bodies.performers[i]!.head;
          const span = frame.top - frame.bottom;
          const distance = (span / 2) / Math.tan((FOV / 2) * Math.PI / 180);
          const target: Vec3 = [head[0], head[1] + (frame.top + frame.bottom) / 2, head[2] + frame.ahead];
          const shot = await call(page, 'close', i, { position: [target[0], target[1], target[2] + distance], target, fov: FOV, width: SIZE, height: SIZE, background: BACKGROUND, far: distance + DEPTH }) as { image: string };
          const file = join(out, lookPicture(row, l.value));
          await mkdir(join(file, '..'), { recursive: true });
          await writeFile(file, Buffer.from(shot.image.slice(shot.image.indexOf(',') + 1), 'base64'));
          console.log(`${row} ${l.value}: ${file}`);
        }
      } finally { await open.close(); }
    }
  } finally { servers.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
