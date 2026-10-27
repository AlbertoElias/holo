// The Halo (brief Q20, Q21; design-language concept 4): one radial menu with
// eight directions that never change, on every device. A novice holds and
// the ring draws after the hold delay; an expert flicks and it never draws.
import { tokens } from "@holoim/design-tokens";

import type { DrawnGlyph } from "./glyph.js";

export const HALO_DIRECTIONS = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;
export type HaloDirection = (typeof HALO_DIRECTIONS)[number];

/** Each direction's action, fixed everywhere. Most do not exist yet; their places stay reserved. */
export const HALO_ACTIONS = {
  n: "note",
  ne: "symbols",
  e: "redo",
  se: "markMoment",
  s: "record",
  sw: "retake",
  w: "undo",
  nw: "ink"
} as const satisfies Record<HaloDirection, string>;
export type HaloAction = (typeof HALO_ACTIONS)[HaloDirection];

/** Capture's first Halo (Q20): S record/stop, W undo the last held mark, E redo it. */
export const CAPTURE_HALO_ACTIONS: readonly HaloAction[] = ["record", "undo", "redo"];

/** Capture's Halo on a flat screen: the dock already carries Record, so S stays empty there. */
export const FLAT_CAPTURE_HALO_ACTIONS: readonly HaloAction[] = ["undo", "redo"];

/** The line glyph drawn in an action's ring; null where the ring is drawn empty (Record draws its own shape). */
export function haloSlotGlyph(action: HaloAction): DrawnGlyph | null {
  return action === "undo" || action === "redo" ? action : null;
}

export interface HaloSlot {
  direction: HaloDirection;
  /** Angle from east, counter-clockwise, radians. */
  angle: number;
  /** Centre in apx from the Halo's centre, y up. */
  x: number;
  y: number;
  /** Null for an empty direction: nothing is drawn there, and its place stays. */
  action: HaloAction | null;
}

export interface HaloLayout {
  slots: HaloSlot[];
  /** Distance from the centre to each slot's centre. */
  radiusApx: number;
  /** Movement within this distance is no direction yet. */
  deadZoneApx: number;
  /** Each slot's drawn ring. */
  slotApx: number;
}

/**
 * The Halo's layout, from the glyph tokens only: each slot is a glyph ring,
 * neighbours sit one glyph gap apart, and leaving the centre's own ring
 * picks a direction. Headset sizes are 2.5×.
 */
export function haloLayout(available: readonly HaloAction[], { headset }: { headset: boolean }): HaloLayout {
  const scale = headset ? tokens.size.headsetScale : 1;
  const slotApx = tokens.glyph.ring * scale;
  const radiusApx = (slotApx + tokens.glyph.gap * scale) / (2 * Math.sin(Math.PI / HALO_DIRECTIONS.length));
  const slots = HALO_DIRECTIONS.map((direction, index): HaloSlot => {
    const angle = Math.PI / 2 - (index * 2 * Math.PI) / HALO_DIRECTIONS.length;
    const action = HALO_ACTIONS[direction];
    return {
      direction,
      angle,
      x: Math.cos(angle) * radiusApx,
      y: Math.sin(angle) * radiusApx,
      action: available.includes(action) ? action : null
    };
  });
  return { slots, radiusApx, deadZoneApx: slotApx / 2, slotApx };
}

/** The direction of a movement (apx, y up), snapped to the nearest of the eight; null inside the dead zone. */
export function haloDirectionOf(dx: number, dy: number, deadZoneApx: number): HaloDirection | null {
  if (Math.hypot(dx, dy) <= deadZoneApx) return null;
  const fromNorthClockwise = Math.atan2(dx, dy);
  const sector = Math.round(fromNorthClockwise / (Math.PI / 4));
  return HALO_DIRECTIONS[((sector % 8) + 8) % 8]!;
}

export type HaloState =
  | { phase: "closed" }
  | { phase: "held"; atMs: number; ringDrawn: boolean; dx: number; dy: number };

export const HALO_CLOSED: HaloState = { phase: "closed" };

export type HaloEvent =
  | { type: "press"; atMs: number }
  | { type: "move"; atMs: number; dx: number; dy: number }
  | { type: "tick"; atMs: number }
  | { type: "release"; atMs: number }
  | { type: "cancel" };

export interface HaloCommit {
  direction: HaloDirection;
  /** Null when the direction is empty: nothing happens. */
  action: HaloAction | null;
  /** Committed before the ring drew. */
  flick: boolean;
}

export interface HaloStep {
  state: HaloState;
  /** The ring is drawn; never during a flick. */
  ringDrawn: boolean;
  /** The direction the movement points at now. */
  highlighted: HaloDirection | null;
  commit: HaloCommit | null;
}

/**
 * One event of the Halo. A hold draws the ring after `motion.hold.delay`; a
 * release outside the dead zone commits its direction, flicked or not; a
 * release inside it, or a cancel (blur, tracking loss), commits nothing.
 */
export function stepHalo(state: HaloState, event: HaloEvent, layout: HaloLayout): HaloStep {
  const closed = (commit: HaloCommit | null = null): HaloStep => ({ state: HALO_CLOSED, ringDrawn: false, highlighted: null, commit });
  if (event.type === "cancel") return closed();
  if (event.type === "press") {
    return { state: { phase: "held", atMs: event.atMs, ringDrawn: false, dx: 0, dy: 0 }, ringDrawn: false, highlighted: null, commit: null };
  }
  if (state.phase === "closed") return closed();
  const ringDrawn = state.ringDrawn || event.atMs - state.atMs >= tokens.motion.hold.delay;
  const dx = event.type === "move" ? event.dx : state.dx;
  const dy = event.type === "move" ? event.dy : state.dy;
  const highlighted = haloDirectionOf(dx, dy, layout.deadZoneApx);
  if (event.type === "release") {
    if (!highlighted) return closed();
    const slot = layout.slots.find((candidate) => candidate.direction === highlighted)!;
    return closed({ direction: highlighted, action: slot.action, flick: !ringDrawn });
  }
  return { state: { ...state, ringDrawn, dx, dy }, ringDrawn, highlighted, commit: null };
}
