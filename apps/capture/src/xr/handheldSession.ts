/**
 * Whether an XR session is a handheld screen (a phone) rather than a headset.
 *
 * Slice 0 of docs/features/ar-recording.md moves this into
 * `@holoim/xr-ui-iwsdk`, shared with the viewer; until then capture keeps its
 * own copy and calls it strict.
 *
 * `strict` trusts only what the session says about itself:
 * `XRSession.interactionMode === 'screen-space'`. A headset in passthrough
 * reports `world-space`, and a browser that does not report the mode at all
 * (`undefined`) is not taken for a phone: both stay spectators. Non-strict may
 * also accept a phone-like guess for callers that can afford one.
 */
export function isHandheldSession(session: XRSession | null | undefined, { strict }: { strict: boolean }): boolean {
  if (!session) return false;
  const mode = (session as XRSession & { interactionMode?: string }).interactionMode;
  if (mode === 'screen-space') return true;
  if (strict || mode !== undefined) return false;
  // Mode unreported: a blend-mode AR session with no tracked input sources
  // yet is most likely a phone.
  return session.environmentBlendMode === 'alpha-blend';
}
