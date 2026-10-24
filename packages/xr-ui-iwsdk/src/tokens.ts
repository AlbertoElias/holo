import { Color } from "three";


// Values from docs/product/design/tokens.json (the styleguide wins where they
// differ). Sizes are apx: angular pixels, size_m = apx × 0.000372 × distance.

export const APX_PER_METRE_AT_1M = 1 / 0.000372; // $extensions.holoim.sizeFormula
/** Foot controls are sized for this viewing distance (brief: 1.75 m reference). */
export const FOOT_REFERENCE_DISTANCE_M = 1.75;
/** The hand dock is read at arm's reach (styleguide §6.1: 45 cm). */
export const DOCK_REFERENCE_DISTANCE_M = 0.45;
/** Labels sit 1 m away or more (type.headsetLabelMinDistanceM). */
export const LABEL_MIN_DISTANCE_M = 1;
export const HEADSET_SCALE = 2.5; // $extensions.holoim.headsetScale: type and icons, not hit targets

export const metresPerApx = (distanceM: number): number => distanceM / APX_PER_METRE_AT_1M;

export const COLOR = {
  gold: "#ffc872", // color.gold
  highlight: "#fff3cf", // color.highlight (hover)
  textMuted: "#bfd0cc", // color.textMuted (timecode)
  deepSea: "#081a1e", // color.deepSea (chip, shade)
  record: "#ff3b5c" // color.record
} as const;

export const CHIP_OPACITY = {
  vr: 0.72, // chip.opacity.vr
  arQuestPassthrough: 0.97, // chip.opacity.arQuestPassthrough
  arAndroidChrome: 0.88 // chip.opacity.arAndroidChrome
} as const;

export const SHADE = {
  inner: 0.7, // shade.inner alpha (deepSea)
  mid: 0.5, // shade.mid alpha
  midStop: 0.6, // shade.midStop
  phoneHeight: 0.24 // shade $extensions placement.heightPhone: 24% of screen height
} as const;

export const CHIP = {
  radius: 18, // chip.radius
  paddingBlock: 5, // chip.paddingBlock
  paddingInline: 14, // chip.paddingInline
  controlRowPaddingStart: 3, // chip.controlRowPaddingStart (also top and bottom)
  vrFadeInMs: 300, // chip.vrFadeIn
  vrMinHoldMs: 2000 // chip.vrMinHold
} as const;

export const GLYPH = {
  stroke: 1.5, // glyph.stroke
  icon: 16, // glyph.icon
  ring: 36, // glyph.ring
  playTriangle: 14, // glyph.playTriangle
  gap: 12, // glyph.gap
  idleAfterMs: 4000, // glyph.idleAfter
  idleOpacity: 0.4, // glyph.idleOpacity
  pressedOpacity: 0.55 // glyph.states.pressedOpacity
} as const;

export const HIT = {
  touch: 44, // hit.touch
  ray: 56, // hit.ray
  poke: 72, // hit.poke
  pokeFloorMm: 20, // hit.pokeFloorMm
  pokeGap: 30, // hit.pokeGap
  phoneHomeBar: 34 // hit.phoneHomeBar
} as const;

export const TYPE = {
  controlLabel: { size: 14, weight: 500 }, // type.controlLabel
  timecode: { size: 14.4, weight: 400 } // type.timecode
} as const;

export const MOTION = {
  chromeInMs: 240, // motion.chrome.in
  chromeOutMs: 400 // motion.chrome.out
} as const;

/** Where the controls are drawn, which sets sizes, hit areas and the chip. */
export type XrUiTarget = "vr" | "ar-quest" | "ar-phone";

export interface TargetMetrics {
  /** Type and icon multiplier: 2.5 in a headset, 1 on a phone (styleguide §9.2). */
  scale: number;
  /** Minimum hit area for the target's pointer (apx, never scaled). */
  hitMin: number;
  chipOpacity: number;
}

export function targetMetrics(target: XrUiTarget): TargetMetrics {
  switch (target) {
    case "vr": return { scale: HEADSET_SCALE, hitMin: HIT.ray, chipOpacity: CHIP_OPACITY.vr };
    case "ar-quest": return { scale: HEADSET_SCALE, hitMin: HIT.ray, chipOpacity: CHIP_OPACITY.arQuestPassthrough };
    case "ar-phone": return { scale: 1, hitMin: HIT.touch, chipOpacity: CHIP_OPACITY.arAndroidChrome };
  }
}

/** A token colour with alpha, as UIKit takes it ([r, g, b, a] in the working colour space). */
export function withAlpha(hex: string, alpha: number): [number, number, number, number] {
  const color = new Color(hex);
  return [color.r, color.g, color.b, alpha];
}
