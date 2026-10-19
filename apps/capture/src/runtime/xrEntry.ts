import { ReferenceSpaceType, SessionMode, type World } from '@iwsdk/core';

export type XrSessionMode = 'none' | 'vr' | 'ar';

export interface XrEntry {
  readonly sessionMode: XrSessionMode;
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
 * ENTER VR / ENTER AR buttons (`#VRButton`, `#ARButton`) over World's XR
 * lifecycle. Both keep `local-floor` mandatory: AR is spectated at true scale
 * on the real floor, and VR height fitting reads floor-relative head height.
 */
export function mountXrEntry(world: World): XrEntry {
  let sessionMode: XrSessionMode = 'none';
  // The mode a button asked for. World's own offer flow also starts sessions
  // (always VR), so a request only counts while World reports it pending.
  let requestedMode: Exclude<XrSessionMode, 'none'> | null = null;

  const launch = (mode: Exclude<XrSessionMode, 'none'>): void => {
    requestedMode = mode;
    world.launchXR({
      sessionMode: mode === 'ar' ? SessionMode.ImmersiveAR : SessionMode.ImmersiveVR,
      referenceSpace: { type: ReferenceSpaceType.LocalFloor, required: true },
      features: { handTracking: true }
    });
  };
  const toggle = (mode: Exclude<XrSessionMode, 'none'>): void => {
    if (world.session) world.exitXR();
    else launch(mode);
  };

  const vrButton = createEntryButton('VRButton', 'VR', 'calc(50% - 50px)', 'calc(50% - 75px)', () => toggle('vr'));
  const arButton = createEntryButton('ARButton', 'AR', 'calc(50% + 60px)', 'calc(50% + 60px)', () => toggle('ar'));

  const xr = world.renderer.xr;
  const onSessionStart = (): void => {
    sessionMode = world.sessionRequestPending && requestedMode ? requestedMode : 'vr';
    requestedMode = null;
    (sessionMode === 'ar' ? arButton : vrButton).setActive(true);
  };
  const onSessionEnd = (): void => {
    sessionMode = 'none';
    vrButton.setActive(false);
    arButton.setActive(false);
  };
  xr.addEventListener('sessionstart', onSessionStart);
  xr.addEventListener('sessionend', onSessionEnd);

  if (navigator.xr) {
    void navigator.xr.isSessionSupported('immersive-vr').then((supported) => {
      vrButton.showSupported(supported);
      if (supported && vrSessionGranted) launch('vr');
    }).catch((error: unknown) => {
      console.warn('Exception when trying to call xr.isSessionSupported', error);
      vrButton.showNotAllowed();
    });
    void navigator.xr.isSessionSupported('immersive-ar').then((supported) => arButton.showSupported(supported));
    document.body.append(vrButton.element, arButton.element);
  } else {
    document.body.append(createWebXrUnavailableNotice());
  }

  return {
    get sessionMode() {
      return sessionMode;
    }
  };
}

interface EntryButton {
  element: HTMLButtonElement;
  showSupported(supported: boolean): void;
  showNotAllowed(): void;
  setActive(active: boolean): void;
}

// Matches three's VRButton look and states, which capture used before.
function createEntryButton(id: string, label: 'VR' | 'AR', enabledLeft: string, disabledLeft: string, onClick: () => void): EntryButton {
  const button = document.createElement('button');
  button.id = id;
  stylize(button);
  button.style.display = 'none';
  // Keep desktop keyboard control on the game surface after XR transitions.
  button.setAttribute('tabindex', '-1');

  const disable = (text: string): void => {
    button.style.display = '';
    button.style.cursor = 'auto';
    button.style.left = disabledLeft;
    button.style.width = '150px';
    button.onmouseenter = null;
    button.onmouseleave = null;
    button.onclick = null;
    button.textContent = text;
  };

  return {
    element: button,
    showSupported: (supported) => {
      if (!supported) {
        disable(`${label} NOT SUPPORTED`);
        return;
      }
      button.style.display = '';
      button.style.cursor = 'pointer';
      button.style.left = enabledLeft;
      button.style.width = '100px';
      button.textContent = `ENTER ${label}`;
      button.onmouseenter = () => {
        button.style.opacity = '1.0';
      };
      button.onmouseleave = () => {
        button.style.opacity = '0.5';
      };
      button.onclick = onClick;
    },
    showNotAllowed: () => disable(`${label} NOT ALLOWED`),
    setActive: (active) => {
      if (button.onclick) button.textContent = `${active ? 'EXIT' : 'ENTER'} ${label}`;
    }
  };
}

function createWebXrUnavailableNotice(): HTMLAnchorElement {
  const message = document.createElement('a');
  if (window.isSecureContext === false) {
    message.href = document.location.href.replace(/^http:/, 'https:');
    message.textContent = 'WEBXR NEEDS HTTPS';
  } else {
    message.href = 'https://immersiveweb.dev/';
    message.textContent = 'WEBXR NOT AVAILABLE';
  }
  message.style.left = 'calc(50% - 90px)';
  message.style.width = '180px';
  message.style.textDecoration = 'none';
  stylize(message);
  return message;
}

function stylize(element: HTMLElement): void {
  element.style.position = 'absolute';
  element.style.bottom = '20px';
  element.style.padding = '12px 6px';
  element.style.border = '1px solid #fff';
  element.style.borderRadius = '4px';
  element.style.background = 'rgba(0,0,0,0.1)';
  element.style.color = '#fff';
  element.style.font = 'normal 13px sans-serif';
  element.style.textAlign = 'center';
  element.style.opacity = '0.5';
  element.style.outline = 'none';
  element.style.zIndex = '999';
}
