export type HandheldSessionOptions =
  /** Trust only what the session says about itself. */
  | { strict: true }
  /** Also take a session that reports no mode for a phone when `monoView` says it has a single view. */
  | { strict: false; monoView: boolean };

/**
 * Whether an XR session is a handheld screen (a phone) rather than a headset.
 *
 * `strict` trusts only what the session says about itself:
 * `XRSession.interactionMode === 'screen-space'`. A headset in passthrough
 * reports `world-space`, and a browser that does not report the mode at all
 * (`undefined`) is not taken for a phone: both stay spectators. Capture calls
 * it strict.
 *
 * Non-strict keeps `screen-space` as a phone and any other reported mode as
 * not one, and only when the mode is unreported falls back to the caller's
 * guess: the viewer passes whether the viewer pose has a single view, which a
 * phone has and a headset does not.
 */
export function isHandheldSession(session: XRSession | null | undefined, options: HandheldSessionOptions): boolean {
  if (!session) return false;
  const mode = (session as XRSession & { interactionMode?: string }).interactionMode;
  if (mode === "screen-space") return true;
  if (options.strict || mode !== undefined) return false;
  return options.monoView;
}
