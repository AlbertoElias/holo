import { nonDominantHand, type Handedness } from '@holoim/xr-ui-core';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Vector3 } from 'three';
import { LocomotionAnimator } from '../animation/LocomotionAnimator';
import { TerrainLegSolver } from '../animation/TerrainLegSolver';
import { AvatarRig } from '../avatar/AvatarRig';
import { BodyTracking } from '../body/BodyTracking';
import { CrouchState } from '../body/crouch';
import { CameraController } from '../camera/CameraController';
import { loadRuntimeConfig } from '../config/runtimeConfig';
import { applyIwerMockVrPoseInput } from '../debug/iwerRuntime';
import { ChromeProbe } from '../debug/chromeProbe';
import { DiagnosticViews } from '../debug/DiagnosticViews';
import { FaceDriver } from '../face/FaceDriver';
import { DesktopPointAction } from '../input/DesktopPointAction';
import { InputController } from '../input/InputController';
import { VrLocomotion } from '../input/VrLocomotion';
import { CaptureObjects } from '../objects/CaptureObjects';
import { CharacterMotor } from '../physics/CharacterMotor';
import { RecordingSession } from '../recording/RecordingSession';
import { activeCamera, type CaptureContext } from '../systems/captureContext';
import { registerCaptureSystems } from '../systems';
import type { CaptureUiBridge } from '../ui/captureUiBridge';
import { PointCrosshair } from '../ui/PointCrosshair';
import { UIStateStore } from '../ui/UIStateStore';
import { saveHandedness } from '@holoim/ui-dom';
import { TouchStickView } from '../ui/TouchStickView';
import { FlatHalo } from '../ui/flatHalo';
import { VrChrome } from '../ui/VrChrome';
import { prefetchStats } from '../objects/objectSearch';
import { voiceLog } from '../objects/voiceInput';
import { HeadsetHolds } from '../xr/HeadsetHolds';
import { ArSpectator } from '../xr/ArSpectator';
import { HandEmbodiment } from '../xr/HandEmbodiment';
import { HeightFit } from '../xr/HeightFit';
import { XrTracking } from '../xr/XrTracking';
import { installAutomationHooks } from './automationHooks';
import { createHaloActions } from './haloActions';
import { createCaptureStage, holdXrInputBetweenFrames, syncPlayerToRig } from './captureStage';
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
  ui.setXrEntry(xrEntry.offers);
  xrEntry.onChange(() => ui.setXrEntry(xrEntry.offers));
  const touchStick = new TouchStickView(container);
  // The Halo's actions (slice 5), one runner for every input that summons it.
  const haloActions = createHaloActions({
    ui,
    recording: { toggle: () => recording.toggle() },
    getPointSamples: () => recording.recorder.pointSamples,
    getTimeSec: () => capture.frame.elapsedSec
  });
  const flatHalo = new FlatHalo((commit) => {
    if (commit.action) haloActions.run(commit.action, 'key');
  });
  const input = new InputController({
    domElement: renderer.domElement,
    isXrPresenting: () => tracking.isXrPresenting(),
    look: camera,
    onRecordToggle: () => recording.toggle(),
    onTouchStick: (stick) => touchStick.update(stick),
    halo: flatHalo
  });
  const setHandedness = (handedness: Handedness): void => {
    saveHandedness(handedness);
    ui.setHandedness(handedness);
  };
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
    onSizeLocked: () => heightFit.calibration.interrupt(),
    onTakeStart: () => objects.startTake()
  });
  const hands = new HandEmbodiment(tracking, avatar, () => motor.getWorld(), config);
  const objects = new CaptureObjects({
    worldGroup: stage.worldGroup,
    renderer,
    loader: stage.loader,
    avatar,
    tracking,
    ui,
    embodyOffset: config.embodyOffset,
    isTakeActive: () => ui.getState().recordingState !== 'idle',
    getHandedness: () => ui.getState().handedness
  });
  const vrChrome = new VrChrome({
    world,
    xrCamera: stage.xrCamera,
    store: ui,
    renderer,
    scene,
    tracking,
    refitHeight: () => heightFit.requestRefit(),
    toggleRecording: () => recording.toggle(),
    setHandedness,
    ownsSelect: (source) => headsetHolds.ownsSelect(source, capture.frame.elapsedSec),
    pickObject: (url) => void objects.loadTrayUrls([url])
  });
  const headsetHolds = new HeadsetHolds({
    tracking,
    root: vrChrome.root,
    renderer,
    getHandedness: () => ui.getState().handedness,
    // A hand grabbing, or holding the tray open, is doing that: no mark or Halo on it.
    isHandBusy: (side) => objects.grabInput.get(side).pressed || (side === nonDominantHand(ui.getState().handedness) && objects.trayGesture.isHeld()),
    onHaloAction: (action, kind, side, at) => {
      haloActions.run(action, kind);
      vrChrome.haloFeedback(side, at, kind);
    }
  });
  headsetHolds.bind();

  const capture: CaptureContext = {
    config,
    stage,
    xrEntry,
    avatar,
    motor,
    camera,
    tracking,
    input,
    point: new DesktopPointAction({
      avatar,
      desktopCamera: stage.desktopCamera,
      crosshair: new PointCrosshair(container),
      embodyOffset: config.embodyOffset,
      getPointSamples: () => recording.recorder.pointSamples,
      getHandedness: () => ui.getState().handedness
    }),
    locomotion,
    body,
    heightFit,
    crouch: new CrouchState(),
    hands,
    objects,
    face: new FaceDriver(cameraRig, (state) => ui.setFaceCamera(state)),
    animator: new LocomotionAnimator(),
    terrainLegs: new TerrainLegSolver(),
    ar: new ArSpectator(scene, renderer, stage.worldGroup, avatar, config.embodyOffset),
    ui,
    vrChrome,
    headsetHolds,
    recording,
    diagnostics: new DiagnosticViews({
      scene,
      renderer,
      worldGroup: stage.worldGroup,
      avatar,
      tracking,
      getLookYaw: () => camera.lookYaw,
      getBodyYaw: () => body.solver.bodyYaw,
      getHud: () => vrChrome.root
    }),
    frame: { deltaSec: 0, elapsedSec: 0, steps: 0, xrPresenting: false, arSpectator: false, vrActive: false, bodyTracking: false, character: null },
    clockMode: () => loop.clockMode
  };
  world.globals.capture = capture;

  let started = false;
  const sampleXrInput = holdXrInputBetweenFrames(world);
  const loop = new FrameLoop({
    world,
    sampleInput: sampleXrInput,
    acquire: (frame) => {
      // IWSDK's pointers live under world.player; capture moves its own rig.
      syncPlayerToRig(world, cameraRig);
      tracking.captureFloorHeadPose(frame);
      if (frame) {
        recording.recordInputFrame(frame);
        tracking.noteXrFrame(frame);
        capture.face.xrGaze.noteXrFrame(frame, renderer.xr.getReferenceSpace());
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

  const chromeProbe = new ChromeProbe();
  const onResize = (): void => camera.onResize();

  const loadAssets = async (): Promise<void> => {
    const load = (url: string): Promise<GLTF> => new Promise((resolve, reject) => stage.loader.load(url, resolve, undefined, reject));
    try {
      const [sceneGltf, avatarGltf] = await Promise.all([load(config.sceneUrl), load(config.avatarUrl)]);
      avatar.applyLoadedModels(sceneGltf.scene, avatarGltf.scene, config, {
        json: avatarGltf.parser.json,
        associations: avatarGltf.parser.associations
      });
      capture.terrainLegs.attach(avatar);
      hands.attach();
      capture.point.attach();
      objects.attach();
      // Bind pose is measured before any animation writes the skeleton.
      body.measureBindPose();
      const spawned = await motor.init(avatar);
      hands.ensureSensors();
      if (avatar.avatar) capture.animator.attachClips(avatar.avatar, avatarGltf.animations, avatar.humanoid);
      // Bound at bind pose, like the body, before any system writes the eyes.
      if (avatar.avatar && avatar.humanoid) {
        capture.face.attach(avatar.avatar, {
          head: avatar.bone('head'), leftEye: avatar.bone('leftEye'), rightEye: avatar.bone('rightEye')
        });
        avatar.humanoid.warnOnce();
      }
      // The supplied object loads after the avatar, so its bone names never shadow the avatar's.
      if (config.objectUrl) await objects.loadUrl(config.objectUrl);
      if (config.trayUrls.length > 0) await objects.loadTrayUrls(config.trayUrls);
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
      halo: { subscribe: flatHalo.subscribe, getSnapshot: flatHalo.getSnapshot, layout: flatHalo.layout },
      runHaloAction: (action, kind) => {
        haloActions.run(action, kind);
      },
      loadObjectFile: (file) => void objects.loadFile(file),
      loadTrayFiles: (files) => void objects.loadTrayFiles(files),
      loadTrayUrls: (urls) => void objects.loadTrayUrls(urls),
      toggleFaceCamera: () => capture.face.toggleCamera(),
      setHandedness,
      toggleXr: (mode) => xrEntry.toggle(mode),
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
        __resetHandCalibrationPose: () => hands.resetCalibrationPose(),
        __loadObjectUrl: (url) => objects.loadUrl(url),
        __loadTrayUrls: (urls) => objects.loadTrayUrls(urls),
        __setFaceInput: (sample) => capture.face.setAutomationInput(sample),
        __sampleFace: () => capture.face.snapshot(),
        __sampleHumanoid: () => avatar.humanoid?.report() ?? null,
        __toggleFaceCamera: () => capture.face.toggleCamera(),
        __sampleChrome: () => ({ ui: ui.getState(), vr: vrChrome.snapshot(stage.xrCamera), touch: input.touch.snapshot() }),
        __chromeTarget: (target) => vrChrome.targetPosition(target),
        __sampleObjectSearch: () => ({ headset: vrChrome.findSession.getState(), voiceLog: [...voiceLog], prefetch: { ...prefetchStats } }),
        __setRetainLastTake: (retain) => recording.setRetainLastTake(retain),
        __reexportLastTake: async () => {
          const bytes = await recording.reexportLastTake();
          if (!bytes) return null;
          let binary = '';
          const view = new Uint8Array(bytes);
          for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
          return { base64: btoa(binary), byteLength: bytes.byteLength };
        },
        __setChromeProbe: (mode) => chromeProbe.set(mode, avatar.worldModel, avatar.avatarRoot, vrChrome.root),
        __setChromeVisible: (visible) => {
          vrChrome.root.visible = visible;
        },
        __sampleHolds: () => ({
          headset: headsetHolds.snapshot(),
          holds: recording.recorder.pointSamples.holdCounts(),
          touch: input.touch.snapshot().hold,
          flatHalo: flatHalo.getSnapshot(),
          actions: haloActions.log
        }),
        __projectToScreen: (point) => {
          const ndc = new Vector3(point[0], point[1], point[2]).project(stage.desktopCamera);
          if (ndc.z > 1) return null;
          const rect = renderer.domElement.getBoundingClientRect();
          return { x: rect.left + ((ndc.x + 1) / 2) * rect.width, y: rect.top + ((1 - ndc.y) / 2) * rect.height };
        }
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
