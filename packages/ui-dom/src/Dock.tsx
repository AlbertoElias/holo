// The dock (styleguide 5.2, 6.1): general actions fixed at the bottom of the
// screen, never a band or shade across it (only a hologram casts a shade),
// its targets kept out of a phone's gesture zones and safe-area insets. Over
// a picture (AR, capture) the row sits on the chip sized to it; on the feed's
// amber horizon it stands bare and its controls draw as lanterns.
import type { HTMLAttributes, ReactNode } from "react";

import { PHONE_EDGES, VIEW_TARGETS, glyphGapApx, type HitInput } from "@holoim/xr-ui-core";

import { chipSurfaceStyle } from "./Chip.js";
import { OnHorizon, defaultHitInput } from "./internal.js";

export interface DockProps extends HTMLAttributes<HTMLDivElement> {
  /** Sets the gap between targets; defaults to touch on a coarse pointer, else mouse. */
  input?: HitInput;
  /** What the dock stands on: a picture, so the row takes the chip, or the feed's amber horizon. */
  ground?: "picture" | "horizon";
  children?: ReactNode;
}

/**
 * Gold fails on the amber at the bottom of the ground (2.1:1). Over a picture
 * the row takes the chip; on the horizon each control holds its own lens
 * (`lanternLook`), so no slab sits across the row.
 */
export function Dock({ input, ground = "picture", style, children, ...props }: DockProps) {
  const gap = glyphGapApx(input ?? defaultHitInput(), { headset: false });
  const chip = ground === "horizon" ? null : chipSurfaceStyle(VIEW_TARGETS.desktop, { controlRow: true });
  return (
    <div
      role="toolbar"
      {...props}
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        boxSizing: "border-box",
        display: "flex",
        justifyContent: "center",
        paddingBottom: `max(env(safe-area-inset-bottom), ${PHONE_EDGES.bottom}px)`,
        paddingLeft: `max(env(safe-area-inset-left), ${PHONE_EDGES.side}px)`,
        paddingRight: `max(env(safe-area-inset-right), ${PHONE_EDGES.side}px)`,
        pointerEvents: "none",
        ...style
      }}
    >
      <div data-dock-row="" data-dock-ground={ground} style={{ ...chip, display: "flex", alignItems: "center", justifyContent: "center", gap, pointerEvents: "auto" }}>
        <OnHorizon.Provider value={ground === "horizon"}>{children}</OnHorizon.Provider>
      </div>
    </div>
  );
}
