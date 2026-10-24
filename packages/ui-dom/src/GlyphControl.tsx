// A glyph control (styleguide 6, 6.1): a thin gold line drawing, no button
// chrome, at least the input's hit area, never a glow.
import { drawnSizeApx, glyphDrawing, glyphMetrics, isIdleDimmed, type GlyphId, type HitInput } from "@holoim/xr-ui-core";

import { GlyphButton } from "./GlyphButton.js";
import { GlyphSvg } from "./glyphSvg.js";

export interface GlyphControlProps {
  /** null for an action with no drawing yet (brief, "still to draw"): the control is its word. */
  glyph: GlyphId | null;
  /** The accessible name. */
  label: string;
  /** The visible word, beside the glyph with `showLabel` or in place of a null glyph; defaults to `label`. */
  word?: string;
  onPress: () => void;
  /** Record's shape: a circle idle, a rounded square while recording. */
  recording?: boolean;
  /** Defaults to touch on a coarse pointer, else mouse. */
  input?: HitInput;
  /** Time since anyone used the always-there set (1.2); with `approached`, dims Play, Free and Return. */
  msSinceUse?: number;
  /** A hand or cursor is in the row that holds the set. */
  approached?: boolean;
  showLabel?: boolean;
}

export function GlyphControl({ glyph, label, word, onPress, recording = false, input, msSinceUse = 0, approached = false, showLabel = false }: GlyphControlProps) {
  const shared = { label, onPress, ...(word !== undefined ? { word } : {}), ...(input ? { input } : {}) };
  if (glyph === null) {
    return <GlyphButton {...shared} drawnApx={glyphMetrics({ headset: false }).iconApx} />;
  }
  const drawing = glyphDrawing(glyph, { recording });
  const dimmed = isIdleDimmed(glyph, { msSinceUse, approached });
  return (
    <GlyphButton {...shared} dimmed={dimmed} drawnApx={drawnSizeApx(drawing, { headset: false })} showLabel={showLabel}>
      {(appearance) => <GlyphSvg drawing={drawing} appearance={appearance} />}
    </GlyphButton>
  );
}
