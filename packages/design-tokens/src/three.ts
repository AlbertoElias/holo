import { Color, SRGBColorSpace } from "three";

/**
 * A three.js colour from a token's sRGB hex, converted to the working
 * (linear) colour space exactly once. Chrome materials using it also set
 * `toneMapped: false` (see `chromeMaterial`), since tone mapping would shift
 * gold and cream.
 */
export function tokenColor(hex: string): Color {
  return new Color().setStyle(hex, SRGBColorSpace);
}

/** Material parameters every chrome material shares. */
export const chromeMaterial = { toneMapped: false } as const;
