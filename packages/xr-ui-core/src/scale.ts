// Scale (styleguide 4; brief Q13): true scale is a fact, so a hologram opens
// at true scale, and any rescale is visible, labelled and reversible.

export const TRUE_SCALE = 1;

function ratio(value: number): string {
  for (const digits of [1, 2, 3]) {
    const text = Number(value.toFixed(digits)).toString();
    if (text !== "1") return text;
  }
  return value.toString();
}

/**
 * The label for a scale factor: null at true scale, "1:4" for a quarter size,
 * "2.5:1" for larger. A factor near 1 keeps enough digits never to read
 * "1:1" while it is not true scale.
 */
export function scaleLabel(factor: number): string | null {
  if (!(factor > 0)) throw new RangeError(`scale factor must be positive, got ${factor}`);
  if (factor === TRUE_SCALE) return null;
  return factor > 1 ? `${ratio(factor)}:1` : `1:${ratio(1 / factor)}`;
}

export interface ScaleState {
  factor: number;
  label: string | null;
  /** The glyph that returns to true size shows whenever the scale is not true. */
  canReturn: boolean;
}

export function scaleState(factor: number = TRUE_SCALE): ScaleState {
  const label = scaleLabel(factor);
  return { factor, label, canReturn: label !== null };
}
