// The look sheet's pictures: one per value of each row, made by
// `scripts/authoring/house-look-pictures.ts` into `public/look-pictures/`.
// The rows' words and values are here too, so the phone sheet and the
// headset panel (docs/features/your-look.md, slice 2) read one list.
import { BUILDS, CLOTHING, EYES, FINISHES, GLASSES, HAIR_COLOUR, HAIR_STYLES, SKIN, type LookCard } from '@holoim/avatar-look';

import type { HouseLook } from '../avatar/houseLook';

/** The look sheet's rows, top to bottom. */
export const LOOK_ROWS = ['finish', 'build', 'skin', 'hair', 'hairColour', 'eyes', 'glasses', 'clothing'] as const;
export type LookRow = (typeof LOOK_ROWS)[number];

/** A value's picture, relative to the app's base: "look-pictures/skin-caramel.jpg". */
export const lookPicture = (row: LookRow, value: string): string => `look-pictures/${row}-${value}.jpg`;

/** "sweptCrop" → "Swept crop". */
export function traitWords(value: string): string {
  const words = value.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "shirtJeans" → "Shirt and jeans". */
export const clothingWords = (value: string): string => traitWords(value).replace(/ /, ' and ');

const keys = <T extends string>(record: Record<T, unknown>): T[] => Object.keys(record) as T[];

/** Each row's word, as the sheet's heading says it. */
export const LOOK_ROW_TITLES: Record<LookRow, string> = {
  finish: 'Finish',
  build: 'Build',
  skin: 'Skin',
  hair: 'Hair',
  hairColour: 'Hair colour',
  eyes: 'Eyes',
  glasses: 'Glasses',
  clothing: 'Clothes'
};

/** Each row's values, in the sheet's order, with the word under each picture. */
export const LOOK_CHOICES: Record<LookRow, ReadonlyArray<{ value: string; label: string }>> = {
  finish: FINISHES.map((value) => ({ value, label: traitWords(value) })),
  build: BUILDS.map((value) => ({ value, label: traitWords(value) })),
  skin: keys(SKIN).map((value) => ({ value, label: traitWords(value) })),
  hair: HAIR_STYLES.map((value) => ({ value, label: traitWords(value) })),
  hairColour: keys(HAIR_COLOUR).map((value) => ({ value, label: traitWords(value) })),
  eyes: keys(EYES).map((value) => ({ value, label: traitWords(value) })),
  glasses: GLASSES.map((value) => ({ value, label: traitWords(value) })),
  clothing: keys(CLOTHING).map((value) => ({ value, label: clothingWords(value) }))
};

/** A row's value in a look. */
export function lookValue(look: HouseLook, row: LookRow): string {
  const card = look.look;
  switch (row) {
    case 'finish':
      return look.finish;
    case 'hair':
      return card.hair.style;
    case 'hairColour':
      return card.hair.colour;
    default:
      return card[row];
  }
}

/** The look with one row changed. `value` is one of `LOOK_CHOICES[row]`. */
export function withLookValue(look: HouseLook, row: LookRow, value: string): HouseLook {
  const card = look.look;
  if (row === 'finish') return { look: card, finish: value as HouseLook['finish'] };
  if (row === 'hair') return { look: { ...card, hair: { ...card.hair, style: value as LookCard['hair']['style'] } }, finish: look.finish };
  if (row === 'hairColour') return { look: { ...card, hair: { ...card.hair, colour: value as LookCard['hair']['colour'] } }, finish: look.finish };
  return { look: { ...card, [row]: value } as LookCard, finish: look.finish };
}
