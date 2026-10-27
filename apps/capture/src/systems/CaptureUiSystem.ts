import { createSystem } from '@iwsdk/core';
import { type CaptureContext, captureContext, resolveAppMode } from './captureContext';

/** Publishes the mode and the take's running time to the DOM overlay; the headset chrome follows its wrist and takes pokes and rays. */
export class CaptureUiSystem extends createSystem() {
  private capture!: CaptureContext;

  init(): void {
    this.capture = captureContext(this.world);
  }

  update(deltaSec: number): void {
    const c = this.capture;
    const frames = c.recording.recorder.getFrames();
    if (frames.length > 0) c.ui.setRecordingElapsed((frames[frames.length - 1]!.timeSec - frames[0]!.timeSec) * 1000);
    if (c.frame.arSpectator) {
      // Passthrough AR carries Find on the wrist (PRD-060 slice 2), nothing else.
      // No avatar is embodied, so the wrist and fingertips the chrome follows
      // are the tracked joints where they are (TrackedHandsSystem skips AR).
      c.tracking.updateSpectatorHandJoints();
      c.vrChrome.update(c.stage.xrCamera, deltaSec, c.frame.elapsedSec);
      return;
    }
    c.ui.publishMode(resolveAppMode(c));
    if (c.frame.vrActive) c.vrChrome.update(c.stage.xrCamera, deltaSec, c.frame.elapsedSec);
  }
}
