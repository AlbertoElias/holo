// The look sheet's pictures: one per value of each row, made by
// `scripts/authoring/house-look-pictures.ts` into `public/look-pictures/`.

/** The look sheet's rows, top to bottom. */
export const LOOK_ROWS = ['finish', 'build', 'skin', 'hair', 'hairColour', 'eyes', 'glasses', 'clothing'] as const;
export type LookRow = (typeof LOOK_ROWS)[number];

/** A value's picture, relative to the app's base: "look-pictures/skin-caramel.jpg". */
export const lookPicture = (row: LookRow, value: string): string => `look-pictures/${row}-${value}.jpg`;
