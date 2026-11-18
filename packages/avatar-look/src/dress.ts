import type { Document } from '@gltf-transform/core';
import type { LookCard } from './card.js';
import { CLOTHING, EYES, HAIR_COLOUR, linear, SKIN } from './traits.js';

/** The brows take the hair's colour, darker. */
export const BROW_SHARE = 0.55;

/**
 * How far below the skin the brows' OKLab lightness must sit (unlit base
 * colours), so the audition's rendered brow contrast holds on every skin and
 * hair pair: light hair on light skin and dark hair on the darkest skin both
 * lost it at the plain share. Decided by the agent in the owner's absence on
 * 2026-11-18, for review.
 */
export const BROW_STEP = 0.42;

/** OKLab lightness of a linear sRGB colour. */
export function oklabL(c: readonly number[]): number {
  const [r, g, b] = [c[0]!, c[1]!, c[2]!];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

/** The brows' linear colour: the hair's hue at BROW_SHARE, darkened further until it sits BROW_STEP below the skin. */
export function browColour(hair: readonly number[], skin: readonly number[]): [number, number, number] {
  const brow = hair.slice(0, 3).map((v) => v * BROW_SHARE) as [number, number, number];
  const target = Math.max(0.02, oklabL(skin) - BROW_STEP);
  const now = oklabL(brow);
  // Scaling a linear colour by k scales its OKLab lightness by cbrt(k).
  return now <= target ? brow : (brow.map((v) => v * (target / now) ** 3) as [number, number, number]);
}

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
        p.dispose(); // else the primitive keeps its material alive below
      }
      mesh.dispose();
    }
  }
  for (const skin of root.listSkins()) if (!root.listNodes().some((n) => n.getSkin() === skin)) skin.dispose();

  const hair = linear(HAIR_COLOUR[card.hair.colour]);
  const skin = linear(SKIN[card.skin]);
  const colours: Record<string, readonly number[]> = {
    HouseBase_skin: skin,
    HouseBase_eye_iris: linear(EYES[card.eyes]),
    HouseBase_hair: hair,
    HouseBase_brow: browColour(hair, skin),
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
