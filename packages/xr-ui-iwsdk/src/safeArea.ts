import { PHONE_EDGES } from "@holoim/xr-ui-core";

// A phone's safe-area insets (CSS px = apx on a phone) for the docks and the
// status line. In immersive AR without a DOM overlay the page is not shown and
// cannot read live insets, so the reading is taken from the page whenever it
// can be (at load, on resize and on rotation, so before the session starts)
// and the last non-zero reading stands in a session. With no reading at all
// the insets are zero and the token floors (`PHONE_EDGES`) rule.

export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const NONE: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
let last: SafeAreaInsets = NONE;
let tracking = false;

/** Reads `env(safe-area-inset-*)` from the page now; the last non-zero reading when the page reads zero. */
export function readSafeAreaInsets(): SafeAreaInsets {
  if (typeof document === "undefined" || !document.body) return last;
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;top:0;left:0;width:0;height:0;" +
    "padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)";
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const reading = {
    top: parseFloat(style.paddingTop) || 0,
    right: parseFloat(style.paddingRight) || 0,
    bottom: parseFloat(style.paddingBottom) || 0,
    left: parseFloat(style.paddingLeft) || 0
  };
  probe.remove();
  if (reading.top || reading.right || reading.bottom || reading.left) last = reading;
  return last;
}

/** Keeps the reading current while the page is shown; idempotent. Importing this package starts it. */
export function trackSafeArea(): void {
  if (tracking || typeof window === "undefined") return;
  tracking = true;
  const refresh = (): void => void readSafeAreaInsets();
  window.addEventListener("resize", refresh);
  window.addEventListener("orientationchange", refresh);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", refresh, { once: true });
  else refresh();
}

/** Where a phone target may not be: the larger of the system's inset and the token floor on each edge (§6.1 "Phone edges"). */
export function phoneClearance(insets: SafeAreaInsets = readSafeAreaInsets()): { side: { left: number; right: number }; top: number; bottom: number } {
  return {
    side: { left: Math.max(insets.left, PHONE_EDGES.side), right: Math.max(insets.right, PHONE_EDGES.side) },
    top: insets.top,
    bottom: Math.max(insets.bottom, PHONE_EDGES.bottom)
  };
}

trackSafeArea();
