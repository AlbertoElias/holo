import { createSystem } from '@iwsdk/core';
import { type CaptureContext, captureContext } from './captureContext';

/**
 * The face: morph weights and eye bones, after the body pose (which may move
 * the head the eyes ride on) and before the recorder samples the frame.
 */
export class FaceSystem extends createSystem() {
  private capture!: CaptureContext;

  init(): void {
    this.capture = captureContext(this.world);
  }

  update(deltaSec: number): void {
    const c = this.capture;
    if (c.frame.arSpectator) return;
    c.face.update({
      timeSec: c.frame.elapsedSec,
      deltaSec,
      vrActive: c.frame.vrActive,
      micGranted: c.ui.getState().micPermission === 'granted'
    });
  }
}
