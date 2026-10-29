// Find's lens, drawn for the tray on every device (docs/features/tray-everywhere.md),
// on the styleguide's 16 × 16 viewBox, as lines. Provisional until the
// styleguide's glyph table and tokens.json carry it; the tray's own glyphs
// (tray, pinch, squeeze and the slot fallbacks) are in tokens.json.
export const PROVISIONAL_GLYPHS = {
  /** Find: a lens and its handle. */
  find: { d: "M6.75 2a4.75 4.75 0 1 0 0 9.5a4.75 4.75 0 1 0 0-9.5zM10.2 10.2l4.3 4.3" }
} as const;

export type ProvisionalGlyphName = keyof typeof PROVISIONAL_GLYPHS;
