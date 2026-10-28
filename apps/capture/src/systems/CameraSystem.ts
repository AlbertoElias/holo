import { createSystem } from '@iwsdk/core';
import { type CaptureContext, captureContext } from './captureContext';

/**
 * Desktop first/third-person cameras and the VR rig. While the room-scale
 * body owns the world-locked rig, the camera never dollies it to the avatar.
 */
export class CameraSystem extends createSystem() {
  private capture!: CaptureContext;

  init(): void {
    this.capture = captureContext(this.world);
  }

  update(deltaSec: number): void {
    const c = this.capture;
    const frame = c.frame;
    if (frame.arSpectator) return;
    const rigWorldLocked = c.body.active && !c.body.solver.faults.has('rig-follows-avatar');
    c.camera.holdLookHeight = c.objects.isReachActive();
    c.camera.update(frame.vrActive, frame.xrPresenting, deltaSec, false, rigWorldLocked);
    // Tracked hands and the VR panel read the rig's world matrix.
    c.stage.cameraRig.updateMatrixWorld(true);
  }
}
