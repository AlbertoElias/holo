import { createSystem } from '@iwsdk/core';
import { type CaptureContext, captureContext } from './captureContext';

/** Moves the debug overlays (tracked joints, head path) with the step. */
export class DiagnosticsSystem extends createSystem() {
  private capture!: CaptureContext;

  init(): void {
    this.capture = captureContext(this.world);
  }

  update(): void {
    const c = this.capture;
    if (c.frame.arSpectator) return;
    c.diagnostics.update();
  }
}
