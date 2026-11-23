/**
 * The photo read (slice 5a of docs/features/directed-performance.md): one
 * photo of one face in, the skin, hair colour and eye colour it shows out,
 * each with what was measured, plus the hair's outline for the hair style
 * proposal. Browser only (MediaPipe runs in WebAssembly): the authoring CLI
 * runs it in headless Chromium, and the capture app can import it as is.
 *
 * It uses the face landmarker capture ships and MediaPipe's multiclass
 * selfie segmenter (both Apache 2.0; their model cards put identity
 * recognition out of scope, and this reads no identity). Nothing leaves the
 * page: the models run locally and the photo is never sent anywhere.
 *
 * Imported as `@holoim/avatar-look/read`, not from the package's index, so
 * Node code that dresses avatars never loads MediaPipe.
 */
import { FaceLandmarker, ImageSegmenter } from '@mediapipe/tasks-vision';

import { HAIR_COLOUR, EYES, SKIN, linear, type Eyes, type HairColour, type Skin, type SRGB } from './traits.js';
import {
  applyGains, EYES_MIN_CONFIDENCE, GRID, HAIR_LIGHTNESS_WEIGHT, HAIR_MIN_AREA, HAIR_OUTSIDE, luminance, nearest, pickEyes, pickSkin, toSrgb, whiteGains,
  type HairGrid, type IrisMeasure, type Linear, type TraitRead
} from './photo.js';

export interface ReaderAssets {
  /** MediaPipe's WebAssembly loader and binary (`@mediapipe/tasks-vision/wasm/vision_wasm_internal.{js,wasm}`). */
  readonly wasm: { readonly wasmLoaderPath: string; readonly wasmBinaryPath: string };
  /** `face_landmarker.task`. */
  readonly faceModel: string;
  /** `selfie_multiclass_256x256.tflite`. */
  readonly segmenterModel: string;
}

/** A photo the read will not take, with the reason by name. */
export class PhotoRefused extends Error {
  constructor(readonly reason: 'no-face' | 'several-faces' | 'face-too-small', message: string) { super(message); this.name = 'PhotoRefused'; }
}

/** The face's own frame in image px: the eyes' midpoint, the eye line's angle and the face's width (cheek to cheek). */
export interface FaceFrame {
  readonly centre: readonly [number, number];
  readonly angle: number;
  readonly width: number;
}

/** The face must be at least this wide (px, cheek to cheek): below it the irises are under 8 px across. */
export const MIN_FACE_PX = 200;

export interface SkinRead extends TraitRead<Skin> {
  /** Each sampled area's colour after white balance (absent when the area showed too little face skin). */
  readonly areas: readonly { readonly name: string; readonly pixels: number; readonly measured?: SRGB; /** Before white balance. */ readonly photo?: SRGB }[];
  readonly rank?: number;
  readonly lightness?: number;
}

export interface PhotoRead {
  readonly size: { readonly width: number; readonly height: number };
  readonly frame: FaceFrame;
  readonly white: { readonly method: 'eye whites' | 'brightest pixels'; readonly measured: SRGB; readonly pixels: number };
  readonly skin: SkinRead;
  readonly hairColour: TraitRead<HairColour> & { readonly area: number };
  readonly eyes: TraitRead<Eyes>;
  /** The hair mask in the face's frame, for `proposeHairStyle`; null when the hair is not read. */
  readonly hairGrid: HairGrid | null;
}

/** The defaults a trait keeps when the photo cannot say. */
export interface ReadDefaults { readonly skin: Skin; readonly eyes: Eyes; readonly hairColour: HairColour }

// Face mesh indices (MediaPipe's 478-point canonical face).
const CHEEK = [234, 454] as const;
const EYE_CONTOURS = [
  [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466]
] as const;
const IRISES = [[468, 469, 470, 471, 472], [473, 474, 475, 476, 477]] as const;
/** Skin areas: the forehead's middle and sides and both cheeks, each a disc of `AREA_RADIUS` face widths. */
const SKIN_AREAS = { forehead: 151, foreheadLeft: 108, foreheadRight: 337, cheekLeft: 50, cheekRight: 280 } as const;
const AREA_RADIUS = 0.05;
/** The selfie segmenter's classes. */
const CLASS = { hair: 1, faceSkin: 3 } as const;

const LUT = Array.from({ length: 256 }, (_, v) => linear([v, v, v])[0]);

type Pt = readonly [number, number];

class Pixels {
  constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
  inside(x: number, y: number): boolean { return x >= 0 && y >= 0 && x < this.width && y < this.height; }
  at(x: number, y: number): Linear {
    const i = (Math.round(y) * this.width + Math.round(x)) * 4;
    return [LUT[this.data[i]!]!, LUT[this.data[i + 1]!]!, LUT[this.data[i + 2]!]!];
  }
}

/** The mean of the middle fifth of the pixels by luminance: a median that keeps a real colour. */
function middleColour(px: readonly Linear[], from = 0.4, to = 0.6): Linear {
  const s = [...px].sort((a, b) => luminance(a) - luminance(b));
  const band = s.slice(Math.floor(s.length * from), Math.max(Math.floor(s.length * from) + 1, Math.ceil(s.length * to)));
  return [0, 1, 2].map((k) => band.reduce((sum, c) => sum + c[k]!, 0) / band.length) as unknown as Linear;
}

function inPolygon(p: Pt, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Every pixel centre in a bounding box, as [x, y]. */
function* box(x0: number, y0: number, x1: number, y1: number): Generator<Pt> {
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y += 1) for (let x = Math.floor(x0); x <= Math.ceil(x1); x += 1) yield [x, y];
}

/** The face's frame from its landmarks (image px). */
export function frameOf(points: readonly Pt[]): FaceFrame {
  const mid = (ids: readonly number[]): Pt => [ids.reduce((s, i) => s + points[i]![0], 0) / ids.length, ids.reduce((s, i) => s + points[i]![1], 0) / ids.length];
  const [a, b] = [mid(EYE_CONTOURS[0]), mid(EYE_CONTOURS[1])];
  const left = a[0] <= b[0] ? a : b;
  const right = a[0] <= b[0] ? b : a;
  return {
    centre: [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2],
    angle: Math.atan2(right[1] - left[1], right[0] - left[0]),
    width: Math.hypot(points[CHEEK[0]]![0] - points[CHEEK[1]]![0], points[CHEEK[0]]![1] - points[CHEEK[1]]![1])
  };
}

/** A grid of the face's frame (`GRID`), each cell 1 where `isHair` holds at most of its 3×3 samples, 2 outside the image. */
export function gridOf(frame: FaceFrame, width: number, height: number, isHair: (x: number, y: number) => boolean): HairGrid {
  const cells: number[] = [];
  const [c, s] = [Math.cos(frame.angle), Math.sin(frame.angle)];
  for (let gy = 0; gy < GRID.h; gy += 1) {
    for (let gx = 0; gx < GRID.w; gx += 1) {
      let hair = 0;
      let seen = 0;
      for (let k = 0; k < 9; k += 1) {
        const u = (GRID.left + (gx + (1 + (k % 3)) / 4) * GRID.cell) * frame.width;
        const v = (GRID.top + (gy + (1 + Math.floor(k / 3)) / 4) * GRID.cell) * frame.width;
        const x = Math.round(frame.centre[0] + c * u - s * v);
        const y = Math.round(frame.centre[1] + s * u + c * v);
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        seen += 1;
        if (isHair(x, y)) hair += 1;
      }
      cells.push(seen < 5 ? 2 : hair * 2 > seen ? 1 : 0);
    }
  }
  return { w: GRID.w, h: GRID.h, cells };
}

const canvasPixels = (canvas: HTMLCanvasElement): Pixels => {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('readLook: no 2D context');
  return new Pixels(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
};

export interface LookReader {
  /** Reads one photo; throws `PhotoRefused` for no face, several faces or a face too small. */
  read(canvas: HTMLCanvasElement, defaults: ReadDefaults): PhotoRead;
  /** The face's frame in an image, or null when no single face is found (used on renders of the house base). */
  frame(canvas: HTMLCanvasElement): FaceFrame | null;
  close(): void;
}

/** Loads the two models once; `read` then takes photos one after another. */
export async function createLookReader(assets: ReaderAssets): Promise<LookReader> {
  const faces = await FaceLandmarker.createFromOptions(assets.wasm, {
    baseOptions: { modelAssetPath: assets.faceModel, delegate: 'CPU' },
    runningMode: 'IMAGE',
    numFaces: 2
  });
  const segmenter = await ImageSegmenter.createFromOptions(assets.wasm, {
    baseOptions: { modelAssetPath: assets.segmenterModel, delegate: 'CPU' },
    runningMode: 'IMAGE',
    outputCategoryMask: true,
    outputConfidenceMasks: false
  });

  const landmarks = (canvas: HTMLCanvasElement): Pt[][] =>
    faces.detect(canvas).faceLandmarks.map((face) => face.map((p) => [p.x * canvas.width, p.y * canvas.height] as Pt));

  return {
    frame(canvas) {
      const found = landmarks(canvas);
      return found.length === 1 ? frameOf(found[0]!) : null;
    },
    read(canvas, defaults) {
      const found = landmarks(canvas);
      if (found.length === 0) throw new PhotoRefused('no-face', 'no face found in the photo (a small face in a wide photo is not found: use a close photo of one face)');
      if (found.length > 1) throw new PhotoRefused('several-faces', `${found.length} faces found in the photo; use a photo of one face, your own`);
      const points = found[0]!;
      const frame = frameOf(points);
      if (frame.width < MIN_FACE_PX) throw new PhotoRefused('face-too-small', `the face is ${Math.round(frame.width)} px wide; it must be at least ${MIN_FACE_PX} px (use a larger or sharper photo)`);

      const px = canvasPixels(canvas);
      const seg = segmenter.segment(canvas);
      const mask = seg.categoryMask!;
      const classes = mask.getAsUint8Array();
      const [mw, mh] = [mask.width, mask.height];
      const classAt = (x: number, y: number): number => classes[Math.min(mh - 1, Math.floor((y * mh) / canvas.height)) * mw + Math.min(mw - 1, Math.floor((x * mw) / canvas.width))]!;
      mask.close();
      seg.close();

      // White balance and exposure from the eye whites: inside each eye's outline, outside its iris, the brighter half.
      const irisDiscs = IRISES.map((ids) => {
        const centre = points[ids[0]]!;
        const radius = ids.slice(1).reduce((s, i) => s + Math.hypot(points[i]![0] - centre[0], points[i]![1] - centre[1]), 0) / 4;
        return { centre, radius };
      });
      const eyePolys = EYE_CONTOURS.map((ids) => ids.map((i) => points[i]!));
      // Each eye's outline drawn in by a fifth toward its centre (the lids' edges are skin and lashes), less the iris.
      const sclera: Linear[] = [];
      for (const outline of eyePolys) {
        const c = outline.reduce((acc, q) => [acc[0] + q[0] / outline.length, acc[1] + q[1] / outline.length] as Pt, [0, 0] as Pt);
        const poly = outline.map((q) => [c[0] + (q[0] - c[0]) * 0.8, c[1] + (q[1] - c[1]) * 0.8] as Pt);
        const xs = poly.map((p) => p[0]);
        const ys = poly.map((p) => p[1]);
        for (const p of box(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys))) {
          if (!px.inside(p[0], p[1]) || !inPolygon(p, poly)) continue;
          if (irisDiscs.some((d) => Math.hypot(p[0] - d.centre[0], p[1] - d.centre[1]) < d.radius * 1.3)) continue;
          sclera.push(px.at(p[0], p[1]));
        }
      }
      // The whitest third: bright and grey (skin is as bright but coloured).
      const whiteness = (c: Linear): number => luminance(c) * (Math.min(...c) / Math.max(1e-4, ...c));
      sclera.sort((a, b) => whiteness(b) - whiteness(a));
      const whites = sclera.slice(0, Math.floor(sclera.length / 3));
      let white: PhotoRead['white'];
      let whiteLinear: Linear;
      if (whites.length >= 15) {
        whiteLinear = middleColour(whites);
        white = { method: 'eye whites', measured: toSrgb(whiteLinear), pixels: whites.length };
      } else {
        // Too little eye white (closed eyes, dark glasses): the photo's brightest 1% instead.
        const all: Linear[] = [];
        for (let y = 0; y < px.height; y += 4) for (let x = 0; x < px.width; x += 4) all.push(px.at(x, y));
        all.sort((a, b) => luminance(b) - luminance(a));
        whiteLinear = middleColour(all.slice(0, Math.max(1, Math.floor(all.length / 100))));
        white = { method: 'brightest pixels', measured: toSrgb(whiteLinear), pixels: Math.floor(all.length / 100) };
      }
      const gains = whiteGains(whiteLinear);
      const balanced = (x: number, y: number): Linear => applyGains(px.at(x, y), gains);

      // Skin: each area's face-skin pixels, the middle of each area, then the middle area.
      const r = AREA_RADIUS * frame.width;
      const areas = Object.entries(SKIN_AREAS).map(([name, id]) => {
        const [cx, cy] = points[id]!;
        const pixels: Linear[] = [];
        const raw: Linear[] = [];
        for (const p of box(cx - r, cy - r, cx + r, cy + r)) {
          if (!px.inside(p[0], p[1]) || Math.hypot(p[0] - cx, p[1] - cy) > r || classAt(p[0], p[1]) !== CLASS.faceSkin) continue;
          pixels.push(balanced(p[0], p[1]));
          raw.push(px.at(p[0], p[1]));
        }
        return { name, pixels: pixels.length, colour: pixels.length >= 20 ? middleColour(pixels) : null, raw: raw.length >= 20 ? middleColour(raw) : null };
      });
      const usableAreas = areas.filter((a) => a.colour).sort((a, b) => luminance(a.colour!) - luminance(b.colour!));
      let skin: SkinRead;
      const areaReport = areas.map((a) => ({ name: a.name, pixels: a.pixels, ...(a.colour ? { measured: toSrgb(a.colour), photo: toSrgb(a.raw!) } : {}) }));
      if (usableAreas.length >= 2) {
        const mid = usableAreas[Math.floor((usableAreas.length - 1) / 2)]!.colour!;
        const pick = pickSkin(mid);
        skin = {
          value: pick.value, read: true, measured: toSrgb(mid), swatch: SKIN[pick.value], rank: pick.rank, lightness: pick.lightness,
          confidence: 1 - Math.abs(pick.rank - Math.round(pick.rank)) * 2 * 0.5,
          notes: [
            `lightness ${pick.lightness.toFixed(3)} is rank ${pick.rank.toFixed(2)} of 0 (porcelain) to 7 (espresso)`,
            ...(usableAreas.length < areas.length ? [`${areas.length - usableAreas.length} skin area(s) showed too little face skin (hair, glasses or the frame's edge)`] : [])
          ],
          areas: areaReport
        };
      } else {
        skin = { value: defaults.skin, read: false, notes: ['too little face skin showed in the cheek and forehead areas; the default is kept'], areas: areaReport };
      }

      // Hair: the segmenter's hair class, away from its edges (they mix with the background).
      const e = Math.max(2, Math.round(0.012 * frame.width));
      const isHair = (x: number, y: number): boolean => px.inside(x, y) && classAt(x, y) === CLASS.hair;
      const hairPx: Linear[] = [];
      let hairArea = 0;
      const step = Math.max(1, Math.round(frame.width / 300));
      for (let y = 0; y < px.height; y += step) {
        for (let x = 0; x < px.width; x += step) {
          if (!isHair(x, y)) continue;
          hairArea += step * step;
          if (isHair(x - e, y) && isHair(x + e, y) && isHair(x, y - e) && isHair(x, y + e)) hairPx.push(balanced(x, y));
        }
      }
      const area = hairArea / (frame.width * frame.width);
      let hairColour: PhotoRead['hairColour'];
      let hairGrid: HairGrid | null = null;
      if (area < HAIR_MIN_AREA || hairPx.length < 50) {
        hairColour = { value: defaults.hairColour, read: false, area, notes: [`the hair covers ${area.toFixed(2)} of the face's width squared (needs ${HAIR_MIN_AREA}): a hat, a hood or little hair; hair colour and style are not read`] };
      } else {
        // The lit body of the hair: above the shade between strands, below the shine.
        const measured = middleColour(hairPx, 0.6, 0.85);
        const pick = nearest(HAIR_COLOUR, measured, HAIR_LIGHTNESS_WEIGHT);
        hairColour = {
          value: pick.value, read: true, area, measured: toSrgb(measured), swatch: HAIR_COLOUR[pick.value], distance: pick.distance,
          confidence: Math.max(0, 1 - pick.distance / HAIR_OUTSIDE / 2),
          notes: [
            `next nearest ${pick.runnerUp.value} at ${pick.runnerUp.distance.toFixed(3)}`,
            ...(pick.distance > HAIR_OUTSIDE ? [`outside the palette: ${pick.distance.toFixed(3)} from the nearest swatch (a dye?); the nearest is taken`] : [])
          ]
        };
        hairGrid = gridOf(frame, px.width, px.height, isHair);
      }

      // Eyes: each iris disc inside its eye's outline, less the pupil and the glints.
      const irises: IrisMeasure[] = irisDiscs.map((d) => {
        const poly = eyePolys.reduce((best, p) => {
          const c = p.reduce((s, q) => [s[0] + q[0] / p.length, s[1] + q[1] / p.length] as Pt, [0, 0] as Pt);
          const cb = best.reduce((s, q) => [s[0] + q[0] / best.length, s[1] + q[1] / best.length] as Pt, [0, 0] as Pt);
          return Math.hypot(c[0] - d.centre[0], c[1] - d.centre[1]) < Math.hypot(cb[0] - d.centre[0], cb[1] - d.centre[1]) ? p : best;
        });
        const ring: Linear[] = [];
        for (const p of box(d.centre[0] - d.radius, d.centre[1] - d.radius, d.centre[0] + d.radius, d.centre[1] + d.radius)) {
          const dist = Math.hypot(p[0] - d.centre[0], p[1] - d.centre[1]);
          if (!px.inside(p[0], p[1]) || dist > d.radius * 0.85 || dist < d.radius * 0.35 || !inPolygon(p, poly)) continue;
          ring.push(balanced(p[0], p[1]));
        }
        if (!ring.length) return { colour: [0, 0, 0], radiusPx: d.radius, pixels: 0, glare: 1 };
        const mid = luminance(middleColour(ring));
        const kept = ring.filter((c) => luminance(c) <= mid * 2.5);
        return { colour: kept.length ? middleColour(kept) : middleColour(ring), radiusPx: d.radius, pixels: kept.length, glare: 1 - kept.length / ring.length };
      });
      const eyePick = pickEyes(irises);
      let eyes: TraitRead<Eyes>;
      if (!eyePick) {
        eyes = { value: defaults.eyes, read: false, confidence: 0, notes: ['no iris pixels showed; the default is kept'] };
      } else {
        const ok = eyePick.confidence >= EYES_MIN_CONFIDENCE;
        const measured = irises.filter((i) => i.pixels >= 20);
        const mean = [0, 1, 2].map((k) => measured.reduce((s, i) => s + i.colour[k]!, 0) / measured.length) as unknown as Linear;
        eyes = {
          value: ok ? eyePick.value : defaults.eyes, read: ok, measured: toSrgb(mean), swatch: EYES[eyePick.value], distance: eyePick.distance, confidence: eyePick.confidence,
          notes: [
            `per eye: ${eyePick.perEye.map((p) => `${p.value} (${p.distance.toFixed(3)})`).join(', ')}; iris radius ${irises.map((i) => i.radiusPx.toFixed(1)).join(', ')} px`,
            ...(eyePick.why.length ? [`confidence lowered by ${eyePick.why.join(', ')}`] : []),
            ...(ok ? [] : [`confidence ${eyePick.confidence.toFixed(2)} is under ${EYES_MIN_CONFIDENCE}: the read says ${eyePick.value}, the card keeps the default ${defaults.eyes}`])
          ]
        };
      }

      return { size: { width: px.width, height: px.height }, frame, white, skin, hairColour, eyes, hairGrid };
    },
    close() { faces.close(); segmenter.close(); }
  };
}

/** Whether a render pixel is the keyed hair colour: pure green, which `photo-look.ts` gives the house base's hair. */
export const isKeyedHair = (r: number, g: number, b: number): boolean => g > 60 && g > r * 1.6 && g > b * 1.6;

/** The keyed hair of a render of the house base, in the face frame of an unkeyed render from the same view. */
export function keyedHairGrid(canvas: HTMLCanvasElement, frame: FaceFrame): HairGrid {
  const px = canvasPixels(canvas);
  return gridOf(frame, px.width, px.height, (x, y) => {
    const i = (y * px.width + x) * 4;
    return isKeyedHair(px.data[i]!, px.data[i + 1]!, px.data[i + 2]!);
  });
}

