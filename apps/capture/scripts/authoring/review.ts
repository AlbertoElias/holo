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
 * - close: one per performer, head to hips, from the side the card sees,
 *   widening to hold the recorded objects the performer acts on while they
 *   act on them (below).
 *
 * The card stills are cropped to the cast and every recorded object on the
 * card, so a stage the card shows is never cut from the stills. A performer
 * acts on an object while a beat of theirs names it (take, put, aim, look,
 * reach or turn toward it, its anchors, a place or mark measured from it),
 * from half a second before the beat to half a second after, and while it
 * is in their hand. Without a sheet, an object is acted on while
 * `HOLOIM_objects` says it is held, by the performer the viewer frames.
 *
 * The pack (default `output/authoring/review/<take>/`):
 * - `reader/`: what the fresh reader is given and nothing else: `review.mp4`
 *   (H.264, card and close side by side, real time), frame sheets every
 *   `--step` seconds with the take time on each tile
 *   (`sheet-card-NN.jpg`, `sheet-close-<performer>-NN.jpg`), and
 *   `README.md`, the reader's instructions. No intent, no beat names.
 * - `acting-report.json`: what moves and when (`acting-report.ts`).
 * - `on-screen.json`: each recorded object's size on the card and how much
 *   of the take it is wholly on it; per performer, the face's height at card framing in
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
import { beatSpan, holdingsOf, pointObjects, type BeatSheet, type Direction, type Point } from './lib/beats.ts';
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
type ScreenBox = [number, number, number, number];
interface CardReading { canvas: { width: number; height: number; pixelRatio: number }; performers: CardPerformer[]; objects: { name: string; box: ScreenBox | null }[] }
interface WorldBox { name: string; min: Vec; max: Vec }
interface Bodies { camera: Vec; performers: { head: Vec; hips: Vec }[]; objects: WorldBox[] }
interface InitObject { name: string; source?: string; holds: { hand: string; start: number; end: number }[] }
interface Init { duration: number; performers: { name: string; bones: string[]; faceVertices: number }[]; fov: number; pixelRatio: number; objects: InitObject[] }
/** How long before and after a beat the close view holds the objects it names. */
const ACT_MARGIN_S = 0.5;

export interface ReviewOptions {
  readonly sheet?: string;
  readonly out?: string;
  readonly step?: number;
  readonly fps?: number;
  /** Only the first `until` seconds of the take. */
  readonly until?: number;
  /** The card framing alone: no close views and no video. */
  readonly cardOnly?: boolean;
  /** Also render the card's moments from a camera swung this many degrees about the cast (`sheet-orbit-NN.jpg`, `orbit/`). */
  readonly orbit?: number;
}

export interface OnScreen {
  readonly framing: string;
  /** Each recorded object's box on the card, CSS px (median over the take), and the share of the take it is wholly on the card. */
  readonly objects: { readonly name: string; readonly cssPx: { readonly width: number; readonly height: number }; readonly wholeOnCard: number }[];
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

const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Head to hips, from the side the card sees, a little above the eyes. With
 * `objects` (world boxes of what the performer acts on), the view widens and
 * recentres, from the same side, until they are in it too.
 */
export function closeView(head: Vec, hips: Vec, camera: Vec, fov = CLOSE_FOV, objects: readonly WorldBox[] = []): { position: Vec; target: Vec } {
  const top = head[1] + 0.22;
  const bottom = hips[1] - 0.14;
  const body: Vec = [(head[0] + hips[0]) / 2, (top + bottom) / 2, (head[2] + hips[2]) / 2];
  const flat = norm([camera[0] - body[0], 0, camera[2] - body[2]]);
  const dir = norm([flat[0], 0.14, flat[2]]);
  const tan = Math.tan((fov * Math.PI) / 360);
  if (!objects.length) return { position: add(body, dir, ((top - bottom) / 2 / tan) * 1.08), target: body };
  // The column head to hips and every corner of the objects, seen along -dir (a square view, so one tangent).
  const points: Vec[] = [[body[0], top, body[2]], [body[0], bottom, body[2]]];
  for (const o of objects) for (let k = 0; k < 8; k += 1) points.push([(k & 1 ? o.max : o.min)[0], (k & 2 ? o.max : o.min)[1], (k & 4 ? o.max : o.min)[2]]);
  const right = norm(cross([0, 1, 0], dir));
  const up = cross(dir, right);
  const span = (axis: Vec) => { const xs = points.map((q) => dot(q, axis)); return [Math.min(...xs), Math.max(...xs)] as const; };
  const [r0, r1] = span(right); const [u0, u1] = span(up); const [d0, d1] = span(dir);
  const target = add(add(add([0, 0, 0], right, (r0 + r1) / 2), up, (u0 + u1) / 2), dir, (d0 + d1) / 2);
  let distance = 0;
  for (const q of points) {
    const o: Vec = [q[0] - target[0], q[1] - target[1], q[2] - target[2]];
    // The camera stands at target + dir·distance; a point nearer the camera by dot(o, dir) needs that much more.
    distance = Math.max(distance, dot(o, dir) + Math.max(Math.abs(dot(o, right)), Math.abs(dot(o, up))) / tan);
  }
  return { position: add(target, dir, distance * 1.08), target };
}

/** The point fields a direction names (where it reaches, looks, aims, turns toward, puts). */
function directionPoints(d: Direction): (Point | undefined)[] {
  switch (d.kind) {
    case 'look': case 'reach': case 'aim': case 'gesture': case 'state': return [d.at];
    case 'turn': return [d.toward];
    case 'put': return [d.at, d.on];
    default: return [];
  }
}

/**
 * For each performer (by the viewer's wrapper name), the times at which they
 * act on each declared object: what the module comment says.
 */
export function actedOn(sheet: BeatSheet | undefined, performers: readonly string[], objects: readonly InitObject[]): (performer: number, t: number) => string[] {
  const spans: { performer: number; object: string; from: number; to: number }[] = [];
  if (sheet?.objects && Object.keys(sheet.objects).length) {
    const ids = new Set(Object.keys(sheet.objects));
    const declared = (id: string) => sheet.objects![id]!.name ?? id;
    // The writer names the first performer's wrapper RecordedAvatar and the others Performer_<id>,
    // which the viewer's loader sanitises as three's PropertyBinding does (whitespace to _, []./: dropped).
    const loaded = (name: string) => name.replace(/\s/g, '_').replace(/[[\]./:]/g, '');
    const index = (id: string) => (sheet.performers[0]?.id === id
      ? performers.indexOf('RecordedAvatar')
      : performers.indexOf(loaded(`Performer_${id}`)));
    for (const beat of sheet.beats) {
      const p = index(beat.performer);
      if (p < 0) continue;
      const span = beatSpan(beat);
      const named = new Set(beat.directions.flatMap((d) => [
        ...(d.kind === 'take' || d.kind === 'put' ? [d.object] : []),
        ...directionPoints(d).flatMap((pt) => (typeof pt === 'string' && ids.has(pt) ? [pt] : pointObjects(pt, ids, sheet.marks ?? {})))
      ]));
      for (const id of named) spans.push({ performer: p, object: declared(id), from: span.from - ACT_MARGIN_S, to: span.to + ACT_MARGIN_S });
    }
    for (const h of holdingsOf(sheet).holdings) {
      const p = index(h.performer);
      if (p >= 0) spans.push({ performer: p, object: declared(h.object), from: h.from, to: h.to });
    }
  } else {
    for (const o of objects) for (const h of o.holds) spans.push({ performer: 0, object: o.name, from: h.start, to: h.end });
  }
  const known = new Set(objects.map((o) => o.name));
  return (performer, t) => [...new Set(spans.filter((s) => s.performer === performer && t >= s.from && t <= s.to && known.has(s.object)).map((s) => s.object))];
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
  const orbitDir = join(out, 'orbit');
  await rm(reader, { recursive: true, force: true });
  await rm(frameDir, { recursive: true, force: true });
  await rm(orbitDir, { recursive: true, force: true });
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
    const span = Math.min(init.duration, options.until ?? init.duration);
    const frames = Math.floor(span * fps + 1e-6) + 1;
    const times = Array.from({ length: frames }, (_, i) => Math.min(span, i / fps));
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

    const acts = actedOn(sheetData, init.performers.map((x) => x.name), init.objects);
    // Pass 2: a close view per performer, its camera smoothed over a second so it does not hide small movement.
    const closed = options.cardOnly ? 0 : init.performers.length;
    for (let p = 0; p < closed; p += 1) {
      const dir = join(frameDir, `close-${p}`);
      await mkdir(dir, { recursive: true });
      const plan = bodies.map((b, f) => {
        const acting = new Set(acts(p, times[f]!));
        return closeView(b.performers[p]!.head, b.performers[p]!.hips, b.camera, CLOSE_FOV, b.objects.filter((o) => acting.has(o.name) && Number.isFinite(o.min[0]!)));
      });
      const pos = smoothed(plan.map((x) => x.position), Math.round(fps / 2));
      const tgt = smoothed(plan.map((x) => x.target), Math.round(fps / 2));
      for (let f = 0; f < frames; f += 1) {
        await R('seek', times[f]);
        const shot = await R('close', p, { position: pos[f], target: tgt[f], fov: CLOSE_FOV, width: CLOSE_SIZE, height: CLOSE_SIZE, background: BACKGROUND, label: `${times[f]!.toFixed(2)} s` }) as { image: string };
        await dataUrlTo(join(dir, `${String(f).padStart(4, '0')}.jpg`), shot.image);
      }
    }
    // The card's moments again from a camera swung about the cast: its centre is the mean of every performer's head-to-hips midpoint,
    // the camera keeps the card's height, distance and field of view, and is turned `orbit` degrees about the vertical through that centre.
    const orbitFrames = options.orbit === undefined ? [] : Array.from({ length: Math.floor(span / step + 1e-6) + 1 }, (_, k) => Math.min(frames - 1, Math.round(k * step * fps)));
    if (options.orbit !== undefined) {
      await mkdir(orbitDir, { recursive: true });
      const turn = (options.orbit * Math.PI) / 180;
      for (const f of orbitFrames) {
        const b = bodies[f]!;
        const mids = b.performers.map((q) => [(q.head[0] + q.hips[0]) / 2, (q.head[1] + q.hips[1]) / 2, (q.head[2] + q.hips[2]) / 2] as Vec);
        const centre: Vec = [mids.reduce((a, m) => a + m[0], 0) / mids.length, mids.reduce((a, m) => a + m[1], 0) / mids.length, mids.reduce((a, m) => a + m[2], 0) / mids.length];
        const dx = b.camera[0] - centre[0]; const dz = b.camera[2] - centre[2];
        const position: Vec = [centre[0] + dx * Math.cos(turn) + dz * Math.sin(turn), b.camera[1], centre[2] - dx * Math.sin(turn) + dz * Math.cos(turn)];
        await R('seek', times[f]);
        const shot = await R('close', 0, { position, target: centre, fov: init.fov, width: PHONE.width * CARD_PIXEL_RATIO, height: PHONE.height * CARD_PIXEL_RATIO, background: BACKGROUND, label: `${times[f]!.toFixed(2)} s` }) as { image: string };
        await dataUrlTo(join(orbitDir, `${String(f).padStart(4, '0')}.jpg`), shot.image);
      }
    }
    await open.close();

    // The video: card and close views side by side, at the take's real speed.
    if (!options.cardOnly) {
    const inputs = ['-framerate', String(fps), '-i', join(frameDir, 'card', '%04d.jpg')];
    const scales = ['[0]scale=-2:1080[c0]'];
    for (let p = 0; p < init.performers.length; p += 1) {
      inputs.push('-framerate', String(fps), '-i', join(frameDir, `close-${p}`, '%04d.jpg'));
      scales.push(`[${p + 1}]scale=1080:1080[c${p + 1}]`);
    }
    const stack = init.performers.length ? `;${Array.from({ length: init.performers.length + 1 }, (_, i) => `[c${i}]`).join('')}hstack=inputs=${init.performers.length + 1}[v]` : ';[c0]null[v]';
    ffmpeg([...inputs, '-filter_complex', scales.join(';') + stack, '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-r', String(fps), '-movflags', '+faststart', join(reader, 'review.mp4')]);
    }

    // Frame sheets every `step` s: the card cropped to the cast at true device pixels, and each close view.
    const pr = init.pixelRatio;
    let box: number[] | undefined;
    for (const c of cards) {
      // The cast, and every recorded object the card shows (its box's corners): the stills keep what the card frames.
      const corners = c.objects.flatMap((o) => (o.box ? [[o.box[0], o.box[1]], [o.box[2], o.box[3]]] as [number, number][] : []));
      for (const [x, y] of [...c.performers.flatMap((p) => Object.values(p.points)), ...corners]) {
        box = box ? [Math.min(box[0]!, x), Math.min(box[1]!, y), Math.max(box[2]!, x), Math.max(box[3]!, y)] : [x, y, x, y];
      }
    }
    const pad = box ? Math.max(box[2]! - box[0]!, box[3]! - box[1]!) * 0.15 + 12 : 0;
    const crop = box
      ? [Math.max(0, box[0]! - pad), Math.max(0, box[1]! - pad), Math.min(PHONE.width, box[2]! + pad), Math.min(PHONE.height, box[3]! + pad)].map((v) => Math.round(v * pr))
      : [0, 0, PHONE.width * pr, PHONE.height * pr];
    const cardCrop = [crop[0]!, crop[1]!, crop[2]! - crop[0]!, crop[3]! - crop[1]!];
    const picks = Array.from({ length: Math.floor(span / step + 1e-6) + 1 }, (_, k) => Math.min(frames - 1, Math.round(k * step * fps)));
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
      for (let p = 0; p < closed; p += 1) {
        await sheet(sheetPage, join(reader, `sheet-close-${p}-${n}.jpg`), chunk.map((f) => ({ file: join(frameDir, `close-${p}`, `${String(f).padStart(4, '0')}.jpg`), label: `${times[f]!.toFixed(2)} s` })),
          360, 360, `close view, performer ${p + 1}, ${span}`);
      }
    }
    // The orbit: the same moments, 360 px square around the cast's centre (true device pixels, cropped from the card-sized frame).
    const orbitCrop = [0, Math.round((PHONE.height * pr - 360 * 1.6) / 2), PHONE.width * pr, Math.round(360 * 1.6)];
    for (let s = 0; s * perSheet < orbitFrames.length; s += 1) {
      const chunk = orbitFrames.slice(s * perSheet, (s + 1) * perSheet);
      await sheet(sheetPage, join(reader, `sheet-orbit-${String(s).padStart(2, '0')}.jpg`), chunk.map((f) => ({ file: join(orbitDir, `${String(f).padStart(4, '0')}.jpg`), label: `${times[f]!.toFixed(2)} s`, crop: orbitCrop })),
        360, 360, `the same moments from a camera swung ${options.orbit} degrees around the cast, ${times[chunk[0]!]!.toFixed(2)}–${times[chunk.at(-1)!]!.toFixed(2)} s`);
    }
    await browser.close();

    // On screen: the face's size at card framing, and how far head and hands travel per second.
    onScreen = {
      framing: `feed card on a phone, ${PHONE.width}×${PHONE.height} CSS px, canvas at ${pr} device px per CSS px`,
      objects: init.objects.map((o, j) => {
        const boxes = cards.map((c) => c.objects[j]?.box ?? null);
        const sized = boxes.filter((b): b is ScreenBox => Boolean(b));
        const whole = boxes.filter((b) => b && b[0] >= 0 && b[1] >= 0 && b[2] <= PHONE.width && b[3] <= PHONE.height).length;
        return { name: o.name, cssPx: { width: round(median(sized.map((b) => b[2] - b[0]))), height: round(median(sized.map((b) => b[3] - b[1]))) }, wholeOnCard: round(whole / Math.max(1, boxes.length), 100) };
      }),
      performers: init.performers.map((perf, p) => {
        const faces = cards.map((c) => c.performers[p]!.face).filter((b): b is [number, number, number, number] => Boolean(b)).map((b) => b[3] - b[1]);
        const bodiesPx = cards.map((c) => { const q = c.performers[p]!.points; const feet = [q.leftFoot, q.rightFoot].filter(Boolean).map((x) => x![1]); return q.headTop && feet.length ? Math.max(...feet) - q.headTop[1] : 0; });
        const travel: OnScreen['performers'][number]['travelPerSecond'][number][] = [];
        for (let from = 0; from < span - 1e-6; from += 1) {
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
    '- `review.mp4`: the take in real time. Left: as it appears on a feed card on a phone. Right: a closer view of each performer, which widens to show what they are handling or directing attention to.',
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
    framings: { card: { viewport: PHONE, pixelRatio: CARD_PIXEL_RATIO, camera: 'the card\'s own' }, close: { size: CLOSE_SIZE, fov: CLOSE_FOV, camera: `head to hips from the card's side, widened to the objects the performer acts on (beats naming them ±${ACT_MARGIN_S} s, and while held), smoothed over 1 s` }, cardStills: 'cropped to the cast and every recorded object on the card' },
    objects: init.objects,
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
