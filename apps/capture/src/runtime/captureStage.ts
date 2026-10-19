import { AudioSystem, EnvironmentSystem, InputSystem, LightSystem, ReferenceSpaceType, SessionMode, World } from '@iwsdk/core';
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
      features: { handTracking: true },
      // Capture resets its own cameras on exit; a deferred SDK restore would race the frame loop.
      restoreCameraOnExit: false
    },
    input: { canvasPointerEvents: false },
    features: { locomotion: false, physics: false, grabbing: false, spatialUI: false }
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
  // Renders its own controller/hand models (loaded from a CDN) and ray
  // pointers; capture reads three's controllers and hands directly.
  world.unregisterSystem(InputSystem);
  // Would clear the background and clear alpha in AR, duplicating capture's AR
  // spectator; capture lights its scene itself.
  world.unregisterSystem(EnvironmentSystem);
  world.unregisterSystem(LightSystem);
  // Spatial playback with wall-clock AudioParam ramps, which throw under
  // replay's rebased clock. Capture records the microphone with MediaRecorder.
  world.unregisterSystem(AudioSystem);
  for (const child of [...world.player.head.children]) {
    if (child.type === 'AudioListener') child.removeFromParent();
  }
}
