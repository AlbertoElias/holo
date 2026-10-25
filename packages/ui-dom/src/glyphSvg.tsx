// The drawings of the glyph controls (styleguide 6) as inline SVG. Sizes,
// strokes and colours come from the core's `glyphDrawing`, `glyphMetrics` and
// `glyphAppearance`; this only maps them to elements.
import { GLYPH_VIEWBOX, drawnSizeApx, glyphMetrics, type GlyphAppearance, type GlyphDrawing } from "@holoim/xr-ui-core";

export interface GlyphSvgProps {
  drawing: GlyphDrawing;
  appearance: GlyphAppearance;
}

/** A drawing in its own box: the ring's 36 apx if it is ringed, else the 16 apx icon. */
export function GlyphSvg({ drawing, appearance }: GlyphSvgProps) {
  const metrics = glyphMetrics({ headset: false });
  const size = drawnSizeApx(drawing, { headset: false });
  const centre = size / 2;
  const ringRadius = (size - metrics.strokeApx) / 2;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      focusable="false"
      style={{ display: "block", overflow: "visible", flex: "none" }}
    >
      {drawing.ringed ? (
        <circle cx={centre} cy={centre} r={ringRadius} fill="none" stroke={appearance.color} strokeWidth={metrics.strokeApx} />
      ) : null}
      {drawing.kind === "path" ? <PathDrawing drawing={drawing} appearance={appearance} size={size} strokeApx={metrics.strokeApx} /> : null}
      {drawing.kind === "recordIdle" ? <circle data-record-shape="idle" cx={centre} cy={centre} r={drawing.diameterApx / 2} fill={appearance.recordColor} /> : null}
      {drawing.kind === "recordStop" ? (
        <rect
          data-record-shape="recording"
          x={centre - drawing.sizeApx / 2}
          y={centre - drawing.sizeApx / 2}
          width={drawing.sizeApx}
          height={drawing.sizeApx}
          rx={drawing.cornerRadiusApx}
          fill={appearance.recordColor}
        />
      ) : null}
    </svg>
  );
}

function PathDrawing({ drawing, appearance, size, strokeApx }: { drawing: Extract<GlyphDrawing, { kind: "path" }>; appearance: GlyphAppearance; size: number; strokeApx: number }) {
  // The 16 × 16 drawing, scaled to its drawn size and centred (Play: 14 apx in the 36 apx ring).
  const scale = drawing.drawnApx / GLYPH_VIEWBOX;
  const offset = (size - drawing.drawnApx) / 2;
  return (
    <g transform={`translate(${offset} ${offset}) scale(${scale})`}>
      {drawing.fill ? (
        <path d={drawing.d} fill={appearance.color} stroke="none" />
      ) : (
        <path
          d={drawing.d}
          fill="none"
          stroke={appearance.color}
          strokeWidth={strokeApx / scale}
          strokeLinecap="round"
          strokeLinejoin={drawing.linejoin}
        />
      )}
    </g>
  );
}

/** An empty gold ring of the slot size: the stand-in for an action with no decided drawing. */
export function RingSvg({ sizeApx, appearance }: { sizeApx: number; appearance: GlyphAppearance }) {
  const { strokeApx } = glyphMetrics({ headset: false });
  return (
    <svg width={sizeApx} height={sizeApx} viewBox={`0 0 ${sizeApx} ${sizeApx}`} aria-hidden="true" focusable="false" style={{ display: "block", overflow: "visible" }}>
      <circle cx={sizeApx / 2} cy={sizeApx / 2} r={(sizeApx - strokeApx) / 2} fill="none" stroke={appearance.color} strokeWidth={strokeApx} />
    </svg>
  );
}
