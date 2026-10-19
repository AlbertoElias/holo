import * as THREE from 'three';
import type { AvatarRig } from '../avatar/AvatarRig';
import { SCENE_BACKGROUND } from '../runtime/captureStage';
import { isFiniteVector3Like } from '../shared/math';

const INITIAL_WORLD_DISTANCE_METERS = 2.2;
// Emulators and devices can report unsettled poses for the first frames, so
// placement repeats for a moment after entry.
const RECENTER_FRAMES = 36;

/**
 * AR spectator: a transparent background and the recorded world placed at
 * true scale in front of the viewer, on the real floor.
 */
export class ArSpectator {
  private recenterFramesRemaining = 0;
  private readonly viewer = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly anchor = new THREE.Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly worldGroup: THREE.Group,
    private readonly avatar: AvatarRig,
    private readonly embodyOffset: number
  ) {}

  onEntered(): void {
    this.scene.background = null;
    this.recenterFramesRemaining = RECENTER_FRAMES;
    this.placeInFrontOfViewer();
  }

  onExited(): void {
    this.scene.background = new THREE.Color(SCENE_BACKGROUND);
    this.recenterFramesRemaining = 0;
    this.worldGroup.position.set(0, 0, 0);
  }

  update(): void {
    if (this.recenterFramesRemaining <= 0) return;
    this.placeInFrontOfViewer();
    this.recenterFramesRemaining -= 1;
  }

  recenter(): void {
    this.recenterFramesRemaining = 0;
    this.placeInFrontOfViewer();
  }

  private placeInFrontOfViewer(): void {
    // Some emulators expose invalid XR camera pose data for the first frame(s).
    // Guard against NaNs so world placement stays visible and stable.
    const xrCamera = this.renderer.xr.getCamera();
    xrCamera.updateMatrixWorld(true);
    xrCamera.getWorldPosition(this.viewer);
    if (!isFiniteVector3Like(this.viewer)) this.viewer.set(0, 0, 0);

    xrCamera.getWorldDirection(this.forward);
    if (!isFiniteVector3Like(this.forward)) this.forward.set(0, 0, -1);
    this.forward.y = 0;
    if (!isFiniteVector3Like(this.forward) || this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, -1);
    else this.forward.normalize();

    // Anchor placement around the avatar's spawn rather than the scene origin,
    // which can be empty, so the meaningful content is in front.
    const eyeHeight = this.resolveEyeHeightMeters(xrCamera);
    this.target.set(
      this.viewer.x + this.forward.x * INITIAL_WORLD_DISTANCE_METERS,
      this.viewer.y - eyeHeight,
      this.viewer.z + this.forward.z * INITIAL_WORLD_DISTANCE_METERS
    );
    if (!isFiniteVector3Like(this.target)) this.target.set(0, -eyeHeight, -INITIAL_WORLD_DISTANCE_METERS);

    this.anchor.copy(this.avatar.avatarRoot.position);
    if (!isFiniteVector3Like(this.anchor)) this.anchor.set(0, 0, 0);

    this.worldGroup.position.copy(this.target.sub(this.anchor));
  }

  private resolveEyeHeightMeters(xrCamera: THREE.ArrayCamera): number {
    const localY = xrCamera.position.y;
    if (Number.isFinite(localY) && localY >= 0.2 && localY <= 3.2) return localY;
    const fallback = this.avatar.avatarEyeLocalY + this.embodyOffset;
    if (Number.isFinite(fallback) && fallback >= 0.2) return fallback;
    return 1.65;
  }
}
