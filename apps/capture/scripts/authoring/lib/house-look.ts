/**
 * The house base on disk: one wardrobe per build (every hair style and
 * glasses kind; `house-base.ts` makes them) and the looks dressed from them,
 * cached under output/authoring/avatars/ by card.
 */
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeIO } from '@gltf-transform/core';
import { dressAvatar, lookKey, type Build, type LookCard } from '@holoim/avatar-look';

const ASSETS = fileURLToPath(new URL('../../../assets/house-base/', import.meta.url));
const DRESSED = fileURLToPath(new URL('../../../output/authoring/avatars/', import.meta.url));

/** The house base dressed in its default look (`defaultLook` in house-base/base.json). */
export const HOUSE_BASE = fileURLToPath(new URL('../../../public/gltf/models/house-base.glb', import.meta.url));

export const wardrobeFile = (build: Build): string => join(ASSETS, `wardrobe-${build}.glb`);

const newer = async (a: string, b: string): Promise<boolean> => {
  try { return (await stat(a)).mtimeMs >= (await stat(b)).mtimeMs; } catch { return false; }
};

/** The house base dressed as the card says: a cached GLB, re-dressed when its wardrobe is newer. */
export async function dressedFile(card: LookCard): Promise<string> {
  const file = join(DRESSED, `house-${lookKey(card)}.glb`);
  if (await newer(file, wardrobeFile(card.build))) return file;
  const io = new NodeIO();
  const doc = await io.read(wardrobeFile(card.build));
  dressAvatar(doc, card);
  await mkdir(DRESSED, { recursive: true });
  await io.write(file, doc);
  return file;
}
