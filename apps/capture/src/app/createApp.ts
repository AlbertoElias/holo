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
    setManualClock: (enabled, draw) => orchestrator.setManualClock(enabled, draw),
    setMockVrPose: (payload) => {
      applyIwerMockVrPoseInput(payload);
      orchestrator.setMockVrPose(payload);
    },
    setMockInput: (payload) => orchestrator.setMockInput(payload),
    respawnCharacter: () => orchestrator.respawnCharacter(),
    sampleHands: () => orchestrator.sampleHands(),
    setHandOverlay: (enabled) => orchestrator.setHandOverlay(enabled),
    setSpectatorView: (mode) => orchestrator.setSpectatorView(mode),
    setFrameStepping: (enabled, draw) => orchestrator.setFrameStepping(enabled, draw),
    sampleBody: () => orchestrator.sampleBody(),
    setBodyFaults: (faults) => orchestrator.setBodyFaults(faults),
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
      // Automation: ?manualClock=1 never ticks on real time, so a replay starts
      // from the same state on any host (see __setFrameStepping).
      if (new URLSearchParams(window.location.search).get('manualClock') === '1') {
        orchestrator.setManualClock(true, false);
      }
      await orchestrator.init();
      orchestrator.setAnimationLoop((_time, frame) => {
        orchestrator.onRealtimeFrame(frame);
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
