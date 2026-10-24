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
 * Placeholder for the VR trigger: the styleguide has no glyph or label for
 * entering VR yet, so the card shows this text alone until it does.
 */
export const VR_TRIGGER_PLACEHOLDER_LABEL = "Step inside";

/** Entry labels on the feed card and the route's enter button; AR's is the styleguide's (section 6). */
export const XR_ENTRY_LABEL = {
  vr: VR_TRIGGER_PLACEHOLDER_LABEL,
  ar: "View in AR"
} as const;
