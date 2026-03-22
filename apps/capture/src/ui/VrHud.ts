import type { Camera } from 'three';
import { createRecordingUiState } from '@holoim/xr-ui-core';
import type { UIStateStore } from './UIStateStore';
import { VrRecordingPanel } from './VrRecordingPanel';

export class VrHud {
  private recordingPanel: VrRecordingPanel | null = null;

  constructor(private readonly store: UIStateStore) {}

  init(): void {
    this.recordingPanel = new VrRecordingPanel();
  }

  getRecordingPanel(): VrRecordingPanel | null {
    return this.recordingPanel;
  }

  update(camera: Camera, deltaSec: number): void {
    this.recordingPanel?.updateFromCamera(camera);
    this.recordingPanel?.updateVisuals(deltaSec, this.getRecordingState());
  }

  dispose(): void {
    this.recordingPanel = null;
  }

  private getRecordingState() {
    const state = this.store.getState();
    return createRecordingUiState(state.recordingState, state.recordingMessage);
  }
}
