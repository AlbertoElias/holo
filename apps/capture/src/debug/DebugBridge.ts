import type { MockInputState, MockVrPoseInput } from '../types/contracts';

export interface DebugBridgeAdapters {
  renderGameToText: () => string;
  advanceTime: (ms: number) => void;
  setMockVrPose: (payload: MockVrPoseInput) => void;
  setMockInput: (payload: MockInputState) => void;
  captureHandCalibrationPose: () => Record<'left' | 'right', boolean>;
  resetHandCalibrationPose: () => void;
}

export class DebugBridge {
  private readonly globalWindow = window as Window & {
    render_game_to_text?: () => string;
    advanceTime?: (ms: number) => void;
    __setMockVrPose?: (payload: MockVrPoseInput) => void;
    __setMockInput?: (payload: MockInputState) => void;
    __captureHandCalibrationPose?: () => Record<'left' | 'right', boolean>;
    __resetHandCalibrationPose?: () => void;
  };

  constructor(private readonly adapters: DebugBridgeAdapters) {}

  init(): void {
    this.globalWindow.render_game_to_text = this.adapters.renderGameToText;
    this.globalWindow.advanceTime = this.adapters.advanceTime;
    this.globalWindow.__setMockVrPose = this.adapters.setMockVrPose;
    this.globalWindow.__setMockInput = this.adapters.setMockInput;
    this.globalWindow.__captureHandCalibrationPose = this.adapters.captureHandCalibrationPose;
    this.globalWindow.__resetHandCalibrationPose = this.adapters.resetHandCalibrationPose;
  }

  dispose(): void {
    delete this.globalWindow.render_game_to_text;
    delete this.globalWindow.advanceTime;
    delete this.globalWindow.__setMockVrPose;
    delete this.globalWindow.__setMockInput;
    delete this.globalWindow.__captureHandCalibrationPose;
    delete this.globalWindow.__resetHandCalibrationPose;
  }
}
