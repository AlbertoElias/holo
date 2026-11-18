import type { Document } from '@gltf-transform/core';
import type { LookCard } from './card.js';
import { CLOTHING, EYES, HAIR_COLOUR, linear, SKIN } from './traits.js';

/** The brows take the hair's colour, darker, so they read on every skin. */
export const BROW_SHARE = 0.55;

/**
 * Dresses a house-base wardrobe (every hair style and glasses kind, one
 * build) as the card says, in place: keeps the card's hair and glasses
 * meshes, removes the others, and sets the materials' colours. The scene's
 * `holoimAvatar` extras record the card. The wardrobe must be the card's
 * build.
 */
export function dressAvatar(doc: Document, card: LookCard): void {
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) throw new Error('dressAvatar: the document has no scene');
  const extras = scene.getExtras() as { holoimAvatar?: string };
  const avatar = JSON.parse(extras.holoimAvatar ?? 'null') as Record<string, unknown> | null;
  if (!avatar || avatar.name !== 'house-base') throw new Error('dressAvatar: not a house-base wardrobe (no holoimAvatar extras naming it)');
  if (avatar.build !== card.build) throw new Error(`dressAvatar: the wardrobe is the ${String(avatar.build)} build, the card asks for ${card.build}`);

  const keep = new Set([`Hair_${card.hair.style}`, ...(card.glasses === 'none' ? [] : [`Glasses_${card.glasses}`])]);
  const parts = root.listNodes().filter((n) => /^(Hair|Glasses)_/.test(n.getName()));
  for (const want of keep) if (!parts.some((n) => n.getName() === want)) throw new Error(`dressAvatar: the wardrobe has no ${want}`);
  for (const node of parts) {
    if (keep.has(node.getName())) continue;
    const mesh = node.getMesh();
    node.dispose();
    if (mesh && !root.listNodes().some((n) => n.getMesh() === mesh)) {
      for (const p of mesh.listPrimitives()) {
        for (const a of p.listAttributes()) a.dispose();
        p.getIndices()?.dispose();
        for (const t of p.listTargets()) for (const a of t.listAttributes()) a.dispose();
      }
      mesh.dispose();
    }
  }
  for (const skin of root.listSkins()) if (!root.listNodes().some((n) => n.getSkin() === skin)) skin.dispose();

  const hair = linear(HAIR_COLOUR[card.hair.colour]);
  const colours: Record<string, readonly number[]> = {
    HouseBase_skin: linear(SKIN[card.skin]),
    HouseBase_eye_iris: linear(EYES[card.eyes]),
    HouseBase_hair: hair,
    HouseBase_brow: hair.map((v) => v * BROW_SHARE),
    HouseBase_top: linear(CLOTHING[card.clothing].top),
    HouseBase_trousers: linear(CLOTHING[card.clothing].trousers)
  };
  for (const m of root.listMaterials()) {
    const c = colours[m.getName()];
    if (c) m.setBaseColorFactor([c[0]!, c[1]!, c[2]!, 1]);
  }
  for (const m of root.listMaterials()) if (!m.listParents().some((p) => p.propertyType === 'Primitive')) m.dispose();

  extras.holoimAvatar = JSON.stringify({ ...avatar, look: card });
  scene.setExtras(extras);
}
