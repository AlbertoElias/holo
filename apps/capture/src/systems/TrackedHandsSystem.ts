import { createSystem } from '@iwsdk/core';
import { type CaptureContext, captureContext } from './captureContext';

/**
 * Arms and fingers follow tracked hands or controllers, after the body and
 * camera have their final pose for the step. Never writes head or root.
 */
export class TrackedHandsSystem extends createSystem() {
  private capture!: CaptureContext;

  init(): void {
    this.capture = captureContext(this.world);
  }

  update(): void {
    const c = this.capture;
    if (c.frame.arSpectator || !c.frame.vrActive || !c.motor.hasSpawnResolved()) return;
    const { tracking, avatar, heightFit, config } = c;
    // Once the height fit maps real meters to the avatar, hand offsets are
    // measured from the tracked head; otherwise from the avatar's eyes.
    const fromTrackedHead = tracking.isXrPresenting() && !tracking.getMockSnapshot().enabled && heightFit.eyeHeight !== undefined;
    c.hands.update((out) => (fromTrackedHead ? tracking.getHeadWorldPosition(out) : avatar.getEyeAnchorWorldPosition(out, config.embodyOffset)));
  }
}
