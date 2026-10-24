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

/**
 * Placeholder for the VR trigger: the styleguide's "Step inside" glyph is
 * still to be drawn, so the card shows this label alone until it is.
 */
export const VR_TRIGGER_PLACEHOLDER_LABEL = "Step inside";

/** Entry labels on the feed card and the route's enter button (styleguide section 6). */
export const XR_ENTRY_LABEL = {
  vr: VR_TRIGGER_PLACEHOLDER_LABEL,
  ar: "View in your room"
} as const;
