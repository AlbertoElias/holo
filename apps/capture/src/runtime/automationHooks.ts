import type { XRDevice } from 'iwer';

import type { HumanoidBindingReport } from '../avatar/HumanoidSkeleton';
import type { FaceSample } from '../face/faceTypes';
import type { FaceSnapshot } from '../face/FaceDriver';
import type { BodySample, HandSample, MockInputState, MockVrPoseInput, SpectatorViewMode, UiViewModel, VrHandSide } from '../types/contracts';
import type { TouchStick } from '../input/TouchInput';
import type { VrChromeSnapshot } from '../ui/VrChrome';

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
  __loadObjectUrl: (url: string) => Promise<boolean>;
  __loadTrayUrls: (urls: readonly string[]) => Promise<boolean>;
  // A full face (weights and optional gaze) that overrides the camera and
  // liveness until released with null.
  __setFaceInput: (sample: FaceSample | null) => void;
  __sampleFace: () => FaceSnapshot;
  /** The avatar's canonical humanoid binding (bones, facing, disabled features), or null before load. */
  __sampleHumanoid: () => HumanoidBindingReport | null;
  __toggleFaceCamera: () => void;
  /** The chrome as drawn: the overlay's view model, the headset chrome's placement, the touch stick (slice 4 reports). */
  __sampleChrome: () => { ui: UiViewModel; vr: VrChromeSnapshot; touch: { stick: TouchStick | null; looking: number } };
  /** World position of the wrist's record glyph or a world-panel row, for checks that aim at it. */
  __chromeTarget: (target: 'record' | 'refit' | 'hand') => number[] | null;
  /** Keep the last take's samples after export so `__reexportLastTake` can export them again. */
  __setRetainLastTake: (retain: boolean) => void;
  /** The last take exported again against the scene as it is now: the GLB's bytes (base64) and size. */
  __reexportLastTake: () => Promise<{ base64: string; byteLength: number } | null>;
  /** A box in the scene model beside the avatar (chrome-flagged or plain), the live headset chrome moved into the scene model, or none. */
  __setChromeProbe: (mode: 'none' | 'flagged' | 'plain' | 'chrome') => void;
  /** Shows or hides every headset chrome object at once. */
  __setChromeVisible: (visible: boolean) => void;
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
