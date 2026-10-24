// The dock (styleguide 5.2, 6.1): a fixed bottom bar on the shade's colours as
// a band along the bottom edge, its targets kept out of a phone's gesture
// zones and safe-area insets.
import type { HTMLAttributes, ReactNode } from "react";

import { PHONE_EDGES, glyphGapApx, type HitInput } from "@holoim/xr-ui-core";

import { defaultHitInput } from "./internal.js";
import { dockShadeGradient } from "./Shade.js";

export interface DockProps extends HTMLAttributes<HTMLDivElement> {
  /** Sets the gap between targets; defaults to touch on a coarse pointer, else mouse. */
  input?: HitInput;
  children?: ReactNode;
}

export function Dock({ input, style, children, ...props }: DockProps) {
  const gap = glyphGapApx(input ?? defaultHitInput(), { headset: false });
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
        alignItems: "center",
        justifyContent: "center",
        gap,
        paddingTop: gap,
        paddingBottom: `max(env(safe-area-inset-bottom), ${PHONE_EDGES.bottom}px)`,
        paddingLeft: `max(env(safe-area-inset-left), ${PHONE_EDGES.side}px)`,
        paddingRight: `max(env(safe-area-inset-right), ${PHONE_EDGES.side}px)`,
        background: dockShadeGradient(),
        ...style
      }}
    >
      {children}
    </div>
  );
}
