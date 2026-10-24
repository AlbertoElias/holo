// Motion (styleguide 8): the halo's flicker per target, the stage light,
// sparks on the hologram in focus only, reduced motion and chrome unfolding.
// Every curve is written here once; renderers sample it per frame.
import { tokens } from "@holoim/design-tokens";

import { isRoom, type ViewTarget } from "./targets.js";

const { flicker, reducedMotion, sparks, chrome } = tokens.motion;

/** CSS `cubic-bezier(x1, y1, x2, y2)` as a function of progress in [0, 1]. */
export function cubicBezier([x1, y1, x2, y2]: readonly [number, number, number, number]): (x: number) => number {
  const at = (a: number, b: number, t: number) => 3 * a * (1 - t) ** 2 * t + 3 * b * (1 - t) * t ** 2 + t ** 3;
  const slope = (a: number, b: number, t: number) => 3 * a * (1 - t) ** 2 + 6 * (b - a) * (1 - t) * t + 3 * (1 - b) * t ** 2;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const d = slope(x1, x2, t);
      if (Math.abs(d) < 1e-6) break;
      t = Math.min(1, Math.max(0, t - (at(x1, x2, t) - x) / d));
    }
    return at(y1, y2, t);
  };
}

const easeInOut = cubicBezier(flicker.easing);
const keyframes = Object.values(flicker.flatHalo);
const flatLevels = keyframes.map((keyframe) => keyframe.level);
const flatMin = Math.min(...flatLevels);
const flatMax = Math.max(...flatLevels);

function loop(timeMs: number, periodMs: number): number {
  return (((timeMs % periodMs) + periodMs) % periodMs) / periodMs;
}

/** Flat halo level: the round 1 keyframes over a 2.6 s loop, eased per segment (8.1). */
export function flatHaloLevel(timeMs: number): number {
  const at = loop(timeMs, flicker.period);
  for (let i = 1; i < keyframes.length; i += 1) {
    const from = keyframes[i - 1]!;
    const to = keyframes[i]!;
    if (at <= to.at) {
      const progress = easeInOut((at - from.at) / (to.at - from.at));
      return from.level + (to.level - from.level) * progress;
    }
  }
  return keyframes.at(-1)!.level;
}

/** VR and AR halo: the same rhythm at a gentle swing, 0.45 to 0.50 (8.1). */
export function roomHaloLevel(timeMs: number): number {
  return flicker.xrHaloRest + ((flatHaloLevel(timeMs) - flatMin) * flicker.xrHaloSwing) / (flatMax - flatMin);
}

/** Reduced motion on every target: 0.50 to 0.489 and back over 8 s, eased (8.3). */
export function reducedHaloLevel(timeMs: number): number {
  const at = loop(timeMs, reducedMotion.period);
  const half = at < 0.5 ? at * 2 : 2 - at * 2;
  return reducedMotion.haloFrom + (reducedMotion.haloTo - reducedMotion.haloFrom) * cubicBezier(reducedMotion.easing)(half);
}

export interface MotionOptions {
  reducedMotion: boolean;
}

/** The halo level for a target at a time; null where nothing animates (Quick Look). */
export function haloLevel(target: ViewTarget, timeMs: number, { reducedMotion: reduced }: MotionOptions): number | null {
  if (target.kind === "quickLook") return null;
  if (reduced) return reducedHaloLevel(timeMs);
  return isRoom(target) ? roomHaloLevel(timeMs) : flatHaloLevel(timeMs);
}

/**
 * Stage light intensity (8.1): on flat screens the portal's own stage
 * flickers, `0.9 + 0.12 · sin 9t · sin 3.7t`; in a room it is steady at 0.9,
 * since it falls on real surfaces. Steady under reduced motion; none in
 * Quick Look.
 */
export function stageLight(target: ViewTarget, timeMs: number, { reducedMotion: reduced }: MotionOptions): number | null {
  if (target.kind === "quickLook") return null;
  if (reduced || isRoom(target)) return flicker.stageLightRest;
  const t = timeMs / 1000;
  return flicker.stageLightRest + flicker.stageLightSwing * Math.sin(flicker.stageLightRateA * t) * Math.sin(flicker.stageLightRateB * t);
}

// --- Sparks on focus only (8.2) ---

export interface FlatCandidate {
  id: string;
  centerX: number;
  centerY: number;
}

/** The card nearest the middle of the screen or window. */
export function nearestToMiddle(cards: readonly FlatCandidate[], viewport: { width: number; height: number }): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const card of cards) {
    const distance = Math.hypot(card.centerX - viewport.width / 2, card.centerY - viewport.height / 2);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = card.id;
    }
  }
  return best;
}

export interface RoomCandidate {
  id: string;
  /** Angle between the head's forward ray and the direction to the hologram. */
  angleDegrees: number;
}

/** The hologram nearest the head's forward ray, or none if all are in peripheral vision. */
export function nearestToForwardRay(holograms: readonly RoomCandidate[]): string | null {
  let best: RoomCandidate | null = null;
  for (const hologram of holograms) {
    if (hologram.angleDegrees <= sparks.peripheralDegrees && (!best || hologram.angleDegrees < best.angleDegrees)) best = hologram;
  }
  return best?.id ?? null;
}

/** Degrees between two directions. */
export function angleBetweenDegrees(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const length = Math.hypot(...a) * Math.hypot(...b);
  if (length === 0) return 180;
  return (Math.acos(Math.min(1, Math.max(-1, dot / length))) * 180) / Math.PI;
}

export interface SparkOptions extends MotionOptions {
  inFocus: boolean;
  recording: boolean;
}

/**
 * How many sparks a hologram sheds: 26 on the card in focus on a flat screen,
 * up to 70 on the hologram in focus in a room; none out of focus, under
 * reduced motion, while recording, or in Quick Look.
 */
export function sparkCount(target: ViewTarget, { inFocus, reducedMotion: reduced, recording }: SparkOptions): number {
  if (!inFocus || reduced || recording || target.kind === "quickLook") return 0;
  return isRoom(target) ? sparks.countRoomMax : sparks.countFlat;
}

/** Whether a phone card redraws: only the card in focus does (8.2). */
export function cardRedraws(target: ViewTarget, inFocus: boolean): boolean {
  return !(target.kind === "flat" && target.device === "phone") || inFocus;
}

export interface Spark {
  /** Position along the edge loop, 0 to 1. */
  along: number;
  /** Size as a share of the short side. */
  size: number;
  lifeMs: number;
}

/** One spark: a gold ember 0.4% to 0.8% of the short side, living 2 to 4 s. */
export function createSpark(random: () => number): Spark {
  return {
    along: random(),
    size: sparks.sizeMin + (sparks.sizeMax - sparks.sizeMin) * random(),
    lifeMs: sparks.lifeMin + (sparks.lifeMax - sparks.lifeMin) * random()
  };
}

// --- Chrome (8.4) ---

export interface ChromeTransition {
  durationMs: number;
  easing: readonly [number, number, number, number];
  /** Unfold from the source; under reduced motion, crossfade in place. */
  style: "unfold" | "crossfade";
}

/** Chrome unfolds in 240 ms and leaves in 400 ms, ease-out, back to its source. */
export function chromeTransition(direction: "in" | "out", { reducedMotion: reduced }: MotionOptions): ChromeTransition {
  return {
    durationMs: direction === "in" ? chrome.in : chrome.out,
    easing: chrome.easing,
    style: reduced ? "crossfade" : "unfold"
  };
}
