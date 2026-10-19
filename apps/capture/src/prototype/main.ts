import React from 'react';
import { createRoot } from 'react-dom/client';
import { AudioSystem, ReferenceSpaceType, SessionMode, World } from '@iwsdk/core';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { AppOrchestrator } from '../app/AppOrchestrator';
import { createApp } from '../app/createApp';
import type { SceneBootstrap } from '../scene/SceneBootstrap';
import { CaptureOverlay } from '../ui/CaptureOverlay';
import { CaptureState, CaptureSystem } from './CaptureSystem';

async function start(): Promise<void> {
  const container = document.getElementById('app');
  const uiContainer = document.getElementById('ui-root');
  if (!container || !uiContainer) throw new Error('Prototype containers are missing');
  const world = await World.create(container, {
    xr: {
      sessionMode: SessionMode.ImmersiveVR, offer: 'none',
      referenceSpace: { type: ReferenceSpaceType.LocalFloor, required: true },
      features: { handTracking: true, layers: false }, restoreCameraOnExit: false
    },
    render: { fov: 70, near: 0.005, far: 2000 },
    input: { canvasPointerEvents: false },
    features: { locomotion: false, physics: false, grabbing: false, spatialUI: false }
  });
  // Capture records microphone media directly; it has no SDK audio sources.
  // The SDK installs spatial playback unconditionally. Remove its unused
  // listener too: its wall-clock AudioParam ramps cannot follow replay's
  // rebased performance clock. This does not touch MediaRecorder or GLB audio.
  world.unregisterSystem(AudioSystem);
  for (const child of [...world.player.head.children]) {
    if (child.type === 'AudioListener') child.removeFromParent();
  }
  // Both packages share super-three; isolate the differing @types/three versions.
  const renderer = world.renderer as unknown as THREE.WebGLRenderer;
  const scene = world.scene as unknown as THREE.Scene;
  const xrCamera = world.camera as unknown as THREE.PerspectiveCamera;
  const cameraRig = world.player as unknown as THREE.Group;
  const desktopCamera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.005, 2000);
  desktopCamera.position.set(0, 2, 6);
  scene.background = new THREE.Color(0x111318);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
  const light = new THREE.DirectionalLight(0xffffff, 1.1);
  light.position.set(2, 4, 2);
  scene.add(light);
  const worldGroup = new THREE.Group();
  worldGroup.name = 'capture-world';
  world.createTransformEntity(worldGroup as unknown as Parameters<World['createTransformEntity']>[0], { persistent: true });
  const bootstrap: SceneBootstrap = {
    scene, renderer, xrCamera, desktopCamera, cameraRig, worldGroup,
    loader: new GLTFLoader(), clock: new THREE.Clock(),
    get xrSessionMode() { return renderer.xr.isPresenting ? 'vr' : 'none'; }
  };
  const orchestrator = new AppOrchestrator(bootstrap, (camera) => {
    // Input retains the original tracking camera; World renders the active view.
    world.camera = camera as unknown as World['camera'];
  });
  const app = createApp({ orchestrator, externalFrameLoop: true });
  const uiRoot = createRoot(uiContainer);
  uiRoot.render(React.createElement(CaptureOverlay, { bridge: app.uiBridge }));
  await app.start();
  world.registerComponent(CaptureState);
  const state = world.createEntity();
  state.addComponent(CaptureState);
  world.registerSystem(CaptureSystem, { priority: 10 });
  const system = world.getSystem(CaptureSystem)!;
  system.attach(orchestrator, state);
  system.publish();
  const button = document.createElement('button');
  button.id = 'VRButton';
  button.textContent = 'ENTER VR';
  button.style.cssText = 'position:absolute;bottom:20px;right:20px;z-index:999;padding:12px';
  button.onclick = () => {
    if (renderer.xr.isPresenting) world.exitXR();
    else {
      world.camera = xrCamera as unknown as World['camera'];
      world.launchXR();
    }
  };
  renderer.xr.addEventListener('sessionstart', () => { button.textContent = 'EXIT VR'; });
  renderer.xr.addEventListener('sessionend', () => { button.textContent = 'ENTER VR'; });
  document.body.appendChild(button);
  const originalAdvance = window.advanceTime;
  window.advanceTime = (ms) => { originalAdvance?.(ms); system.publish(); };
  window.__iwsdkPrototype = {
    snapshot: () => orchestrator.getSimulationSnapshot(),
    rendererStats: () => ({ ...renderer.info.render, memory: { ...renderer.info.memory } }),
    dispose: () => {
      app.dispose(); uiRoot.unmount(); world.destroy(); renderer.dispose(); button.remove();
      delete window.__iwsdkPrototype;
    }
  };
  import.meta.hot?.dispose(() => window.__iwsdkPrototype?.dispose());
}

declare global {
  interface Window {
    advanceTime?: (ms: number) => void;
    __iwsdkPrototype?: {
      snapshot: () => ReturnType<AppOrchestrator['getSimulationSnapshot']>;
      rendererStats: () => unknown;
      dispose: () => void;
    };
  }
}

void start().catch((error: unknown) => {
  console.error(error);
  const label = document.getElementById('prototype-label');
  if (label) label.textContent = `Prototype failed: ${String(error)}`;
});
