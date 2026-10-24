// A glyph control (styleguide 6, 6.1): a thin gold line drawing, no button
// chrome, at least the input's hit area, never a glow.
import { drawnSizeApx, glyphDrawing, isIdleDimmed, type GlyphId, type HitInput } from "@holoim/xr-ui-core";

import { GlyphButton } from "./GlyphButton.js";
import { GlyphSvg } from "./glyphSvg.js";

export interface GlyphControlProps {
  glyph: GlyphId;
  /** The accessible name, and the visible label when `showLabel` is set. */
  label: string;
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

export function GlyphControl({ glyph, label, onPress, recording = false, input, msSinceUse = 0, approached = false, showLabel = false }: GlyphControlProps) {
  const drawing = glyphDrawing(glyph, { recording });
  const dimmed = isIdleDimmed(glyph, { msSinceUse, approached });
  return (
    <GlyphButton
      label={label}
      onPress={onPress}
      dimmed={dimmed}
      drawnApx={drawnSizeApx(drawing, { headset: false })}
      showLabel={showLabel}
      {...(input ? { input } : {})}
    >
      {(appearance) => <GlyphSvg drawing={drawing} appearance={appearance} />}
    </GlyphButton>
  );
}
