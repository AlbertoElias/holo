import type { BodySample, HandSample, MockInputState, MockVrPoseInput, SpectatorViewMode, VrHandSide } from '../types/contracts';

export interface DebugBridgeAdapters {
  renderGameToText: () => string;
  advanceTime: (ms: number) => void;
  setManualClock: (enabled: boolean, draw?: boolean) => void;
  setMockVrPose: (payload: MockVrPoseInput) => void;
  setMockInput: (payload: MockInputState) => void;
  respawnCharacter: () => boolean;
  sampleHands: () => Record<VrHandSide, HandSample>;
  setHandOverlay: (enabled: boolean) => void;
  setSpectatorView: (mode: boolean | SpectatorViewMode) => void;
  setFrameStepping: (enabled: boolean, draw?: boolean) => void;
  sampleBody: () => BodySample;
  setBodyFaults: (faults: readonly string[]) => void;
  captureHandCalibrationPose: () => Record<'left' | 'right', boolean>;
  resetHandCalibrationPose: () => void;
}

export class DebugBridge {
  private readonly globalWindow = window as Window & {
    render_game_to_text?: () => string;
    advanceTime?: (ms: number) => void;
    __setManualClock?: (enabled: boolean, draw?: boolean) => void;
    __setMockVrPose?: (payload: MockVrPoseInput) => void;
    __setMockInput?: (payload: MockInputState) => void;
    __respawnCharacter?: () => boolean;
    __sampleHands?: () => Record<VrHandSide, HandSample>;
    __setHandOverlay?: (enabled: boolean) => void;
    __setSpectatorView?: (mode: boolean | SpectatorViewMode) => void;
    __setFrameStepping?: (enabled: boolean, draw?: boolean) => void;
    __sampleBody?: () => BodySample;
    __setBodyFaults?: (faults: readonly string[]) => void;
    __captureHandCalibrationPose?: () => Record<'left' | 'right', boolean>;
    __resetHandCalibrationPose?: () => void;
  };

  constructor(private readonly adapters: DebugBridgeAdapters) {}

  init(): void {
    this.globalWindow.render_game_to_text = this.adapters.renderGameToText;
    this.globalWindow.advanceTime = this.adapters.advanceTime;
    this.globalWindow.__setManualClock = this.adapters.setManualClock;
    this.globalWindow.__setMockVrPose = this.adapters.setMockVrPose;
    this.globalWindow.__setMockInput = this.adapters.setMockInput;
    this.globalWindow.__respawnCharacter = this.adapters.respawnCharacter;
    this.globalWindow.__sampleHands = this.adapters.sampleHands;
    this.globalWindow.__setHandOverlay = this.adapters.setHandOverlay;
    this.globalWindow.__setSpectatorView = this.adapters.setSpectatorView;
    this.globalWindow.__setFrameStepping = this.adapters.setFrameStepping;
    this.globalWindow.__sampleBody = this.adapters.sampleBody;
    this.globalWindow.__setBodyFaults = this.adapters.setBodyFaults;
    this.globalWindow.__captureHandCalibrationPose = this.adapters.captureHandCalibrationPose;
    this.globalWindow.__resetHandCalibrationPose = this.adapters.resetHandCalibrationPose;
  }

  dispose(): void {
    delete this.globalWindow.render_game_to_text;
    delete this.globalWindow.advanceTime;
    delete this.globalWindow.__setManualClock;
    delete this.globalWindow.__setMockVrPose;
    delete this.globalWindow.__setMockInput;
    delete this.globalWindow.__respawnCharacter;
    delete this.globalWindow.__sampleHands;
    delete this.globalWindow.__setHandOverlay;
    delete this.globalWindow.__setSpectatorView;
    delete this.globalWindow.__setFrameStepping;
    delete this.globalWindow.__sampleBody;
    delete this.globalWindow.__setBodyFaults;
    delete this.globalWindow.__captureHandCalibrationPose;
    delete this.globalWindow.__resetHandCalibrationPose;
  }
}
