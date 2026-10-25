import { tokens } from "./generated/tokens.js";

export { tokens, type Tokens } from "./generated/tokens.js";

export interface SizeOptions {
  /** True in VR and on Quest AR, where the styleguide's headset sizes apply. */
  headset: boolean;
}

/**
 * Metres for an angular size at a distance (styleguide section 2,
 * `size_m = apx × 0.000372 × distance_m`). In a headset the 2.5× factor
 * applies, so pass only drawn sizes here: type, icons, glyph strokes, rings,
 * glyph gaps and the chip's shape. Hit areas never scale; use `hitAreaMeters`.
 */
export function apxToMeters(apx: number, distanceM: number, { headset }: SizeOptions): number {
  return apx * tokens.size.radiansPerApx * distanceM * (headset ? tokens.size.headsetScale : 1);
}

export type HitInput = "mouse" | "touch" | "ray" | "gazePinch" | "poke";

/**
 * A glyph's hit area in metres: the larger of its drawn size (scaled like
 * any drawn size) and the input's minimum, which is never scaled
 * (styleguide 6.1). A poke is never under 20 mm.
 */
export function hitAreaMeters(input: HitInput, drawnApx: number, distanceM: number, options: SizeOptions): number {
  const minimum = apxToMeters(tokens.hit[input], distanceM, { headset: false });
  const floor = input === "poke" ? tokens.hit.pokeFloorMm / 1000 : 0;
  return Math.max(apxToMeters(drawnApx, distanceM, options), minimum, floor);
}
