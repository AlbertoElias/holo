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
}

/** Installs the hooks on `window`; returns their removal. */
export function installAutomationHooks(hooks: AutomationHooks): () => void {
  const target = window as unknown as Record<string, unknown>;
  for (const [name, hook] of Object.entries(hooks)) target[name] = hook;
  return () => {
    for (const name of Object.keys(hooks)) delete target[name];
  };
}
