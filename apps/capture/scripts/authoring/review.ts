/**
 * Reviews a built take: plays it in viewer-web and writes a review pack, so
 * a fresh reader can say what they see and the author can compare that with
 * the beat sheet's stated intent, beat by beat.
 *
 *   node --conditions=development --import tsx scripts/authoring/review.ts <take.glb> [--sheet take.beats.json] [--out dir] [--step 0.2] [--fps 30]
 *
 * Two framings, both drawn by the viewer's own renderer and scene:
 * - card: the feed card on a phone (390×844 CSS px; the card canvas draws at
 *   1.5 device px per CSS px, the most viewer-web allows), the card's own
 *   camera, as a viewer scrolling the feed sees it;
 * - close: one per performer, head to hips, from the side the card sees.
 *
 * The pack (default `output/authoring/review/<take>/`):
 * - `reader/`: what the fresh reader is given and nothing else: `review.mp4`
 *   (H.264, card and close side by side, real time), frame sheets every
 *   `--step` seconds with the take time on each tile
 *   (`sheet-card-NN.jpg`, `sheet-close-<performer>-NN.jpg`), and
 *   `README.md`, the reader's instructions. No intent, no beat names.
 * - `acting-report.json`: what moves and when (`acting-report.ts`).
 * - `on-screen.json`: per performer, the face's height at card framing in
 *   CSS and device px, and per second how far the head and hands travel on
 *   the card, in CSS px (a hold under 1 px reads as frozen at card size).
 * - `comparison.json`: the stated intent per beat with empty `seen`,
 *   `reads` and `revise`, for the author to fill from the reader's account
 *   (left alone if it already exists).
 * - `pack.json`: what was rendered, and how.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

import { tokens } from '@holoim/design-tokens';

import { actingReport, summarize } from './acting-report.ts';
import { beatSpan, type BeatSheet } from './lib/beats.ts';
import { parseGlb } from './lib/gltf-read.ts';
import { REVIEW_PAGE, SHEET_PAGE } from './lib/review-page.ts';
import { openTake, startViewer } from './lib/viewer-session.ts';

const OUTPUT = fileURLToPath(new URL('../../output/authoring/', import.meta.url));
/** The feed card on a phone: the viewport of an iPhone 15 in CSS px. */
export const PHONE = { width: 390, height: 844 } as const;
/** viewer-web's canvas draws at most 1.5 device px per CSS px (`dpr={[1, 1.5]}` in HologramCardCanvas). */
export const CARD_PIXEL_RATIO = 1.5;
/** An iPhone 15 shows 460 device px per inch at 3 device px per CSS px. */
export const MM_PER_CSS_PX = (25.4 * 3) / 460;
const CLOSE_SIZE = 900;
const CLOSE_FOV = 30;
export const BACKGROUND = Number.parseInt(tokens.color.ground.mid.slice(1), 16);
const STILL_PX = 1;

type Vec = [number, number, number];
interface CardPerformer { name: string; points: Record<string, [number, number]>; face: [number, number, number, number] | null }
interface CardReading { canvas: { width: number; height: number; pixelRatio: number }; performers: CardPerformer[] }
interface Bodies { camera: Vec; performers: { head: Vec; hips: Vec }[] }
interface Init { duration: number; performers: { name: string; bones: string[]; faceVertices: number }[]; fov: number; pixelRatio: number }

export interface ReviewOptions {
  readonly sheet?: string;
  readonly out?: string;
  readonly step?: number;
  readonly fps?: number;
}

export interface OnScreen {
  readonly framing: string;
  readonly performers: {
    readonly name: string;
    /** Height of the part of the mesh the face channels move (brow to chin), at the card's framing. */
    readonly faceCssPx: { readonly min: number; readonly median: number; readonly max: number };
    readonly faceDevicePx: number;
    readonly faceMmOnPhone: number;
    /** Head top to feet, CSS px, median. */
    readonly bodyCssPx: number;
    /** Per second of the take: the largest distance the head or either hand moves on the card from where it was at the start of that second (CSS px). */
    readonly travelPerSecond: { readonly from: number; readonly head: number; readonly hands: number; readonly still: boolean }[];
  }[];
}

const add = (a: Vec, b: Vec, k = 1): Vec => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const len = (a: Vec) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec): Vec => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };
const round = (x: number, k = 10) => Math.round(x * k) / k;
const dist2 = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Moving average over ±`half` samples. */
function smoothed(xs: Vec[], half: number): Vec[] {
  return xs.map((_, i) => {
    let s: Vec = [0, 0, 0]; let n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(xs.length - 1, i + half); j += 1) { s = add(s, xs[j]!); n += 1; }
    return [s[0] / n, s[1] / n, s[2] / n];
  });
}

/** Head to hips, from the side the card sees, a little above the eyes. */
export function closeView(head: Vec, hips: Vec, camera: Vec, fov = CLOSE_FOV): { position: Vec; target: Vec } {
  const top = head[1] + 0.22;
  const bottom = hips[1] - 0.14;
  const target: Vec = [(head[0] + hips[0]) / 2, (top + bottom) / 2, (head[2] + hips[2]) / 2];
  const flat = norm([camera[0] - target[0], 0, camera[2] - target[2]]);
  const dir = norm([flat[0], 0.14, flat[2]]);
  const distance = ((top - bottom) / 2 / Math.tan((fov * Math.PI) / 360)) * 1.08;
  return { position: add(target, dir, distance), target };
}

async function dataUrlTo(file: string, dataUrl: string): Promise<void> {
  await writeFile(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
}

async function sheet(page: Page, out: string, tiles: { file: string; label: string; crop?: number[] }[], tileW: number, tileH: number, title: string): Promise<void> {
  const loaded = await Promise.all(tiles.map(async (t) => ({ src: `data:image/jpeg;base64,${(await readFile(t.file)).toString('base64')}`, label: t.label, crop: t.crop })));
  const url = await page.evaluate(([ts, w, h, ti]) => (window as unknown as { __sheet: (...a: unknown[]) => Promise<string> }).__sheet(ts, 5, w, h, ti), [loaded, tileW, tileH, title] as const);
  await dataUrlTo(out, url);
}

function ffmpeg(args: string[]): void {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr.toString()}`);
}

export async function review(take: string, options: ReviewOptions = {}): Promise<{ out: string; onScreen: OnScreen }> {
  const started = performance.now();
  const sheetFile = options.sheet ?? `${take.replace(/\.glb$/, '')}.beats.json`;
  // A sheet beside the take is optional; one named with --sheet must load.
  const sheetData = await readFile(sheetFile, 'utf8').then((s) => JSON.parse(s) as BeatSheet)
    .catch((error: unknown) => { if (options.sheet) throw new Error(`--sheet ${options.sheet}: ${String(error)}`); return undefined; });
  const out = resolve(options.out ?? join(OUTPUT, 'review', basename(take, '.glb')));
  const reader = join(out, 'reader');
  const step = options.step ?? 0.2;
  const fps = options.fps ?? 30;
  const frameDir = join(out, 'frames');
  await rm(reader, { recursive: true, force: true });
  await rm(frameDir, { recursive: true, force: true });
  await mkdir(join(frameDir, 'card'), { recursive: true });
  await mkdir(reader, { recursive: true });

  const doc = parseGlb(new Uint8Array(await readFile(take)));
  const acting = actingReport(doc, basename(take));
  await writeFile(join(out, 'acting-report.json'), `${JSON.stringify(acting, null, 2)}\n`);

  const servers = await startViewer();
  let onScreen: OnScreen;
  let init: Init;
  try {
    const open = await openTake(servers, take, { viewport: PHONE, deviceScaleFactor: CARD_PIXEL_RATIO, isMobile: true, title: 'Take' }); // the card shows it: never the piece's title, which tells the reader the intent
    const { page } = open;
    await page.addScriptTag({ content: REVIEW_PAGE });
    init = await page.evaluate((u) => (window as unknown as { __review: { init(u: string): Init } }).__review.init(u), open.url);
    const frames = Math.floor(init.duration * fps + 1e-6) + 1;
    const times = Array.from({ length: frames }, (_, i) => Math.min(init.duration, i / fps));
    const R = (fn: string, ...a: unknown[]) => page.evaluate(([f, args]) => (window as unknown as { __review: Record<string, (...x: unknown[]) => unknown> }).__review[f as string]!(...(args as unknown[])), [fn, a] as const);

    // Pass 1: the card as it plays (its camera follows frame to frame), and where each body is.
    const cards: CardReading[] = [];
    const bodies: Bodies[] = [];
    for (let f = 0; f < frames; f += 1) {
      await R('seek', times[f]);
      cards.push(await R('card') as CardReading);
      bodies.push(await R('bodies') as Bodies);
      await page.screenshot({ path: join(frameDir, 'card', `${String(f).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 88 });
    }

    // Pass 2: a close view per performer, its camera smoothed over a second so it does not hide small movement.
    for (let p = 0; p < init.performers.length; p += 1) {
      const dir = join(frameDir, `close-${p}`);
      await mkdir(dir, { recursive: true });
      const plan = bodies.map((b) => closeView(b.performers[p]!.head, b.performers[p]!.hips, b.camera));
      const pos = smoothed(plan.map((x) => x.position), Math.round(fps / 2));
      const tgt = smoothed(plan.map((x) => x.target), Math.round(fps / 2));
      for (let f = 0; f < frames; f += 1) {
        await R('seek', times[f]);
        const shot = await R('close', p, { position: pos[f], target: tgt[f], fov: CLOSE_FOV, width: CLOSE_SIZE, height: CLOSE_SIZE, background: BACKGROUND, label: `${times[f]!.toFixed(2)} s` }) as { image: string };
        await dataUrlTo(join(dir, `${String(f).padStart(4, '0')}.jpg`), shot.image);
      }
    }
    await open.close();

    // The video: card and close views side by side, at the take's real speed.
    const inputs = ['-framerate', String(fps), '-i', join(frameDir, 'card', '%04d.jpg')];
    const scales = ['[0]scale=-2:1080[c0]'];
    for (let p = 0; p < init.performers.length; p += 1) {
      inputs.push('-framerate', String(fps), '-i', join(frameDir, `close-${p}`, '%04d.jpg'));
      scales.push(`[${p + 1}]scale=1080:1080[c${p + 1}]`);
    }
    const stack = init.performers.length ? `;${Array.from({ length: init.performers.length + 1 }, (_, i) => `[c${i}]`).join('')}hstack=inputs=${init.performers.length + 1}[v]` : ';[c0]null[v]';
    ffmpeg([...inputs, '-filter_complex', scales.join(';') + stack, '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-r', String(fps), '-movflags', '+faststart', join(reader, 'review.mp4')]);

    // Frame sheets every `step` s: the card cropped to the cast at true device pixels, and each close view.
    const pr = init.pixelRatio;
    let box: number[] | undefined;
    for (const c of cards) for (const p of c.performers) for (const [x, y] of Object.values(p.points)) {
      box = box ? [Math.min(box[0]!, x), Math.min(box[1]!, y), Math.max(box[2]!, x), Math.max(box[3]!, y)] : [x, y, x, y];
    }
    const pad = box ? Math.max(box[2]! - box[0]!, box[3]! - box[1]!) * 0.15 + 12 : 0;
    const crop = box
      ? [Math.max(0, box[0]! - pad), Math.max(0, box[1]! - pad), Math.min(PHONE.width, box[2]! + pad), Math.min(PHONE.height, box[3]! + pad)].map((v) => Math.round(v * pr))
      : [0, 0, PHONE.width * pr, PHONE.height * pr];
    const cardCrop = [crop[0]!, crop[1]!, crop[2]! - crop[0]!, crop[3]! - crop[1]!];
    const picks = Array.from({ length: Math.floor(init.duration / step + 1e-6) + 1 }, (_, k) => Math.min(frames - 1, Math.round(k * step * fps)));
    const browser = await chromium.launch({ headless: true });
    const sheetPage = await browser.newPage();
    await sheetPage.setContent('<html><body></body></html>');
    await sheetPage.addScriptTag({ content: SHEET_PAGE });
    const perSheet = 10;
    for (let s = 0; s * perSheet < picks.length; s += 1) {
      const chunk = picks.slice(s * perSheet, (s + 1) * perSheet);
      const span = `${times[chunk[0]!]!.toFixed(2)}–${times[chunk.at(-1)!]!.toFixed(2)} s`;
      const n = String(s).padStart(2, '0');
      await sheet(sheetPage, join(reader, `sheet-card-${n}.jpg`), chunk.map((f) => ({ file: join(frameDir, 'card', `${String(f).padStart(4, '0')}.jpg`), label: `${times[f]!.toFixed(2)} s`, crop: cardCrop })),
        cardCrop[2]!, cardCrop[3]!, `card framing, true size on a phone (${PHONE.width}×${PHONE.height} CSS px at ${pr}×), ${span}`);
      for (let p = 0; p < init.performers.length; p += 1) {
        await sheet(sheetPage, join(reader, `sheet-close-${p}-${n}.jpg`), chunk.map((f) => ({ file: join(frameDir, `close-${p}`, `${String(f).padStart(4, '0')}.jpg`), label: `${times[f]!.toFixed(2)} s` })),
          360, 360, `close view, performer ${p + 1}, ${span}`);
      }
    }
    await browser.close();

    // On screen: the face's size at card framing, and how far head and hands travel per second.
    onScreen = {
      framing: `feed card on a phone, ${PHONE.width}×${PHONE.height} CSS px, canvas at ${pr} device px per CSS px`,
      performers: init.performers.map((perf, p) => {
        const faces = cards.map((c) => c.performers[p]!.face).filter((b): b is [number, number, number, number] => Boolean(b)).map((b) => b[3] - b[1]);
        const bodiesPx = cards.map((c) => { const q = c.performers[p]!.points; const feet = [q.leftFoot, q.rightFoot].filter(Boolean).map((x) => x![1]); return q.headTop && feet.length ? Math.max(...feet) - q.headTop[1] : 0; });
        const travel: OnScreen['performers'][number]['travelPerSecond'][number][] = [];
        for (let from = 0; from < init.duration - 1e-6; from += 1) {
          const fs = times.map((t, i) => [t, i] as const).filter(([t]) => t >= from && t < from + 1).map(([, i]) => i);
          const far = (k: string) => { const s = cards[fs[0]!]!.performers[p]!.points[k]; return s ? Math.max(...fs.map((i) => dist2(cards[i]!.performers[p]!.points[k]!, s))) : 0; };
          const head = round(far('head'));
          const hands = round(Math.max(far('leftHand'), far('rightHand')));
          travel.push({ from, head, hands, still: head < STILL_PX && hands < STILL_PX });
        }
        const med = median(faces);
        return {
          name: perf.name,
          faceCssPx: { min: round(Math.min(...faces)), median: round(med), max: round(Math.max(...faces)) },
          faceDevicePx: round(med * pr),
          faceMmOnPhone: round(med * MM_PER_CSS_PX, 100),
          bodyCssPx: round(median(bodiesPx)),
          travelPerSecond: travel
        };
      })
    };
    await writeFile(join(out, 'on-screen.json'), `${JSON.stringify(onScreen, null, 2)}\n`);
  } finally {
    servers.close();
  }

  // What the fresh reader is told: what to look at, not what it means.
  await writeFile(join(reader, 'README.md'), [
    '# Review pack: what do you see?',
    '',
    `A short hologram, ${init.duration.toFixed(1)} s, muted. You have not been told what it is meant to show; please do not guess at what the author intended, only say what you see.`,
    '',
    '- `review.mp4`: the take in real time. Left: as it appears on a feed card on a phone. Right: a closer view of each performer.',
    `- \`sheet-card-NN.jpg\`: the card framing at true size, one still every ${step} s, the time on each still.`,
    '- `sheet-close-<performer>-NN.jpg`: the close view at the same times.',
    '',
    'Answer in three parts:',
    '',
    '1. **Overall:** in one or two sentences, what happens and what it is about.',
    '2. **Moment by moment:** a list of time spans (from the labels on the stills) and, for each, what the performer does and what you think it means. Say where you are unsure.',
    '3. **What you could not read:** anything too small, too fast, ambiguous or frozen, and at which framing.',
    ''
  ].join('\n'));

  // The author's side of the comparison, from the sheet's stated intent.
  const comparisonFile = join(out, 'comparison.json');
  const exists = await stat(comparisonFile).then(() => true, () => false);
  if (sheetData && !exists) {
    await writeFile(comparisonFile, `${JSON.stringify({
      take: basename(take),
      sheet: basename(sheetFile),
      reader: null,
      piece: { intent: sheetData.intent ?? null, seen: null, reads: null },
      beats: sheetData.beats.map((b) => {
        const s = beatSpan(b);
        return { beat: b.id, performer: b.performer, from: round(s.from, 100), to: round(s.to, 100), intent: b.intent ?? null, seen: null, reads: null, revise: null };
      })
    }, null, 2)}\n`);
  }
  const missing = sheetData ? sheetData.beats.filter((b) => !b.intent).map((b) => b.id) : [];
  await writeFile(join(out, 'pack.json'), `${JSON.stringify({
    take: resolve(take), sheet: sheetData ? resolve(sheetFile) : null, duration: init.duration, fps, step,
    framings: { card: { viewport: PHONE, pixelRatio: CARD_PIXEL_RATIO, camera: 'the card\'s own' }, close: { size: CLOSE_SIZE, fov: CLOSE_FOV, camera: 'head to hips from the card\'s side, smoothed over 1 s' } },
    performers: init.performers, beatsWithoutIntent: missing, seconds: round((performance.now() - started) / 1000)
  }, null, 2)}\n`);
  await rm(frameDir, { recursive: true, force: true });
  return { out, onScreen };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i === -1 ? undefined : args.splice(i, 2)[1]; };
  const sheet = flag('--sheet');
  const out = flag('--out');
  const step = flag('--step');
  const fps = flag('--fps');
  const take = args[0];
  if (!take) { console.error('usage: review.ts <take.glb> [--sheet take.beats.json] [--out dir] [--step 0.2] [--fps 30]'); process.exit(2); }
  const r = await review(take, { ...(sheet ? { sheet } : {}), ...(out ? { out } : {}), ...(step ? { step: Number(step) } : {}), ...(fps ? { fps: Number(fps) } : {}) });
  const acting = JSON.parse(await readFile(join(r.out, 'acting-report.json'), 'utf8'));
  console.log(summarize(acting));
  for (const p of r.onScreen.performers) {
    const still = p.travelPerSecond.filter((s) => s.still).map((s) => `${s.from}-${s.from + 1} s`);
    console.log(`  ${p.name} on the card: face ${p.faceCssPx.median} CSS px tall (${p.faceDevicePx} device px, ${p.faceMmOnPhone} mm on a phone), body ${p.bodyCssPx} CSS px` +
      (still.length ? `; still at card size (head and hands < ${STILL_PX} px): ${still.join(', ')}` : '; never still at card size'));
  }
  console.log(`review pack: ${r.out}\n  give a fresh reader only ${join(r.out, 'reader')}; fill ${join(r.out, 'comparison.json')} from their account`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
