/**
 * The audition's render tier: the avatar standing still in a take, on the
 * real viewer's feed card at phone size, measured with the card's own camera
 * and renderer (`lib/review-page.ts`).
 *
 * - Face box: the brow line's top to the chin's bottom, device px.
 * - Eye opening: each eye's opening (the ends `face-geometry` found from the
 *   card's direction) projected, device px.
 * - Brow contrast: a front render of the face by the viewer's renderer and
 *   lights, the OKLab lightness at each brow vertex.
 *
 * It writes the take (`still.glb`), `card.png` with `card-regions.json`
 * (where each measure sits on it) and the front render `brow.jpg`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Page } from 'playwright';

import { build } from '../direct.ts';
import { BACKGROUND, CARD_PIXEL_RATIO, PHONE } from '../review.ts';
import type { RenderMeasures } from './audition-bar.ts';
import type { FaceRegions } from './face-geometry.ts';
import { REVIEW_PAGE } from './review-page.ts';
import { openTake, startViewer } from './viewer-session.ts';

type Review = Record<string, (...a: unknown[]) => unknown>;
type Pt = [number, number];
const call = (page: Page, fn: string, ...a: unknown[]) => page.evaluate(([f, args]) => (window as unknown as { __review: Review }).__review[f as string]!(...(args as unknown[])), [fn, a] as const);

/** Seconds into the still take the card is read at: past the card camera's settle. */
const AT = 1.5;
const CLOSE = 512;

function percentile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(q * s.length) - 1)]!;
}

export interface RenderOptions {
  /** Directory for a real-time recording of the card (webm), if any. */
  readonly recordVideoDir?: string;
}

/** Builds a still take of `avatar` into `outDir`, opens it on a phone card and measures it. */
export async function renderTier(avatar: string, regions: FaceRegions, outDir: string, options: RenderOptions = {}): Promise<RenderMeasures> {
  await mkdir(outDir, { recursive: true });
  const sheetFile = join(outDir, 'still.json');
  await writeFile(sheetFile, `${JSON.stringify({
    title: 'Audition', intent: 'The avatar stands still, facing us, with a neutral face.',
    duration: 3, life: false,
    performers: [{ id: 'p', avatar: resolve(avatar), at: [0, 0], facing: 0 }],
    beats: []
  }, null, 2)}\n`);
  const take = (await build(sheetFile, join(outDir, 'still.glb'))).out;

  const servers = await startViewer();
  try {
    const open = await openTake(servers, take, { viewport: PHONE, deviceScaleFactor: CARD_PIXEL_RATIO, isMobile: true, title: 'Audition', ...(options.recordVideoDir ? { recordVideoDir: options.recordVideoDir } : {}) });
    try {
      const { page } = open;
      await page.addScriptTag({ content: REVIEW_PAGE });
      await call(page, 'init', open.url, regions);
      await call(page, 'seek', AT);
      await call(page, 'seek', AT); // twice: the card's camera damps toward its framing
      const r = await call(page, 'regions', 0) as { browTop: number | null; chinBottom: number | null; eyes: Record<string, { top: Pt; bottom: Pt }>; pixelRatio: number };
      const box = await open.card.boundingBox();
      const canvas = await page.evaluate(() => { const c = document.querySelector('.feed-card canvas')?.getBoundingClientRect(); return c ? [c.x, c.y] as const : null; });
      await open.card.screenshot({ path: join(outDir, 'card.png') });
      // Where the measures sit in card.png (CSS px from the card's corner), to check them by eye.
      await writeFile(join(outDir, 'card-regions.json'), `${JSON.stringify({ offset: box && canvas ? [canvas[0] - box.x, canvas[1] - box.y] : [0, 0], ...r }, null, 2)}\n`);
      const faceBoxDevicePx = r.browTop !== null && r.chinBottom !== null ? Math.round((r.chinBottom - r.browTop) * r.pixelRatio * 10) / 10 : null;
      const eyes = Object.entries(r.eyes).map(([side, e]) => ({ side, devicePx: Math.hypot(e.bottom[0] - e.top[0], e.bottom[1] - e.top[1]) * r.pixelRatio }));

      // A front close-up for the brow's lightness, the face about half the frame.
      const body = await call(page, 'bodies') as { performers: { head: [number, number, number] }[] };
      const head = body.performers[0]!.head;
      const target: [number, number, number] = [head[0], head[1] + 0.06, head[2] + 0.06];
      const close = await call(page, 'close', 0, { position: [target[0], target[1], target[2] + 0.7], target, fov: 20, width: CLOSE, height: CLOSE, background: BACKGROUND, regions: true }) as { image: string; regions: { browL: number[] } };
      await writeFile(join(outDir, 'brow.jpg'), Buffer.from(close.image.slice(close.image.indexOf(',') + 1), 'base64'));
      const L = close.regions.browL;
      const browL = L.length ? { p10: percentile(L, 0.1), p90: percentile(L, 0.9), samples: L.length } : null;
      return { faceBoxDevicePx, eyes, browL };
    } finally { await open.close(); }
  } finally { servers.close(); }
}
