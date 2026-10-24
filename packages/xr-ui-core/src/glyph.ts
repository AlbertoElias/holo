// Glyph controls (styleguide 6): thin gold line drawings in a 16 × 16 box,
// a gold ring around Play and Record, the hover, focus and pressed states,
// and the always-there set dimming when idle (1.2).
import { tokens } from "@holoim/design-tokens";

const { glyph } = tokens;

/** Glyphs with a decided drawing. Pause, true size, exit, undo, redo and settings have none yet. */
export type DrawnGlyph = keyof typeof glyph.path;
export type GlyphId = DrawnGlyph | "record";

export const GLYPH_VIEWBOX = 16;

export type GlyphDrawing =
  | { kind: "path"; d: string; fill: boolean; linejoin: "round" | "miter"; ringed: boolean; drawnApx: number }
  | { kind: "recordIdle"; diameterApx: number; ringed: true }
  | { kind: "recordStop"; sizeApx: number; cornerRadiusApx: number; ringed: true };

/**
 * A glyph's drawing at flat size. Play's triangle is drawn at 14 apx inside
 * the 36 apx ring; the other line glyphs at the 16 apx icon size. Record is
 * a 14 apx rose circle when idle and a 13 apx rose rounded square (radius
 * 3 apx) while recording.
 */
export function glyphDrawing(id: GlyphId, { recording = false }: { recording?: boolean } = {}): GlyphDrawing {
  if (id === "record") {
    return recording
      ? { kind: "recordStop", sizeApx: glyph.recordStop, cornerRadiusApx: glyph.recordStopRadius, ringed: true }
      : { kind: "recordIdle", diameterApx: glyph.recordIdle, ringed: true };
  }
  const path = glyph.path[id];
  const ringed = id === "play";
  return { kind: "path", ...path, ringed, drawnApx: ringed ? glyph.playTriangle : glyph.icon };
}

export interface GlyphMetrics {
  strokeApx: number;
  iconApx: number;
  ringApx: number;
  gapApx: number;
  focusRingWidthApx: number;
  focusRingOffsetApx: number;
}

/** Flat sizes, or the headset's 2.5× (6, 7.3). Hit areas are separate and never scaled. */
export function glyphMetrics({ headset }: { headset: boolean }): GlyphMetrics {
  const scale = headset ? tokens.size.headsetScale : 1;
  return {
    strokeApx: glyph.stroke * scale,
    iconApx: glyph.icon * scale,
    ringApx: glyph.ring * scale,
    gapApx: glyph.gap * scale,
    focusRingWidthApx: glyph.states.focusRingWidth * scale,
    focusRingOffsetApx: glyph.states.focusRingOffset * scale
  };
}

/** A drawing's size scaled for the target. */
export function drawnSizeApx(drawing: GlyphDrawing, { headset }: { headset: boolean }): number {
  const scale = headset ? tokens.size.headsetScale : 1;
  return (drawing.ringed ? glyph.ring : glyph.icon) * scale;
}

export interface GlyphInteraction {
  hovered?: boolean;
  /** Keyboard focus (`:focus-visible`), not pointer focus. */
  focusVisible?: boolean;
  pressed?: boolean;
  /** From `isIdleDimmed`. */
  dimmed?: boolean;
}

export interface GlyphAppearance {
  /** Line, ring and Play's fill. */
  color: string;
  /** Record's rose shape; never changes with state. */
  recordColor: string;
  opacity: number;
  focusRing: { width: number; offset: number; color: string } | null;
  glow: false;
}

/**
 * States (6): hover brightens the glyph, ring included, from gold to the
 * cream highlight; keyboard focus adds a 1.5 apx gold ring 3 apx outside;
 * pressing dims to 55%; never a glow. The idle dim takes the always-there
 * set to 40%.
 */
export function glyphAppearance({ hovered = false, focusVisible = false, pressed = false, dimmed = false }: GlyphInteraction, { headset }: { headset: boolean }): GlyphAppearance {
  const metrics = glyphMetrics({ headset });
  return {
    color: hovered ? glyph.states.hoverColor : glyph.color,
    recordColor: tokens.color.record,
    opacity: (pressed ? glyph.states.pressedOpacity : 1) * (dimmed ? glyph.idleOpacity : 1),
    focusRing: focusVisible ? { width: metrics.focusRingWidthApx, offset: metrics.focusRingOffsetApx, color: glyph.states.focusRingColor } : null,
    glow: false
  };
}

/** Play, Free and Return stay visible (1.2); every other control comes from the hand or cursor. */
export const ALWAYS_THERE: readonly GlyphId[] = ["play", "free", "return"];

export interface IdleInput {
  /** Time since anyone used the always-there set. */
  msSinceUse: number;
  /** A hand, cursor or gaze is in the row that holds the set (its shade or chip). */
  approached: boolean;
}

/** The always-there set dims to 40% after 4 s unused, and comes back as soon as a hand, cursor or gaze nears. */
export function isIdleDimmed(id: GlyphId, { msSinceUse, approached }: IdleInput): boolean {
  return ALWAYS_THERE.includes(id) && !approached && msSinceUse >= glyph.idleAfter;
}
