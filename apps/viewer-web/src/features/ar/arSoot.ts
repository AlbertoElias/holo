// AR soot from the lighting estimate (styleguide 3.2): with no estimate (a
// Quest) it is null and the edge keeps its soot on; with one (Android) it
// turns on at Y ≥ 0.16 and off below 0.095, so a wavering estimate never
// flickers it. Plain WebXR: shared by `useArSoot` and the IWSDK shells.
import { ambientLuminance, nextArSootOn } from "@holoim/xr-ui-core";

// WebXR Lighting Estimation, which the DOM typings do not carry.
type LightProbe = EventTarget;
type LightEstimate = { sphericalHarmonicsCoefficients: Float32Array };
type LightProbeSession = XRSession & { requestLightProbe?: () => Promise<LightProbe> };
type LightEstimateFrame = XRFrame & { getLightEstimate?: (probe: LightProbe) => LightEstimate | null };

export class ArSoot {
  /** Null until an estimate says otherwise (and always on a Quest). */
  sootOn: boolean | null = null;
  private session: XRSession | null = null;
  private probe: LightProbe | null = null;

  /** Follows the session; a new one starts with no estimate. */
  attach(session: XRSession | null): void {
    if (session === this.session) return;
    this.session = session;
    this.probe = null;
    this.sootOn = null;
    const requestProbe = (session as LightProbeSession | null)?.requestLightProbe;
    if (!session || !requestProbe || !session.enabledFeatures?.includes("light-estimation")) return;
    requestProbe
      .call(session)
      .then((probe) => {
        if (this.session === session) this.probe = probe;
      })
      .catch(() => undefined);
  }

  /** Reads the frame's estimate; true when `sootOn` changed. */
  update(frame: XRFrame | undefined): boolean {
    const probe = this.probe;
    const estimate = probe && (frame as LightEstimateFrame | undefined)?.getLightEstimate?.(probe);
    if (!estimate) return false;
    const next = nextArSootOn(this.sootOn ?? true, ambientLuminance(estimate.sphericalHarmonicsCoefficients));
    if (next === this.sootOn) return false;
    this.sootOn = next;
    return true;
  }
}
