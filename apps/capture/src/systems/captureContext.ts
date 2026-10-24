import type * as THREE from 'three';
import type { World } from '@iwsdk/core';
import type { LocomotionAnimator } from '../animation/LocomotionAnimator';
import type { TerrainLegSolver } from '../animation/TerrainLegSolver';
import type { AvatarRig } from '../avatar/AvatarRig';
import type { BodyTracking } from '../body/BodyTracking';
import type { CrouchState } from '../body/crouch';
import type { CameraController } from '../camera/CameraController';
import type { RuntimeConfig } from '../config/runtimeConfig';
import type { DiagnosticViews } from '../debug/DiagnosticViews';
import type { FaceDriver } from '../face/FaceDriver';
import type { DesktopPointAction } from '../input/DesktopPointAction';
import type { InputController } from '../input/InputController';
import type { VrLocomotion } from '../input/VrLocomotion';
import type { CharacterMotor } from '../physics/CharacterMotor';
import type { RecordingSession } from '../recording/RecordingSession';
import type { CaptureStage } from '../runtime/captureStage';
import type { ClockMode } from '../runtime/FrameLoop';
import type { XrEntry } from '../runtime/xrEntry';
import type { AppMode, CharacterSnapshot } from '../types/contracts';
import type { UIStateStore } from '../ui/UIStateStore';
import type { VrHud } from '../ui/VrHud';
import type { ArSpectator } from '../xr/ArSpectator';
import type { HandEmbodiment } from '../xr/HandEmbodiment';
import type { HeightFit } from '../xr/HeightFit';
import type { XrTracking } from '../xr/XrTracking';

/** Facts about the current simulation step, written once by their owner. */
export interface CaptureFrame {
  deltaSec: number;
  // Simulation time: the sum of all step deltas (recording timestamps).
  elapsedSec: number;
  steps: number;
  // Written by XrSessionSystem.
  xrPresenting: boolean;
  // An AR session presents: only the spectator runs; later systems skip.
  arSpectator: boolean;
  // VR embodiment, from a real session or the mock pose hook.
  vrActive: boolean;
  // Real-XR body solver active with a valid head this step.
  bodyTracking: boolean;
  // Written by MovementSystem after the character motor steps.
  character: CharacterSnapshot | null;
}

/** Capture's services: typed owners of Three, Rapier and domain state. */
export interface CaptureContext {
  config: RuntimeConfig;
  stage: CaptureStage;
  xrEntry: XrEntry;
  avatar: AvatarRig;
  motor: CharacterMotor;
  camera: CameraController;
  tracking: XrTracking;
  input: InputController;
  point: DesktopPointAction;
  locomotion: VrLocomotion;
  body: BodyTracking;
  heightFit: HeightFit;
  crouch: CrouchState;
  hands: HandEmbodiment;
  face: FaceDriver;
  animator: LocomotionAnimator;
  terrainLegs: TerrainLegSolver;
  ar: ArSpectator;
  ui: UIStateStore;
  vrHud: VrHud;
  recording: RecordingSession;
  diagnostics: DiagnosticViews;
  frame: CaptureFrame;
  clockMode: () => ClockMode;
}

export function captureContext(world: World): CaptureContext {
  return world.globals.capture as CaptureContext;
}

export function resolveAppMode(c: CaptureContext): AppMode {
  if (c.tracking.isMockVrOnly()) return 'mock-vr';
  if (c.tracking.isVrEmbodimentActive()) return 'vr';
  return c.camera.desktopViewMode === 'third' ? 'desktop-third' : 'desktop-first';
}

/** The camera the frame draws with and recordings sample from. */
export function activeCamera(c: CaptureContext): THREE.PerspectiveCamera {
  const arPresenting = c.xrEntry.sessionMode === 'ar' && c.tracking.isXrPresenting();
  return arPresenting || c.tracking.isVrEmbodimentActive() ? c.stage.xrCamera : c.stage.desktopCamera;
}
