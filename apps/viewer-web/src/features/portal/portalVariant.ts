// Which gestures drive the portal. PRD-002 compares these before one becomes
// the default; each trigger is a separate switch so variants stay cheap to add.

export type PortalVariantName = "freeze" | "drag" | "tilt";

export type PortalTriggers = {
  /** A short tap or click on the card toggles pause. */
  tapToPause: boolean;
  /** One-pointer drags orbit while the hologram plays. */
  dragWhilePlaying: boolean;
  /** One-pointer drags orbit while paused. */
  dragWhilePaused: boolean;
  /** Two-finger pinch zooms while playing. */
  pinchWhilePlaying: boolean;
  /** Two-finger pinch zooms while paused. */
  pinchWhilePaused: boolean;
  /**
   * A plain mouse wheel over the hologram zooms while paused; anywhere else the
   * feed scrolls. ctrl+wheel (trackpad pinch) follows the pinch switches.
   */
  wheelZoomWhilePaused: boolean;
  /**
   * A plain wheel over the hologram zooms at any time. Fully zoomed out, wheeling
   * further out passes through, so the feed still scrolls to the next card.
   */
  wheelZoomOverBubble: boolean;
  /** Device orientation can turn the camera once the viewer enables it. */
  tilt: boolean;
  /** Touch scrolling of the feed stays available while paused. */
  scrollWhilePaused: boolean;
};

export const PORTAL_VARIANTS: Record<PortalVariantName, PortalTriggers> = {
  freeze: {
    tapToPause: true,
    dragWhilePlaying: false,
    dragWhilePaused: true,
    pinchWhilePlaying: false,
    pinchWhilePaused: true,
    wheelZoomWhilePaused: true,
    wheelZoomOverBubble: false,
    tilt: false,
    scrollWhilePaused: false
  },
  drag: {
    tapToPause: true,
    dragWhilePlaying: true,
    dragWhilePaused: true,
    pinchWhilePlaying: true,
    pinchWhilePaused: true,
    wheelZoomWhilePaused: true,
    wheelZoomOverBubble: true,
    tilt: false,
    scrollWhilePaused: true
  },
  tilt: {
    tapToPause: true,
    dragWhilePlaying: true,
    dragWhilePaused: true,
    pinchWhilePlaying: true,
    pinchWhilePaused: true,
    wheelZoomWhilePaused: true,
    wheelZoomOverBubble: true,
    tilt: true,
    scrollWhilePaused: true
  }
};

// Looking around while the hologram plays is the default (decided 2026-10-20);
// `?portal=freeze` keeps exploring to paused moments for comparison.
export const DEFAULT_PORTAL_VARIANT: PortalVariantName = "drag";

function isVariantName(value: string | null): value is PortalVariantName {
  return value === "freeze" || value === "drag" || value === "tilt";
}

/** `?portal=drag` picks a variant for a trial session; anything else keeps the default. */
export function readPortalVariant(search = typeof window === "undefined" ? "" : window.location.search): PortalVariantName {
  const requested = new URLSearchParams(search).get("portal");
  return isVariantName(requested) ? requested : DEFAULT_PORTAL_VARIANT;
}
