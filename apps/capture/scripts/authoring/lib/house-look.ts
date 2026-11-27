/**
 * The house base on disk: one wardrobe per build (every hair style and
 * glasses kind; `house-base.ts` makes them) and the looks dressed from them
 * into output/authoring/avatars/, one file per card, re-dressed on every call
 * (about a second) so a change to the dressing is never missed.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeIO } from '@gltf-transform/core';
import { applyFinish, dressAvatar, lookKey, parseLook, type Build, type Finish, type LookCard } from '@holoim/avatar-look';

const ASSETS = fileURLToPath(new URL('../../../assets/house-base/', import.meta.url));
const DRESSED = fileURLToPath(new URL('../../../output/authoring/avatars/', import.meta.url));

/** The house base dressed in its default look (`defaultLook` in house-base/base.json). */
export const HOUSE_BASE = fileURLToPath(new URL('../../../public/gltf/models/house-base.glb', import.meta.url));

export const wardrobeFile = (build: Build): string => join(process.env.HOLOIM_WARDROBE_DIR ?? ASSETS, `wardrobe-${build}.glb`);

/** The look `public/gltf/models/house-base.glb` wears (`defaultLook` in house-base/base.json). */
export async function defaultLook(): Promise<LookCard> {
  const base = JSON.parse(await readFile(new URL('../house-base/base.json', import.meta.url), 'utf8')) as { defaultLook: Record<string, unknown> };
  const { $comment: _, ...card } = base.defaultLook;
  return parseLook(card, 'base.json defaultLook');
}

/** The house base dressed as the card says, in a finish (default clay), written to its own GLB. */
export async function dressedFile(card: LookCard, finish: Finish = 'clay'): Promise<string> {
  const file = join(DRESSED, `${process.env.HOLOIM_WARDROBE_DIR ? 'collide-' : ''}house-${finish === 'clay' ? '' : `${finish}-`}${lookKey(card)}.glb`);
  const io = new NodeIO();
  const doc = await io.read(wardrobeFile(card.build));
  dressAvatar(doc, card);
  applyFinish(doc, finish);
  await mkdir(DRESSED, { recursive: true });
  await io.write(file, doc);
  return file;
}
