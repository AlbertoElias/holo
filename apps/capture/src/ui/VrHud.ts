import type * as THREE from 'three';
import { createRecordingUiState } from '@holoim/xr-ui-core';
import type { UIStateStore } from './UIStateStore';
import { VrRecordingPanel } from './VrRecordingPanel';

interface VrHudActions {
  refitHeight: () => void;
  toggleRecording: () => void;
}

/**
 * The floating recording/refit panel in VR, under the camera rig. Controller
 * select presses act on the surface that controller points at.
 */
export class VrHud {
  readonly panel = new VrRecordingPanel();
  private unbindSelect: (() => void) | null = null;

  constructor(private readonly store: UIStateStore, private readonly renderer: THREE.WebGLRenderer, private readonly actions: VrHudActions) {}

  show(cameraRig: THREE.Group): void {
    if (!cameraRig.children.includes(this.panel.group)) cameraRig.add(this.panel.group);
    if (this.unbindSelect) return;
    const bindings = [this.renderer.xr.getController(0), this.renderer.xr.getController(1)].map((controller) => {
      const handler = (): void => {
        if (!this.renderer.xr.isPresenting) return;
        if (this.panel.isPointerOverRefit(controller)) this.actions.refitHeight();
        else if (this.panel.isPointerOverAction(controller)) this.actions.toggleRecording();
      };
      controller.addEventListener('select', handler);
      return { controller, handler };
    });
    this.unbindSelect = () => {
      for (const { controller, handler } of bindings) controller.removeEventListener('select', handler);
      this.unbindSelect = null;
    };
  }

  hide(): void {
    this.unbindSelect?.();
    this.panel.group.parent?.remove(this.panel.group);
  }

  update(camera: THREE.Camera, deltaSec: number): void {
    const state = this.store.getState();
    this.panel.updateFromCamera(camera);
    this.panel.updateVisuals(deltaSec, createRecordingUiState(state.recordingState, state.recordingMessage), state.heightFit);
  }
}
