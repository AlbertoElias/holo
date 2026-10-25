import type { HologramDTO } from "@holoim/contracts";

import { VIEWER_CONTROL_NAMES } from "../chrome/controlNames";


/** Whether this browser can start an immersive VR session ("Step inside"). */
export async function supportsImmersiveVr(): Promise<boolean> {
  const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
  if (typeof xr?.isSessionSupported !== "function") return false;
  try {
    return await xr.isSessionSupported("immersive-vr");
  } catch {
    return false;
  }
}

/** Entry labels on the feed card and the route's enter button (styleguide section 6). */
export const XR_ENTRY_LABEL = {
  vr: VIEWER_CONTROL_NAMES.stepInside,
  ar: VIEWER_CONTROL_NAMES.viewInAr
} as const;

/** Router state for `/vr/:id` and `/ar/:id`: the feed the card was opened from, for the gallery. */
export interface XrFeedState {
  feed?: { items: HologramDTO[]; nextCursor: string | null };
}
