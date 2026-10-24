// The shade at a hologram's foot (styleguide 5.1) and the dock's shade (5.2).
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

import { shadeLayout, shadeStops } from "@holoim/xr-ui-core";

import { percent, rgbWithAlpha } from "./internal.js";

function cssStops(): string {
  return shadeStops()
    .map((stop) => `${rgbWithAlpha(stop.color, stop.alpha)} ${percent(stop.position)}`)
    .join(", ");
}

/** `radial-gradient(closest-side, …)` from the core's stops: deep sea 70%, 50% at 60%, then clear. */
export function shadeGradient(): string {
  return `radial-gradient(closest-side, ${cssStops()})`;
}

/**
 * The dock's shade (5.2): the same stops as a band run up from the screen's
 * bottom edge, so only a hologram casts an oval shade.
 */
export function dockShadeGradient(): string {
  return `linear-gradient(to top, ${cssStops()})`;
}

export interface ShadeProps extends HTMLAttributes<HTMLDivElement> {
  /** A phone's shade is 24% of the screen's height; a desktop's is 120 px. */
  device?: "phone" | "desktop";
  /** Where the shade starts, as a share of the card's height; clamped to 0.90–0.95. */
  start?: number;
  children?: ReactNode;
}

/**
 * Placed in a positioned card container: 120% of the card's width and
 * centred on it, starting at the foot. Pointer events only reach children.
 */
export function Shade({ device = "desktop", start, style, children, ...props }: ShadeProps) {
  // The core's box on a unit card, as shares of the card; the phone's height as vh of a unit screen.
  const box = shadeLayout({ card: { left: 0, top: 0, width: 1, height: 1 }, device, screenHeight: 1, ...(start === undefined ? {} : { start }) });
  const boxStyle: CSSProperties = {
    position: "absolute",
    left: percent(box.left),
    top: percent(box.top),
    width: percent(box.width),
    height: device === "desktop" ? `${box.height}px` : `${Number((box.height * 100).toFixed(4))}vh`
  };
  return (
    <div
      {...props}
      style={{
        ...boxStyle,
        boxSizing: "border-box",
        background: shadeGradient(),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
        ...style
      }}
    >
      <div style={{ pointerEvents: "auto" }}>{children}</div>
    </div>
  );
}
