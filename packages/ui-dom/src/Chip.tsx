// The chip (styleguide 2.3, 5.2): flat deep sea at the opacity the target
// composites at; no blur, no rim. Nothing in AR Quick Look.
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

import { VIEW_TARGETS, chipStyle, controlRowPaddingApx, type ViewTarget } from "@holoim/xr-ui-core";

import { rgbWithAlpha } from "./internal.js";

export interface ChipProps extends HTMLAttributes<HTMLDivElement> {
  /** Defaults to a desktop screen. */
  target?: ViewTarget;
  overPicture?: boolean;
  /** The chip holds a control row: 3 apx padding, 14 at the end (so Play sits flush). */
  controlRow?: boolean;
  children?: ReactNode;
}

/** The chip's CSS on a target; null in Quick Look, where no chip is possible. */
export function chipSurfaceStyle(target: ViewTarget, { overPicture = false, controlRow = false }: { overPicture?: boolean; controlRow?: boolean } = {}): CSSProperties | null {
  const look = chipStyle(target, { overPicture });
  if (!look) return null;
  const padding = controlRow
    ? (() => {
        const row = controlRowPaddingApx(target);
        return { paddingTop: row.top, paddingBottom: row.bottom, paddingInlineStart: row.start, paddingInlineEnd: row.end };
      })()
    : { paddingBlock: look.paddingBlockApx, paddingInline: look.paddingInlineApx };
  return {
    boxSizing: "border-box",
    // The colour carries the opacity, so the text on the chip stays at full strength.
    background: rgbWithAlpha(look.color, look.opacity),
    borderRadius: look.radiusApx,
    border: "none",
    ...padding
  };
}

export function Chip({ target = VIEW_TARGETS.desktop, overPicture = false, controlRow = false, style, children, ...props }: ChipProps) {
  const surface = chipSurfaceStyle(target, { overPicture, controlRow });
  if (!surface) return null;
  return (
    <div {...props} style={{ ...surface, ...style }}>
      {children}
    </div>
  );
}
