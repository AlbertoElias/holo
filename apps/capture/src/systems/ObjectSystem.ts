import { createSystem } from '@iwsdk/core';
import { gravity } from '../physics/CharacterMotor';
import * as THREE from 'three';
import { activeCamera, type CaptureContext, captureContext } from './captureContext';

// Above this ground speed the avatar counts as walking, which cancels a flat-screen reach.
const WALKING_MPS = 0.05;

/**
 * Supplied objects and the tray: grab, carry, release and summon, after the
 * arms have their final pose for the step and before the record. The only
 * writer of object transforms.
 */
export class ObjectSystem extends createSystem() {
  private capture!: CaptureContext;
  private readonly view = new THREE.Vector3();

  init(): void {
    this.capture = captureContext(this.world);
  }

  update(): void {
    const c = this.capture;
    if (c.frame.arSpectator) {
      // A phone camera author places tray items where its centre ray lands, in this step, before the camera is recorded.
      // A headset in passthrough only watches: no summon.
      if (c.frame.arCameraAuthor) c.phoneChrome.stepPlacement(c.frame.elapsedSec);
      return;
    }
    if (!c.motor.hasSpawnResolved()) return;
    if (!c.objects.hasPhysics()) {
      const trimesh = c.motor.getWorldTrimesh();
      if (trimesh) c.objects.enablePhysics(trimesh, gravity);
    }
    // The flat dock and keys (docs/features/tray-remove.md), before this step's summon and grab.
    const removeSlot = c.input.consumeTrayRemove();
    // A slot queued with the removal named the item before the renumber: dropped.
    if (removeSlot !== null && c.objects.removeTraySlot(removeSlot)) c.input.consumeSummonSlot();
    if (c.input.consumePutBack()) c.objects.putBackHeld();
    const turn = c.input.getObjectTurn();
    const walk = c.input.moveState;
    const moving = walk.forward || walk.back || walk.left || walk.right || (!c.objects.isStepping() && (c.frame.character?.horizontalSpeed ?? 0) > WALKING_MPS);
    c.objects.update({
      vrActive: c.frame.vrActive,
      deltaSec: c.frame.deltaSec,
      timeSec: c.frame.elapsedSec,
      bodyYaw: c.camera.lookYaw,
      viewDirection: activeCamera(c).getWorldDirection(this.view),
      vrPush: c.frame.vrActive ? c.locomotion.objectPush : 0,
      trayHeld: c.input.isTrayHeld(),
      desktop: {
        toggle: c.input.consumeObjectToggle(),
        turnYaw: turn.yaw,
        turnPitch: turn.pitch,
        walking: moving,
        pointHeld: c.input.isPointHeld(),
        summonSlot: c.input.consumeSummonSlot(),
        grab: c.input.consumeObjectGrab(),
        resize: c.input.consumeObjectResize(c.frame.deltaSec),
        push: c.input.consumeObjectPush()
      }
    });
  }
}
