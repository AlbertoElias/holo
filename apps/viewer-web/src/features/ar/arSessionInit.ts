// The session the AR route asks for: what @react-three/xr builds from the
// store's options, plus light estimation for the edge's soot (styleguide 3.2),
// which the store has no option for. Keep it in step with those options.
export function arSessionInit(domOverlayRoot: Element, depthSensing: boolean): XRSessionInit {
  const init: XRSessionInit = {
    requiredFeatures: ["local-floor"],
    optionalFeatures: ["anchors", "plane-detection", ...(depthSensing ? ["depth-sensing"] : []), "dom-overlay", "hit-test", "light-estimation"],
    domOverlay: { root: domOverlayRoot }
  };
  if (depthSensing) Object.assign(init, { depthSensing: { usagePreference: ["gpu-optimized"], dataFormatPreference: [] } });
  return init;
}
