// Glyphs drawn for the tray on every device (docs/features/tray-everywhere.md),
// on the styleguide's 16 × 16 viewBox, as lines. Provisional until the user
// approves them and the styleguide's glyph table and tokens.json carry them,
// as Find's lens was.
export const PROVISIONAL_GLYPHS = {
  /** The tray: a shallow arc of three small rings over a base line. */
  tray: { d: "M2 13.5h12M2.4 9a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0M6.4 6.5a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0M10.4 9a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0" },
  /** Find: a lens and its handle. */
  find: { d: "M6.75 2a4.75 4.75 0 1 0 0 9.5a4.75 4.75 0 1 0 0-9.5zM10.2 10.2l4.3 4.3" },
  /** Pinch: an index and a thumb curving in to meet, with two contact ticks. */
  pinch: { d: "M3.5 2.5c3 1 5 3 5.5 5.5M4 13.5c2-1 4.2-2.8 5-5.5M11 6.5l2-1M11.5 9l2 .5" },
  /** Squeeze: a controller's grip with the fingers closed round it. */
  squeeze: { d: "M7 2.5h3a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H7a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 7 2.5zM5.5 6.5H3.5M5.5 9H3.5M5.5 11.5H3.5" }
} as const;

export type ProvisionalGlyphName = keyof typeof PROVISIONAL_GLYPHS;
