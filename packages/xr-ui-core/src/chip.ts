// The chip (styleguide 2.3, 5.2, 8.4): the one text container, flat deep sea
// with no blur and no rim, at an opacity set by how the target composites.
import { tokens } from "@holoim/design-tokens";

import { isHeadset, type ArCompositor, type ViewTarget } from "./targets.js";

const { chip } = tokens;

const AR_OPACITY: Record<ArCompositor, number> = {
  questPassthrough: chip.opacity.arQuestPassthrough,
  androidChrome: chip.opacity.arAndroidChrome,
  linear: chip.opacity.arLinear,
  // Brief Q18: an AR target not in the table takes the linear-light value.
  unlisted: chip.opacity.arLinear
};

/** The chip's opacity for a target; null in Quick Look, where no chip is possible. Never 1 in AR. */
export function chipOpacity(target: ViewTarget, { overPicture = false }: { overPicture?: boolean } = {}): number | null {
  switch (target.kind) {
    case "flat": return overPicture ? chip.opacity.flatOverPicture : chip.opacity.flat;
    case "vr": return chip.opacity.vr;
    case "ar": return AR_OPACITY[target.compositor];
    case "quickLook": return null;
  }
}

export interface ChipStyle {
  color: string;
  opacity: number;
  /** Plain source-over blending: no backdrop blur and no rim (2.3). */
  blendMode: "normal";
  backdropBlur: false;
  rim: false;
  radiusApx: number;
  paddingBlockApx: number;
  paddingInlineApx: number;
}

/** The chip's look on a target, with the headset's 2.5× shape (2.3). Null in Quick Look. */
export function chipStyle(target: ViewTarget, options: { overPicture?: boolean } = {}): ChipStyle | null {
  const opacity = chipOpacity(target, options);
  if (opacity === null) return null;
  const scale = isHeadset(target) ? tokens.size.headsetScale : 1;
  return {
    color: chip.color,
    opacity,
    blendMode: "normal",
    backdropBlur: false,
    rim: false,
    radiusApx: chip.radius * scale,
    paddingBlockApx: chip.paddingBlock * scale,
    paddingInlineApx: chip.paddingInline * scale
  };
}

/** Padding of a chip holding a control row: 3 apx at the top, bottom and start, 14 at the end, so Play sits flush. */
export function controlRowPaddingApx(target: ViewTarget): { top: number; bottom: number; start: number; end: number } {
  const scale = isHeadset(target) ? tokens.size.headsetScale : 1;
  const tight = chip.controlRowPaddingStart * scale;
  return { top: tight, bottom: tight, start: tight, end: chip.paddingInline * scale };
}

export type RowKind = "hologramRow" | "feedNotice" | "dock";
/** What is behind the row. Walls, sky and lit surfaces are VR's; picture is the hologram's own picture. */
export type RowBackground = "ground" | "picture" | "wall" | "sky" | "hologram" | "litSurface";
export type RowBacking = "chip" | "shade" | "bare" | "none";

/**
 * What a row of controls or text sits on (5.2). The chip only where the
 * ground fails: in VR in front of the sky, a hologram or a lit surface; in AR
 * always; on flat screens for feed-wide notices and over a picture. Quick
 * Look takes no text or controls.
 */
export function rowBacking(target: ViewTarget, kind: RowKind, background: RowBackground): RowBacking {
  switch (target.kind) {
    case "quickLook": return "none";
    case "ar": return "chip";
    case "vr": return background === "wall" || background === "ground" ? "bare" : "chip";
    case "flat":
      if (background === "picture" || kind === "feedNotice") return "chip";
      return "shade";
  }
}

export interface VrChipFade {
  /** Multiplier on the chip's opacity, 0 to 1. */
  presence: number;
  /** Time since the background last asked for the chip. */
  sinceWantedMs: number;
}

export const VR_CHIP_HIDDEN: VrChipFade = { presence: 0, sinceWantedMs: Infinity };

/**
 * One frame of the VR chip (5.2, 8.4): it fades in over 0.3 s and holds at
 * least 2 s after the background last asked for it, then leaves as chrome
 * does (0.4 s), so a background that wavers at a boundary never makes it
 * flicker.
 */
export function stepVrChipFade(state: VrChipFade, wanted: boolean, dtMs: number): VrChipFade {
  const sinceWantedMs = wanted ? 0 : state.sinceWantedMs + dtMs;
  const show = sinceWantedMs < chip.vrMinHold;
  const presence = show
    ? state.presence + dtMs / chip.vrFadeIn
    : state.presence - dtMs / chip.vrFadeOut;
  // Snapped at the ends, so "fully shown" and "gone" are exact despite summed steps.
  return { presence: presence >= 1 - 1e-9 ? 1 : presence <= 1e-9 ? 0 : presence, sinceWantedMs };
}
