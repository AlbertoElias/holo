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
    if (c.frame.arCameraAuthor) {
      // The phone is a camera: its path, the objects and the set, in the set's frame.
      c.recording.cameraRecorder.capture(c.frame.elapsedSec, c.stage.worldGroup, c.stage.renderer.xr.getCamera(), c.objects.registry.eventObjects());
      c.screenHolds.step(c.frame.elapsedSec);
      return;
    }
    if (c.frame.arSpectator) return;
    const held = c.frame.vrActive
      ? c.headsetHolds.update({ timeSec: c.frame.elapsedSec, presenting: c.frame.xrPresenting && !c.tracking.mock.enabled, recording: c.recording.recorder.isEnabled(), camera: c.stage.xrCamera })
      : c.headsetHolds.update({ timeSec: c.frame.elapsedSec, presenting: false, recording: false, camera: c.stage.xrCamera });
    // What drove each hand, unmasked by chrome: a hand poking chrome still moved as tracked.
    const handSources = c.frame.vrActive ? { left: c.tracking.getHandPoseSource('left'), right: c.tracking.getHandPoseSource('right') } : undefined;
    c.recording.recorder.capture(c.frame.elapsedSec, c.avatar.avatar, c.avatar.avatarRoot, activeCamera(c), this.pointingHands(), c.objects.registry.eventObjects(), c.objects.authoringFrame(), held, handSources);
  }

  // A finger reaching for the wrist's record glyph is pressing chrome, and a
  // hand summoning the Halo is choosing from it, not pointing: that hand
  // gives no point evidence meanwhile (docs/features/ui-redesign.md, failure cases).
  private pointingHands(): TrackedHandJointReader {
    const c = this.capture;
    const busy = c.vrChrome.pokingHand(c.frame.elapsedSec) ?? c.headsetHolds.haloHand();
    if (!busy) return c.tracking;
    return {
      getHandPoseSource: (side) => (side === busy ? 'none' : c.tracking.getHandPoseSource(side)),
      getTrackedHandJointPosition: (side, joint, out) => c.tracking.getTrackedHandJointPosition(side, joint, out)
    };
  }
}
