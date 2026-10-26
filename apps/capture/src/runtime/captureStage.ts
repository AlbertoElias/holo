import { AudioSystem, EnvironmentSystem, GazeSystem, LightSystem, ReferenceSpaceType, SessionMode, World } from '@iwsdk/core';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export const SCENE_BACKGROUND = 0x111318;

// Everything capture renders and simulates. World owns the scene, renderer,
// XR session and ECS; capture's rig, cameras and world group are plain three
// objects, never ECS transform entities: IWSDK's TransformSystem stores entity
// transforms as float32, which would round every rig write and change replays.
export interface CaptureStage {
  world: World;
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  // Environment and avatar; AR spectator placement moves it.
  worldGroup: THREE.Group;
  // Dollies tracking space; parents the XR camera, controllers and hands.
  cameraRig: THREE.Group;
  xrCamera: THREE.PerspectiveCamera;
  desktopCamera: THREE.PerspectiveCamera;
  loader: GLTFLoader;
}

export async function createCaptureStage(container: HTMLElement): Promise<CaptureStage> {
  // World.create always builds the SDK's spatial-audio listener, which opens a
  // Web Audio context (about 190 ms at startup in Chromium). Capture removes
  // that system below and plays no audio through three (microphone recording
  // uses MediaRecorder), so three's shared context stays an offline one.
  THREE.AudioContext.setContext(new OfflineAudioContext(1, 1, 44100) as unknown as AudioContext);
  const world = await World.create(container, {
    xr: {
      sessionMode: SessionMode.ImmersiveVR,
      // Same session request and browser offer as three's VRButton.
      offer: 'always',
      referenceSpace: { type: ReferenceSpaceType.LocalFloor, required: true },
      // Optional eye gaze (Quest Browser 'gaze-tracking') drives the avatar's eyes.
      features: { handTracking: true, gazeTracking: true },
      // Capture resets its own cameras on exit; a deferred SDK restore would race the frame loop.
      restoreCameraOnExit: false
    },
    input: { canvasPointerEvents: false },
    // Spatial UI and pointers for the headset chrome (@holoim/xr-ui-iwsdk, as the viewer).
    features: { locomotion: false, physics: false, grabbing: false, spatialUI: true }
  });
  removeCompetingSdkSystems(world);

  const scene = world.scene;
  const renderer = world.renderer;
  scene.background = new THREE.Color(SCENE_BACKGROUND);

  const xrCamera = createCamera();
  const desktopCamera = createCamera();
  const cameraRig = new THREE.Group();
  cameraRig.add(xrCamera);
  scene.add(cameraRig);
  // three dollies the XR view through xrCamera's parent in updateCamera. Never
  // parent renderer.xr.getCamera(): three writes its *world* pose each frame.

  const worldGroup = new THREE.Group();
  scene.add(worldGroup);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
  keyLight.position.set(2, 4, 2);
  scene.add(keyLight);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(20, 64),
    new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.95, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  worldGroup.add(ground);

  return { world, scene, renderer, worldGroup, cameraRig, xrCamera, desktopCamera, loader: new GLTFLoader() };
}

function createCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.005, 2000);
  camera.position.set(0, 2, 6);
  return camera;
}

// SDK systems that would become a second owner of something capture owns.
function removeCompetingSdkSystems(world: World): void {
  // InputSystem stays, for its pointers only: they dispatch pointer events to
  // the chrome, while capture still reads three's controllers and hands for
  // recording. Its controller and hand models would load from a CDN and
  // duplicate capture's avatar hands, so they never load.
  disableSdkInputVisuals(world);
  // Would clear the background and clear alpha in AR, duplicating capture's AR
  // spectator; capture lights its scene itself.
  world.unregisterSystem(EnvironmentSystem);
  world.unregisterSystem(LightSystem);
  // Spatial playback with wall-clock AudioParam ramps, which throw under
  // replay's rebased clock. Capture records the microphone with MediaRecorder.
  world.unregisterSystem(AudioSystem);
  // Gaze-and-pinch targeting; capture reads the gaze ray only to aim the
  // avatar's eyes (face/XrGaze).
  world.unregisterSystem(GazeSystem);
  for (const child of [...world.player.head.children]) {
    if (child.type === 'AudioListener') child.removeFromParent();
  }
}

// IWSDK's XR input visuals load controller and hand models from the
// webxr-input-profiles CDN even when toggled off; a loader that returns an
// empty scene leaves input tracked with no visual and no request.
function disableSdkInputVisuals(world: World): void {
  const adapters = (world.input.xr as unknown as {
    visualAdapters: Record<'controller' | 'hand', Record<'left' | 'right', { assetLoader: unknown; toggleVisual(enabled: boolean): void }>>;
  }).visualAdapters;
  const noModels = { loadGLTF: async () => ({ scene: new THREE.Group() }) };
  for (const kind of ['controller', 'hand'] as const) {
    for (const side of ['left', 'right'] as const) {
      adapters[kind][side].assetLoader = noModels;
      adapters[kind][side].toggleVisual(false);
    }
  }
}

/**
 * Copies the camera rig's world pose to `world.player`, where IWSDK keeps its
 * pointer spaces, so its rays and pokes start from capture's controllers and
 * hands. Only pointers read the player (a float32 entity transform); recording
 * reads three's rig.
 */
export function syncPlayerToRig(world: World, cameraRig: THREE.Object3D): void {
  cameraRig.updateMatrixWorld();
  cameraRig.matrixWorld.decompose(world.player.position, world.player.quaternion, world.player.scale);
}

/**
 * IWSDK samples XR input inside `world.update`, which needs the XR frame, but
 * under capture's manual clock `world.update` runs from `advanceTime`, outside
 * any frame, where IWSDK would disable every pointer. A step without a frame
 * keeps the last sample instead; the returned sampler takes one on the frame.
 */
export function holdXrInputBetweenFrames(world: World): (deltaSec: number, timeSec: number) => void {
  const input = world.input as unknown as { update(xrManager: THREE.WebXRManager, delta: number, time: number): void };
  const update = input.update.bind(input);
  const xr = world.renderer.xr;
  input.update = (xrManager, delta, time) => {
    if (xrManager.getSession() && !xrManager.getFrame()) return;
    update(xrManager, delta, time);
  };
  return (deltaSec, timeSec) => {
    if (xr.getSession() && xr.getFrame()) update(xr, deltaSec, timeSec);
  };
}
