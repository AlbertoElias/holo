import { createSystem } from '@iwsdk/core';
import { type CaptureContext, captureContext } from './captureContext';

// The body solver fits the avatar this much taller than the calibrated eye
// height so its straight-leg reach has headroom: a user standing taller than
// at calibration, the head's walking bob, or feet apart after a stop still
// keep the avatar's eyes on the tracked eyes (knees flex slightly at neutral).
const BODY_REACH_HEADROOM = 0.015;

/**
 * Restores last step's procedural pose corrections, then fits avatar size to
 * the user's neutral eye height: once per session, or again on request. Only
 * the avatar asset scales; rig, world and tracking stay in meters.
 */
export class CalibrationSystem extends createSystem() {
  private capture!: CaptureContext;

  init(): void {
    this.capture = captureContext(this.world);
  }

  update(deltaSec: number): void {
    const c = this.capture;
    if (c.frame.arSpectator) return;
    c.terrainLegs.restore();
    c.avatar.restoreCrouchPose();
    this.updateHeightFit(deltaSec);
  }

  private updateHeightFit(deltaSec: number): void {
    const c = this.capture;
    const { heightFit, tracking, camera } = c;
    const calibration = heightFit.calibration;
    const realVr = c.frame.xrPresenting && !tracking.mock.enabled;
    const pose = realVr ? tracking.getFloorHeadPosition() : undefined;
    const revision = tracking.getHeightReferenceRevision();
    if (revision !== heightFit.referenceRevision) {
      heightFit.referenceRevision = revision;
      calibration.interrupt();
      camera.reanchorFloorOrigin();
      c.crouch.resetBaseline();
    }
    if (!realVr) calibration.reset();

    const sizeLocked = c.recording.isSizeLocked;
    let scaleRatio = 1;
    if (!sizeLocked) {
      if (!realVr) {
        scaleRatio = c.avatar.setXrEyeHeight(undefined);
      } else {
        const wasRefitting = calibration.refitting;
        const height = calibration.update(pose?.y, deltaSec);
        if (height !== undefined) {
          scaleRatio = c.avatar.setXrEyeHeight(c.body.ready ? height * (1 + BODY_REACH_HEADROOM) : height);
          camera.reanchorFloorOrigin();
          c.crouch.setStandingHeadY(height);
          if (wasRefitting) c.crouch.release();
        }
      }
    }
    if (scaleRatio !== 1) {
      // The body solver measured the avatar at its old size; rescale and
      // realign so the tracked eyes sit on the refitted avatar's eyes.
      c.body.solver.rescale(scaleRatio);
      c.body.solver.reset();
      c.hands.rescale(scaleRatio);
    }
    const fitted = calibration.eyeHeight !== undefined;
    camera.setFloorHeightMapped(realVr && fitted, pose);
    c.ui.setHeightFit({
      enabled: realVr && !sizeLocked && !calibration.refitting && fitted,
      pending: realVr && (!fitted || calibration.refitting),
      eyeHeight: calibration.eyeHeight ?? null
    });
  }
}
