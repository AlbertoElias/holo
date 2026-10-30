// Find's lens and Put back's arrow, drawn for the tray on every device (docs/features/archive/tray-everywhere.md),
// on the styleguide's 16 × 16 viewBox, as lines. Provisional until the
// styleguide's glyph table and tokens.json carry it; the tray's own glyphs
// (tray, pinch, squeeze and the slot fallbacks) are in tokens.json.
export const PROVISIONAL_GLYPHS = {
  /** Find: a lens and its handle. */
  find: { d: "M6.75 2a4.75 4.75 0 1 0 0 9.5a4.75 4.75 0 1 0 0-9.5zM10.2 10.2l4.3 4.3" },
  /** Put back (docs/features/tray-remove.md): an arrow down onto the tray's shelf, the mirror of Upload. */
  putBack: { d: "M1.5 13.5h13M8 1.5v10M4.8 8.3 8 11.5l3.2-3.2" }
} as const;

export type ProvisionalGlyphName = keyof typeof PROVISIONAL_GLYPHS;
