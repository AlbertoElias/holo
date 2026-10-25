// Type roles (styleguide 7): two voices, Fraunces for titles and the
// wordmark, Figtree for everything else, with each role's colour.
import { tokens } from "@holoim/design-tokens";

type TypeTokens = typeof tokens.type;
export type TypeRole = { [K in keyof TypeTokens]: TypeTokens[K] extends { fontFamily: unknown } ? K : never }[keyof TypeTokens];

const ROLE_COLOR: Record<TypeRole, string> = {
  titleDesktop: tokens.color.text,
  titlePhoneCard: tokens.color.text,
  wordmarkPhone: tokens.color.text,
  captionOnHologram: tokens.color.text,
  captionUnderCard: tokens.color.text,
  byline: tokens.color.textMuted,
  controlLabel: tokens.color.gold,
  timecode: tokens.color.textMuted,
  note: tokens.color.text,
  // On a filled mark; a hollow mark sets it in the author's hue (2.4, 2.6).
  authorInitial: tokens.color.deepSea
};

export const TYPE_ROLES = Object.keys(ROLE_COLOR) as TypeRole[];

export interface TypeStyle {
  fontFamily: readonly string[];
  fontWeight: number;
  fontSizeApx: number;
  lineHeight: number;
  letterSpacingApx: number;
  color: string;
  /** Changing numbers never shift (7.2). */
  tabularNumbers: boolean;
  /** Fraunces sets with optical sizing (7). */
  opticalSizing: boolean;
  /** The MSDF atlas for 3D, `@holoim/design-tokens/msdf/<face>.json`. */
  msdfFace: string;
}

/** A role's style, at the headset's 2.5× where it applies (7.1). */
export function typeStyle(role: TypeRole, { headset }: { headset: boolean }): TypeStyle {
  const value = tokens.type[role];
  const family = value.fontFamily[0];
  return {
    fontFamily: value.fontFamily,
    fontWeight: value.fontWeight,
    fontSizeApx: value.fontSize * (headset ? tokens.size.headsetScale : 1),
    lineHeight: value.lineHeight,
    letterSpacingApx: value.letterSpacing,
    color: ROLE_COLOR[role],
    tabularNumbers: role === "timecode",
    opticalSizing: family === tokens.font.title[0],
    msdfFace: `${family.toLowerCase()}-${value.fontWeight}`
  };
}
