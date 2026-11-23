/**
 * A look card from a photo (slice 5a of docs/features/directed-performance.md).
 *
 *   node --conditions=development --import tsx scripts/authoring/photo-look.ts <photo> [--out card.json] [--finish clay|ink|light] [--name n] [--read-only]
 *
 * Use only a photo of yourself. The tool cannot tell who is in the photo, so
 * that rule is yours to keep.
 *
 * It reads one photo of one face with `@holoim/avatar-look/read` in headless
 * Chromium: skin (by lightness, after white balance), hair colour, eye
 * colour (with a confidence: a low one keeps the default), and a proposed
 * hair style (the hair's outline against the six styles rendered from the
 * same view). Build, glasses and clothing stay the default look's
 * (base.json `defaultLook`): a photo cannot say them. Every value is a
 * proposal: check each one against the photo and change it in the card.
 *
 * Writes to `output/authoring/photo-look/<name>/` (name: the photo's file
 * name, or `--name`): `card.json` (a card `parseLook` accepts), `report.json`
 * (each trait's value, measured colour, swatch, distance and confidence),
 * and `compare.jpg` (the photo's face beside the dressed base from the same
 * view, in each finish, or only `--finish`; under it the hair outlines).
 * `--out` also writes the card there. The photo is not copied: it is read
 * into memory and served to the local page only. Nothing is sent to any
 * service. The segmenter model is fetched once from Google's model store, at
 * a pinned SHA-256, into `output/authoring/photo-look/.models/`. The six
 * hair styles' outlines do not depend on the photo: the first full run
 * renders them (about 15 s) and keeps them in
 * `output/authoring/photo-look/.styles/`; later runs read the card in about
 * 3 s, and only compare.jpg renders.
 *
 * `--read-only` skips the renders and compare.jpg: the card only, in about
 * 3 s. It proposes the hair style from the kept outlines, so run once
 * without it first.
 *
 * Exits 2 when the photo is refused (no face, two or more faces, a face too
 * small), naming why.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { chromium, type Page } from 'playwright';
import { XR_CHROMIUM_ARGS } from '@holoim/tooling-testing/xr-env';
import { build as viteBuild, type Rollup } from 'vite';

import {
  applyFinish, cardFromRead, dressAvatar, FINISHES, HAIR_STYLE_MIN_CONFIDENCE, HAIR_STYLES, parseLook, proposeHairStyle,
  type Finish, type HairGrid, type HairStyle, type HairStyleProposal, type LookCard, type TraitRead
} from '@holoim/avatar-look';
import type { FaceFrame, PhotoRead } from '@holoim/avatar-look/read';
import { tokens } from '@holoim/design-tokens';

import { build } from './direct.ts';
import { defaultLook, dressedFile, wardrobeFile } from './lib/house-look.ts';
import { REVIEW_PAGE } from './lib/review-page.ts';
import { openTake, startViewer, type ViewerServers } from './lib/viewer-session.ts';

const APP = fileURLToPath(new URL('../../', import.meta.url));
const OUTPUT = join(APP, 'output/authoring/photo-look');
const MODELS = join(OUTPUT, '.models');
const STYLE_CACHE = join(OUTPUT, '.styles');
const WASM = join(APP, 'node_modules/@mediapipe/tasks-vision/wasm');
const FACE_MODEL = join(APP, 'public/mediapipe/face_landmarker.task');
const SEGMENTER = {
  file: 'selfie_multiclass_256x256.tflite',
  url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
  sha256: 'c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0'
} as const;
const READ_ENTRY = fileURLToPath(new URL('../../../../packages/avatar-look/src/read.ts', import.meta.url));
const ORIGIN = 'https://photo-look.local';
/** The photo is drawn at most this many px on its long side. */
const MAX_SIDE = 2048;

/** The renders: a head-and-shoulders view, from the head bone up and down (m), RENDER px square. */
const RENDER = 512;
const VIEW = { top: 0.42, bottom: -0.42, ahead: 0.04, fov: 20 } as const;
const SPACING = 3;
const BACKGROUND = Number.parseInt(tokens.color.ground.mid.slice(1), 16);
const KEY_GREEN = [0, 1, 0, 1] as const;

const HELP = `photo-look.ts <photo> [--out card.json] [--finish clay|ink|light] [--name n] [--read-only]

Reads a photo of YOUR OWN face into a look card for beat sheets: skin, hair
colour, eye colour and a proposed hair style. Use only a photo of yourself;
the tool cannot check who is in it. The photo stays on this machine and is
not copied. Check every value in the card against the photo before you use it.`;

type Review = Record<string, (...a: unknown[]) => unknown>;
const call = (page: Page, fn: string, ...a: unknown[]) => page.evaluate(([f, args]) => (window as unknown as { __review: Review }).__review[f as string]!(...(args as unknown[])), [fn, a] as const);

async function segmenterModel(): Promise<Buffer> {
  const file = join(MODELS, SEGMENTER.file);
  if (!existsSync(file)) {
    console.log(`fetching ${SEGMENTER.file} (16 MB, once)`);
    const res = await fetch(SEGMENTER.url);
    if (!res.ok) throw new Error(`fetching ${SEGMENTER.url}: ${res.status}`);
    await mkdir(MODELS, { recursive: true });
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
  }
  const bytes = await readFile(file);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== SEGMENTER.sha256) throw new Error(`${file}: sha256 ${sha}, expected ${SEGMENTER.sha256}; delete it to fetch it again`);
  return bytes;
}

/** The photo's bytes and type. HEIC (an iPhone's default) is converted to JPEG by macOS `sips` in a private temp folder, deleted at once. */
async function photoBytes(path: string): Promise<{ bytes: Buffer; type: string }> {
  const ext = extname(path).toLowerCase();
  if (ext === '.heic' || ext === '.heif') {
    const dir = await mkdtemp(join(tmpdir(), 'photo-look-'));
    try {
      execFileSync('sips', ['-s', 'format', 'jpeg', path, '--out', join(dir, 'p.jpg')], { stdio: 'ignore' });
      return { bytes: await readFile(join(dir, 'p.jpg')), type: 'image/jpeg' };
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  const types: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
  if (!types[ext]) throw new Error(`${path}: use a .jpg, .png, .webp or .heic photo`);
  return { bytes: await readFile(path), type: types[ext] };
}

/** `@holoim/avatar-look/read` and MediaPipe as one ES module, for the page. */
async function readBundle(): Promise<string> {
  const out = await viteBuild({
    configFile: false, logLevel: 'silent', root: APP,
    resolve: { conditions: ['development'] },
    build: { write: false, minify: false, lib: { entry: READ_ENTRY, formats: ['es'], fileName: 'read' } }
  }) as Rollup.RollupOutput | Rollup.RollupOutput[];
  const chunk = (Array.isArray(out) ? out[0]! : out).output.find((o): o is Rollup.OutputChunk => o.type === 'chunk' && o.isEntry);
  if (!chunk) throw new Error('readBundle: no entry chunk');
  return chunk.code;
}

/** The page script: loads the reader once and exposes read, frame, grids and the compare sheet. */
const PAGE_SCRIPT = `
import * as read from '/read.js';
let reader;
try { reader = await read.createLookReader({
  wasm: { wasmLoaderPath: '${ORIGIN}/wasm/vision_wasm_internal.js', wasmBinaryPath: '${ORIGIN}/wasm/vision_wasm_internal.wasm' },
  faceModel: '${ORIGIN}/models/face_landmarker.task',
  segmenterModel: '${ORIGIN}/models/${SEGMENTER.file}'
}); } catch (e) { window.__failed = String(e && e.message || e); throw e; }
async function canvasOf(src, maxSide) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}
let photo = null;
window.__look = {
  async read(defaults) {
    photo = await canvasOf('/photo', ${MAX_SIDE});
    try { return { ok: true, read: reader.read(photo, defaults) }; }
    catch (e) { if (e.name === 'PhotoRefused') return { ok: false, reason: e.reason, message: e.message }; throw e; }
  },
  async frame(src) { return reader.frame(await canvasOf(src, 4096)); },
  async keyedGrid(src, frame) { return read.keyedHairGrid(await canvasOf(src, 4096), frame); },
  // The photo turned so its face lands where the render's face is, beside each render; under them the hair outlines.
  async compare(photoFrame, renderFrame, renders, grids) {
    const S = ${RENDER}, label = 28, gridRow = grids ? 150 : 0;
    const c = document.createElement('canvas');
    c.width = S * (renders.length + 1);
    c.height = S + label + gridRow;
    const g = c.getContext('2d');
    g.fillStyle = '#1b1d22'; g.fillRect(0, 0, c.width, c.height);
    g.save();
    g.beginPath(); g.rect(0, 0, S, S); g.clip();
    const k = renderFrame.width / photoFrame.width;
    g.translate(renderFrame.centre[0], renderFrame.centre[1]);
    g.rotate(renderFrame.angle - photoFrame.angle);
    g.scale(k, k);
    g.translate(-photoFrame.centre[0], -photoFrame.centre[1]);
    g.drawImage(photo, 0, 0);
    g.restore();
    const names = ['photo', ...renders.map((r) => r.name)];
    for (const [i, r] of renders.entries()) g.drawImage(await canvasOf(r.src, S), S * (i + 1), 0, S, S);
    g.fillStyle = '#e8e4dc'; g.font = '18px sans-serif';
    names.forEach((n, i) => g.fillText(n, S * i + 10, S + 20));
    if (grids) {
      const cell = 2, y0 = S + label + 8;
      grids.forEach((item, i) => {
        const x0 = 10 + i * (item.grid.w * cell + 18);
        for (let y = 0; y < item.grid.h; y += 1) for (let x = 0; x < item.grid.w; x += 1) {
          const v = item.grid.cells[y * item.grid.w + x];
          g.fillStyle = v === 1 ? '#e8e4dc' : v === 2 ? '#2a2d33' : '#3b3f47';
          g.fillRect(x0 + x * cell, y0 + y * cell, cell, cell);
        }
        g.fillStyle = '#e8e4dc'; g.font = '11px sans-serif';
        g.fillText(item.label, x0, y0 + item.grid.h * cell + 12);
      });
    }
    return c.toDataURL('image/jpeg', 0.9);
  }
};
window.__ready = true;
`;

async function openReader(photo: { bytes: Buffer; type: string }) {
  const [bundle, segmenter, face] = await Promise.all([readBundle(), segmenterModel(), readFile(FACE_MODEL)]);
  // The segmenter's last step runs in WebGL even on the CPU delegate: software GL, as the XR checks use.
  const browser = await chromium.launch({ headless: true, args: [...XR_CHROMIUM_ARGS] });
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const renders = new Map<string, Buffer>();
  await context.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = (b: Buffer | string, contentType: string) => route.fulfill({ status: 200, body: b, contentType });
    if (path === '/') return body(`<!doctype html><meta charset="utf-8"><script type="module" src="/page.js"></script>`, 'text/html');
    if (path === '/page.js') return body(PAGE_SCRIPT, 'text/javascript');
    if (path === '/read.js') return body(bundle, 'text/javascript');
    if (path === '/photo') return body(photo.bytes, photo.type);
    if (path === '/models/face_landmarker.task') return body(face, 'application/octet-stream');
    if (path === `/models/${SEGMENTER.file}`) return body(segmenter, 'application/octet-stream');
    if (path.startsWith('/wasm/')) return body(await readFile(join(WASM, basename(path))), path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
    if (path.startsWith('/render/') && renders.has(path)) return body(renders.get(path)!, 'image/jpeg');
    return route.fulfill({ status: 404, body: 'not found' });
  });
  // Nothing outside the local origin: the photo has nowhere to go.
  await context.route((url) => !url.href.startsWith(ORIGIN), (route) => route.abort());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => { const w = window as unknown as { __ready?: boolean; __failed?: string }; return w.__ready === true || w.__failed !== undefined; }, null, { timeout: 120_000 });
  const failed = await page.evaluate(() => (window as unknown as { __failed?: string }).__failed);
  if (failed !== undefined || errors.length) throw new Error(`the read page did not load: ${failed ?? errors.join('; ')}`);
  const look = <T>(fn: string, ...a: unknown[]) => page.evaluate(([f, args]) => (window as unknown as { __look: Record<string, (...x: unknown[]) => unknown> }).__look[f as string]!(...(args as unknown[])), [fn, a] as const) as Promise<T>;
  return {
    look,
    addRender(name: string, jpeg: Buffer): string { const path = `/render/${name}.jpg`; renders.set(path, jpeg); return path; },
    close: () => browser.close()
  };
}

/** The keyed copy of a look: its hair pure green and unlit-looking, so its outline can be read off a render. */
async function keyedFile(card: LookCard, dir: string): Promise<string> {
  const io = new NodeIO();
  const doc = await io.read(wardrobeFile(card.build));
  dressAvatar(doc, card);
  applyFinish(doc, 'clay');
  for (const m of doc.getRoot().listMaterials()) {
    if (m.getName() !== 'HouseBase_hair') continue;
    m.setBaseColorFactor([...KEY_GREEN]);
    m.setEmissiveFactor([0, 0.6, 0]);
  }
  const file = join(dir, `keyed-${card.hair.style}.glb`);
  await io.write(file, doc);
  return file;
}

/** Renders each avatar head-on, one performer each, in one still take; returns JPEG bytes in order. */
async function renderHeads(servers: ViewerServers, dir: string, label: string, avatars: string[]): Promise<Buffer[]> {
  await mkdir(dir, { recursive: true });
  const sheetFile = join(dir, 'still.json');
  const performers = avatars.map((avatar, i) => ({ id: `p${i}`, avatar, at: [i * SPACING, 0], facing: 0 }));
  await writeFile(sheetFile, `${JSON.stringify({ title: label, intent: 'Each performer stands still, facing us, with a neutral face.', duration: 1, life: false, performers, beats: [] }, null, 2)}\n`);
  const take = (await build(sheetFile, join(dir, 'still.glb'))).out;
  const open = await openTake(servers, take, { viewport: { width: 600, height: 600 }, title: label });
  try {
    const { page } = open;
    await page.addScriptTag({ content: REVIEW_PAGE });
    await call(page, 'init', open.url);
    await call(page, 'seek', 0.5);
    const bodies = await call(page, 'bodies') as { performers: { head: [number, number, number] }[] };
    const out: Buffer[] = [];
    for (const i of avatars.keys()) {
      const head = bodies.performers[i]!.head;
      const distance = ((VIEW.top - VIEW.bottom) / 2) / Math.tan((VIEW.fov / 2) * Math.PI / 180);
      const target: [number, number, number] = [head[0], head[1] + (VIEW.top + VIEW.bottom) / 2, head[2] + VIEW.ahead];
      const shot = await call(page, 'close', i, { position: [target[0], target[1], target[2] + distance], target, fov: VIEW.fov, width: RENDER, height: RENDER, background: BACKGROUND, far: distance + 0.6 }) as { image: string };
      out.push(Buffer.from(shot.image.slice(shot.image.indexOf(',') + 1), 'base64'));
    }
    return out;
  } finally { await open.close(); }
}

type Reader = Awaited<ReturnType<typeof openReader>>;

/** The face frame of the house base render and the outline of each hair style, from the same view. */
interface StyleOutlines { readonly frame: FaceFrame; readonly grids: Record<HairStyle, HairGrid> }

const AVATAR_LOOK_SRC = fileURLToPath(new URL('../../../../packages/avatar-look/src/', import.meta.url));

/**
 * The outlines do not depend on the photo, so they are kept in
 * `.styles/<key>.json`. The key covers what makes them: the wardrobe, the
 * default look, and the code that dresses, renders and reads them.
 */
async function outlinesKey(defaults: LookCard): Promise<string> {
  const hash = createHash('sha256').update(JSON.stringify(defaults)).update(await readFile(wardrobeFile(defaults.build)));
  const sources = [fileURLToPath(import.meta.url), fileURLToPath(new URL('./lib/house-look.ts', import.meta.url)), ...['photo.ts', 'read.ts', 'look.ts', 'traits.ts'].map((f) => join(AVATAR_LOOK_SRC, f))];
  for (const file of sources) if (existsSync(file)) hash.update(await readFile(file));
  return hash.digest('hex').slice(0, 16);
}

/** Renders the base and the six keyed styles once (about 15 s) and reads their outlines; null when the base render shows no face. */
async function renderOutlines(reader: Reader, servers: ViewerServers, defaults: LookCard, work: string): Promise<StyleOutlines | null> {
  const avatars = [await dressedFile(defaults, 'clay'), ...await Promise.all(HAIR_STYLES.map((style) => keyedFile({ ...defaults, hair: { ...defaults.hair, style } }, work)))];
  const shots = await renderHeads(servers, join(work, 'styles'), 'Photo look: hair styles', avatars);
  const frame = await reader.look<FaceFrame | null>('frame', reader.addRender('plain', shots[0]!));
  if (!frame) return null;
  const grids = {} as Record<HairStyle, HairGrid>;
  for (const [i, style] of HAIR_STYLES.entries()) grids[style] = await reader.look<HairGrid>('keyedGrid', reader.addRender(`keyed-${style}`, shots[i + 1]!), frame);
  return { frame, grids };
}

export interface PhotoLookReport {
  readonly photo: string;
  readonly card: LookCard;
  readonly read: Omit<PhotoRead, 'hairGrid'>;
  readonly hairStyle: TraitRead<HairStyle> & { readonly proposal?: HairStyleProposal };
  readonly notRead: readonly string[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(HELP); return; }
  const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const values = new Set(['--out', '--finish', '--name'].flatMap((f) => { const i = args.indexOf(f); return i >= 0 ? [i, i + 1] : []; }));
  const photoPath = args.find((a, i) => !values.has(i) && !a.startsWith('--'));
  if (!photoPath) throw new Error(HELP);
  const finishFlag = flag('--finish');
  if (finishFlag && !FINISHES.includes(finishFlag as Finish)) throw new Error(`--finish: one of ${FINISHES.join(', ')}`);
  const finishes: Finish[] = finishFlag ? [finishFlag as Finish] : [...FINISHES];
  const name = flag('--name') ?? basename(photoPath, extname(photoPath));
  const dir = join(OUTPUT, name);
  const work = join(dir, 'work');
  await mkdir(work, { recursive: true });

  const defaults = await defaultLook();
  const reader = await openReader(await photoBytes(resolve(photoPath)));
  let servers: ViewerServers | undefined;
  try {
    const result = await reader.look<{ ok: true; read: PhotoRead } | { ok: false; reason: string; message: string }>('read', { skin: defaults.skin, eyes: defaults.eyes, hairColour: defaults.hair.colour });
    if (!result.ok) { console.error(`photo refused (${result.reason}): ${result.message}`); process.exitCode = 2; return; }
    const read = result.read;
    const base = cardFromRead(defaults, { skin: read.skin, eyes: read.eyes, hairColour: read.hairColour, hairStyle: { value: defaults.hair.style, read: false, notes: [] } });

    const readOnly = args.includes('--read-only');
    // The hair style: the photo's hair outline against the six styles' outlines, kept from an earlier run.
    const cached = join(STYLE_CACHE, `${await outlinesKey(defaults)}.json`);
    let outlines: StyleOutlines | null = existsSync(cached) ? JSON.parse(await readFile(cached, 'utf8')) as StyleOutlines : null;
    if (!readOnly) servers = await startViewer();
    if (!outlines && !readOnly && read.hairGrid) {
      outlines = await renderOutlines(reader, servers!, defaults, work);
      if (outlines) { await mkdir(STYLE_CACHE, { recursive: true }); await writeFile(cached, JSON.stringify(outlines)); }
    }
    let hairStyle: PhotoLookReport['hairStyle'];
    let grids: { label: string; grid: HairGrid }[] | null = null;
    if (!read.hairGrid) {
      hairStyle = { value: defaults.hair.style, read: false, notes: ['the hair is not read, so no style is proposed; the default is kept'] };
    } else if (!outlines) {
      hairStyle = { value: defaults.hair.style, read: false, notes: [readOnly
        ? 'the hair styles are not rendered yet: run once without --read-only; the default is kept'
        : 'the face landmarker found no face on the house base render, so no style is proposed; the default is kept'] };
    } else {
      const styleGrids = outlines.grids;
      const proposal = proposeHairStyle(read.hairGrid, styleGrids);
      const sure = proposal.confidence >= HAIR_STYLE_MIN_CONFIDENCE;
      hairStyle = {
        value: sure ? proposal.value : defaults.hair.style, read: sure, confidence: proposal.confidence, proposal,
        notes: [
          `a proposal: overlap ${HAIR_STYLES.map((s) => `${s} ${proposal.overlap[s].toFixed(2)}`).join(', ')}; margin ${proposal.margin.toFixed(2)} over the next`,
          ...(sure ? [] : [`confidence ${proposal.confidence.toFixed(2)} is under ${HAIR_STYLE_MIN_CONFIDENCE}: the outline says ${proposal.value}, the card keeps the default ${defaults.hair.style}`])
        ]
      };
      grids = [{ label: 'photo', grid: read.hairGrid }, ...HAIR_STYLES.map((s) => ({ label: `${s} ${proposal.overlap[s].toFixed(2)}`, grid: styleGrids[s] }))];
    }
    let renderFrame: FaceFrame | null = outlines?.frame ?? null;

    const card = parseLook({ ...base, hair: { ...base.hair, style: hairStyle.value } }, 'photo-look card');
    const finishShots = readOnly ? [] : await renderHeads(servers!, join(work, 'finishes'), 'Photo look: the card', await Promise.all(finishes.map((f) => dressedFile(card, f))));
    if (!readOnly) renderFrame ??= await reader.look<FaceFrame | null>('frame', reader.addRender('clay', finishShots[0]!));
    if (readOnly) {
      // no renders
    } else if (renderFrame) {
      const jpeg = await reader.look<string>('compare', read.frame, renderFrame, finishes.map((f, i) => ({ name: f, src: reader.addRender(`finish-${f}`, finishShots[i]!) })), grids);
      await writeFile(join(dir, 'compare.jpg'), Buffer.from(jpeg.slice(jpeg.indexOf(',') + 1), 'base64'));
    } else {
      console.warn('no face found on the house base render: compare.jpg is not written');
    }

    const { hairGrid: _, ...readReport } = read;
    const report: PhotoLookReport = { photo: basename(photoPath), card, read: readReport, hairStyle, notRead: ['build', 'glasses', 'clothing'] };
    await writeFile(join(dir, 'card.json'), `${JSON.stringify(card, null, 2)}\n`);
    await writeFile(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    if (flag('--out')) await writeFile(resolve(flag('--out')!), `${JSON.stringify(card, null, 2)}\n`);

    const line = (t: string, r: TraitRead<string>) => `  ${t.padEnd(11)} ${r.value.padEnd(12)} ${r.read ? '' : '(default) '}${r.confidence !== undefined ? `confidence ${r.confidence.toFixed(2)}` : ''}`;
    console.log(`${basename(photoPath)}: white balance from ${read.white.method}`);
    console.log(line('skin', read.skin));
    if (!read.skin.read) console.log(`    ${read.skin.notes.at(-1)}`);
    console.log(line('hair colour', read.hairColour));
    console.log(line('eyes', read.eyes));
    console.log(line('hair style', hairStyle));
    console.log('  build, glasses and clothing: the default look\'s (a photo does not show them)');
    console.log(`Check each value against the photo, then use the card: ${join(dir, 'card.json')}`);
    console.log(`  ${join(dir, 'report.json')}${readOnly ? '' : `\n  ${join(dir, 'compare.jpg')}`}`);
  } finally {
    servers?.close();
    await reader.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
