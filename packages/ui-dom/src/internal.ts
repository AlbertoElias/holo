// Small browser helpers shared by the redesigned components. No design value
// lives here: every size, colour and timing comes from the tokens or the core.
import { useEffect, useState } from "react";

import type { HitInput } from "@holoim/xr-ui-core";

function matches(query: string): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/**
 * The input a DOM page sizes for (6.1): touch wherever a finger can reach the
 * screen, including a laptop with a touch screen whose primary pointer is a
 * mouse, since a larger hit area never hurts the mouse; else mouse.
 */
export function defaultHitInput(): HitInput {
  return matches("(any-pointer: coarse)") || matches("(pointer: coarse)") ? "touch" : "mouse";
}

/** `prefers-reduced-motion: reduce`, live; false where matchMedia is missing. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => matches("(prefers-reduced-motion: reduce)"));
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

/** `#rrggbb` as the channels of a CSS `rgb()` triplet: "8 26 30". */
export function hexToRgbTriplet(hex: string): string {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((start) => parseInt(value.slice(start, start + 2), 16)).join(" ");
}

/** A hex colour at an alpha, as space-separated CSS `rgb(r g b / a)`. */
export function rgbWithAlpha(hex: string, alpha: number): string {
  return `rgb(${hexToRgbTriplet(hex)} / ${alpha})`;
}

/** A percentage without floating-point noise (120, not 120.00000000000001). */
export function percent(fraction: number): string {
  return `${Number((fraction * 100).toFixed(4))}%`;
}
