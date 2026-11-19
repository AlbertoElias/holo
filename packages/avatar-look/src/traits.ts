/**
 * The house base's traits (slice 2d of docs/features/directed-performance.md):
 * every value a look card may name, with its colour in sRGB 0–255 as picked
 * from the clay-traits sheet (skin at the cheek, hair at its mid-tone,
 * clothing at the lit side). Eye colours were picked by eye: the sheet's
 * irises are too small to sample. Decided by the agent in the owner's
 * absence on 2026-11-18, for review.
 */
export type SRGB = readonly [number, number, number];

export const SKIN = {
  porcelain: [243, 171, 136],
  linen: [225, 152, 111],
  goldenSand: [232, 152, 100],
  honey: [228, 143, 93],
  caramel: [229, 139, 94],
  copper: [205, 122, 75],
  umber: [176, 98, 64],
  espresso: [148, 82, 54]
} as const satisfies Record<string, SRGB>;

export const EYES = {
  darkBrown: [70, 40, 22],
  amber: [170, 100, 30],
  mossGreen: [105, 105, 55],
  blue: [80, 110, 140],
  coolGrey: [120, 125, 130],
  hazel: [135, 95, 40]
} as const satisfies Record<string, SRGB>;

export const HAIR_COLOUR = {
  black: [48, 43, 39],
  espresso: [67, 48, 38],
  chestnut: [129, 62, 41],
  copper: [175, 86, 45],
  wheat: [217, 172, 119],
  plum: [113, 45, 62],
  silver: [170, 163, 157],
  ashBrown: [134, 108, 89]
} as const satisfies Record<string, SRGB>;

/** Each style is the wardrobe's `Hair_<style>` mesh. */
export const HAIR_STYLES = ['sweptCrop', 'wavyBob', 'tightCoils', 'highBun', 'centrePart', 'shortTwists'] as const;

/** Each kind but `none` is the wardrobe's `Glasses_<kind>` mesh. */
export const GLASSES = ['none', 'round', 'square'] as const;

/** Each build is its own wardrobe file (the body's proportions are not a colour). */
export const BUILDS = ['slight', 'medium', 'broad'] as const;

export const CLOTHING = {
  oatmealSlate: { top: [231, 195, 168], trousers: [60, 64, 71] },
  rustWalnut: { top: [160, 65, 39], trousers: [56, 43, 34] },
  stormGraphite: { top: [52, 63, 75], trousers: [68, 62, 58] }
} as const satisfies Record<string, { top: SRGB; trousers: SRGB }>;

export type Skin = keyof typeof SKIN;
export type Eyes = keyof typeof EYES;
export type HairColour = keyof typeof HAIR_COLOUR;
export type HairStyle = (typeof HAIR_STYLES)[number];
export type Glasses = (typeof GLASSES)[number];
export type Build = (typeof BUILDS)[number];
export type Clothing = keyof typeof CLOTHING;

/** sRGB 0–255 to the linear 0–1 a glTF base colour factor holds. */
export function linear(c: SRGB): [number, number, number] {
  return c.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}
