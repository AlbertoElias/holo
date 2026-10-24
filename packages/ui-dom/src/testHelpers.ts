// Test-only helpers: express a token hex the way jsdom serialises a colour.

/** `#rrggbb` as jsdom writes a style colour: `rgb(r, g, b)`. */
export function cssRgb(hex: string): string {
  const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
  return `rgb(${channels.join(", ")})`;
}

/** The alpha of a serialised `rgba(r, g, b, a)` colour, or 1 for an opaque `rgb(...)`. */
export function alphaOf(colour: string): number {
  const match = /rgba\([^)]*,\s*([\d.]+)\)/.exec(colour);
  return match ? Number(match[1]) : 1;
}
