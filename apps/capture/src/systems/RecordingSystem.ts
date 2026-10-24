import { createSystem } from '@iwsdk/core';
import { activeCamera, type CaptureContext, captureContext } from './captureContext';

/**
 * Samples the completed body and hand pose once per simulation step, at
 * simulation time. Recorded data never depends on the playback camera.
 */
export class RecordingSystem extends createSystem() {
  private capture!: CaptureContext;

  init(): void {
    this.capture = captureContext(this.world);
  }

  update(): void {
    const c = this.capture;
    if (c.frame.arSpectator) return;
    c.recording.recorder.capture(c.frame.elapsedSec, c.avatar.avatar, c.avatar.avatarRoot, activeCamera(c), c.tracking, c.objects.registry.eventObjects());
  }
}
