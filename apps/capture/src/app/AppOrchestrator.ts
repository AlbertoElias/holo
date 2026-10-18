import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createSceneBootstrap } from '../scene/SceneBootstrap';
import { loadRuntimeConfig } from '../config/runtimeConfig';
import { AvatarRig, type ArmIkChain, type HandFingerRetargetChain } from '../avatar/AvatarRig';
import { palmFrameQuaternion } from '../xr/palmFrame';
import { CharacterMotor } from '../physics/CharacterMotor';
import { CameraController } from '../camera/CameraController';
import { XrHeightCalibration } from '../xr/XrHeightCalibration';
import { XrSessionService } from '../xr/XrSessionService';
import { HandFingerRetargeter } from '../xr/HandFingerRetargeter';
import { InputController } from '../input/InputController';
import { ArmIkSolver } from '../ik/ArmIkSolver';
import { LocomotionAnimator } from '../animation/LocomotionAnimator';
import { UIStateStore } from '../ui/UIStateStore';
import { VrHud } from '../ui/VrHud';
import { AvatarRecorder } from '../recording/AvatarRecorder';
import { AudioRecorder } from '../recording/AudioRecorder';
import type { InputRecordingSession } from '../debug/inputRecording';
import { TRACKED_HAND_JOINT_NAMES } from '../types/contracts';
import type { AppMode, FrameContext, HandPoseSnapshot, HandSample, MockInputState, MockVrPoseInput, QuatLike, System, TrackedHandJointName, UiViewModel, VrHandSide } from '../types/contracts';
import {
  computeCrouchPoseAmount,
  computeVrCrouchTarget,
  type CrouchSource,
  resolveCrouchTargetAndSource,
  stepCrouchAmount
} from './crouch';

interface HandSensorState {
  body?: import('@dimforge/rapier3d-compat').RigidBody;
  collider?: import('@dimforge/rapier3d-compat').Collider;
  radius: number;
}

interface FingerQuatFallbackCalibrationState {
  jointName: TrackedHandJointName;
  parentJointName: TrackedHandJointName;
  targetFromSourceLocalQuaternion: THREE.Quaternion;
  missingFrames: number;
}

const CROUCH_MOVE_SPEED_AT_FULL = 0.75;
const CROUCH_MIN_EFFECT_THRESHOLD = 0.05;
const FINGER_QUAT_CALIBRATION_STALE_FRAMES = 24;
const AR_INITIAL_WORLD_DISTANCE_METERS = 2.2;
const AR_WORLD_RECENTER_FRAMES = 36;

// Avatar bones that sit on the same anatomical joint as each WebXR hand joint.
const AVATAR_BONE_FOR_HAND_JOINT: ReadonlyArray<readonly [TrackedHandJointName, string]> = [
  ['wrist', 'Hand'],
  ['thumb-metacarpal', 'HandThumb1'],
  ['thumb-phalanx-proximal', 'HandThumb2'],
  ['thumb-phalanx-distal', 'HandThumb3'],
  ['thumb-tip', 'HandThumb4'],
  ...(['index', 'middle', 'ring', 'pinky'] as const).flatMap((finger) => {
    const bone = `Hand${finger[0]!.toUpperCase()}${finger.slice(1)}`;
    return [
      [`${finger}-finger-phalanx-proximal`, `${bone}1`],
      [`${finger}-finger-phalanx-intermediate`, `${bone}2`],
      [`${finger}-finger-phalanx-distal`, `${bone}3`],
      [`${finger}-finger-tip`, `${bone}4`]
    ] as const;
  })
];

const FINGER_DEBUG_BONES: Readonly<Record<VrHandSide, { thumb: string; index: string; middle: string }>> = {
  left: { thumb: 'LeftHandThumb2', index: 'LeftHandIndex3', middle: 'LeftHandMiddle3' },
  right: { thumb: 'RightHandThumb2', index: 'RightHandIndex3', middle: 'RightHandMiddle3' }
};

export class AppOrchestrator implements System {
  private readonly config = loadRuntimeConfig();
  private readonly bootstrap = createSceneBootstrap();
  private readonly avatarRig = new AvatarRig(this.bootstrap.scene, this.bootstrap.worldGroup, this.bootstrap.renderer);
  private readonly characterMotor = new CharacterMotor();
  private readonly camera = new CameraController({
    renderer: this.bootstrap.renderer,
    xrCamera: this.bootstrap.xrCamera,
    desktopCamera: this.bootstrap.desktopCamera,
    cameraRig: this.bootstrap.cameraRig,
    avatarRig: this.avatarRig,
    embodyOffset: this.config.embodyOffset
  });

  private readonly xrService = new XrSessionService(
    this.bootstrap.renderer,
    this.config.mockVrEnabledFromQuery,
    () => this.avatarRig.avatarHeight,
    {
      handPitchDeg: this.config.handTrackPitchDeg,
      handYawDeg: this.config.handTrackYawDeg,
      handRollDeg: this.config.handTrackRollDeg,
      handInwardYawDeg: this.config.handTrackInwardYawDeg,
      controllerPitchDeg: this.config.controllerTrackPitchDeg,
      controllerYawDeg: this.config.controllerTrackYawDeg,
      controllerRollDeg: this.config.controllerTrackRollDeg
    }
  );

  private readonly input = new InputController({
    domElement: this.bootstrap.renderer.domElement,
    isXrPresenting: () => this.xrService.isXrPresenting(),
    getDesktopViewMode: () => this.camera.desktopViewMode,
    setDesktopViewMode: (mode) => {
      this.camera.desktopViewMode = mode;
    },
    getLookYaw: () => this.camera.lookYaw,
    setLookYaw: (value) => {
      this.camera.lookYaw = value;
    },
    getThirdPersonPitch: () => this.camera.thirdPersonPitch,
    setThirdPersonPitch: (value) => {
      this.camera.thirdPersonPitch = this.camera.clampThirdPersonPitch(value);
    },
    getFirstPersonPitch: () => this.camera.firstPersonPitch,
    setFirstPersonPitch: (value) => {
      this.camera.firstPersonPitch = this.camera.clampFirstPersonPitch(value);
    },
    onRecordToggle: () => this.toggleRecording()
  });

  private readonly ikSolver = new ArmIkSolver();
  private readonly animator = new LocomotionAnimator();
  private readonly uiStore = new UIStateStore();
  private readonly vrHud = new VrHud(this.uiStore);
  private readonly recorder = new AvatarRecorder();
  private readonly audioRecorder = new AudioRecorder();

  private readonly armIkChains: Partial<Record<VrHandSide, ArmIkChain>> = {};
  private readonly fingerRetargetChains: Partial<Record<VrHandSide, HandFingerRetargetChain>> = {};
  private readonly fingerRetargeter = new HandFingerRetargeter(this.xrService, {
    twistGain: this.config.handFingerCurlGain
  });
  private readonly fingerQuatFallbackCalibration: Record<VrHandSide, Map<string, FingerQuatFallbackCalibrationState>> = {
    left: new Map(),
    right: new Map()
  };
  private readonly handSensors: Record<VrHandSide, HandSensorState> = {
    left: { radius: 0.08 },
    right: { radius: 0.08 }
  };
  private vrHandRigReady = false;
  private vrRigWarningLogged = false;
  private vrIkWarningLogged = false;
  private crouchAmount = 0;
  private crouchPoseAmount = 0;
  private crouchTarget = 0;
  private crouchSource: CrouchSource = 'none';
  private readonly heightCalibration = new XrHeightCalibration();
  private heightReferenceRevision = -1;
  private recordingSizeLocked = false;
  private vrStandingHeadY = 0;
  private vrStandingCaptured = false;

  private elapsedSec = 0;
  private started = false;
  // Automation can own the clock so wall-clock frames never mutate state
  // between deterministic steps. Realtime remains the default.
  private manualClock = false;
  private manualClockDraws = true;
  private drawFrames = true;
  private inputRecording: InputRecordingSession | null = null;
  private handOverlay: THREE.InstancedMesh | null = null;
  private spectatorCamera: THREE.PerspectiveCamera | null = null;
  private readonly overlayMatrix = new THREE.Matrix4();
  private activeXrSession: XRSession | null = null;
  private readonly defaultSceneBackground = new THREE.Color(0x111318);
  private wasArSession = false;
  private arWorldRecenterFramesRemaining = 0;

  private readonly tmpEyeAnchor = new THREE.Vector3();
  private readonly tmpBodyPosition = new THREE.Vector3();
  private readonly tmpHandWorld = new THREE.Vector3();
  private readonly tmpVecA = new THREE.Vector3();
  private readonly tmpVecB = new THREE.Vector3();
  private readonly tmpVecC = new THREE.Vector3();
  private readonly tmpVecD = new THREE.Vector3();
  private readonly tmpQuatA = new THREE.Quaternion();
  private readonly handWorldScratch = new THREE.Quaternion();
  private readonly palmJointScratch = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private readonly tmpQuatB = new THREE.Quaternion();
  private readonly tmpQuatC = new THREE.Quaternion();
  private readonly tmpQuatD = new THREE.Quaternion();
  private readonly onNativeXrSessionEnded = (): void => {
    this.input.onXrSessionEnded();
  };

  async init(): Promise<void> {
    this.xrService.mountToScene(this.bootstrap.scene, this.bootstrap.cameraRig);
    this.vrHud.init();
    this.input.init();

    window.addEventListener('resize', this.onResize);

    // Request mic permission early (before VR entry where dialogs are awkward).
    // Fire-and-forget: recording still works without mic.
    this.audioRecorder.requestMicPermission().then((granted) => {
      this.uiStore.setMicPermission(granted ? 'granted' : 'denied');
    }).catch(() => {
      this.uiStore.setMicPermission('denied');
    });

    try {
      const [sceneGltf, avatarGltf] = await Promise.all([this.loadGltf(this.config.sceneUrl), this.loadGltf(this.config.avatarUrl)]);

      this.avatarRig.applyLoadedModels(sceneGltf.scene, avatarGltf.scene, this.config);

      this.initializeVrHandRig();
      const spawned = await this.characterMotor.init(this.avatarRig);
      this.ensureHandSensors();

      if (this.avatarRig.avatar) {
        this.animator.attachClips(this.avatarRig.avatar, avatarGltf.animations);
      }

      this.uiStore.setLoadState(spawned ? 'ready' : 'warning', spawned ? null : 'Loaded with warnings: spawn/physics setup incomplete.');
      this.started = true;
    } catch (error) {
      console.error(error);
      this.uiStore.setLoadState('error', 'Failed to load scene/avatar assets.');
    }
  }

  update(ctx: FrameContext): void {
    if (!this.started) return;

    const transition = this.xrService.updateTransition();
    const isAr = this.bootstrap.xrSessionMode === 'ar';

    if (transition.entered) {
      this.wasArSession = isAr;
      this.bindXrSessionEndListener();
      if (isAr) {
        this.onArEntered();
      } else {
        this.bindXrSelectListeners();
        this.mountVrRecordingPanel();
        if (this.config.handRetargetMode === 'legacy') {
          this.resetFingerQuatFallbackCalibration();
        }
        this.fingerRetargeter.resetRuntimeState();
        this.heightCalibration.reset();
        this.resetVrStandingHeadBaseline();
        this.input.onXrEntered();
      }
      this.camera.onXrEntered(isAr);
    }
    if (transition.exited) {
      const exitingAr = this.wasArSession;
      this.wasArSession = false;
      this.unbindXrSessionEndListener();
      if (exitingAr) {
        this.onArExited();
      } else {
        this.unbindXrSelectListeners();
        this.unmountVrRecordingPanel();
        if (this.config.handRetargetMode === 'legacy') {
          this.resetFingerQuatFallbackCalibration();
        }
        this.fingerRetargeter.resetRuntimeState();
        this.characterMotor.onXrExited(this.avatarRig);
        this.resetVrStandingHeadBaseline();
        this.crouchTarget = 0;
        this.crouchAmount = 0;
        this.crouchPoseAmount = 0;
        this.crouchSource = 'none';
        this.input.onXrExited();
      }
      this.camera.onXrExited();
      this.avatarRig.applyCrouchPose(0);
    }

    const isXrPresenting = this.xrService.isXrPresenting();

    // ── AR spectator path ──────────────────────────────────────────
    if (isAr && isXrPresenting) {
      this.camera.update(false, true, ctx.deltaSec, true);
      if (this.arWorldRecenterFramesRemaining > 0) {
        this.placeArWorldInFrontOfViewer();
        this.arWorldRecenterFramesRemaining -= 1;
      }
      this.present(this.bootstrap.xrCamera);
      return;
    }

    // ── VR / desktop path (unchanged) ──────────────────────────────
    this.camera.lookYaw = this.xrService.syncYaw(this.camera.lookYaw);

    const isVrActive = this.xrService.isVrEmbodimentActive();
    this.input.tickDesktopFocusRecovery(isXrPresenting);

    if (this.xrService.isMockVrOnly()) {
      const mock = this.xrService.getMockHeadPose();
      this.camera.applyVrHeadPoseForMock();
      this.bootstrap.cameraRig.quaternion.copy(mock.quaternion);
    } else if (!isXrPresenting) {
      this.bootstrap.cameraRig.position.set(0, 0, 0);
      this.bootstrap.cameraRig.rotation.set(0, 0, 0);
      this.camera.ensureDesktopRendererState();
    }

    this.updateHeightAdaptation(ctx.deltaSec, isXrPresenting);
    this.updateCrouchState(ctx.deltaSec, isVrActive);
    const jumpQueued = this.input.consumeJumpQueued();
    this.characterMotor.update(ctx.deltaSec, this.camera.lookYaw, this.input.moveState, jumpQueued, {
      moveSpeedMultiplier: 1 - (1 - CROUCH_MOVE_SPEED_AT_FULL) * this.crouchAmount,
      allowJump: true,
      stickToTerrain: this.crouchAmount >= CROUCH_MIN_EFFECT_THRESHOLD
    });
    const characterSnapshot = this.characterMotor.getSnapshot();

    this.characterMotor.getCharacterBodyPosition(this.tmpBodyPosition);
    // The avatar forward offset must apply in all view modes so the model
    // faces the look direction.  Omitting it in first-person / VR causes the
    // avatar's left and right sides to appear swapped from the user's
    // perspective (the model faces +Z while the user faces −Z).
    const avatarForwardOffset = this.config.avatarForwardOffset;
    this.avatarRig.syncAvatarPoseFromCharacter(
      this.tmpBodyPosition,
      this.camera.lookYaw,
      this.characterMotor.getAvatarVisualOffsetY(),
      avatarForwardOffset
    );
    this.animator.update({
      deltaSec: ctx.deltaSec,
      grounded: characterSnapshot.grounded,
      velocityY: characterSnapshot.velocityY,
      horizontalSpeed: characterSnapshot.horizontalSpeed,
      targetHorizontalSpeed: characterSnapshot.targetHorizontalSpeed,
      moveIntent: this.input.moveState.forward || this.input.moveState.back || this.input.moveState.left || this.input.moveState.right,
      vrMode: isVrActive
    });
    this.avatarRig.applyCrouchPose(this.crouchPoseAmount, characterSnapshot.horizontalSpeed);

    this.camera.update(isVrActive, isXrPresenting, ctx.deltaSec);
    this.bootstrap.cameraRig.updateMatrixWorld(true);

    if (isVrActive && this.characterMotor.hasSpawnResolved()) {
      this.updateVrHandEmbodiment();
    }

    const mode = this.resolveAppMode();
    this.uiStore.publishMode(mode);

    if (isVrActive) {
      this.vrHud.update(this.bootstrap.xrCamera, ctx.deltaSec);
    }

    const activeCamera = isVrActive ? this.bootstrap.xrCamera : this.bootstrap.desktopCamera;
    this.recorder.capture(ctx.elapsedSec, this.avatarRig.avatar, this.avatarRig.avatarRoot, activeCamera);
    this.updateHandOverlay();
    this.present(activeCamera);
  }

  private present(camera: THREE.PerspectiveCamera): void {
    if (this.drawFrames) {
      this.bootstrap.renderer.render(this.bootstrap.scene, camera);
      this.renderSpectatorView();
      return;
    }
    // Keep the non-drawing side effects of render() so skipped frames leave
    // world matrices and the XR camera exactly as a drawn frame would.
    this.bootstrap.scene.updateMatrixWorld();
    const xr = this.bootstrap.renderer.xr;
    if (xr.isPresenting && xr.cameraAutoUpdate) {
      xr.updateCamera(camera);
    }
  }

  dispose(): void {
    this.bootstrap.renderer.setAnimationLoop(null);
    this.unbindXrSessionEndListener();
    this.unbindXrSelectListeners();
    window.removeEventListener('resize', this.onResize);
    this.input.dispose();
    this.vrHud.dispose();
    this.audioRecorder.dispose();
  }

  subscribeUi(listener: (state: UiViewModel) => void): () => void {
    return this.uiStore.subscribe(listener);
  }

  getUiState(): UiViewModel {
    return this.uiStore.getState();
  }

  requestToggleRecording(): void {
    this.toggleRecording();
  }

  private toggleRecording(): void {
    const state = this.uiStore.getState();
    if (state.recordingState === 'exporting' || (this.recordingSizeLocked && state.recordingState === 'idle')) return;

    if (state.recordingState === 'recording') {
      this.stopRecordingAndExport();
    } else {
      void this.startRecording();
    }
  }

  private async startRecording(): Promise<void> {
    this.recordingSizeLocked = true;
    this.recorder.clear();
    this.recorder.setEnabled(true);
    await this.startInputRecording();
    try {
      await this.audioRecorder.start();
    } catch {
      // Audio capture is best-effort; continue without it
    } finally {
      this.uiStore.setMicPermission(this.audioRecorder.getPermissionState());
    }
    this.uiStore.setRecordingState('recording');
  }

  private async stopRecordingAndExport(): Promise<void> {
    this.uiStore.setRecordingState('exporting', 'Exporting...');
    this.recorder.setEnabled(false);

    let audioData: { buffer: ArrayBuffer; mimeType: string } | undefined;
    if (this.audioRecorder.isRecording()) {
      try {
        audioData = await this.audioRecorder.stop();
      } catch {
        // Audio export is best-effort; continue without it
      }
    }

    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    try {
      if (!this.avatarRig.avatar) {
        throw new Error('No avatar to export');
      }
      const baseName = `avatar-recording-${Date.now()}`;
      await this.finishInputRecording(baseName);
      const blob = await this.recorder.exportToGlbBlob(this.avatarRig.avatar, this.avatarRig.worldModel, audioData);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${baseName}.glb`;
      a.click();
      URL.revokeObjectURL(url);
      this.recorder.clear();
      this.uiStore.setRecordingState('idle');
    } catch (err) {
      console.error(err);
      this.uiStore.setRecordingState('idle', (err as Error).message);
    } finally {
      this.recordingSizeLocked = false;
    }
  }

  // Development builds also keep the raw headset input behind each capture
  // recording so it can be replayed as a test fixture.
  private async startInputRecording(): Promise<void> {
    this.inputRecording = null;
    const session = this.bootstrap.renderer.xr.getSession();
    const refSpace = this.bootstrap.renderer.xr.getReferenceSpace();
    if (!import.meta.env.DEV || !session || !refSpace) return;
    try {
      const { InputRecordingSession } = await import('../debug/inputRecording');
      this.inputRecording = await InputRecordingSession.start(session, refSpace);
    } catch (error) {
      console.warn('Input recording unavailable.', error);
    }
  }

  private async finishInputRecording(baseName: string): Promise<void> {
    const inputRecording = this.inputRecording;
    this.inputRecording = null;
    if (!inputRecording) return;
    try {
      const { saveInputRecording } = await import('../debug/inputRecording');
      const savedTo = await saveInputRecording(inputRecording.finish(), baseName);
      this.uiStore.setRecordingState('exporting', `Saved headset input to ${savedTo}`);
    } catch (error) {
      console.warn('Saving input recording failed.', error);
    }
  }

  private xrSelectUnsubscribe: (() => void) | null = null;

  private bindXrSelectListeners(): void {
    if (this.xrSelectUnsubscribe) return;
    const controllers = [
      this.bootstrap.renderer.xr.getController(0),
      this.bootstrap.renderer.xr.getController(1)
    ];
    const handler = (): void => {
      if (!this.xrService.isXrPresenting()) return;
      const panel = this.vrHud.getRecordingPanel();
      if (panel) {
        for (const ctrl of controllers) {
          if (panel.isPointerOverAction(ctrl)) {
            this.toggleRecording();
            return;
          }
        }
      }
    };
    for (const ctrl of controllers) {
      ctrl.addEventListener('select', handler);
    }
    this.xrSelectUnsubscribe = () => {
      for (const ctrl of controllers) {
        ctrl.removeEventListener('select', handler);
      }
      this.xrSelectUnsubscribe = null;
    };
  }

  private mountVrRecordingPanel(): void {
    const panel = this.vrHud.getRecordingPanel();
    if (panel && !this.bootstrap.cameraRig.children.includes(panel.group)) {
      this.bootstrap.cameraRig.add(panel.group);
    }
  }

  private unmountVrRecordingPanel(): void {
    const panel = this.vrHud.getRecordingPanel();
    if (panel && panel.group.parent) {
      panel.group.parent.remove(panel.group);
    }
  }

  private unbindXrSelectListeners(): void {
    this.xrSelectUnsubscribe?.();
  }

  tick(deltaSec: number): void {
    this.elapsedSec += deltaSec;
    this.update({ deltaSec, elapsedSec: this.elapsedSec, mode: this.resolveAppMode() });
  }

  onRealtimeFrame(frame?: XRFrame): void {
    this.xrService.captureFloorHeadPose(frame);
    if (frame && this.inputRecording) this.inputRecording.recordFrame(frame);
    const deltaSec = this.bootstrap.clock.getDelta();
    if (this.manualClock) {
      // Simulation is paused for automation; keep displaying its state unless
      // the caller only needs frames to deliver XR input. Either way the frame
      // applies render()'s camera updates, so results do not depend on drawing.
      this.drawFrames = this.manualClockDraws;
      try {
        this.presentFrame();
      } finally {
        this.drawFrames = true;
      }
      return;
    }
    this.tick(deltaSec);
  }

  private presentFrame(): void {
    const isArPresenting = this.bootstrap.xrSessionMode === 'ar' && this.xrService.isXrPresenting();
    const camera = isArPresenting || this.xrService.isVrEmbodimentActive() ? this.bootstrap.xrCamera : this.bootstrap.desktopCamera;
    this.present(camera);
  }

  // Debug view for recordings: after the XR frame, redraw the page canvas from
  // a camera facing the avatar so its whole upper body and hands are visible.
  setSpectatorView(enabled: boolean): void {
    this.spectatorCamera = enabled ? (this.spectatorCamera ?? new THREE.PerspectiveCamera(38, 16 / 9, 0.01, 200)) : null;
  }

  // Two close-ups side by side, one per hand, each from in front of the
  // avatar looking back at the palm; the avatar's right hand is on the left,
  // as seen when facing the avatar.
  private renderSpectatorView(): void {
    const spectator = this.spectatorCamera;
    const renderer = this.bootstrap.renderer;
    if (!spectator || !renderer.xr.isPresenting) return;
    const width = renderer.domElement.width / renderer.getPixelRatio();
    const height = renderer.domElement.height / renderer.getPixelRatio();
    const yaw = this.camera.lookYaw;
    spectator.aspect = width / 2 / Math.max(1, height);
    spectator.updateProjectionMatrix();
    renderer.xr.enabled = false;
    renderer.setRenderTarget(null);
    renderer.setScissorTest(true);
    (['right', 'left'] as const).forEach((side, slot) => {
      const hand = this.avatarRig.getHandBoneWorldPosition(side, this.tmpVecD);
      if (!hand) return;
      spectator.position.set(hand.x - Math.sin(yaw) * 0.35, hand.y + 0.06, hand.z - Math.cos(yaw) * 0.35);
      spectator.lookAt(hand.x, hand.y + 0.02, hand.z);
      renderer.setViewport(slot * (width / 2), 0, width / 2, height);
      renderer.setScissor(slot * (width / 2), 0, width / 2, height);
      renderer.render(this.bootstrap.scene, spectator);
    });
    renderer.setScissorTest(false);
    renderer.xr.enabled = true;
  }

  setManualClock(enabled: boolean, draw = true): void {
    this.manualClock = enabled;
    this.manualClockDraws = draw;
    // Discard time that elapsed while manual so realtime resumes without a jump.
    this.bootstrap.clock.getDelta();
  }

  setAnimationLoop(callback: ((time: number, frame?: XRFrame) => void) | null): void {
    this.bootstrap.renderer.setAnimationLoop(callback);
  }

  renderGameToText(): string {
    const resolvedMode = this.resolveAppMode();
    const character = this.characterMotor.getSnapshot();
    const leftHand = this.avatarRig.getHandBoneWorldPosition('left', this.tmpVecA);
    const rightHand = this.avatarRig.getHandBoneWorldPosition('right', this.tmpVecB);

    const leftSensor = this.getHandSensorPosition('left', this.tmpVecC);
    const rightSensor = this.getHandSensorPosition('right', this.tmpVecD);

    const leftTracking = this.xrService.getHandTrackingState('left');
    const rightTracking = this.xrService.getHandTrackingState('right');

    const handSnapshot = (
      side: VrHandSide,
      tracking: ReturnType<XrSessionService['getHandTrackingState']>,
      bone: THREE.Vector3 | undefined,
      sensor: THREE.Vector3 | undefined
    ): HandPoseSnapshot => {
      const retargetDebug = this.fingerRetargeter.getDebugSnapshot(side);
      return {
        poseValid: tracking.poseValid,
        targetPosition: {
          x: tracking.targetPosition.x,
          y: tracking.targetPosition.y,
          z: tracking.targetPosition.z
        },
        targetQuaternion: {
          x: tracking.targetQuaternion.x,
          y: tracking.targetQuaternion.y,
          z: tracking.targetQuaternion.z,
          w: tracking.targetQuaternion.w
        },
        bonePosition: bone ? { x: bone.x, y: bone.y, z: bone.z } : null,
        sensorPosition: sensor ? { x: sensor.x, y: sensor.y, z: sensor.z } : null,
        jointTrackedCount: this.xrService.getTrackedFingerJointCount(side),
        fingerLocalQuaternions: this.getFingerDebugLocalQuaternions(side),
        calibrated: retargetDebug.calibrated,
        pinchDistanceMeters: retargetDebug.pinchDistanceMeters,
        fingerTips: retargetDebug.fingerTips,
        retargetDataQuality: retargetDebug.retargetDataQuality
      };
    };

    const payload = {
      mode: resolvedMode === 'desktop-third' ? 'third' : resolvedMode === 'desktop-first' ? 'first' : resolvedMode,
      character: {
        position: {
          x: character.position.x,
          y: character.position.y,
          z: character.position.z
        },
        velocityY: character.velocityY,
        grounded: character.grounded
      },
      input: {
        forward: this.input.moveState.forward,
        back: this.input.moveState.back,
        left: this.input.moveState.left,
        right: this.input.moveState.right,
        crouch: this.input.isCrouchHeld()
      },
      avatar: {
        x: this.avatarRig.avatarRoot.position.x,
        y: this.avatarRig.avatarRoot.position.y,
        z: this.avatarRig.avatarRoot.position.z,
        yaw: this.camera.lookYaw
      },
      locomotion: {
        state: this.animator.getState(),
        horizontalSpeed: character.horizontalSpeed,
        targetHorizontalSpeed: character.targetHorizontalSpeed,
        timeScale: this.animator.getCurrentTimeScale(),
        activeProfile: this.animator.getActiveProfile()
      },
      crouch: {
        amount: this.crouchAmount,
        poseAmount: this.crouchPoseAmount,
        target: this.crouchTarget,
        source: this.crouchSource
      },
      tracking: {
        left: handSnapshot('left', leftTracking, leftHand, leftSensor),
        right: handSnapshot('right', rightTracking, rightHand, rightSensor)
      },
      heightAdaptation: {
        eyeHeight: this.heightCalibration.eyeHeight ?? null,
        scale: this.avatarRig.xrHeightScale,
        avatarHeight: this.avatarRig.avatarHeight,
        minY: this.avatarRig.avatarMinLocalY,
        baseWorldY: this.avatarRig.avatarRoot.position.y + this.avatarRig.avatarMinLocalY,
        eyeWorld: this.avatarRig.getEyeAnchorWorldPosition(new THREE.Vector3(), 0),
        headWorld: this.xrService.getHeadWorldPosition(new THREE.Vector3()),
        floorHead: this.xrService.getFloorHeadPosition() ?? null,
        recordingSizeLocked: this.recordingSizeLocked
      },
      mockVr: this.xrService.getMockSnapshot()
    };

    return JSON.stringify(payload);
  }

  private getFingerDebugLocalQuaternions(side: VrHandSide): { thumb: QuatLike | null; index: QuatLike | null; middle: QuatLike | null } {
    const names = FINGER_DEBUG_BONES[side]!;
    return {
      thumb: this.getFingerDebugQuaternion(names.thumb),
      index: this.getFingerDebugQuaternion(names.index),
      middle: this.getFingerDebugQuaternion(names.middle)
    };
  }

  private getFingerDebugQuaternion(boneName: string): QuatLike | null {
    const localQuat = this.avatarRig.getBoneLocalQuaternion(boneName, this.tmpQuatD);
    if (!localQuat) return null;
    return {
      x: localQuat.x,
      y: localQuat.y,
      z: localQuat.z,
      w: localQuat.w
    };
  }

  advanceTime(ms: number): void {
    const steps = Math.max(1, Math.round(ms / (1000 / 60)));
    const stepDelta = 1 / 60;
    // Intermediate draws are pure cost. Under the manual clock realtime frames
    // draw instead, because draws outside an XR frame are never composited and
    // queue up while automation holds frames.
    for (let i = 0; i < steps; i += 1) {
      this.drawFrames = !this.manualClock && i === steps - 1;
      try {
        this.tick(stepDelta);
      } finally {
        this.drawFrames = true;
      }
    }
  }

  setMockVrPose(payload: MockVrPoseInput): void {
    const wasMockVrEnabled = this.xrService.getMockSnapshot().enabled;
    this.xrService.applyMockVrPoseInput(payload);
    const isMockVrEnabled = this.xrService.getMockSnapshot().enabled;
    if (wasMockVrEnabled !== isMockVrEnabled) {
      // Real XR head height and the debug pose use different coordinate
      // spaces, so a baseline captured before the source switch is invalid.
      this.resetVrStandingHeadBaseline();
    }
  }

  sampleHands(): Record<VrHandSide, HandSample> {
    const sample = (side: VrHandSide): HandSample => {
      const prefix = side === 'left' ? 'Left' : 'Right';
      const result: HandSample = { source: this.xrService.getHandPoseSource(side), tracked: {}, avatar: {} };
      for (const jointName of TRACKED_HAND_JOINT_NAMES) {
        if (this.xrService.getTrackedHandJointPosition(side, jointName, this.tmpVecA)) {
          result.tracked[jointName] = [this.tmpVecA.x, this.tmpVecA.y, this.tmpVecA.z];
        }
      }
      for (const [jointName, boneSuffix] of AVATAR_BONE_FOR_HAND_JOINT) {
        if (this.avatarRig.getBoneWorldPosition(`${prefix}${boneSuffix}`, this.tmpVecA)) {
          result.avatar[jointName] = [this.tmpVecA.x, this.tmpVecA.y, this.tmpVecA.z];
        }
      }
      return result;
    };
    return { left: sample('left'), right: sample('right') };
  }

  // Debug overlay of the tracked joints (cyan left, magenta right) drawn over
  // the scene, so recordings show source and avatar hands together.
  setHandOverlay(enabled: boolean): void {
    if (!enabled) {
      if (this.handOverlay) this.handOverlay.visible = false;
      return;
    }
    if (!this.handOverlay) {
      const jointCount = TRACKED_HAND_JOINT_NAMES.length;
      const material = new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: 0.85 });
      this.handOverlay = new THREE.InstancedMesh(new THREE.SphereGeometry(0.0045, 8, 6), material, jointCount * 2);
      this.handOverlay.frustumCulled = false;
      this.handOverlay.renderOrder = 999;
      const left = new THREE.Color(0x22d3ee);
      const right = new THREE.Color(0xf472b6);
      for (let i = 0; i < jointCount * 2; i += 1) this.handOverlay.setColorAt(i, i < jointCount ? left : right);
      this.bootstrap.scene.add(this.handOverlay);
    }
    this.handOverlay.visible = true;
    this.updateHandOverlay();
  }

  private updateHandOverlay(): void {
    const overlay = this.handOverlay;
    if (!overlay?.visible) return;
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    (['left', 'right'] as const).forEach((side, sideIndex) => {
      TRACKED_HAND_JOINT_NAMES.forEach((jointName, jointIndex) => {
        const index = sideIndex * TRACKED_HAND_JOINT_NAMES.length + jointIndex;
        const tracked = this.xrService.getTrackedHandJointPosition(side, jointName, this.tmpVecA);
        overlay.setMatrixAt(index, tracked ? this.overlayMatrix.makeTranslation(this.tmpVecA) : hidden);
      });
    });
    overlay.instanceMatrix.needsUpdate = true;
  }

  respawnCharacter(): boolean {
    return this.characterMotor.respawn();
  }

  setMockInput(payload: MockInputState): void {
    this.input.applyMockInput(payload);
  }

  captureHandCalibrationPose(): Record<VrHandSide, boolean> {
    return this.fingerRetargeter.captureCalibrationPose();
  }

  resetHandCalibrationPose(): void {
    this.fingerRetargeter.resetCalibrationPose();
    this.fingerRetargeter.resetRuntimeState();
    this.resetFingerQuatFallbackCalibration();
  }

  private updateHeightAdaptation(deltaSec: number, isPresenting: boolean): void {
    const realVr = isPresenting && !this.xrService.getMockSnapshot().enabled;
    const pose = realVr ? this.xrService.getFloorHeadPosition() : undefined;
    const revision = this.xrService.getHeightReferenceRevision();
    if (revision !== this.heightReferenceRevision) {
      this.heightReferenceRevision = revision;
      this.heightCalibration.interrupt();
      this.camera.reanchorFloorOrigin();
      this.resetVrStandingHeadBaseline();
    }
    if (!realVr) this.heightCalibration.reset();
    let scaleRatio = 1;
    if (!this.recordingSizeLocked) {
      if (!realVr) scaleRatio = this.avatarRig.setXrEyeHeight(undefined);
      else {
        const height = this.heightCalibration.update(pose?.y, deltaSec);
        if (height !== undefined) scaleRatio = this.avatarRig.setXrEyeHeight(height);
      }
    }
    if (scaleRatio !== 1) {
      for (const side of ['left', 'right'] as const) {
        const chain = this.armIkChains[side];
        if (chain) {
          chain.upperLength *= scaleRatio;
          chain.lowerLength *= scaleRatio;
        }
      }
    }
    this.camera.setFloorHeightMapped(realVr && this.heightCalibration.eyeHeight !== undefined, pose);
  }

  private updateCrouchState(deltaSec: number, isVrActive: boolean): void {
    const desktopTarget = this.input.isCrouchHeld() ? 1 : 0;
    const vrCrouch = computeVrCrouchTarget(
      deltaSec,
      isVrActive ? this.xrService.getCurrentHeadLocalY() : undefined,
      {
        standingHeadY: this.vrStandingHeadY,
        standingCaptured: this.vrStandingCaptured
      }
    );
    this.vrStandingHeadY = vrCrouch.baseline.standingHeadY;
    this.vrStandingCaptured = vrCrouch.baseline.standingCaptured;

    const crouchResolution = resolveCrouchTargetAndSource(isVrActive, desktopTarget, vrCrouch.vrTarget);
    this.crouchTarget = crouchResolution.target;
    this.crouchSource = crouchResolution.source;

    this.crouchAmount = stepCrouchAmount(this.crouchAmount, this.crouchTarget, deltaSec);
    this.crouchPoseAmount = computeCrouchPoseAmount(this.crouchAmount, isVrActive);
  }

  private resetVrStandingHeadBaseline(): void {
    this.vrStandingHeadY = 0;
    this.vrStandingCaptured = false;
  }

  private resolveAppMode(): AppMode {
    if (this.xrService.isMockVrOnly()) return 'mock-vr';
    if (this.xrService.isVrEmbodimentActive()) return 'vr';
    return this.camera.desktopViewMode === 'third' ? 'desktop-third' : 'desktop-first';
  }

  private async loadGltf(url: string): Promise<import('three/examples/jsm/loaders/GLTFLoader.js').GLTF> {
    return new Promise((resolve, reject) => {
      this.bootstrap.loader.load(url, resolve, undefined, reject);
    });
  }

  private initializeVrHandRig(): void {
    const leftArm = this.avatarRig.createArmIkChain('left');
    if (leftArm) this.armIkChains.left = leftArm;
    const rightArm = this.avatarRig.createArmIkChain('right');
    if (rightArm) this.armIkChains.right = rightArm;
    const leftFingers = this.avatarRig.createHandFingerRetargetChain('left');
    if (leftFingers) this.fingerRetargetChains.left = leftFingers;
    const rightFingers = this.avatarRig.createHandFingerRetargetChain('right');
    if (rightFingers) this.fingerRetargetChains.right = rightFingers;
    this.fingerRetargeter.setChain('left', this.fingerRetargetChains.left);
    this.fingerRetargeter.setChain('right', this.fingerRetargetChains.right);
    this.fingerRetargeter.resetRuntimeState();
    if (this.config.handRetargetMode === 'legacy') {
      this.resetFingerQuatFallbackCalibration();
    }
    this.vrHandRigReady = Boolean(this.armIkChains.left && this.armIkChains.right);
    if (!this.vrHandRigReady && !this.vrRigWarningLogged) {
      console.warn('VR hand embodiment disabled: missing or invalid avatar arm bones for IK chain.');
      this.vrRigWarningLogged = true;
    }
  }

  private ensureHandSensors(): void {
    const rapierWorld = this.characterMotor.getWorld();
    if (!rapierWorld) return;

    const sensorRadius = Math.max(0.05, Math.min(this.avatarRig.avatarHeight * 0.06, 0.14));
    for (const side of ['left', 'right'] as const) {
      const sensorState = this.handSensors[side];
      sensorState.radius = sensorRadius;
      if (sensorState.body) continue;

      const body = rapierWorld.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      const collider = rapierWorld.createCollider(RAPIER.ColliderDesc.ball(sensorRadius).setSensor(true), body);
      sensorState.body = body;
      sensorState.collider = collider;
    }
  }

  private setHandSensorTransform(side: VrHandSide, worldPosition: THREE.Vector3): void {
    const sensorState = this.handSensors[side];
    const rapierWorld = this.characterMotor.getWorld();
    if (!sensorState.body || !rapierWorld) return;

    sensorState.body.setTranslation({ x: worldPosition.x, y: worldPosition.y, z: worldPosition.z }, true);
    sensorState.body.setNextKinematicTranslation({ x: worldPosition.x, y: worldPosition.y, z: worldPosition.z });
    rapierWorld.propagateModifiedBodyPositionsToColliders();
  }

  private getHandSensorPosition(side: VrHandSide, out: THREE.Vector3): THREE.Vector3 | undefined {
    const body = this.handSensors[side].body;
    if (!body) return undefined;
    const p = body.translation();
    out.set(p.x, p.y, p.z);
    return out;
  }

  private updateVrHandEmbodiment(): void {
    if (!this.vrHandRigReady || !this.avatarRig.avatar) return;

    this.xrService.updateHandTrackingTargets((out) => (
      this.xrService.isXrPresenting() && !this.xrService.getMockSnapshot().enabled && this.heightCalibration.eyeHeight !== undefined
        ? this.xrService.getHeadWorldPosition(out)
        : this.avatarRig.getEyeAnchorWorldPosition(out, this.config.embodyOffset)
    ));
    this.ensureHandSensors();

    for (const side of ['left', 'right'] as const) {
      const chain = this.armIkChains[side];
      const trackingState = this.xrService.getHandTrackingState(side);
      if (!chain || !trackingState.poseValid) continue;

      const handWorld = this.resolveTrackedHandWorldQuaternion(side, chain, this.handWorldScratch);
      const solved = this.ikSolver.solve(chain, trackingState.targetPosition, trackingState.targetQuaternion, this.avatarRig.avatarRoot, handWorld);
      if (!solved) {
        if (!this.vrIkWarningLogged) {
          console.warn('VR arm IK solve produced invalid output; skipping frame write.');
          this.vrIkWarningLogged = true;
        }
        continue;
      }
      if (this.config.handRetargetMode === 'legacy') {
        this.applyTrackedFingerPoseLegacy(side);
      } else {
        this.fingerRetargeter.apply(side);
      }

      chain.hand.getWorldPosition(this.tmpHandWorld);
      if (Number.isFinite(this.tmpHandWorld.x) && Number.isFinite(this.tmpHandWorld.y) && Number.isFinite(this.tmpHandWorld.z)) {
        this.setHandSensorTransform(side, this.tmpHandWorld);
      }
    }
  }

  // Aligns the avatar palm to the tracked palm when hand joints are available,
  // replacing hand-tuned rotation offsets with a rig-independent mapping.
  private resolveTrackedHandWorldQuaternion(side: VrHandSide, chain: ArmIkChain, out: THREE.Quaternion): THREE.Quaternion | undefined {
    if (!chain.palmInHand) return undefined;
    const source = this.xrService.getHandPoseSource(side);
    if (source !== 'xr-hand' && source !== 'mock') return undefined;
    const wrist = this.palmJointScratch[0]!;
    const index = this.palmJointScratch[1]!;
    const middle = this.palmJointScratch[2]!;
    const pinky = this.palmJointScratch[3]!;
    if (
      !this.xrService.getTrackedHandJointPosition(side, 'wrist', wrist) ||
      !this.xrService.getTrackedHandJointPosition(side, 'index-finger-phalanx-proximal', index) ||
      !this.xrService.getTrackedHandJointPosition(side, 'middle-finger-phalanx-proximal', middle) ||
      !this.xrService.getTrackedHandJointPosition(side, 'pinky-finger-phalanx-proximal', pinky)
    ) {
      return undefined;
    }
    const palmWorld = palmFrameQuaternion(wrist, index, middle, pinky, out);
    return palmWorld?.multiply(this.tmpQuatB.copy(chain.palmInHand).invert()).normalize();
  }

  private applyTrackedFingerPoseLegacy(side: VrHandSide): void {
    const retarget = this.fingerRetargetChains[side];
    if (!retarget) return;

    for (const entry of retarget.entries) {
      if (!entry.bone.parent) continue;
      let applied = this.applyTrackedFingerPoseFromQuaternionLegacy(side, entry);
      if (applied) continue;

      const hasSource = this.getTrackedJointWorldPosition(side, entry.xrSourceJointNames, this.tmpVecA);
      const hasTarget = this.getTrackedJointWorldPosition(side, entry.xrTargetJointNames, this.tmpVecB);
      if (hasSource && hasTarget) {
        this.tmpVecC.subVectors(this.tmpVecB, this.tmpVecA);
        if (this.tmpVecC.lengthSq() >= 1e-8) {
          applied = this.aimFingerBoneAtDirection(entry.bone, entry.bindQuaternion, entry.bindAimInParent, this.tmpVecC);
        }
      }
    }
  }

  private getTrackedJointWorldPosition(side: VrHandSide, jointCandidates: readonly TrackedHandJointName[], out: THREE.Vector3): boolean {
    for (const jointName of jointCandidates) {
      if (!this.xrService.getTrackedHandJointPosition(side, jointName, out)) continue;
      if (Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z)) {
        return true;
      }
    }
    return false;
  }

  private applyTrackedFingerPoseFromQuaternionLegacy(side: VrHandSide, entry: HandFingerRetargetChain['entries'][number]): boolean {
    if (!entry.bone.parent) return false;
    const calibrationByBone = this.fingerQuatFallbackCalibration[side];
    let selectedJointName: TrackedHandJointName | undefined;
    let selectedParentJointName: TrackedHandJointName | undefined;

    for (const source of entry.xrQuaternionSources) {
      if (!this.xrService.getTrackedHandJointQuaternion(side, source.jointName, this.tmpQuatA)) continue;
      for (const parentJointName of source.parentJointNames) {
        if (!this.xrService.getTrackedHandJointQuaternion(side, parentJointName, this.tmpQuatB)) continue;
        selectedJointName = source.jointName;
        selectedParentJointName = parentJointName;
        break;
      }
      if (selectedJointName && selectedParentJointName) break;
    }

    if (!selectedJointName || !selectedParentJointName) {
      const calibration = calibrationByBone.get(entry.bone.uuid);
      if (calibration) {
        calibration.missingFrames += 1;
        if (calibration.missingFrames >= FINGER_QUAT_CALIBRATION_STALE_FRAMES) {
          calibrationByBone.delete(entry.bone.uuid);
        }
      }
      return false;
    }

    // Source local rotation = inverse(parentJointWorld) * jointWorld.
    this.tmpQuatC.copy(this.tmpQuatB).invert().multiply(this.tmpQuatA).normalize();
    let calibration = calibrationByBone.get(entry.bone.uuid);
    const needsRecalibration =
      !calibration ||
      calibration.jointName !== selectedJointName ||
      calibration.parentJointName !== selectedParentJointName ||
      calibration.missingFrames >= FINGER_QUAT_CALIBRATION_STALE_FRAMES;
    if (needsRecalibration) {
      const nextCalibration: FingerQuatFallbackCalibrationState = {
        jointName: selectedJointName,
        parentJointName: selectedParentJointName,
        targetFromSourceLocalQuaternion: entry.bindQuaternion.clone().multiply(this.tmpQuatD.copy(this.tmpQuatC).invert()).normalize(),
        missingFrames: 0
      };
      calibrationByBone.set(entry.bone.uuid, nextCalibration);
      calibration = nextCalibration;
    }
    if (!calibration) return false;
    calibration.missingFrames = 0;

    // Target local rotation = calibration * source local.
    this.tmpQuatA.copy(calibration.targetFromSourceLocalQuaternion).multiply(this.tmpQuatC).normalize();
    if (
      !Number.isFinite(this.tmpQuatA.x) ||
      !Number.isFinite(this.tmpQuatA.y) ||
      !Number.isFinite(this.tmpQuatA.z) ||
      !Number.isFinite(this.tmpQuatA.w)
    ) {
      return false;
    }

    entry.bone.quaternion.copy(this.tmpQuatA);
    entry.bone.updateMatrixWorld(true);
    return true;
  }

  private aimFingerBoneAtDirection(
    bone: THREE.Bone,
    bindQuaternion: THREE.Quaternion,
    bindAimInParent: THREE.Vector3,
    desiredDirectionWorld: THREE.Vector3
  ): boolean {
    if (!bone.parent || desiredDirectionWorld.lengthSq() < 1e-8) return false;
    bone.parent.getWorldQuaternion(this.tmpQuatA);
    this.tmpVecD.copy(desiredDirectionWorld).normalize();
    this.tmpVecD.applyQuaternion(this.tmpQuatB.copy(this.tmpQuatA).invert()).normalize();
    if (this.tmpVecD.lengthSq() < 1e-8) return false;

    this.tmpQuatC.setFromUnitVectors(bindAimInParent, this.tmpVecD);
    this.tmpQuatB.copy(this.tmpQuatC).multiply(bindQuaternion).normalize();
    if (
      !Number.isFinite(this.tmpQuatB.x) ||
      !Number.isFinite(this.tmpQuatB.y) ||
      !Number.isFinite(this.tmpQuatB.z) ||
      !Number.isFinite(this.tmpQuatB.w)
    ) {
      return false;
    }

    bone.quaternion.copy(this.tmpQuatB);
    bone.updateMatrixWorld(true);
    return true;
  }

  private resetFingerQuatFallbackCalibration(side?: VrHandSide): void {
    if (side) {
      this.fingerQuatFallbackCalibration[side].clear();
      return;
    }
    this.fingerQuatFallbackCalibration.left.clear();
    this.fingerQuatFallbackCalibration.right.clear();
  }

  /** AR spectator entry: transparent background, scene placed in front of the viewer. */
  private onArEntered(): void {
    this.bootstrap.scene.background = null;
    this.arWorldRecenterFramesRemaining = AR_WORLD_RECENTER_FRAMES;
    this.placeArWorldInFrontOfViewer();
  }

  /** AR spectator exit: restore desktop scene background and worldGroup position. */
  private onArExited(): void {
    this.bootstrap.scene.background = this.defaultSceneBackground;
    this.arWorldRecenterFramesRemaining = 0;
    this.bootstrap.worldGroup.position.set(0, 0, 0);
  }

  private placeArWorldInFrontOfViewer(): void {
    // Some emulators expose invalid XR camera pose data for the first frame(s).
    // Guard against NaNs so world placement stays visible and stable.
    const xrCamera = this.bootstrap.renderer.xr.getCamera();
    xrCamera.updateMatrixWorld(true);
    xrCamera.getWorldPosition(this.tmpVecA);
    if (!this.isFiniteVector3(this.tmpVecA)) {
      this.tmpVecA.set(0, 0, 0);
    }

    xrCamera.getWorldDirection(this.tmpVecB);
    if (!this.isFiniteVector3(this.tmpVecB)) {
      this.tmpVecB.set(0, 0, -1);
    }

    this.tmpVecB.y = 0;
    if (!this.isFiniteVector3(this.tmpVecB) || this.tmpVecB.lengthSq() < 1e-6) {
      this.tmpVecB.set(0, 0, -1);
    } else {
      this.tmpVecB.normalize();
    }

    // Anchor AR placement around the avatar/root spawn, not raw scene origin.
    // This keeps the meaningful content in front even when world origin is empty.
    const eyeHeight = this.resolveArEyeHeightMeters(xrCamera);
    this.tmpVecC.set(
      this.tmpVecA.x + this.tmpVecB.x * AR_INITIAL_WORLD_DISTANCE_METERS,
      this.tmpVecA.y - eyeHeight,
      this.tmpVecA.z + this.tmpVecB.z * AR_INITIAL_WORLD_DISTANCE_METERS
    );
    if (!this.isFiniteVector3(this.tmpVecC)) {
      this.tmpVecC.set(0, -eyeHeight, -AR_INITIAL_WORLD_DISTANCE_METERS);
    }

    this.tmpVecD.copy(this.avatarRig.avatarRoot.position);
    if (!this.isFiniteVector3(this.tmpVecD)) {
      this.tmpVecD.set(0, 0, 0);
    }

    this.bootstrap.worldGroup.position.copy(this.tmpVecC.sub(this.tmpVecD));
  }

  private isFiniteVector3(value: THREE.Vector3): boolean {
    return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
  }

  private resolveArEyeHeightMeters(xrCamera: THREE.ArrayCamera): number {
    const localY = xrCamera.position.y;
    if (Number.isFinite(localY) && localY >= 0.2 && localY <= 3.2) {
      return localY;
    }
    const fallback = this.avatarRig.avatarEyeLocalY + this.config.embodyOffset;
    if (Number.isFinite(fallback) && fallback >= 0.2) {
      return fallback;
    }
    return 1.65;
  }

  private readonly onResize = (): void => {
    this.camera.onResize();
  };

  private bindXrSessionEndListener(): void {
    const session = this.bootstrap.renderer.xr.getSession();
    if (!session || this.activeXrSession === session) return;

    this.unbindXrSessionEndListener();
    this.activeXrSession = session;
    this.activeXrSession.addEventListener('end', this.onNativeXrSessionEnded);
  }

  private unbindXrSessionEndListener(): void {
    if (!this.activeXrSession) return;
    this.activeXrSession.removeEventListener('end', this.onNativeXrSessionEnded);
    this.activeXrSession = null;
  }
}
