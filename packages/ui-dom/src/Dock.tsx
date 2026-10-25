// The dock (styleguide 5.2, 6.1): general actions fixed at the bottom of the
// screen, on the chip sized to its row, never a band or shade across the
// screen (only a hologram casts a shade), its targets kept out of a phone's
// gesture zones and safe-area insets.
import type { HTMLAttributes, ReactNode } from "react";

import { PHONE_EDGES, VIEW_TARGETS, glyphGapApx, type HitInput } from "@holoim/xr-ui-core";

import { chipSurfaceStyle } from "./Chip.js";
import { defaultHitInput } from "./internal.js";

export interface DockProps extends HTMLAttributes<HTMLDivElement> {
  /** Sets the gap between targets; defaults to touch on a coarse pointer, else mouse. */
  input?: HitInput;
  children?: ReactNode;
}

/** The bottom of the ground is amber, where gold fails (2.1:1), so the row takes the chip. */
export function Dock({ input, style, children, ...props }: DockProps) {
  const gap = glyphGapApx(input ?? defaultHitInput(), { headset: false });
  const chip = chipSurfaceStyle(VIEW_TARGETS.desktop, { controlRow: true });
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
      <div data-dock-row="" style={{ ...chip, display: "flex", alignItems: "center", justifyContent: "center", gap, pointerEvents: "auto" }}>
        {children}
      </div>
    </div>
  );
}
