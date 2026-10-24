import { ReferenceSpaceType, SessionMode, type World } from '@iwsdk/core';
import type { XrEntryOffer } from '../types/contracts';

export type XrSessionMode = 'none' | 'vr' | 'ar';

export interface XrEntry {
  readonly sessionMode: XrSessionMode;
  /** What the dock's VR and AR entries offer; `onChange` fires when either changes. */
  readonly offers: { vr: XrEntryOffer; ar: XrEntryOffer };
  onChange(listener: () => void): () => void;
  /** Enters that mode, or leaves the session if one is running. */
  toggle(mode: Exclude<XrSessionMode, 'none'>): void;
}

// A session the browser grants on navigation (from another immersive page) is
// entered as soon as VR is known to be supported, as three's VRButton does.
// Registered at module load so a grant delivered before World exists is kept.
let vrSessionGranted = false;
if (typeof navigator !== 'undefined' && navigator.xr && !/WebXRViewer\//i.test(navigator.userAgent)) {
  navigator.xr.addEventListener('sessiongranted', () => {
    vrSessionGranted = true;
  });
}

/**
 * The VR and AR entries over World's XR lifecycle. The dock draws them
 * (`#VRButton`, `#ARButton`, docs/features/ui-redesign.md slice 4); this
 * module only knows what each offers. Both keep `local-floor` mandatory: AR
 * is spectated at true scale on the real floor, and VR height fitting reads
 * floor-relative head height.
 */
export function mountXrEntry(world: World): XrEntry {
  let sessionMode: XrSessionMode = 'none';
  // The mode a button asked for. World's own offer flow also starts sessions
  // (always VR), so a request only counts while World reports it pending.
  let requestedMode: Exclude<XrSessionMode, 'none'> | null = null;
  const supported = { vr: 'unknown' as XrEntryOffer, ar: 'unknown' as XrEntryOffer };
  const listeners = new Set<() => void>();
  let offers = { vr: supported.vr, ar: supported.ar };
  const publish = (): void => {
    const next = {
      vr: sessionMode === 'vr' ? 'active' : supported.vr,
      ar: sessionMode === 'ar' ? 'active' : supported.ar
    } satisfies XrEntry['offers'];
    if (next.vr === offers.vr && next.ar === offers.ar) return;
    offers = next;
    for (const listener of listeners) listener();
  };

  const launch = (mode: Exclude<XrSessionMode, 'none'>): void => {
    // A second press while a request is pending would relabel that request.
    if (world.sessionRequestPending) return;
    requestedMode = mode;
    world.launchXR({
      sessionMode: mode === 'ar' ? SessionMode.ImmersiveAR : SessionMode.ImmersiveVR,
      referenceSpace: { type: ReferenceSpaceType.LocalFloor, required: true },
      features: { handTracking: true, gazeTracking: true }
    });
  };

  const xr = world.renderer.xr;
  xr.addEventListener('sessionstart', () => {
    // The session says what it is: opaque is VR, a passthrough blend is AR. A
    // remembered request can be stale (it was refused, or World started this
    // session itself), so it only decides when the blend mode is missing.
    const blend = xr.getSession()?.environmentBlendMode;
    sessionMode = blend ? (blend === 'opaque' ? 'vr' : 'ar') : requestedMode ?? 'vr';
    requestedMode = null;
    publish();
  });
  xr.addEventListener('sessionend', () => {
    sessionMode = 'none';
    publish();
  });

  if (navigator.xr) {
    void navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
      supported.vr = ok ? 'available' : 'unsupported';
      publish();
      if (ok && vrSessionGranted) launch('vr');
    }).catch((error: unknown) => {
      console.warn('Exception when trying to call xr.isSessionSupported', error);
      supported.vr = 'unsupported';
      publish();
    });
    void navigator.xr.isSessionSupported('immersive-ar').then((ok) => {
      supported.ar = ok ? 'available' : 'unsupported';
      publish();
    }).catch(() => {
      supported.ar = 'unsupported';
      publish();
    });
  } else {
    supported.vr = 'unsupported';
    supported.ar = 'unsupported';
    publish();
  }

  return {
    get sessionMode() {
      return sessionMode;
    },
    get offers() {
      return offers;
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    toggle: (mode) => {
      if (world.session) world.exitXR();
      else launch(mode);
    }
  };
}
