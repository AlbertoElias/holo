// The photo read for the look step (docs/features/directed-performance.md,
// slice 5b): slice 5a's read on a photo the creator picks, on the device.
// This module and the outlines are a lazy chunk; `photoLook.ts` imports it
// only when the creator selects "From a photo". The models load from
// capture's own origin, as the selfie face's do.
import { cardFromRead, HAIR_STYLE_MIN_CONFIDENCE, HAIR_STYLES, proposeHairStyle, type HairGrid, type HairStyle, type LookCard, type TraitRead } from '@holoim/avatar-look';
import { createLookReader, PhotoRefused, type LookReader, type PhotoRead } from '@holoim/avatar-look/read';

import { MEDIAPIPE_WASM } from '../face/WebcamFace';
import { OUTLINES, OUTLINES_SIZE } from './photoLookOutlines';

export { PhotoRefused };
export type { LookReader };

/** The photo is drawn at most this many px on its long side before the read (as `photo-look.ts`). */
export const MAX_SIDE = 2048;

export function openReader(): Promise<LookReader> {
  return createLookReader({
    wasm: MEDIAPIPE_WASM,
    faceModel: `${import.meta.env.BASE_URL}mediapipe/face_landmarker.task`,
    segmenterModel: `${import.meta.env.BASE_URL}mediapipe/selfie_multiclass_256x256.tflite`
  });
}

/** Thrown when the file does not decode as an image. */
export class NotAnImage extends Error {
  constructor() {
    super('the file is not an image this browser can open');
    this.name = 'NotAnImage';
  }
}

/** The photo upright (its EXIF orientation applied) on a canvas, its long side at most `MAX_SIDE`. The bitmap closes here. */
export async function photoCanvas(file: Blob): Promise<HTMLCanvasElement> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new NotAnImage();
  }
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2D context for the photo');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    bitmap.close();
  }
}

/** A row the photo set, or kept as it was, with the reason in the creator's words. */
export type PhotoTrait = 'skin' | 'hairColour' | 'eyes' | 'hairStyle';
export interface PhotoCard {
  card: LookCard;
  set: { trait: PhotoTrait; value: string }[];
  kept: { trait: PhotoTrait; why: string }[];
  /** For the e2e and the parity check: the read's numbers. Never saved and never in a take. */
  read: PhotoRead;
  hairStyle: TraitRead<HairStyle>;
}

const outlineGrids = (): Record<HairStyle, HairGrid> => {
  const grids = {} as Record<HairStyle, HairGrid>;
  for (const style of HAIR_STYLES) grids[style] = { w: OUTLINES_SIZE.w, h: OUTLINES_SIZE.h, cells: Array.from(OUTLINES[style], Number) };
  return grids;
};

/**
 * Reads the photo into a card on top of `current`: a trait the photo cannot
 * say keeps the creator's current value, never the house default.
 * Throws `PhotoRefused` for no face, several faces or a face too small.
 */
export function readCard(reader: LookReader, canvas: HTMLCanvasElement, current: LookCard): PhotoCard {
  const read = reader.read(canvas, { skin: current.skin, eyes: current.eyes, hairColour: current.hair.colour });
  let hairStyle: TraitRead<HairStyle>;
  if (!read.hairGrid) {
    hairStyle = { value: current.hair.style, read: false, notes: ['hair not read'] };
  } else {
    const proposal = proposeHairStyle(read.hairGrid, outlineGrids());
    const sure = proposal.confidence >= HAIR_STYLE_MIN_CONFIDENCE;
    hairStyle = { value: sure ? proposal.value : current.hair.style, read: sure, confidence: proposal.confidence, notes: [] };
  }
  const card = cardFromRead(current, { skin: read.skin, eyes: read.eyes, hairColour: read.hairColour, hairStyle });
  const set: PhotoCard['set'] = [];
  const kept: PhotoCard['kept'] = [];
  const add = (trait: PhotoTrait, got: { read: boolean; value: string }, why: string): void => {
    if (got.read) set.push({ trait, value: got.value });
    else kept.push({ trait, why });
  };
  add('skin', read.skin, skinWhy(read));
  add('hairColour', read.hairColour, 'the hair did not show (a hat, a hood or little hair)');
  add('eyes', read.eyes, 'the eyes did not show clearly (glare, glasses or shade)');
  add('hairStyle', hairStyle, read.hairGrid ? 'the hair’s outline is not close to one style' : 'the hair did not show (a hat, a hood or little hair)');
  return { card, set, kept, read, hairStyle };
}

function skinWhy(read: PhotoRead): string {
  const notes = read.skin.notes.join(' ');
  if (!read.white.usable) return 'the eye whites did not show clearly enough to measure against';
  if (notes.includes('uneven')) return 'the light on the face is uneven';
  return 'too little skin showed';
}
