import type { XRDevice } from 'iwer';

import type { HumanoidBindingReport } from '../avatar/HumanoidSkeleton';
import type { FaceSample } from '../face/faceTypes';
import type { FaceSnapshot } from '../face/FaceDriver';
import type { BodySample, HandSample, MockInputState, MockVrPoseInput, SpectatorViewMode, UiViewModel, VrHandSide } from '../types/contracts';
import type { TouchStick } from '../input/TouchInput';
import type { FlatHaloView } from '../ui/flatHalo';
import type { PointResolutionReport } from '../recording/PointResolver';
import type { PhoneArChromeProbe } from '../ui/PhoneArChrome';
import type { ChromeTarget, VrChromeSnapshot } from '../ui/VrChrome';
import type { prefetchStats } from '../objects/objectSearch';
import type { ObjectSearchState } from '../objects/objectSearchSession';
import type { voiceLog } from '../objects/voiceInput';
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
  /** The avatar's canonical humanoid binding (bones, facing, disabled features), or null before load. */
  __sampleHumanoid: () => HumanoidBindingReport | null;
  __toggleFaceCamera: () => void;
  /** The chrome as drawn: the overlay's view model, the headset chrome's placement, the touch stick (slice 4 reports). */
  __sampleChrome: () => { ui: UiViewModel; vr: VrChromeSnapshot; touch: { stick: TouchStick | null; looking: number; hold: string } };
  /** The phone camera author's bottom dock (button positions and visibility) and status line, or built: false. */
  __samplePhoneChrome: () => PhoneArChromeProbe;
  /** World position of a phone tray row slot's hit area (1-5), or null while the row is closed: where a check taps it. */
  __phoneTraySlotPosition: (slot: number) => number[] | null;
  /** World position of a headset tray miniature's Close ring (1-5), or null while it is hidden (docs/features/tray-remove.md). */
  __trayClosePosition: (slot: number) => number[] | null;
  /** World position of a phone AR tray slot's Close glyph (1-5), or null while the row is closed. */
  __phoneTrayClosePosition: (slot: number) => number[] | null;
  /** World position of the wrist's record glyph or a world-panel row, for checks that aim at it. */
  __chromeTarget: (target: ChromeTarget) => number[] | null;
  /** Find (PRD-060): the headset panel's search state, voice paths taken, and GLB prefetches. */
  __sampleObjectSearch: () => { headset: ObjectSearchState; voiceLog: typeof voiceLog; prefetch: typeof prefetchStats };
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
  /** Record or Stop, through the same `recording.toggle()` the dock, the key and the wrist glyph reach. */
  __toggleRecording: () => void;
  /** What point resolution decided at the latest camera take's export (holds, referents, "no referent"), or null. */
  __lastPointReport: () => PointResolutionReport | null;
  /** `worldGroup.matrixWorld` (column-major, 16 numbers): the set's frame in the room, for scripting a camera walk in the set's frame. */
  __arWorldFrame: () => number[];
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
