// Where a part is shown. Values that differ per target (styleguide "How to
// read this") are looked up from one of these.

/** How an AR target composites translucency (styleguide 2.3). */
export type ArCompositor = "questPassthrough" | "androidChrome" | "linear" | "unlisted";

export type ViewTarget =
  | { kind: "flat"; device: "phone" | "desktop" }
  | { kind: "vr" }
  | { kind: "ar"; compositor: ArCompositor; headset: boolean }
  | { kind: "quickLook" };

export const VIEW_TARGETS = {
  phone: { kind: "flat", device: "phone" },
  desktop: { kind: "flat", device: "desktop" },
  vr: { kind: "vr" },
  questPassthrough: { kind: "ar", compositor: "questPassthrough", headset: true },
  androidChrome: { kind: "ar", compositor: "androidChrome", headset: false },
  quickLook: { kind: "quickLook" }
} as const satisfies Record<string, ViewTarget>;

/** True where the styleguide's headset sizes (2.5×) and text rules apply. */
export function isHeadset(target: ViewTarget): boolean {
  return target.kind === "vr" || (target.kind === "ar" && target.headset);
}

/** True in a room (VR or WebXR AR), where parts are objects in space. */
export function isRoom(target: ViewTarget): boolean {
  return target.kind === "vr" || target.kind === "ar";
}

/**
 * The AR compositor for a browser. Anything not listed is "unlisted", which
 * takes the linear-light chip (brief Q18).
 */
export function arCompositorFromUserAgent(userAgent: string): ArCompositor {
  if (/OculusBrowser/i.test(userAgent)) return "questPassthrough";
  if (/Android/i.test(userAgent) && /Chrome\//i.test(userAgent)) return "androidChrome";
  return "unlisted";
}
