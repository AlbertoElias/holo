// Held modes (concept 4: "modes are held, never toggled"): a mode lasts only
// while its button, key, touch or pinch is held, ends on release, on
// tracking loss and on blur, and consumes its own release so the release
// never also fires a select at whatever a ray points at.
import { tokens } from "@holoim/design-tokens";

import { nonDominantHand, type Hand, type Handedness } from "./placement.js";

/** Which button, key, touch or pinch holds the mode, e.g. "mouse:2", "touch:7", "left:thumbMiddle". */
export type HeldSource = string;

export type HeldModeState =
  | { phase: "idle"; swallow: HeldSource | null }
  /** Pressed, waiting out the hold delay (touch-and-hold). */
  | { phase: "pending"; source: HeldSource; atMs: number; delayMs: number; swallow: HeldSource | null }
  | { phase: "held"; source: HeldSource; sinceMs: number; swallow: HeldSource | null };

export const HELD_IDLE: HeldModeState = { phase: "idle", swallow: null };

export type HeldModeEvent =
  /** `delayMs` 0 starts at once (a button, key, trigger or pinch); a touch on a surface waits `motion.hold.delay`. */
  | { type: "press"; source: HeldSource; atMs: number; delayMs: number }
  | { type: "tick"; atMs: number }
  /** A touch that moves beyond its slop before the delay is a scroll or drag, not a hold. */
  | { type: "move"; source: HeldSource; distanceApx: number }
  | { type: "release"; source: HeldSource; atMs: number }
  | { type: "trackingLost"; source: HeldSource }
  | { type: "blur" };

export type HeldEnd = "release" | "trackingLost" | "blur";

export interface HeldModeStep {
  state: HeldModeState;
  started: boolean;
  ended: HeldEnd | null;
  /** The event's release belongs to the mode: do not also click, tap or select with it. */
  consumeRelease: boolean;
}

/** Slop before a touch-and-hold starts: half the touch hit area. */
export const TOUCH_HOLD_SLOP_APX = tokens.hit.touch / 2;

/** The hold delay for touch-and-hold, the same as the Halo ring's. */
export const HOLD_DELAY_MS = tokens.motion.hold.delay;

export function stepHeldMode(state: HeldModeState, event: HeldModeEvent): HeldModeStep {
  const step = (next: HeldModeState, started = false, ended: HeldEnd | null = null, consumeRelease = false): HeldModeStep => ({ state: next, started, ended, consumeRelease });
  switch (event.type) {
    case "press": {
      if (state.phase !== "idle") return step(state);
      const swallow = state.swallow === event.source ? null : state.swallow;
      return event.delayMs <= 0
        ? step({ phase: "held", source: event.source, sinceMs: event.atMs, swallow }, true)
        : step({ phase: "pending", source: event.source, atMs: event.atMs, delayMs: event.delayMs, swallow });
    }
    case "tick":
      if (state.phase === "pending" && event.atMs - state.atMs >= state.delayMs) {
        return step({ phase: "held", source: state.source, sinceMs: event.atMs, swallow: state.swallow }, true);
      }
      return step(state);
    case "move":
      if (state.phase === "pending" && state.source === event.source && event.distanceApx > TOUCH_HOLD_SLOP_APX) {
        return step({ phase: "idle", swallow: state.swallow });
      }
      return step(state);
    case "release":
      if (state.phase === "held" && state.source === event.source) return step({ phase: "idle", swallow: state.swallow }, false, "release", true);
      if (state.phase === "pending" && state.source === event.source) return step({ phase: "idle", swallow: state.swallow });
      // A release that arrives after its mode already ended on tracking loss or blur.
      if (state.swallow === event.source) return step({ ...state, swallow: null }, false, null, true);
      return step(state);
    case "trackingLost":
      if (state.phase !== "idle" && state.source === event.source) {
        return step({ phase: "idle", swallow: event.source }, false, state.phase === "held" ? "trackingLost" : null);
      }
      return step(state);
    case "blur":
      if (state.phase === "idle") return step(state);
      return step({ phase: "idle", swallow: state.source }, false, state.phase === "held" ? "blur" : null);
  }
}

export type HeldMarkTrigger =
  | { input: "mouse"; button: "right" }
  | { input: "touch"; on: "referent"; delayMs: number }
  | { input: "hands"; hand: Hand; pinch: "thumbMiddle" }
  | { input: "controllers"; hand: Hand; button: "trigger" };

/**
 * What holds the mark "this" (Q1, Q21): the right button on a desktop,
 * touch-and-hold on the referent on a phone, the non-dominant thumb–middle
 * pinch on hands (never the ordinary thumb–index pinch), the non-dominant
 * trigger on controllers.
 */
export function heldMarkTrigger(input: HeldMarkTrigger["input"], handedness: Handedness): HeldMarkTrigger {
  const hand = nonDominantHand(handedness);
  switch (input) {
    case "mouse": return { input, button: "right" };
    case "touch": return { input, on: "referent", delayMs: HOLD_DELAY_MS };
    case "hands": return { input, hand, pinch: "thumbMiddle" };
    case "controllers": return { input, hand, button: "trigger" };
  }
}
