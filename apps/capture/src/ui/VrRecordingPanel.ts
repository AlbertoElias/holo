import * as THREE from 'three';
import type { UiViewModel } from '../types/contracts';

/**
 * Floating 3D panel for VR recording UI.
 * Positioned in front of the user (billboard). User points with controller ray
 * and presses select to click the button.
 */
export class VrRecordingPanel {
  readonly group = new THREE.Group();
  private readonly buttonMesh: THREE.Mesh;
  private readonly tmpRay = new THREE.Ray();
  private readonly tmpRaycaster = new THREE.Raycaster();
  private readonly tmpQuat = new THREE.Quaternion();

  constructor(private getRecordingState: () => UiViewModel['recordingState']) {
    const panelWidth = 0.4;
    const panelHeight = 0.12;
    const geometry = new THREE.PlaneGeometry(panelWidth, panelHeight);
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 96;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#1a1c20';
    ctx.fillRect(0, 0, 256, 96);
    ctx.font = 'bold 24px system-ui, sans-serif';
    ctx.fillStyle = '#eceff4';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Start Recording (R)', 128, 48);
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide
    });
    this.buttonMesh = new THREE.Mesh(geometry, material);
    this.buttonMesh.name = 'VrRecordButton';
    this.group.add(this.buttonMesh);

    this.canvas = canvas;
    this.ctx = ctx;

    // Position ~0.5m in front, slightly below eye level
    this.group.position.set(0, -0.15, -0.5);
  }

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  updateFromCamera(camera: THREE.Camera): void {
    this.group.position.set(0, -0.15, -0.5);
    this.group.quaternion.copy(camera.quaternion);
  }

  /**
   * Check if the given controller ray intersects the button.
   * Controller target ray points along -Z in local space.
   */
  isPointerOverButton(controller: THREE.Group): boolean {
    controller.getWorldPosition(this.tmpRay.origin);
    this.tmpRay.direction
      .set(0, 0, -1)
      .applyQuaternion(controller.getWorldQuaternion(this.tmpQuat));
    this.tmpRaycaster.ray.copy(this.tmpRay);
    const intersects = this.tmpRaycaster.intersectObject(this.buttonMesh, true);
    return intersects.length > 0;
  }

  updateVisuals(): void {
    const state = this.getRecordingState();
    const mat = this.buttonMesh.material as THREE.MeshBasicMaterial;
    const { canvas, ctx } = this;
    ctx.fillStyle = state === 'recording' ? '#6b2a2a' : state === 'exporting' ? '#4a4a2a' : '#1a1c20';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = 'bold 24px system-ui, sans-serif';
    ctx.fillStyle = '#eceff4';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      state === 'recording' ? 'Stop Recording' : state === 'exporting' ? 'Exporting...' : 'Start Recording (R)',
      128,
      48
    );
    if (mat.map) mat.map.needsUpdate = true;
  }
}
