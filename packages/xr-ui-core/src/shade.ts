// The shade at a hologram's foot (styleguide 5.1) and the dock's shade (5.2).
import { tokens } from "@holoim/design-tokens";

const { shade } = tokens;

export interface ShadeStop {
  color: string;
  alpha: number;
  position: number;
}

/** `radial-gradient(closest-side, …)` stops: deep sea at 70%, 50% at 60%, then clear. */
export function shadeStops(): ShadeStop[] {
  return [
    { color: shade.inner.hex, alpha: shade.inner.alpha, position: 0 },
    { color: shade.mid.hex, alpha: shade.mid.alpha, position: shade.midStop },
    { color: shade.mid.hex, alpha: 0, position: 1 }
  ];
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ShadeLayoutOptions {
  card: Box;
  device: "phone" | "desktop";
  screenHeight: number;
  /** Where the shade starts, as a share of the card's height; clamped to 0.90–0.95. */
  start?: number;
}

/**
 * The shade's box: 120% of the hologram's width, centred on it, starting 90
 * to 95% of the way down the card, 120 px tall on a desktop and 24% of the
 * screen on a phone.
 */
export function shadeLayout({ card, device, screenHeight, start = shade.startMin }: ShadeLayoutOptions): Box {
  const width = card.width * shade.widthOfHologram;
  const startShare = Math.min(shade.startMax, Math.max(shade.startMin, start));
  return {
    left: card.left - (width - card.width) / 2,
    top: card.top + card.height * startShare,
    width,
    height: device === "desktop" ? shade.heightDesktop : screenHeight * shade.heightPhoneOfScreen
  };
}

/** Whether a point is inside 45% of the shade's radius, where every label must sit. */
export function isInsideLabelRim(shadeBox: Box, x: number, y: number): boolean {
  const rx = shadeBox.width / 2;
  const ry = shadeBox.height / 2;
  const dx = (x - (shadeBox.left + rx)) / rx;
  const dy = (y - (shadeBox.top + ry)) / ry;
  return Math.hypot(dx, dy) <= shade.labelRim;
}

/** Whether a whole box (a label, a glyph) is inside the label rim. */
export function boxInsideLabelRim(shadeBox: Box, box: Box): boolean {
  const corners: Array<[number, number]> = [
    [box.left, box.top],
    [box.left + box.width, box.top],
    [box.left, box.top + box.height],
    [box.left + box.width, box.top + box.height]
  ];
  return corners.every(([x, y]) => isInsideLabelRim(shadeBox, x, y));
}
