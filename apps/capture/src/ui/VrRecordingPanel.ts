import type { UiViewModel } from '../types/contracts';
import * as THREE from 'three';
import type { RecordingUiState } from '@holoim/xr-ui-core';
import { ThreeLabelPill, ThreeRecordingActionPanel } from '@holoim/xr-ui-three';

export class VrRecordingPanel {
  readonly group = new THREE.Group();
  private readonly refit = new ThreeLabelPill(0.44, 0.13);
  private refitEnabled = false;
  private readonly panel = new ThreeRecordingActionPanel();

  constructor() {
    this.group.add(this.panel.group);
    this.group.add(this.refit.group);
  }

  updateFromCamera(camera: THREE.Camera): void {
    this.panel.updateFromCamera(camera);
    // Both surfaces live under cameraRig, so include the tracked local head pose.
    this.panel.group.position.applyQuaternion(camera.quaternion).add(camera.position);
    this.refit.group.position.set(0, -0.32, -0.55).applyQuaternion(camera.quaternion).add(camera.position);
    this.refit.group.quaternion.copy(camera.quaternion);
  }

  setHovered(action: boolean, refit: boolean): void {
    this.panel.setHovered(action);
    this.refit.setHovered(refit && this.refitEnabled);
  }

  pressAction(): void {
    this.panel.press();
  }

  getActionWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    return this.panel.group.getWorldPosition(out);
  }

  isPointerOverAction(controller: THREE.Group): boolean {
    return this.panel.isPointerOverAction(controller);
  }

  isPointerOverRefit(controller: THREE.Group): boolean {
    if (!this.refitEnabled) return false;
    return this.refit.isPointerOver(controller);
  }

  updateVisuals(deltaSec: number, state: RecordingUiState, heightFit: UiViewModel['heightFit']): void {
    this.panel.update(deltaSec, state);
    this.refitEnabled = heightFit.enabled;
    this.refit.setContent({
      text: heightFit.pending ? 'Hold neutral posture…' : heightFit.enabled ? 'Refit height' : 'Refit after recording',
      background: '#14354a',
      border: '#8fcfff',
      color: heightFit.enabled ? '#f4fbff' : '#92a4af'
    });
  }
}
