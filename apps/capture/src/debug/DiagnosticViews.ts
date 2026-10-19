import * as THREE from 'three';
import type { AvatarRig } from '../avatar/AvatarRig';
import { TRACKED_HAND_JOINT_NAMES, type SpectatorViewMode } from '../types/contracts';
import type { XrSessionService } from '../xr/XrSessionService';
import { HeightEvidenceView } from './HeightEvidenceView';

const HEAD_PATH_POINTS = 150;

interface DiagnosticViewsDeps {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  worldGroup: THREE.Group;
  avatar: AvatarRig;
  tracking: XrSessionService;
  getLookYaw: () => number;
  getBodyYaw: () => number;
  getHud: () => THREE.Object3D;
}

/**
 * Debug views for recordings and evidence. Overlays follow the simulation each
 * step; the extra views draw to the page canvas after the XR frame's draw and
 * never change simulation state.
 */
export class DiagnosticViews {
  private handOverlay: THREE.InstancedMesh | null = null;
  private heightEvidence: HeightEvidenceView | null = null;
  private spectatorCamera: THREE.PerspectiveCamera | null = null;
  private spectatorMode: SpectatorViewMode = 'off';
  private readonly spectatorFocus = new THREE.Vector3();
  private spectatorFocusReady = false;
  private spectatorViewYaw = 0;
  private headPathLine: THREE.Line | null = null;
  private headMarker: THREE.Mesh | null = null;
  private eyeMarker: THREE.Mesh | null = null;
  private headPathCount = 0;
  private readonly overlayMatrix = new THREE.Matrix4();
  private readonly tmpVec = new THREE.Vector3();

  constructor(private readonly deps: DiagnosticViewsDeps) {}

  setHeightEvidenceView(enabled: boolean): void {
    this.heightEvidence = enabled ? new HeightEvidenceView() : null;
  }

  // 'hands' shows both hands close up; 'body' follows the avatar from a fixed
  // world direction with the tracked head path overlaid.
  setSpectatorView(mode: boolean | SpectatorViewMode): void {
    this.spectatorMode = mode === true ? 'hands' : mode === false ? 'off' : mode;
    this.spectatorCamera = this.spectatorMode === 'off' ? null : (this.spectatorCamera ?? new THREE.PerspectiveCamera(38, 16 / 9, 0.01, 200));
    this.spectatorFocusReady = false;
    this.headPathCount = 0;
    if (this.spectatorMode === 'body') this.ensureHeadPathOverlay();
    this.setHeadPathOverlayVisible(false);
  }

  // Tracked joints (cyan left, magenta right) drawn over the scene, so
  // recordings show source and avatar hands together.
  setHandOverlay(enabled: boolean): void {
    if (!enabled) {
      if (this.handOverlay) this.handOverlay.visible = false;
      return;
    }
    if (!this.handOverlay) {
      const jointCount = TRACKED_HAND_JOINT_NAMES.length;
      const material = new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: 0.85 });
      this.handOverlay = new THREE.InstancedMesh(new THREE.SphereGeometry(0.0045, 8, 6), material, jointCount * 2);
      this.handOverlay.frustumCulled = false;
      this.handOverlay.renderOrder = 999;
      const left = new THREE.Color(0x22d3ee);
      const right = new THREE.Color(0xf472b6);
      for (let i = 0; i < jointCount * 2; i += 1) this.handOverlay.setColorAt(i, i < jointCount ? left : right);
      this.deps.scene.add(this.handOverlay);
    }
    this.handOverlay.visible = true;
    this.updateHandOverlay();
  }

  /** Follows the simulation after each step. */
  update(): void {
    this.updateHeadPathOverlay();
    this.updateHandOverlay();
  }

  /** Extra views after the main draw; only while an XR session presents. */
  render(): void {
    const { renderer, scene } = this.deps;
    if (this.heightEvidence && renderer.xr.isPresenting) {
      this.heightEvidence.render(renderer, scene, this.deps.worldGroup, this.deps.avatar, this.deps.tracking.getHeadWorldPosition(new THREE.Vector3()), this.deps.getHud());
      return;
    }
    const spectator = this.spectatorCamera;
    if (!spectator || !renderer.xr.isPresenting) return;
    const width = renderer.domElement.width / renderer.getPixelRatio();
    const height = renderer.domElement.height / renderer.getPixelRatio();
    renderer.xr.enabled = false;
    renderer.setRenderTarget(null);
    if (this.spectatorMode === 'body') this.renderBodySpectator(spectator, width, height);
    else this.renderHandsSpectator(spectator, width, height);
    renderer.xr.enabled = true;
  }

  // Two close-ups side by side, one per hand, each from in front of the
  // avatar looking back at the palm; the avatar's right hand is on the left,
  // as seen when facing the avatar.
  private renderHandsSpectator(spectator: THREE.PerspectiveCamera, width: number, height: number): void {
    const { renderer, scene, avatar } = this.deps;
    const yaw = this.deps.getLookYaw();
    spectator.aspect = width / 2 / Math.max(1, height);
    spectator.updateProjectionMatrix();
    renderer.setScissorTest(true);
    (['right', 'left'] as const).forEach((side, slot) => {
      const hand = avatar.getHandBoneWorldPosition(side, this.tmpVec);
      if (!hand) return;
      spectator.position.set(hand.x - Math.sin(yaw) * 0.35, hand.y + 0.06, hand.z - Math.cos(yaw) * 0.35);
      spectator.lookAt(hand.x, hand.y + 0.02, hand.z);
      renderer.setViewport(slot * (width / 2), 0, width / 2, height);
      renderer.setScissor(slot * (width / 2), 0, width / 2, height);
      renderer.render(scene, spectator);
    });
    renderer.setScissorTest(false);
  }

  // Third person, front-left of where the avatar first faced, so turns,
  // crouches, and steps read clearly; the camera only follows position.
  private renderBodySpectator(spectator: THREE.PerspectiveCamera, width: number, height: number): void {
    const { renderer, scene, avatar } = this.deps;
    const root = avatar.avatarRoot.position;
    if (!this.spectatorFocusReady) {
      this.spectatorFocus.copy(root);
      this.spectatorFocusReady = true;
    }
    this.spectatorFocus.lerp(root, 0.08);
    const distance = avatar.avatarHeight * 2.1;
    spectator.aspect = width / Math.max(1, height);
    spectator.updateProjectionMatrix();
    spectator.position.set(
      this.spectatorFocus.x - Math.sin(this.spectatorViewYaw) * distance,
      this.spectatorFocus.y + avatar.avatarHeight * 0.75,
      this.spectatorFocus.z - Math.cos(this.spectatorViewYaw) * distance
    );
    spectator.lookAt(this.spectatorFocus.x, this.spectatorFocus.y + avatar.avatarHeight * 0.45, this.spectatorFocus.z);
    renderer.setViewport(0, 0, width, height);
    avatar.setFirstPersonVisualState('off');
    this.setHeadPathOverlayVisible(true);
    renderer.render(scene, spectator);
    this.setHeadPathOverlayVisible(false);
    avatar.setFirstPersonVisualState('vr');
  }

  private ensureHeadPathOverlay(): void {
    if (this.headPathLine) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(HEAD_PATH_POINTS * 3), 3));
    geometry.setDrawRange(0, 0);
    const overlay = (color: number) => new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 });
    this.headPathLine = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0x22d3ee, depthTest: false, transparent: true }));
    this.headPathLine.frustumCulled = false;
    this.headMarker = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), overlay(0x22d3ee));
    this.eyeMarker = new THREE.Mesh(new THREE.SphereGeometry(0.02, 12, 8), overlay(0xf472b6));
    for (const object of [this.headPathLine, this.headMarker, this.eyeMarker]) {
      object.renderOrder = 999;
      object.visible = false;
      this.deps.scene.add(object);
    }
  }

  private setHeadPathOverlayVisible(visible: boolean): void {
    for (const object of [this.headPathLine, this.headMarker, this.eyeMarker]) {
      if (object) object.visible = visible;
    }
  }

  // Cyan: the tracked eyes' recent path and current position; pink: the
  // avatar's eye midpoint.
  private updateHeadPathOverlay(): void {
    if (this.spectatorMode !== 'body' || !this.headPathLine || !this.headMarker || !this.eyeMarker) return;
    const pose = this.deps.tracking.getHeadPose();
    if (!pose.valid) return;
    if (this.headPathCount === 0) this.spectatorViewYaw = this.deps.getBodyYaw() + Math.PI * 0.25;
    const positions = this.headPathLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (this.headPathCount === HEAD_PATH_POINTS) {
      positions.array.copyWithin(0, 3);
      this.headPathCount -= 1;
    }
    positions.setXYZ(this.headPathCount, pose.worldPosition.x, pose.worldPosition.y, pose.worldPosition.z);
    this.headPathCount += 1;
    positions.needsUpdate = true;
    this.headPathLine.geometry.setDrawRange(0, this.headPathCount);
    this.headMarker.position.copy(pose.worldPosition);
    this.deps.avatar.getEyeAnchorWorldPosition(this.eyeMarker.position, 0);
  }

  private updateHandOverlay(): void {
    const overlay = this.handOverlay;
    if (!overlay?.visible) return;
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    (['left', 'right'] as const).forEach((side, sideIndex) => {
      TRACKED_HAND_JOINT_NAMES.forEach((jointName, jointIndex) => {
        const index = sideIndex * TRACKED_HAND_JOINT_NAMES.length + jointIndex;
        const tracked = this.deps.tracking.getTrackedHandJointPosition(side, jointName, this.tmpVec);
        overlay.setMatrixAt(index, tracked ? this.overlayMatrix.makeTranslation(this.tmpVec) : hidden);
      });
    });
    overlay.instanceMatrix.needsUpdate = true;
  }
}
