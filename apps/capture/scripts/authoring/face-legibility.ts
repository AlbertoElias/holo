/**
 * How big a face must be on screen for an expression to read, measured in
 * the real viewer:
 *
 *   node --conditions=development --import tsx scripts/authoring/face-legibility.ts <take.glb> [--sheet take.beats.json] [--out dir]
 *
 * The take is one performer facing +Z with one expression per beat (as
 * `sheets/expressions.json`). It writes to `output/authoring/face/`:
 * - `face.json`: the face's height at feed-card framing on a phone
 *   (390×844 CSS px, canvas at 1.5×) and on a desktop (1440×900 at 1× and
 *   2×), in CSS px, device px and, on the phone, mm;
 * - `blind-NN.jpg`: per face height (device px), each expression and a
 *   neutral face rendered from the front by the viewer's own renderer with
 *   the face exactly that many pixels tall, then enlarged to the same tile
 *   size, in a shuffled order labelled A, B, C…; `key.json` says which is
 *   which. Enlarging keeps what limits a small face, its pixel count; the
 *   phone's mm says how small it is to the eye.
 *
 * Give each `blind-NN.jpg` to a different fresh reader, with the list of
 * expression names, and score against `key.json`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

import { beatSpan, resolveTiming, type BeatSheet } from './lib/beats.ts';
import { REVIEW_PAGE, SHEET_PAGE } from './lib/review-page.ts';
import { openTake, startViewer, type ViewerServers } from './lib/viewer-session.ts';
import { BACKGROUND, CARD_PIXEL_RATIO, MM_PER_CSS_PX, PHONE } from './review.ts';

const OUTPUT = fileURLToPath(new URL('../../output/authoring/face/', import.meta.url));
const SIZES = [8, 12, 16, 24, 32, 48, 64, 96];
const FOV = 20;
const REF = 400;
const TILE = 220;

type Vec = [number, number, number];
type Review = Record<string, (...a: unknown[]) => unknown>;
const call = (page: Page, fn: string, ...a: unknown[]) => page.evaluate(([f, args]) => (window as unknown as { __review: Review }).__review[f as string]!(...(args as unknown[])), [fn, a] as const);
const round = (x: number) => Math.round(x * 10) / 10;

interface CardFace { cssPx: number; devicePx: number; mm?: number; bodyCssPx: number }

async function cardFace(servers: ViewerServers, take: string, viewport: { width: number; height: number }, scale: number, mobile: boolean, at: number): Promise<CardFace> {
  const open = await openTake(servers, take, { viewport, deviceScaleFactor: scale, isMobile: mobile });
  try {
    await open.page.addScriptTag({ content: REVIEW_PAGE });
    await call(open.page, 'init', open.url);
    await call(open.page, 'seek', at);
    await call(open.page, 'seek', at); // twice: the card's camera damps toward its framing
    const c = await call(open.page, 'card') as { canvas: { pixelRatio: number }; performers: { points: Record<string, [number, number]>; face: number[] | null }[] };
    const p = c.performers[0]!;
    const css = p.face ? p.face[3]! - p.face[1]! : 0;
    const feet = Math.max(p.points.leftFoot?.[1] ?? 0, p.points.rightFoot?.[1] ?? 0);
    return { cssPx: round(css), devicePx: round(css * c.canvas.pixelRatio), ...(mobile ? { mm: Math.round(css * MM_PER_CSS_PX * 100) / 100 } : {}), bodyCssPx: round(feet - (p.points.headTop?.[1] ?? 0)) };
  } finally { await open.close(); }
}

/** A seeded shuffle, so a rerun gives the same key. */
function shuffled<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  let s = seed;
  for (let i = out.length - 1; i > 0; i -= 1) { s = (s * 1103515245 + 12345) % 2 ** 31; const j = s % (i + 1); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(n); return i === -1 ? undefined : args.splice(i, 2)[1]; };
  const sheetArg = flag('--sheet');
  const out = resolve(flag('--out') ?? OUTPUT);
  const take = args[0];
  if (!take) { console.error('usage: face-legibility.ts <take.glb> [--sheet take.beats.json] [--out dir]'); process.exit(2); }
  const sheet = JSON.parse(await readFile(sheetArg ?? take.replace(/\.glb$/, '.beats.json'), 'utf8')) as BeatSheet;
  const peaks = sheet.beats.map((b) => {
    if (!b.directions[0]) throw new Error(`beat ${b.id}: no directions; give each beat one expression`);
    const r = resolveTiming(b, b.directions[0]);
    return { name: b.id, t: r.at + r.attack + r.hold / 2 };
  });
  const firstFrom = Math.min(...sheet.beats.map((b) => beatSpan(b).from));
  peaks.push({ name: 'neutral', t: Math.max(0, firstFrom / 2) });
  await mkdir(out, { recursive: true });

  const servers = await startViewer();
  try {
    const neutralAt = peaks.at(-1)!.t;
    const card = {
      phone: await cardFace(servers, take, PHONE, CARD_PIXEL_RATIO, true, neutralAt),
      desktop: await cardFace(servers, take, { width: 1440, height: 900 }, 1, false, neutralAt),
      desktopRetina: await cardFace(servers, take, { width: 1440, height: 900 }, 2, false, neutralAt)
    };
    if (card.phone.devicePx <= 0) throw new Error('no face found on the card: the first performer needs a face mesh, facing the camera');

    const open = await openTake(servers, take, { viewport: { width: 600, height: 600 } });
    const tiles: Record<number, Record<string, string>> = {};
    try {
      const { page } = open;
      await page.addScriptTag({ content: REVIEW_PAGE });
      await call(page, 'init', open.url);
      await call(page, 'seek', neutralAt);
      const body = await call(page, 'bodies') as { performers: { head: Vec }[] };
      const head = body.performers[0]!.head;
      // A reference render from the front, to find the face's box and centre it.
      const d0 = 0.9;
      let target: Vec = [head[0], head[1] + 0.04, head[2] + 0.06];
      const view = (d: number, size: number, faceBox = false) => ({ position: [target[0], target[1], target[2] + d], target, fov: FOV, width: size, height: size, background: BACKGROUND, faceBox });
      const ref = await call(page, 'close', 0, view(d0, REF, true)) as { face: number[] };
      const span = 2 * d0 * Math.tan((FOV * Math.PI) / 360); // metres across the reference image at the target
      const [x0, y0, x1, y1] = ref.face;
      target = [target[0] + (((x0! + x1!) / 2 - REF / 2) / REF) * span, target[1] - (((y0! + y1!) / 2 - REF / 2) / REF) * span, target[2]];
      const h0 = y1! - y0!;
      for (const n of [...new Set([Math.round(card.phone.devicePx), ...SIZES])].sort((a, b) => a - b)) {
        tiles[n] = {};
        const size = Math.max(16, Math.round(n * 2.2));
        const d = d0 * (h0 / REF) * (size / n);
        for (const p of peaks) {
          await call(page, 'seek', p.t);
          const shot = await call(page, 'close', 0, view(d, size)) as { image: string };
          tiles[n]![p.name] = shot.image;
        }
      }
    } finally { await open.close(); }

    const browser = await chromium.launch({ headless: true });
    const key: Record<string, Record<string, string>> = {};
    try {
      const sheetPage = await browser.newPage();
      await sheetPage.setContent('<html><body></body></html>');
      await sheetPage.addScriptTag({ content: SHEET_PAGE });
      for (const [i, [n, byName]] of Object.entries(tiles).entries()) {
        const order = shuffled(Object.keys(byName), 7919 * (i + 1));
        const letters = order.map((_, k) => String.fromCharCode(65 + k));
        key[`blind-${String(i).padStart(2, '0')}`] = Object.fromEntries(order.map((name, k) => [letters[k]!, name]));
        const url = await sheetPage.evaluate(([ts, w, ti]) => (window as unknown as { __sheet: (...a: unknown[]) => Promise<string> }).__sheet(ts, 4, w, w, ti),
          [order.map((name, k) => ({ src: byName[name]!, label: letters[k]! })), TILE, `faces ${n} px tall, enlarged`] as const);
        await writeFile(join(out, `blind-${String(i).padStart(2, '0')}.jpg`), Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
        key[`blind-${String(i).padStart(2, '0')}`]!.facePx = String(n);
      }
    } finally { await browser.close(); }
    await writeFile(join(out, 'key.json'), `${JSON.stringify(key, null, 2)}\n`);
    await writeFile(join(out, 'face.json'), `${JSON.stringify({ take: basename(take), card, sizes: Object.keys(tiles).map(Number), expressions: peaks.map((p) => p.name) }, null, 2)}\n`);
    console.log(`card framing, standing performer: phone ${card.phone.cssPx} CSS px (${card.phone.devicePx} device px, ${card.phone.mm} mm), body ${card.phone.bodyCssPx} CSS px; desktop ${card.desktop.cssPx} px (${card.desktopRetina.devicePx} at 2×)`);
    console.log(`blind sheets: ${out}`);
  } finally { servers.close(); }
}

await main();
