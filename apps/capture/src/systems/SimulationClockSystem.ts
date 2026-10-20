import { createSystem } from '@iwsdk/core';
import { type CaptureContext, captureContext } from './captureContext';

/** Simulation time: advances once per step, and only when the ECS runs. */
export class SimulationClockSystem extends createSystem() {
  private capture!: CaptureContext;

  init(): void {
    this.capture = captureContext(this.world);
  }

  update(deltaSec: number): void {
    const frame = this.capture.frame;
    frame.deltaSec = deltaSec;
    frame.elapsedSec += deltaSec;
    frame.steps += 1;
  }
}
