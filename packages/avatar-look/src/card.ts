import { BUILDS, CLOTHING, EYES, GLASSES, HAIR_COLOUR, HAIR_STYLES, SKIN } from './traits.js';
import type { Build, Clothing, Eyes, Glasses, HairColour, HairStyle, Skin } from './traits.js';

/** A look card: one value per trait. A character is made from a card alone. */
export interface LookCard {
  readonly build: Build;
  readonly skin: Skin;
  readonly eyes: Eyes;
  readonly hair: { readonly style: HairStyle; readonly colour: HairColour };
  readonly glasses: Glasses;
  readonly clothing: Clothing;
}

const oneOf = (values: readonly string[], v: unknown, what: string, errors: string[]): void => {
  if (typeof v !== 'string' || !values.includes(v)) errors.push(`${what} must be one of ${values.join(', ')} (got ${JSON.stringify(v)})`);
};

/** Checks an untrusted card (from a beat sheet); throws naming every bad trait. */
export function parseLook(input: unknown, where = 'look'): LookCard {
  const errors: string[] = [];
  const c = (input ?? {}) as Record<string, unknown>;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error(`${where} must be an object`);
  const known = ['build', 'skin', 'eyes', 'hair', 'glasses', 'clothing'];
  for (const k of Object.keys(c)) if (!known.includes(k)) errors.push(`unknown trait "${k}"`);
  oneOf(BUILDS, c.build, 'build', errors);
  oneOf(Object.keys(SKIN), c.skin, 'skin', errors);
  oneOf(Object.keys(EYES), c.eyes, 'eyes', errors);
  oneOf(GLASSES, c.glasses, 'glasses', errors);
  oneOf(Object.keys(CLOTHING), c.clothing, 'clothing', errors);
  const hair = (c.hair ?? {}) as Record<string, unknown>;
  oneOf(HAIR_STYLES, hair.style, 'hair.style', errors);
  oneOf(Object.keys(HAIR_COLOUR), hair.colour, 'hair.colour', errors);
  if (errors.length) throw new Error(`${where}: ${errors.join('; ')}`);
  return input as LookCard;
}

/** A short stable name for a card, for cache files: build-skin-eyes-style-colour-glasses-clothing. */
export function lookKey(card: LookCard): string {
  return [card.build, card.skin, card.eyes, card.hair.style, card.hair.colour, card.glasses, card.clothing].join('-');
}

/** Reads a card back from `lookKey` (a `?look=` link value); throws naming every bad trait. */
export function parseLookKey(key: string, where = 'look'): LookCard {
  const parts = key.split('-');
  if (parts.length !== 7) throw new Error(`${where} must have 7 parts joined by "-" (got ${parts.length})`);
  const [build, skin, eyes, style, colour, glasses, clothing] = parts;
  return parseLook({ build, skin, eyes, hair: { style, colour }, glasses, clothing }, where);
}
