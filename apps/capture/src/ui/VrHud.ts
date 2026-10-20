import * as THREE from 'three';
import { createRecordingUiState } from '@holoim/xr-ui-core';
import type { XrTracking } from '../xr/XrTracking';
import type { UIStateStore } from './UIStateStore';
import { VrRecordingPanel } from './VrRecordingPanel';

interface VrHudDeps {
  store: UIStateStore;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  tracking: XrTracking;
  refitHeight: () => void;
  toggleRecording: () => void;
}

// A tracked hand this close to the record pill presses it; hand-tracked aim
// rays are unreliable on device.
const TOUCH_RADIUS_M = 0.14;
// One press per reach: a hand resting near the pill does not toggle again.
const TOUCH_REARM_SEC = 1.2;
const RAY_IDLE_LENGTH_M = 1.4;
const RAY_COLOR = 0x8fcfff;
const RAY_HOVER_COLOR = 0xffffff;

/**
 * The floating recording/refit panel in VR, under the camera rig, and its
 * interaction: controller select on the surface a controller aims at (shown
 * by an aim ray per controller), or a tracked hand touching the record pill.
 */
export class VrHud {
  readonly panel = new VrRecordingPanel();
  private unbindSelect: (() => void) | null = null;
  private rays: THREE.Line[] = [];
  private touchNear = false;
  private touchRearmAtSec = 0;
  private readonly actionCenter = new THREE.Vector3();
  private readonly rayOrigin = new THREE.Vector3();
  private readonly rayDirection = new THREE.Vector3();
  private readonly rayQuaternion = new THREE.Quaternion();

  constructor(private readonly deps: VrHudDeps) {}

  show(cameraRig: THREE.Group): void {
    if (!cameraRig.children.includes(this.panel.group)) cameraRig.add(this.panel.group);
    if (this.unbindSelect) return;
    const xr = this.deps.renderer.xr;
    const bindings = [xr.getController(0), xr.getController(1)].map((controller) => {
      const handler = (): void => {
        if (!xr.isPresenting) return;
        if (this.panel.isPointerOverRefit(controller)) {
          this.deps.refitHeight();
        } else if (this.panel.isPointerOverAction(controller)) {
          this.panel.pressAction();
          this.deps.toggleRecording();
        }
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

  update(camera: THREE.Camera, deltaSec: number, elapsedSec: number): void {
    const state = this.deps.store.getState();
    this.panel.updateFromCamera(camera);
    this.panel.updateVisuals(deltaSec, createRecordingUiState(state.recordingState, state.recordingMessage), state.heightFit);
    this.updateTouch(elapsedSec);
    this.updateAimRays();
  }

  private updateTouch(elapsedSec: number): void {
    this.panel.getActionWorldPosition(this.actionCenter);
    let near = false;
    for (const side of ['left', 'right'] as const) {
      const hand = this.deps.tracking.getHandTrackingState(side);
      if (hand.poseValid && hand.targetPosition.distanceTo(this.actionCenter) < TOUCH_RADIUS_M) near = true;
    }
    if (near && !this.touchNear && elapsedSec >= this.touchRearmAtSec) {
      this.touchRearmAtSec = elapsedSec + TOUCH_REARM_SEC;
      this.panel.pressAction();
      this.deps.toggleRecording();
    }
    this.touchNear = near;
  }

  // One visible aim ray per controller, shortened to the panel and brightened
  // while it points at a pill.
  private updateAimRays(): void {
    if (this.rays.length === 0) this.rays = [this.createRay(), this.createRay()];
    const xr = this.deps.renderer.xr;
    let hoverAction = false;
    let hoverRefit = false;
    this.rays.forEach((ray, index) => {
      const controller = xr.getController(index);
      controller.getWorldPosition(this.rayOrigin);
      this.rayDirection.set(0, 0, -1).applyQuaternion(controller.getWorldQuaternion(this.rayQuaternion)).normalize();
      const overAction = this.panel.isPointerOverAction(controller);
      const overRefit = this.panel.isPointerOverRefit(controller);
      hoverAction ||= overAction;
      hoverRefit ||= overRefit;
      const hovering = overAction || overRefit;
      const length = hovering ? Math.max(0.1, this.rayOrigin.distanceTo(this.actionCenter)) : RAY_IDLE_LENGTH_M;
      const positions = ray.geometry.getAttribute('position') as THREE.BufferAttribute;
      positions.setXYZ(0, this.rayOrigin.x, this.rayOrigin.y, this.rayOrigin.z);
      positions.setXYZ(1, this.rayOrigin.x + this.rayDirection.x * length, this.rayOrigin.y + this.rayDirection.y * length, this.rayOrigin.z + this.rayDirection.z * length);
      positions.needsUpdate = true;
      (ray.material as THREE.LineBasicMaterial).color.set(hovering ? RAY_HOVER_COLOR : RAY_COLOR);
      ray.visible = xr.isPresenting;
    });
    this.panel.setHovered(hoverAction, hoverRefit);
  }

  private createRay(): THREE.Line {
    const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
    const ray = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: RAY_COLOR, transparent: true, opacity: 0.85, depthTest: false }));
    ray.renderOrder = 998;
    ray.frustumCulled = false;
    this.deps.scene.add(ray);
    return ray;
  }
}
