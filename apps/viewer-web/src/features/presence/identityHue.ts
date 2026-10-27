import { tokens } from "@holoim/design-tokens";

// A person's identity hue and initial (styleguide 2.4). The API gives a take
// a name (`submittedBy`) and no hue, so the hue is derived from the name: the
// same name is always the same one of the eight, on every device and visit.
// Case and surrounding space do not change it.

export type Identity = {
  /** 1 to 8, as `tokens.color.identity` numbers them. */
  index: number;
  hex: string;
  /** The first letter of the name, upper case; "?" when the name has none. */
  initial: string;
};

const HUES = Object.entries(tokens.color.identity)
  .sort(([a], [b]) => Number(a) - Number(b))
  .map(([index, hex]) => ({ index: Number(index), hex }));

/** FNV-1a over the name's UTF-16 units. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

export function identityOf(name: string): Identity {
  const trimmed = name.trim();
  const hue = HUES[hash(trimmed.toLocaleLowerCase()) % HUES.length]!;
  const first = Array.from(trimmed)[0];
  return { index: hue.index, hex: hue.hex, initial: first ? first.toLocaleUpperCase() : "?" };
}
