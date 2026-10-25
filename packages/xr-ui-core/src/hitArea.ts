// Hit areas per input (styleguide 6.1): the larger of the drawn size and the
// input's minimum, centred on the glyph, never scaled by the headset factor.
import { hitAreaMeters, tokens, type HitInput } from "@holoim/design-tokens";

export { hitAreaMeters, type HitInput };

/** A glyph's hit area in apx on a flat screen: the larger of its drawn size and the input's minimum. */
export function hitAreaApx(input: HitInput, drawnApx: number): number {
  return Math.max(drawnApx, tokens.hit[input]);
}

/** The input a DOM pointer is. A pen, or a pointer type the browser does not name, is held to touch's minimum. */
export function inputFromPointerType(pointerType: string): HitInput {
  return pointerType === "mouse" ? "mouse" : "touch";
}

/**
 * The input a WebXR input source is. visionOS sends gaze and pinch as
 * `transient-pointer` (brief Q17); a tracked hand touching a panel is a poke.
 */
export function inputFromTargetRayMode(targetRayMode: string, { poke = false }: { poke?: boolean } = {}): HitInput {
  switch (targetRayMode) {
    case "transient-pointer":
    case "gaze":
      return "gazePinch";
    case "screen":
      return "touch";
    default:
      return poke ? "poke" : "ray";
  }
}

/** Space between glyph centres' hit areas: the glyph gap (2.5× in a headset), and at least 30 apx for a poke. */
export function glyphGapApx(input: HitInput, { headset }: { headset: boolean }): number {
  const gap = tokens.glyph.gap * (headset ? tokens.size.headsetScale : 1);
  return input === "poke" ? Math.max(gap, tokens.hit.pokeGap) : gap;
}

/** A phone's gesture zones and safe-area margins, in apx, that no target may enter (6.1 "Phone edges"). */
export const PHONE_EDGES = { side: tokens.hit.phoneSideEdge, bottom: tokens.hit.phoneHomeBar } as const;
