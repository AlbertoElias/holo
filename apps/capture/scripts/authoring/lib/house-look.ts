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
/** The collision set (`house-base.ts --collide`): the same wardrobes without the jumper's `cuff` (B-101). */
const COLLIDE = join(ASSETS, 'collide');
const DRESSED = fileURLToPath(new URL('../../../output/authoring/avatars/', import.meta.url));

/** The house base dressed in its default look (`defaultLook` in house-base/base.json). */
export const HOUSE_BASE = fileURLToPath(new URL('../../../public/gltf/models/house-base.glb', import.meta.url));

/**
 * `shown` is what a take wears. `collide` is what the solver keeps the arms out of: the shown cuff moves the
 * arm samples and the pinned numbers, so the solver reads the body without it (B-101).
 */
export type WardrobeSet = 'shown' | 'collide';

export const wardrobeFile = (build: Build, set: WardrobeSet = 'shown'): string => join(set === 'collide' ? COLLIDE : ASSETS, `wardrobe-${build}.glb`);

/** The look `public/gltf/models/house-base.glb` wears (`defaultLook` in house-base/base.json). */
export async function defaultLook(): Promise<LookCard> {
  const base = JSON.parse(await readFile(new URL('../house-base/base.json', import.meta.url), 'utf8')) as { defaultLook: Record<string, unknown> };
  const { $comment: _, ...card } = base.defaultLook;
  return parseLook(card, 'base.json defaultLook');
}

/** The house base dressed as the card says, in a finish (default clay), written to its own GLB. */
export async function dressedFile(card: LookCard, finish: Finish = 'clay', set: WardrobeSet = 'shown'): Promise<string> {
  const file = join(DRESSED, `${set === 'collide' ? 'collide-' : ''}house-${finish === 'clay' ? '' : `${finish}-`}${lookKey(card)}.glb`);
  const io = new NodeIO();
  const doc = await io.read(wardrobeFile(card.build, set));
  dressAvatar(doc, card);
  applyFinish(doc, finish);
  await mkdir(DRESSED, { recursive: true });
  await io.write(file, doc);
  return file;
}
