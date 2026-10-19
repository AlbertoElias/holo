import * as THREE from 'three';
import { clamp } from '../shared/math';
import type { AvatarRig } from '../avatar/AvatarRig';
import type { DesktopViewMode } from '../types/contracts';

interface CameraControllerDeps {
  renderer: THREE.WebGLRenderer;
  xrCamera: THREE.PerspectiveCamera;
  desktopCamera: THREE.PerspectiveCamera;
  cameraRig: THREE.Group;
  avatarRig: AvatarRig;
  embodyOffset: number;
}

export class CameraController {
  desktopViewMode: DesktopViewMode = 'third';
  lookYaw = 0;
  thirdPersonPitch = 0.32;
  firstPersonPitch = 0;

  private snapDesktopCameraAfterVrExit = false;
  private postVrExitSnapFrames = 0;
  private postVrForceThirdFrames = 0;
  private floorHeightMapped = false;
  private floorOriginPending = true;
  private readonly floorOrigin = new THREE.Vector2();

  reanchorFloorOrigin(): void {
    this.floorOriginPending = true;
  }

  setFloorHeightMapped(enabled: boolean, head?: { x: number; z: number }): void {
    if (enabled && head && (!this.floorHeightMapped || this.floorOriginPending)) {
      this.floorOrigin.set(head.x, head.z);
      this.floorOriginPending = false;
    }
    this.floorHeightMapped = enabled;
  }

  private xrInitialHeadY = 0;
  private xrInitialHeadCaptured = false;

  private readonly tmpEyeAnchor = new THREE.Vector3();
  private readonly tmpForward = new THREE.Vector3();
  private readonly tmpDesiredCam = new THREE.Vector3();
  private readonly tmpTargetCam = new THREE.Vector3();
  private readonly tmpCorrectedCam = new THREE.Vector3();
  private readonly tmpCamRayDir = new THREE.Vector3();
  private readonly tmpLookTarget = new THREE.Vector3();
  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  private readonly raycaster = new THREE.Raycaster();

  constructor(private readonly deps: CameraControllerDeps) {}

  onXrEntered(isAr: boolean): void {
    this.xrInitialHeadCaptured = false;
    if (isAr) {
      // AR spectator: cameraRig at origin so the WebXR device pose is used directly.
      this.deps.cameraRig.position.set(0, 0, 0);
      this.deps.cameraRig.rotation.set(0, 0, 0);
      this.deps.xrCamera.position.set(0, 0, 0);
      this.deps.xrCamera.quaternion.identity();
      this.deps.xrCamera.scale.set(1, 1, 1);
    } else {
      this.alignCameraRigToEyeAnchor();
    }
  }

  onXrExited(): void {
    this.desktopViewMode = 'third';
    this.firstPersonPitch = 0;
    this.snapDesktopCameraAfterVrExit = true;
    this.postVrExitSnapFrames = 8;
    this.postVrForceThirdFrames = 120;
    this.xrInitialHeadCaptured = false;
    this.resetCameraForDesktop();
  }

  // rigWorldLocked: the VR body solver owns the rig (it moves only with
  // artificial locomotion), so the camera must not dolly it to the avatar.
  update(isVrActive: boolean, isXrPresenting: boolean, deltaSec: number, isAr = false, rigWorldLocked = false): void {
    // AR spectator: the WebXR device controls the camera directly.
    // Keep cameraRig at origin so the XR pose maps 1:1 to world space.
    if (isAr) {
      this.deps.cameraRig.position.set(0, 0, 0);
      this.deps.cameraRig.quaternion.identity();
      return;
    }

    if (!isXrPresenting && this.postVrForceThirdFrames > 0) {
      this.desktopViewMode = 'third';
      this.postVrForceThirdFrames -= 1;
    }

    const firstPersonMode: 'off' | 'desktop' | 'vr' = isVrActive ? 'vr' : this.desktopViewMode === 'first' ? 'desktop' : 'off';
    this.deps.avatarRig.setFirstPersonVisualState(firstPersonMode);

    if (!isVrActive) {
      if (this.desktopViewMode === 'third') {
        const shouldSnap = this.snapDesktopCameraAfterVrExit || this.postVrExitSnapFrames > 0;
        this.updateThirdPersonCamera(deltaSec, shouldSnap);
        this.snapDesktopCameraAfterVrExit = false;
        if (this.postVrExitSnapFrames > 0) this.postVrExitSnapFrames -= 1;
      } else {
        this.updateFirstPersonCamera('desktop');
      }
      return;
    }

    if (rigWorldLocked) return;
    this.updateFirstPersonCamera('vr');
  }

  applyVrHeadPoseForMock(): void {
    this.deps.avatarRig.getEyeAnchorWorldPosition(this.tmpEyeAnchor, this.deps.embodyOffset);
    this.deps.cameraRig.position.copy(this.tmpEyeAnchor);
  }

  alignCameraRigToEyeAnchor(): void {
    this.deps.avatarRig.getEyeAnchorWorldPosition(this.tmpEyeAnchor, this.deps.embodyOffset);
    this.deps.cameraRig.position.copy(this.tmpEyeAnchor);
    this.deps.cameraRig.rotation.set(0, 0, 0);
    this.deps.xrCamera.position.set(0, 0, 0);
    this.deps.xrCamera.quaternion.identity();
    this.deps.xrCamera.scale.set(1, 1, 1);
  }

  ensureDesktopRendererState(): void {
    this.deps.renderer.setRenderTarget(null);
    this.deps.renderer.setPixelRatio(window.devicePixelRatio);
    this.deps.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.deps.renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
    this.deps.renderer.setScissorTest(false);
  }

  resetCameraForDesktop(): void {
    this.deps.cameraRig.position.set(0, 0, 0);
    this.deps.cameraRig.rotation.set(0, 0, 0);
    this.deps.desktopCamera.position.set(0, 2, 6);
    this.deps.desktopCamera.quaternion.identity();
    this.deps.desktopCamera.up.set(0, 1, 0);
    this.deps.desktopCamera.scale.set(1, 1, 1);
    this.deps.desktopCamera.zoom = 1;
    this.deps.desktopCamera.clearViewOffset();
    this.deps.desktopCamera.aspect = window.innerWidth / window.innerHeight;
    this.deps.desktopCamera.updateProjectionMatrix();
    this.deps.desktopCamera.updateMatrixWorld(true);
    this.ensureDesktopRendererState();
  }

  onResize(): void {
    this.deps.xrCamera.aspect = window.innerWidth / window.innerHeight;
    this.deps.xrCamera.updateProjectionMatrix();
    this.deps.desktopCamera.aspect = window.innerWidth / window.innerHeight;
    this.deps.desktopCamera.updateProjectionMatrix();
    this.deps.renderer.setSize(window.innerWidth, window.innerHeight);
    if (!this.deps.renderer.xr.isPresenting) {
      this.ensureDesktopRendererState();
    }
  }

  private updateThirdPersonCamera(delta: number, snapInstantly = false): void {
    if (!this.deps.avatarRig.avatar) return;

    const avatarHeight = this.deps.avatarRig.avatarHeight;
    const followDistance = avatarHeight * 1.8;
    const followHeight = avatarHeight * 0.55;
    const pitchDistanceOffset = Math.cos(this.thirdPersonPitch) * followDistance;

    this.tmpDesiredCam.set(
      Math.sin(this.lookYaw) * pitchDistanceOffset,
      followHeight + Math.sin(this.thirdPersonPitch) * followDistance,
      Math.cos(this.lookYaw) * pitchDistanceOffset
    );
    this.tmpDesiredCam.add(this.deps.avatarRig.avatarRoot.position);

    this.deps.avatarRig.getEyeAnchorWorldPosition(this.tmpTargetCam, this.deps.embodyOffset);
    this.tmpCorrectedCam.copy(this.tmpDesiredCam);

    if (this.deps.avatarRig.worldModel) {
      this.tmpCamRayDir.subVectors(this.tmpDesiredCam, this.tmpTargetCam);
      const desiredDistance = this.tmpCamRayDir.length();
      if (desiredDistance > 0.0001) {
        this.tmpCamRayDir.multiplyScalar(1 / desiredDistance);
        this.raycaster.set(this.tmpTargetCam, this.tmpCamRayDir);
        this.raycaster.far = desiredDistance;
        const hits = this.raycaster.intersectObject(this.deps.avatarRig.worldModel, true);
        if (hits.length > 0) {
          const clearance = Math.max(0.08, avatarHeight * 0.08);
          const minDistance = Math.max(0.2, avatarHeight * 0.35);
          const clampedDistance = Math.max(minDistance, hits[0]!.distance - clearance);
          this.tmpCorrectedCam.copy(this.tmpTargetCam).addScaledVector(this.tmpCamRayDir, clampedDistance);
        }
      }
    }

    const smoothing = snapInstantly ? 1 : 1 - Math.exp(-8 * delta);
    this.deps.desktopCamera.position.lerp(this.tmpCorrectedCam, smoothing);
    this.deps.desktopCamera.lookAt(this.tmpTargetCam);
  }

  private updateFirstPersonCamera(source: 'desktop' | 'vr'): void {
    this.deps.avatarRig.getEyeAnchorWorldPosition(this.tmpEyeAnchor, this.deps.embodyOffset);

    if (source === 'desktop') {
      const avatarHeight = this.deps.avatarRig.avatarHeight;
      const bodyViewDownOffset = avatarHeight * 0.06;
      const bodyViewForwardOffset = avatarHeight * 0.14;
      this.tmpForward
        .set(-Math.sin(this.lookYaw) * Math.cos(this.firstPersonPitch), Math.sin(this.firstPersonPitch), -Math.cos(this.lookYaw) * Math.cos(this.firstPersonPitch))
        .normalize();
      this.deps.desktopCamera.position.copy(this.tmpEyeAnchor).addScaledVector(this.worldUp, -bodyViewDownOffset).addScaledVector(this.tmpForward, bodyViewForwardOffset);
      this.tmpLookTarget.copy(this.deps.desktopCamera.position).add(this.tmpForward);
      this.deps.desktopCamera.lookAt(this.tmpLookTarget);
      return;
    }

    if (this.floorHeightMapped) {
      // Only translate the floor. Tracking, hands, and camera remain in meters.
      this.deps.cameraRig.position.set(
        this.tmpEyeAnchor.x - this.floorOrigin.x,
        this.deps.avatarRig.avatarRoot.position.y + this.deps.avatarRig.avatarMinLocalY,
        this.tmpEyeAnchor.z - this.floorOrigin.y
      );
      this.deps.cameraRig.quaternion.identity();
      return;
    }

    // VR first-person: keep placement simple and stable.
    // Use root + fixed eye height (avoids animation-driven drift) and a small
    // forward offset so the camera sits naturally in front of the neck.
    // xrCamera is the rig's child, so three keeps its position in tracking
    // space (renderer.xr.getCamera() holds the world pose instead).
    const trackedHeadY = this.deps.xrCamera.position.y;
    if (!this.xrInitialHeadCaptured && trackedHeadY > 0.1) {
      this.xrInitialHeadY = trackedHeadY;
      this.xrInitialHeadCaptured = true;
    }
    const headY = this.xrInitialHeadCaptured ? this.xrInitialHeadY : trackedHeadY;
    const eyeForwardOffset = this.deps.avatarRig.avatarHeight * 0.08;
    const eyeUpOffset = this.deps.avatarRig.avatarHeight * 0.015;
    this.tmpForward.set(-Math.sin(this.lookYaw), 0, -Math.cos(this.lookYaw)).normalize();
    this.deps.cameraRig.position.set(
      this.tmpEyeAnchor.x + this.tmpForward.x * eyeForwardOffset,
      this.tmpEyeAnchor.y + eyeUpOffset - headY,
      this.tmpEyeAnchor.z + this.tmpForward.z * eyeForwardOffset
    );
    this.deps.cameraRig.quaternion.identity();
  }

  clampThirdPersonPitch(value: number): number {
    return clamp(value, 0.18, 0.72);
  }

  clampFirstPersonPitch(value: number): number {
    return clamp(value, -1.2, 1.2);
  }
}
