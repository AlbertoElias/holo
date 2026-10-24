import type { XRDevice } from 'iwer';

import type { FaceSample } from '../face/faceTypes';
import type { FaceSnapshot } from '../face/FaceDriver';
import type { BodySample, HandSample, MockInputState, MockVrPoseInput, SpectatorViewMode, VrHandSide } from '../types/contracts';

/**
 * Page functions the deterministic XR checks drive. Every one acts through
 * the production pipeline: clock adapters step the same systems and draws.
 */
export interface AutomationHooks {
  render_game_to_text: () => string;
  advanceTime: (ms: number) => void;
  __setManualClock: (enabled: boolean, draw?: boolean) => void;
  __setFrameStepping: (enabled: boolean, draw?: boolean) => void;
  __setMockVrPose: (payload: MockVrPoseInput) => void;
  __setMockInput: (payload: MockInputState) => void;
  __respawnCharacter: () => boolean;
  __sampleHands: () => Record<VrHandSide, HandSample>;
  __sampleBody: () => BodySample;
  __setBodyFaults: (faults: readonly string[]) => void;
  __setHandOverlay: (enabled: boolean) => void;
  __setHeightEvidenceView: (enabled: boolean) => void;
  __setSpectatorView: (mode: boolean | SpectatorViewMode) => void;
  __captureHandCalibrationPose: () => Record<VrHandSide, boolean>;
  __resetHandCalibrationPose: () => void;
  // A full face (weights and optional gaze) that overrides the camera and
  // liveness until released with null.
  __setFaceInput: (sample: FaceSample | null) => void;
  __sampleFace: () => FaceSnapshot;
  __toggleFaceCamera: () => void;
}

/**
 * Hooks on `window`, typed once for the app and for the XR checks in
 * `scripts/`, whose `page.evaluate` callbacks call them. The automation hooks
 * exist once `installAutomationHooks` has run (checks wait for them with
 * `waitForPageFunctions`); `IWER_DEVICE` exists only under the IWER emulator.
 */
declare global {
  interface Window extends AutomationHooks {
    IWER_DEVICE?: XRDevice;
  }
}

export function installAutomationHooks(hooks: AutomationHooks): void {
  Object.assign(window, hooks);
}
