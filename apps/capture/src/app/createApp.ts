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

export function createApp(options: {
  orchestrator?: AppOrchestrator;
  externalFrameLoop?: boolean;
} = {}): AppRuntime {
  const orchestrator = options.orchestrator ?? new AppOrchestrator();
  const debugBridge = new DebugBridge({
    renderGameToText: () => orchestrator.renderGameToText(),
    advanceTime: (ms) => orchestrator.advanceTime(ms),
    setManualClock: (enabled, draw) => orchestrator.setManualClock(enabled, draw),
    setMockVrPose: (payload) => {
      applyIwerMockVrPoseInput(payload);
      orchestrator.setMockVrPose(payload);
    },
    setMockInput: (payload) => orchestrator.setMockInput(payload),
    respawnCharacter: () => orchestrator.respawnCharacter(),
    sampleHands: () => orchestrator.sampleHands(),
    setHandOverlay: (enabled) => orchestrator.setHandOverlay(enabled),
    setSpectatorView: (enabled) => orchestrator.setSpectatorView(enabled),
    captureHandCalibrationPose: () => orchestrator.captureHandCalibrationPose(),
    resetHandCalibrationPose: () => orchestrator.resetHandCalibrationPose()
  });
  const uiBridge: CaptureUiBridge = {
    subscribe: (listener) => orchestrator.subscribeUi(() => listener()),
    getSnapshot: () => orchestrator.getUiState(),
    toggleRecording: () => orchestrator.requestToggleRecording(),
    recenterAr: () => orchestrator.requestRecenterAr()
  };

  return {
    start: async () => {
      debugBridge.init();
      await orchestrator.init();
      if (!options.externalFrameLoop) {
        orchestrator.setAnimationLoop((_time, frame) => {
          orchestrator.onRealtimeFrame(frame);
        });
      }
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
