import { createSystem } from '@iwsdk/core';
import { type CaptureContext, captureContext } from './captureContext';

/**
 * Supplied objects: grab, carry and release, after the arms have their final
 * pose for the step and before the record. The only writer of object
 * transforms.
 */
export class ObjectSystem extends createSystem() {
  private capture!: CaptureContext;

  init(): void {
    this.capture = captureContext(this.world);
  }

  update(): void {
    const c = this.capture;
    if (c.frame.arSpectator || !c.motor.hasSpawnResolved()) return;
    const turn = c.input.getObjectTurn();
    c.objects.interaction.update({
      vrActive: c.frame.vrActive,
      deltaSec: c.frame.deltaSec,
      bodyYaw: c.camera.lookYaw,
      desktop: { toggle: c.input.consumeObjectToggle(), turnYaw: turn.yaw, turnPitch: turn.pitch, pointHeld: c.input.isPointHeld() }
    });
  }
}
