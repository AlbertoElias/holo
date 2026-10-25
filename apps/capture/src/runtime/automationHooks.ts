import type { XRDevice } from 'iwer';

import type { FaceSample } from '../face/faceTypes';
import type { FaceSnapshot } from '../face/FaceDriver';
import type { BodySample, HandSample, MockInputState, MockVrPoseInput, SpectatorViewMode, UiViewModel, VrHandSide } from '../types/contracts';
import type { TouchStick } from '../input/TouchInput';
import type { FlatHaloView } from '../ui/flatHalo';
import type { VrChromeSnapshot } from '../ui/VrChrome';
import type { HeadsetHolds } from '../xr/HeadsetHolds';
import type { HaloActionRecord } from './haloActions';

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
  __toggleFaceCamera: () => void;
  /** The chrome as drawn: the overlay's view model, the headset chrome's placement, the touch stick (slice 4 reports). */
  __sampleChrome: () => { ui: UiViewModel; vr: VrChromeSnapshot; touch: { stick: TouchStick | null; looking: number; hold: string } };
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
  /** Held marks and the Halo (slice 5): the headset modes, the take's holds, the touch hold and every committed Halo action. */
  __sampleHolds: () => HoldsSnapshot;
  /** CSS px of a world point in the flat-screen view, or null behind the camera: where a check touches to aim at it. */
  __projectToScreen: (point: readonly number[]) => { x: number; y: number } | null;
}

export interface HoldsSnapshot {
  headset: ReturnType<HeadsetHolds['snapshot']>;
  holds: { kept: number; undone: number };
  touch: string;
  flatHalo: FlatHaloView;
  actions: HaloActionRecord[];
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
