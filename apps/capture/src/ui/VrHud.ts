import type { Camera } from 'three';
import type { UIStateStore } from './UIStateStore';
import { VrRecordingPanel } from './VrRecordingPanel';

export class VrHud {
  private recordingPanel: VrRecordingPanel | null = null;

  constructor(private readonly store: UIStateStore) {}

  init(): void {
    this.recordingPanel = new VrRecordingPanel(
      () => this.store.getState().recordingState
    );
  }

  getRecordingPanel(): VrRecordingPanel | null {
    return this.recordingPanel;
  }

  update(camera: Camera): void {
    this.recordingPanel?.updateFromCamera(camera);
    this.recordingPanel?.updateVisuals();
  }

  dispose(): void {
    this.recordingPanel = null;
  }
}
