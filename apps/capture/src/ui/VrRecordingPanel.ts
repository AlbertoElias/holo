import { Container, Text } from '@pmndrs/uikit';
import type { UiViewModel } from '../types/contracts';
import * as THREE from 'three';
import type { RecordingUiState } from '@holoim/xr-ui-core';
import { ThreeRecordingActionPanel } from '@holoim/xr-ui-three';

export class VrRecordingPanel {
  readonly group = new THREE.Group();
  private readonly refit = new Container({ width: 340, height: 100, borderRadius: 28, backgroundColor: '#14354a', justifyContent: 'center', alignItems: 'center', depthTest: false });
  private readonly refitLabel = new Text({ text: 'Refit height', fontSize: 20, color: '#f4fbff', textAlign: 'center' });
  private refitEnabled = false;
  private readonly raycaster = new THREE.Raycaster();
  private readonly rayQuaternion = new THREE.Quaternion();
  private readonly panel = new ThreeRecordingActionPanel();

  constructor() {
    this.group.add(this.panel.group);
    this.refit.add(this.refitLabel);
    this.refit.scale.setScalar(0.0013);
    this.group.add(this.refit);
  }

  updateFromCamera(camera: THREE.Camera): void {
    this.panel.updateFromCamera(camera);
    // Both surfaces live under cameraRig, so include the tracked local head pose.
    this.panel.group.position.applyQuaternion(camera.quaternion).add(camera.position);
    this.refit.position.set(0, -0.32, -0.55).applyQuaternion(camera.quaternion).add(camera.position);
    this.refit.quaternion.copy(camera.quaternion);
  }

  isPointerOverAction(controller: THREE.Group): boolean {
    return this.panel.isPointerOverAction(controller);
  }

  isPointerOverRefit(controller: THREE.Group): boolean {
    if (!this.refitEnabled) return false;
    controller.getWorldPosition(this.raycaster.ray.origin);
    this.raycaster.ray.direction.set(0, 0, -1).applyQuaternion(controller.getWorldQuaternion(this.rayQuaternion));
    return this.raycaster.intersectObject(this.refit, true).length > 0;
  }

  updateVisuals(deltaSec: number, state: RecordingUiState, heightFit: UiViewModel['heightFit']): void {
    this.panel.update(deltaSec, state);
    this.refitEnabled = heightFit.enabled;
    this.refit.update(deltaSec * 1000);
    this.refitLabel.resetProperties({
      text: heightFit.pending ? 'Hold neutral posture…' : heightFit.enabled ? 'Refit height' : 'Refit after recording',
      fontSize: 20, color: heightFit.enabled ? '#f4fbff' : '#92a4af', textAlign: 'center'
    });
  }
}
