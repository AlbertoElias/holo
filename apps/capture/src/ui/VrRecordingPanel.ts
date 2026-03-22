import * as THREE from 'three';
import type { RecordingUiState } from '@holoim/xr-ui-core';
import { ThreeRecordingActionPanel } from '@holoim/xr-ui-three';

export class VrRecordingPanel {
  readonly group = new THREE.Group();
  private readonly panel = new ThreeRecordingActionPanel();

  constructor() {
    this.group.add(this.panel.group);
  }

  updateFromCamera(camera: THREE.Camera): void {
    this.panel.updateFromCamera(camera);
  }

  isPointerOverAction(controller: THREE.Group): boolean {
    return this.panel.isPointerOverAction(controller);
  }

  updateVisuals(deltaSec: number, state: RecordingUiState): void {
    this.panel.update(deltaSec, state);
  }
}
