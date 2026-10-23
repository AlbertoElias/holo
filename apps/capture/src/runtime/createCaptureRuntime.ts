import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { LocomotionAnimator } from '../animation/LocomotionAnimator';
import { TerrainLegSolver } from '../animation/TerrainLegSolver';
import { AvatarRig } from '../avatar/AvatarRig';
import { BodyTracking } from '../body/BodyTracking';
import { CrouchState } from '../body/crouch';
import { CameraController } from '../camera/CameraController';
import { loadRuntimeConfig } from '../config/runtimeConfig';
import { applyIwerMockVrPoseInput } from '../debug/iwerRuntime';
import { DiagnosticViews } from '../debug/DiagnosticViews';
import { InputController } from '../input/InputController';
import { VrLocomotion } from '../input/VrLocomotion';
import { CharacterMotor } from '../physics/CharacterMotor';
import { RecordingSession } from '../recording/RecordingSession';
import { activeCamera, type CaptureContext } from '../systems/captureContext';
import { registerCaptureSystems } from '../systems';
import type { CaptureUiBridge } from '../ui/captureUiBridge';
import { UIStateStore } from '../ui/UIStateStore';
import { VrHud } from '../ui/VrHud';
import { ArSpectator } from '../xr/ArSpectator';
import { HandEmbodiment } from '../xr/HandEmbodiment';
import { HeightFit } from '../xr/HeightFit';
import { XrTracking } from '../xr/XrTracking';
import { installAutomationHooks } from './automationHooks';
import { createCaptureStage } from './captureStage';
import { renderCaptureTextState } from './captureTextState';
import { FrameLoop } from './FrameLoop';
import { mountXrEntry } from './xrEntry';

export interface CaptureRuntime {
  uiBridge: CaptureUiBridge;
  // Loads the scene and avatar, then starts the frame loop.
  start(): Promise<void>;
}

/** Composition root: World, capture's services and systems, one frame loop. */
export async function createCaptureRuntime(container: HTMLElement): Promise<CaptureRuntime> {
  const config = loadRuntimeConfig();
  const stage = await createCaptureStage(container);
  const { world, scene, renderer, cameraRig } = stage;
  // World's loop ran its initial level load; capture's frame loop replaces it
  // once the avatar has loaded.
  renderer.setAnimationLoop(null);
  const xrEntry = mountXrEntry(world);

  const avatar = new AvatarRig(stage.worldGroup, renderer);
  const motor = new CharacterMotor();
  const locomotion = new VrLocomotion();
  const camera = new CameraController({
    renderer,
    xrCamera: stage.xrCamera,
    desktopCamera: stage.desktopCamera,
    cameraRig,
    avatarRig: avatar,
    embodyOffset: config.embodyOffset,
    rigYaw: () => locomotion.turnYaw
  });
  const tracking = new XrTracking(renderer, config.mockVrEnabledFromQuery, {
    handPitchDeg: config.handTrackPitchDeg,
    handYawDeg: config.handTrackYawDeg,
    handRollDeg: config.handTrackRollDeg,
    handInwardYawDeg: config.handTrackInwardYawDeg,
    controllerPitchDeg: config.controllerTrackPitchDeg,
    controllerYawDeg: config.controllerTrackYawDeg,
    controllerRollDeg: config.controllerTrackRollDeg
  });
  const ui = new UIStateStore();
  const input = new InputController({
    domElement: renderer.domElement,
    isXrPresenting: () => tracking.isXrPresenting(),
    look: camera,
    onRecordToggle: () => recording.toggle()
  });
  const body = new BodyTracking(avatar, config.avatarForwardOffset);
  const heightFit = new HeightFit({
    ui,
    isRealVrPresenting: () => tracking.isXrPresenting() && xrEntry.sessionMode === 'vr' && !tracking.mock.enabled,
    isRecordingSizeLocked: () => recording.isSizeLocked
  });
  const recording = new RecordingSession({
    ui,
    renderer,
    getAvatar: () => ({ avatar: avatar.avatar, worldModel: avatar.worldModel }),
    onSizeLocked: () => heightFit.calibration.interrupt()
  });
  const hands = new HandEmbodiment(tracking, avatar, () => motor.getWorld(), config);
  const vrHud = new VrHud({
    store: ui,
    renderer,
    scene,
    tracking,
    refitHeight: () => heightFit.requestRefit(),
    toggleRecording: () => recording.toggle()
  });

  const capture: CaptureContext = {
    config,
    stage,
    xrEntry,
    avatar,
    motor,
    camera,
    tracking,
    input,
    locomotion,
    body,
    heightFit,
    crouch: new CrouchState(),
    hands,
    animator: new LocomotionAnimator(),
    terrainLegs: new TerrainLegSolver(),
    ar: new ArSpectator(scene, renderer, stage.worldGroup, avatar, config.embodyOffset),
    ui,
    vrHud,
    recording,
    diagnostics: new DiagnosticViews({
      scene,
      renderer,
      worldGroup: stage.worldGroup,
      avatar,
      tracking,
      getLookYaw: () => camera.lookYaw,
      getBodyYaw: () => body.solver.bodyYaw,
      getHud: () => vrHud.panel.group
    }),
    frame: { deltaSec: 0, elapsedSec: 0, steps: 0, xrPresenting: false, arSpectator: false, vrActive: false, bodyTracking: false, character: null },
    clockMode: () => loop.clockMode
  };
  world.globals.capture = capture;

  let started = false;
  const loop = new FrameLoop({
    world,
    acquire: (frame) => {
      tracking.captureFloorHeadPose(frame);
      if (frame) {
        recording.recordInputFrame(frame);
        tracking.noteXrFrame(frame);
      }
    },
    present: (draw) => {
      const view = activeCamera(capture);
      if (draw) {
        renderer.render(scene, view);
        capture.diagnostics.render();
        return;
      }
      // A skipped draw still applies render()'s side effects, so world
      // matrices and the XR camera are exactly as a drawn frame leaves them.
      scene.updateMatrixWorld();
      if (renderer.xr.isPresenting && renderer.xr.cameraAutoUpdate) renderer.xr.updateCamera(view);
    },
    isStarted: () => started,
    simulationSteps: () => capture.frame.steps
  });

  const onResize = (): void => camera.onResize();

  const loadAssets = async (): Promise<void> => {
    const load = (url: string): Promise<GLTF> => new Promise((resolve, reject) => stage.loader.load(url, resolve, undefined, reject));
    try {
      const [sceneGltf, avatarGltf] = await Promise.all([load(config.sceneUrl), load(config.avatarUrl)]);
      avatar.applyLoadedModels(sceneGltf.scene, avatarGltf.scene, config);
      capture.terrainLegs.attach(avatar);
      hands.attach();
      // Bind pose is measured before any animation writes the skeleton.
      body.measureBindPose();
      const spawned = await motor.init(avatar);
      hands.ensureSensors();
      if (avatar.avatar) capture.animator.attachClips(avatar.avatar, avatarGltf.animations);
      ui.setLoadState(spawned ? 'ready' : 'warning', spawned ? null : 'Loaded with warnings: spawn/physics setup incomplete.');
      registerCaptureSystems(world);
      started = true;
    } catch (error) {
      console.error(error);
      ui.setLoadState('error', 'Failed to load scene/avatar assets.');
    }
  };

  return {
    uiBridge: {
      subscribe: (listener) => ui.subscribe(() => listener()),
      getSnapshot: () => ui.getState(),
      refitHeight: () => heightFit.requestRefit(),
      toggleRecording: () => recording.toggle(),
      recenterAr: () => {
        if (xrEntry.sessionMode === 'ar' && tracking.isXrPresenting()) capture.ar.recenter();
      }
    },
    start: async () => {
      installAutomationHooks({
        render_game_to_text: () => renderCaptureTextState(capture),
        advanceTime: (ms) => loop.advanceTime(ms),
        __setManualClock: (enabled, draw) => loop.setManualClock(enabled, draw),
        __setFrameStepping: (enabled, draw) => loop.setFrameStepping(enabled, draw),
        __setMockVrPose: (payload) => {
          applyIwerMockVrPoseInput(payload);
          const wasEnabled = tracking.mock.enabled;
          tracking.mock.apply(payload);
          // Real XR head height and the debug pose use different coordinate
          // spaces, so a baseline captured before the source switch is invalid.
          if (wasEnabled !== tracking.mock.enabled) capture.crouch.resetBaseline();
        },
        __setMockInput: (payload) => {
          input.applyMockInput(payload);
          if (payload.thumbstick) locomotion.setThumbstick(payload.thumbstick);
          if (payload.turnMode) locomotion.setTurnMode(payload.turnMode);
        },
        __respawnCharacter: () => motor.respawn(),
        __sampleHands: () => hands.sample(),
        __sampleBody: () => body.sample(cameraRig, tracking.getHeadPose()),
        __setBodyFaults: (faults) => body.setFaults(faults),
        __setHandOverlay: (enabled) => capture.diagnostics.setHandOverlay(enabled),
        __setHeightEvidenceView: (enabled) => capture.diagnostics.setHeightEvidenceView(enabled),
        __setSpectatorView: (mode) => capture.diagnostics.setSpectatorView(mode),
        __captureHandCalibrationPose: () => hands.captureCalibrationPose(),
        __resetHandCalibrationPose: () => hands.resetCalibrationPose()
      });
      // ?manualClock=1: never tick on real time, so a replay starts from the
      // same state on any host (see __setFrameStepping).
      if (new URLSearchParams(window.location.search).get('manualClock') === '1') loop.setManualClock(true, false);
      tracking.mountToRig(cameraRig);
      input.init();
      window.addEventListener('resize', onResize);
      recording.requestMicPermission();
      await loadAssets();
      loop.start();
    }
  };
}
