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
  vr: "Step inside",
  ar: "View in your room"
} as const;
