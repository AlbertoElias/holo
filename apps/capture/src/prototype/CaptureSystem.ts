import { createComponent, createSystem, Types, type Entity } from '@iwsdk/core';
import type { AppOrchestrator } from '../app/AppOrchestrator';

// Observation surface only: the retained capture algorithms own these values.
export const CaptureState = createComponent('CaptureState', {
  steps: { type: Types.Int32, default: 0 },
  elapsedSec: { type: Types.Float64, default: 0 },
  mode: { type: Types.String, default: 'loading' },
  x: { type: Types.Float64, default: 0 },
  y: { type: Types.Float64, default: 0 },
  z: { type: Types.Float64, default: 0 },
  grounded: { type: Types.Boolean, default: false },
  recording: { type: Types.String, default: 'idle' }
});

export class CaptureSystem extends createSystem({ captures: { required: [CaptureState] } }) {
  private capture: AppOrchestrator | undefined;
  private state: Entity | undefined;

  attach(capture: AppOrchestrator, state: Entity): void {
    this.capture = capture;
    this.state = state;
  }

  update(deltaSec: number): void {
    if (!this.capture) return;
    // This compatibility layer stays together until the locomotion fixes land.
    // Running inside ECS makes native pause/step control actual simulation.
    this.capture.onRealtimeFrame(this.world.xrFrame ?? undefined, deltaSec);
    this.publish();
  }

  publish(): void {
    if (!this.capture || !this.state) return;
    const snapshot = this.capture.getSimulationSnapshot();
    this.state.setValue(CaptureState, 'steps', snapshot.steps);
    this.state.setValue(CaptureState, 'elapsedSec', snapshot.elapsedSec);
    this.state.setValue(CaptureState, 'mode', snapshot.mode);
    this.state.setValue(CaptureState, 'x', snapshot.x);
    this.state.setValue(CaptureState, 'y', snapshot.y);
    this.state.setValue(CaptureState, 'z', snapshot.z);
    this.state.setValue(CaptureState, 'grounded', snapshot.grounded);
    this.state.setValue(CaptureState, 'recording', snapshot.recording);
  }
}
