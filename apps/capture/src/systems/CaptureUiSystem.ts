import { createSystem } from '@iwsdk/core';
import { type CaptureContext, captureContext, resolveAppMode } from './captureContext';

/** Publishes the mode to the DOM overlay; the VR panel follows the head and takes aims and touches. */
export class CaptureUiSystem extends createSystem() {
  private capture!: CaptureContext;

  init(): void {
    this.capture = captureContext(this.world);
  }

  update(deltaSec: number): void {
    const c = this.capture;
    if (c.frame.arSpectator) return;
    c.ui.publishMode(resolveAppMode(c));
    if (c.frame.vrActive) c.vrHud.update(c.stage.xrCamera, deltaSec, c.frame.elapsedSec);
  }
}
