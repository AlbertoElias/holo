// The MSDF atlases for 3D text (styleguide 7.3), baked by scripts/bake-msdf.ts.
// A separate entry point, so only the 3D renderers that draw text load them.

export const MSDF_FACES = ["fraunces-600", "figtree-400", "figtree-500", "figtree-600"] as const;
export type MsdfFace = (typeof MSDF_FACES)[number];

export interface BmFontChar {
  id: number;
  char: string;
  x: number;
  y: number;
  width: number;
  height: number;
  xoffset: number;
  yoffset: number;
  xadvance: number;
  page: number;
}

/** The BMFont JSON layout `@pmndrs/uikit` also reads. */
export interface BmFont {
  pages: string[];
  chars: BmFontChar[];
  info: { face: string; size: number };
  common: { lineHeight: number; base: number; scaleW: number; scaleH: number };
  distanceField: { fieldType: "msdf"; distanceRange: number };
  kernings: Array<{ first: number; second: number; amount: number }>;
}

export function isMsdfFace(face: string): face is MsdfFace {
  return (MSDF_FACES as readonly string[]).includes(face);
}

/** One face's glyph metrics and the URL of its atlas image, loaded on demand. */
export async function loadMsdfAtlas(face: MsdfFace): Promise<{ font: BmFont; textureUrl: string }> {
  const module = (await import(`./fonts/msdf/${face}.json`)) as { default: BmFont };
  return { font: module.default, textureUrl: new URL(`./fonts/msdf/${face}.png`, import.meta.url).href };
}
