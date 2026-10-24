// Text in a headset (styleguide 7.3): none within arm's reach, and a
// hologram's own text fades as you come within 1 m of it.
import { tokens } from "@holoim/design-tokens";

import { isHeadset, type ViewTarget } from "./targets.js";

export type TextKind = "label" | "timecode" | "caption" | "note" | "status" | "title";

export interface TextDistances {
  /** From the head to the text itself. */
  fromHeadM: number;
  /** From the head to the hologram the text belongs to, if it belongs to one. */
  toHologramM?: number;
}

const HOLOGRAM_TEXT: ReadonlySet<TextKind> = new Set(["label", "timecode", "caption"]);

/**
 * Whether text shows. On flat screens it always does. In a headset no text
 * sits within 1 m of the head (panels you touch carry glyphs only), and a
 * hologram's labels, timecode and caption hide within 1 m of it and return
 * beyond; renderers fade them with the chrome timings.
 */
export function headsetTextVisible(target: ViewTarget, kind: TextKind, { fromHeadM, toHologramM }: TextDistances): boolean {
  if (!isHeadset(target)) return true;
  const limit = tokens.type.headsetLabelMinDistanceM;
  if (fromHeadM < limit) return false;
  if (HOLOGRAM_TEXT.has(kind) && toHologramM !== undefined && toHologramM < limit) return false;
  return true;
}

/** People's notes fold to their mark within 1 m of the hologram in a headset. */
export function noteFolded(target: ViewTarget, toHologramM: number): boolean {
  return isHeadset(target) && toHologramM < tokens.type.headsetLabelMinDistanceM;
}
