// AR soot from the lighting estimate (styleguide 3.2): with no estimate (a
// Quest) it is null and the edge keeps its soot on; with one (Android) it
// turns on at Y ≥ 0.16 and off below 0.095, so a wavering estimate never flickers it.
import { ambientLuminance, nextArSootOn, type SootInput } from "@holoim/xr-ui-core";
import { useFrame } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";

// WebXR Lighting Estimation, which the DOM typings do not carry.
type LightProbe = EventTarget;
type LightEstimate = { sphericalHarmonicsCoefficients: Float32Array };
type LightProbeSession = XRSession & { requestLightProbe?: () => Promise<LightProbe> };
type LightEstimateFrame = XRFrame & { getLightEstimate?: (probe: LightProbe) => LightEstimate | null };

export function useArSoot(session: XRSession | null): SootInput {
  const probeRef = useRef<LightProbe | null>(null);
  const sootOnRef = useRef<boolean | null>(null);
  const [sootOn, setSootOn] = useState<boolean | null>(null);

  useEffect(() => {
    probeRef.current = null;
    sootOnRef.current = null;
    setSootOn(null);
    const requestProbe = (session as LightProbeSession | null)?.requestLightProbe;
    if (!session || !requestProbe || !session.enabledFeatures?.includes("light-estimation")) return;
    let live = true;
    requestProbe
      .call(session)
      .then((probe) => {
        if (live) probeRef.current = probe;
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [session]);

  useFrame((_state, _delta, frame?: XRFrame) => {
    const probe = probeRef.current;
    const estimate = probe && (frame as LightEstimateFrame | undefined)?.getLightEstimate?.(probe);
    if (!estimate) return;
    const next = nextArSootOn(sootOnRef.current ?? true, ambientLuminance(estimate.sphericalHarmonicsCoefficients));
    if (next === sootOnRef.current) return;
    sootOnRef.current = next;
    setSootOn(next);
  });

  return { arSootOn: sootOn };
}
