import { createSystem } from '@iwsdk/core';
import type { TrackedHandJointReader } from '../xr/PointDetector';
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
    c.recording.recorder.capture(c.frame.elapsedSec, c.avatar.avatar, c.avatar.avatarRoot, activeCamera(c), this.pointingHands(), c.objects.registry.eventObjects(), c.objects.authoringFrame());
  }

  // A finger reaching for the wrist's record glyph is pressing chrome, not
  // pointing at the other hand: that hand gives no point evidence meanwhile
  // (docs/features/ui-redesign.md, failure cases).
  private pointingHands(): TrackedHandJointReader {
    const c = this.capture;
    const poking = c.vrChrome.pokingHand(c.frame.elapsedSec);
    if (!poking) return c.tracking;
    return {
      getHandPoseSource: (side) => (side === poking ? 'none' : c.tracking.getHandPoseSource(side)),
      getTrackedHandJointPosition: (side, joint, out) => c.tracking.getTrackedHandJointPosition(side, joint, out)
    };
  }
}
