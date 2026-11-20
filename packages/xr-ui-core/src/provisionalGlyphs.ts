// Find's lens, drawn for the tray on every device (docs/features/archive/tray-everywhere.md),
// and Look's head and shoulders, drawn on the headset's wrist dock,
// on the styleguide's 16 × 16 viewBox, as lines. Provisional until the
// styleguide's glyph table and tokens.json carry it; the tray's own glyphs
// (tray, pinch, squeeze, Put back and the slot fallbacks) are in tokens.json.
export const PROVISIONAL_GLYPHS = {
  /** Find: a lens and its handle. */
  find: { d: "M6.75 2a4.75 4.75 0 1 0 0 9.5a4.75 4.75 0 1 0 0-9.5zM10.2 10.2l4.3 4.3" },
  /** Look (docs/features/your-look.md, slice 2): a head and shoulders, for the house avatar's look in a headset. */
  look: { d: "M8 1.75a2.9 2.9 0 1 0 0 5.8a2.9 2.9 0 1 0 0-5.8zM2.25 14.5c0-3.2 2.55-5.4 5.75-5.4s5.75 2.2 5.75 5.4" }
} as const;

export type ProvisionalGlyphName = keyof typeof PROVISIONAL_GLYPHS;
