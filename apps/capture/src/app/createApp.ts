import { AppOrchestrator } from './AppOrchestrator';
import { DebugBridge } from '../debug/DebugBridge';
import { applyIwerMockVrPoseInput } from '../debug/iwerRuntime';
import type { CaptureUiBridge } from '../ui/captureUiBridge';

export interface AppRuntime {
  start: () => Promise<void>;
  tick: (deltaSec: number) => void;
  dispose: () => void;
  uiBridge: CaptureUiBridge;
}

export function createApp(): AppRuntime {
  const orchestrator = new AppOrchestrator();
  const debugBridge = new DebugBridge({
    renderGameToText: () => orchestrator.renderGameToText(),
    advanceTime: (ms) => orchestrator.advanceTime(ms),
    setMockVrPose: (payload) => {
      applyIwerMockVrPoseInput(payload);
      orchestrator.setMockVrPose(payload);
    },
    setMockInput: (payload) => orchestrator.setMockInput(payload),
    captureHandCalibrationPose: () => orchestrator.captureHandCalibrationPose(),
    resetHandCalibrationPose: () => orchestrator.resetHandCalibrationPose()
  });
  const uiBridge: CaptureUiBridge = {
    subscribe: (listener) => orchestrator.subscribeUi(() => listener()),
    getSnapshot: () => orchestrator.getUiState(),
    toggleRecording: () => orchestrator.requestToggleRecording()
  };

  return {
    start: async () => {
      debugBridge.init();
      await orchestrator.init();
      orchestrator.setAnimationLoop(() => {
        orchestrator.tick(orchestrator.getDeltaFromClock());
      });
    },
    tick: (deltaSec: number) => {
      orchestrator.tick(deltaSec);
    },
    dispose: () => {
      debugBridge.dispose();
      orchestrator.dispose();
    },
    uiBridge
  };
}
