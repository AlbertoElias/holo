// The golden edge as SVG (styleguide 3): the core's seeded outline drawn as
// four strokes, soot, halo, core and highlight, in that order.
import { memo, useId, useMemo, type CSSProperties } from "react";

import { tokens } from "@holoim/design-tokens";
import { edgeOutline, edgePathData, edgeStrokes, type EdgeFrame } from "@holoim/xr-ui-core";

/** The edge at rest on a flat screen: the halo at its resting level, no soot, core and highlight full. */
export const RESTING_EDGE_FRAME: EdgeFrame = {
  drawn: true,
  glowLevel: tokens.edge.halo.level,
  sootOpacity: 0,
  coreOpacity: 1,
  highlightOpacity: 1,
  sparks: 0
};

export interface EdgeSvgProps {
  /** The hologram's id: the same seed draws the same tears everywhere. */
  seed: string;
  width: number;
  height: number;
  /** From the core's `edgeFrame(...)`; the resting edge if omitted. */
  frame?: EdgeFrame;
  style?: CSSProperties;
  className?: string;
}

function EdgeSvgImpl({ seed, width, height, frame = RESTING_EDGE_FRAME, style, className }: EdgeSvgProps) {
  const filterId = useId().replace(/:/g, "");
  const outline = useMemo(() => edgeOutline({ seed, width, height }), [seed, width, height]);
  const d = useMemo(() => edgePathData(outline.points), [outline]);
  if (!frame.drawn) return null;

  const strokes = edgeStrokes(outline.shortSide);
  const sootFilter = `${filterId}-soot`;
  const haloFilter = `${filterId}-halo`;
  const blurRegion = { filterUnits: "userSpaceOnUse" as const, x: 0, y: 0, width, height };

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{ display: "block", pointerEvents: "none", ...style }}
    >
      <defs>
        <filter id={sootFilter} {...blurRegion}>
          <feGaussianBlur stdDeviation={strokes.soot.blur} />
        </filter>
        <filter id={haloFilter} {...blurRegion}>
          <feGaussianBlur stdDeviation={strokes.halo.blur} />
        </filter>
      </defs>
      <g fill="none" strokeLinejoin="round" strokeLinecap="round">
        <path data-edge="soot" d={d} stroke={strokes.soot.color} strokeWidth={strokes.soot.width} opacity={frame.sootOpacity} filter={`url(#${sootFilter})`} />
        <path data-edge="halo" d={d} stroke={strokes.halo.color} strokeWidth={strokes.halo.width} opacity={frame.glowLevel} filter={`url(#${haloFilter})`} />
        <path data-edge="core" d={d} stroke={strokes.core.color} strokeWidth={strokes.core.width} opacity={frame.coreOpacity} />
        <path data-edge="highlight" d={d} stroke={strokes.highlight.color} strokeWidth={strokes.highlight.width} opacity={frame.highlightOpacity} />
      </g>
    </svg>
  );
}

export const EdgeSvg = memo(EdgeSvgImpl);
