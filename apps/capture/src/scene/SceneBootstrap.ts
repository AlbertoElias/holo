import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';

export type XrSessionMode = 'none' | 'vr' | 'ar';

export interface SceneBootstrap {
  scene: THREE.Scene;
  worldGroup: THREE.Group;
  renderer: THREE.WebGLRenderer;
  xrCamera: THREE.PerspectiveCamera;
  desktopCamera: THREE.PerspectiveCamera;
  cameraRig: THREE.Group;
  loader: GLTFLoader;
  clock: THREE.Clock;
  xrSessionMode: XrSessionMode;
}

export function createSceneBootstrap(): SceneBootstrap {
  const app = document.getElementById('app');
  if (!app) {
    throw new Error('Missing required #app element');
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111318);

  const xrCamera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.005, 2000);
  xrCamera.position.set(0, 2, 6);

  const desktopCamera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.005, 2000);
  desktopCamera.position.set(0, 2, 6);

  const cameraRig = new THREE.Group();
  cameraRig.add(xrCamera);
  scene.add(cameraRig);

  const worldGroup = new THREE.Group();
  scene.add(worldGroup);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  app.appendChild(renderer.domElement);

  // The rig dollies the VR view through xrCamera's parent; three.js applies it
  // in WebXRManager.updateCamera. Do not also parent renderer.xr.getCamera():
  // three writes that camera's *world* pose into its position each frame, so a
  // parent would be applied twice by getWorldPosition().

  const vrButton = VRButton.createButton(renderer, {
    optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking']
  });
  // Keep desktop keyboard control on the game surface after XR transitions.
  vrButton.setAttribute('tabindex', '-1');
  document.body.appendChild(vrButton);

  // AR button — custom implementation to keep local-floor reference space
  // (Three.js ARButton forces 'local' which is head-relative, not floor-relative).
  const state: { xrSessionMode: XrSessionMode } = { xrSessionMode: 'none' };
  const arButton = createArButton(renderer, state);
  arButton.setAttribute('tabindex', '-1');
  document.body.appendChild(arButton);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
  keyLight.position.set(2, 4, 2);
  scene.add(keyLight);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(20, 64),
    new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.95, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  worldGroup.add(ground);

  // Track VR session mode transitions.
  renderer.xr.addEventListener('sessionstart', () => {
    if (state.xrSessionMode === 'none') {
      state.xrSessionMode = 'vr';
    }
  });
  renderer.xr.addEventListener('sessionend', () => {
    state.xrSessionMode = 'none';
  });

  return {
    scene,
    worldGroup,
    renderer,
    xrCamera,
    desktopCamera,
    cameraRig,
    loader: new GLTFLoader(),
    clock: new THREE.Clock(),
    get xrSessionMode() {
      return state.xrSessionMode;
    }
  };
}

function createArButton(
  renderer: THREE.WebGLRenderer,
  state: { xrSessionMode: XrSessionMode }
): HTMLButtonElement {
  const button = document.createElement('button');
  let currentSession: XRSession | null = null;

  async function onSessionStarted(session: XRSession): Promise<void> {
    session.addEventListener('end', onSessionEnded);
    // Mark AR mode BEFORE setSession so the sessionstart listener doesn't
    // overwrite it with 'vr'.
    state.xrSessionMode = 'ar';
    // Keep Three.js default reference space ('local-floor') — do NOT call
    // renderer.xr.setReferenceSpaceType('local') like the built-in ARButton does.
    await renderer.xr.setSession(session);
    button.textContent = 'EXIT AR';
    currentSession = session;
  }

  function onSessionEnded(): void {
    if (currentSession) {
      currentSession.removeEventListener('end', onSessionEnded);
    }
    button.textContent = 'ENTER AR';
    state.xrSessionMode = 'none';
    currentSession = null;
  }

  function stylize(el: HTMLElement): void {
    el.style.position = 'absolute';
    el.style.bottom = '20px';
    el.style.padding = '12px 6px';
    el.style.border = '1px solid #fff';
    el.style.borderRadius = '4px';
    el.style.background = 'rgba(0,0,0,0.1)';
    el.style.color = '#fff';
    el.style.font = 'normal 13px sans-serif';
    el.style.textAlign = 'center';
    el.style.opacity = '0.5';
    el.style.outline = 'none';
    el.style.zIndex = '999';
  }

  button.id = 'ARButton';
  button.style.display = 'none';
  stylize(button);

  button.onmouseenter = () => { button.style.opacity = '1.0'; };
  button.onmouseleave = () => { button.style.opacity = '0.5'; };

  button.onclick = () => {
    if (currentSession === null) {
      navigator.xr!.requestSession('immersive-ar', {
        requiredFeatures: ['local-floor'],
        optionalFeatures: ['hand-tracking']
      }).then(onSessionStarted);
    } else {
      currentSession.end();
    }
  };

  if ('xr' in navigator) {
    navigator.xr!.isSessionSupported('immersive-ar').then((supported) => {
      if (supported) {
        button.style.display = '';
        button.style.cursor = 'pointer';
        button.style.left = 'calc(50% + 60px)';
        button.style.width = '100px';
        button.textContent = 'ENTER AR';
      } else {
        button.style.display = '';
        button.style.cursor = 'auto';
        button.style.left = 'calc(50% + 60px)';
        button.style.width = '150px';
        button.textContent = 'AR NOT SUPPORTED';
      }
    });
  }

  return button;
}
