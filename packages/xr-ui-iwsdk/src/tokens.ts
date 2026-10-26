import { tokens } from "@holoim/design-tokens";
import { Color } from "three";

// Values from docs/product/design/tokens.json through @holoim/design-tokens.
// Sizes are apx: angular pixels, size_m = apx × 0.000372 × distance.

export const APX_PER_METRE_AT_1M = 1 / tokens.size.radiansPerApx;
/** Foot controls are sized for this viewing distance (brief: 1.75 m reference). */
export const FOOT_REFERENCE_DISTANCE_M = 1.75;
/** The hand dock is read at arm's reach (styleguide §6.1: 45 cm). */
export const DOCK_REFERENCE_DISTANCE_M = 0.45;
/** Labels sit 1 m away or more (type.headsetLabelMinDistanceM). */
export const LABEL_MIN_DISTANCE_M = 1;
export const HEADSET_SCALE = tokens.size.headsetScale; // type and icons, not hit targets

export const metresPerApx = (distanceM: number): number => distanceM / APX_PER_METRE_AT_1M;

export const COLOR = {
  gold: tokens.color.gold,
  highlight: tokens.color.highlight, // hover
  textMuted: tokens.color.textMuted, // timecode
  deepSea: tokens.color.deepSea, // chip, shade
  record: tokens.color.record
} as const;

export const CHIP_OPACITY = {
  vr: tokens.chip.opacity.vr,
  arQuestPassthrough: tokens.chip.opacity.arQuestPassthrough,
  arAndroidChrome: tokens.chip.opacity.arAndroidChrome
} as const;

export const SHADE = {
  inner: tokens.shade.inner.alpha, // deepSea
  mid: tokens.shade.mid.alpha,
  midStop: tokens.shade.midStop,
  phoneHeight: tokens.shade.heightPhoneOfScreen // share of screen height
} as const;

export const CHIP = {
  radius: tokens.chip.radius,
  paddingBlock: tokens.chip.paddingBlock,
  paddingInline: tokens.chip.paddingInline,
  controlRowPaddingStart: tokens.chip.controlRowPaddingStart, // also top and bottom
  vrFadeInMs: tokens.chip.vrFadeIn,
  vrMinHoldMs: tokens.chip.vrMinHold
} as const;

export const GLYPH = {
  stroke: tokens.glyph.stroke,
  icon: tokens.glyph.icon,
  ring: tokens.glyph.ring,
  playTriangle: tokens.glyph.playTriangle,
  gap: tokens.glyph.gap,
  idleAfterMs: tokens.glyph.idleAfter,
  idleOpacity: tokens.glyph.idleOpacity,
  pressedOpacity: tokens.glyph.states.pressedOpacity
} as const;

export const HIT = {
  touch: tokens.hit.touch,
  ray: tokens.hit.ray,
  poke: tokens.hit.poke,
  pokeFloorMm: tokens.hit.pokeFloorMm,
  pokeGap: tokens.hit.pokeGap,
  phoneHomeBar: tokens.hit.phoneHomeBar
} as const;

export const TYPE = {
  controlLabel: { size: tokens.type.controlLabel.fontSize, weight: tokens.type.controlLabel.fontWeight },
  timecode: { size: tokens.type.timecode.fontSize, weight: tokens.type.timecode.fontWeight }
} as const;

export const MOTION = {
  chromeInMs: tokens.motion.chrome.in,
  chromeOutMs: tokens.motion.chrome.out
} as const;

/** Where the controls are drawn, which sets sizes, hit areas and the chip. */
export type XrUiTarget = "vr" | "ar-quest" | "ar-phone";

export interface TargetMetrics {
  /** Type and icon multiplier: 2.5 in a headset, 1 on a phone (styleguide §9.2). */
  scale: number;
  /** Minimum hit area for the target's pointer (apx, never scaled). */
  hitMin: number;
  /**
   * Minimum hit area for controls that can be within reach, such as the foot
   * controls: in a headset they are poked as well as rayed (§6.1, §9.2), so
   * 72 apx and never under 20 mm at the foot's reference distance.
   */
  reachHitMin: number;
  chipOpacity: number;
}

/** The poke minimum at the foot controls' reference distance (apx). */
const FOOT_POKE_MIN = Math.max(HIT.poke, HIT.pokeFloorMm / 1000 / metresPerApx(FOOT_REFERENCE_DISTANCE_M));

export function targetMetrics(target: XrUiTarget): TargetMetrics {
  switch (target) {
    case "vr": return { scale: HEADSET_SCALE, hitMin: HIT.ray, reachHitMin: FOOT_POKE_MIN, chipOpacity: CHIP_OPACITY.vr };
    case "ar-quest": return { scale: HEADSET_SCALE, hitMin: HIT.ray, reachHitMin: FOOT_POKE_MIN, chipOpacity: CHIP_OPACITY.arQuestPassthrough };
    case "ar-phone": return { scale: 1, hitMin: HIT.touch, reachHitMin: HIT.touch, chipOpacity: CHIP_OPACITY.arAndroidChrome };
  }
}

/** A token colour with alpha, as UIKit takes it ([r, g, b, a] in the working colour space). */
export function withAlpha(hex: string, alpha: number): [number, number, number, number] {
  const color = new Color(hex);
  return [color.r, color.g, color.b, alpha];
}
