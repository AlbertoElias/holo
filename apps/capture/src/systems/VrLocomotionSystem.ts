import { createSystem } from '@iwsdk/core';
import * as THREE from 'three';
import { type CaptureContext, captureContext } from './captureContext';

const UP = new THREE.Vector3(0, 1, 0);

/**
 * VR thumbstick turning, after session setup and before the room-scale
 * body plans from the head: polls controller gamepads (the mock hook
 * writes the same state in deterministic checks), then applies the
 * frame's turn to the world-locked camera rig about the tracked head,
 * so the view turns in place and the body solver follows the new facing.
 */
export class VrLocomotionSystem extends createSystem() {
  private capture!: CaptureContext;
  private wasVrActive = false;
  private readonly turnQuat = new THREE.Quaternion();
  private readonly pivot = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();

  init(): void {
    this.capture = captureContext(this.world);
  }

  update(deltaSec: number): void {
    const c = this.capture;
    if (c.frame.arSpectator) return;
    const loco = c.locomotion;
    if (!c.frame.vrActive) {
      this.wasVrActive = false;
      return;
    }
    if (!this.wasVrActive) {
      loco.resetTurn();
      this.wasVrActive = true;
    }

    // Real controllers write the state the mock hook writes in checks.
    if (c.frame.xrPresenting && !c.tracking.mock.enabled) {
      const move = c.tracking.getThumbstickAxes('left');
      const turn = c.tracking.getThumbstickAxes('right');
      if (move) loco.setThumbstick({ moveX: move.x, moveY: move.y });
      if (turn) loco.setThumbstick({ turnX: turn.x });
    }

    const delta = loco.updateTurn(deltaSec);
    // Facing the motor steers by: in real XR the turned rig makes the
    // head's world yaw carry the turn (syncYaw reads it); the mock pose
    // reports its own yaw, so compose the turn on top of it there.
    if (c.tracking.mock.enabled) {
      c.camera.lookYaw = (c.tracking.mock.yaw() ?? c.camera.lookYaw) + loco.turnYaw;
    } else if (delta !== 0) {
      c.camera.lookYaw += delta;
    }
    if (delta === 0) return;

    const rig = c.stage.cameraRig;
    if (c.tracking.isMockVrOnly()) {
      // XrSessionSystem re-poses the mock rig every frame; re-apply the
      // accumulated turn on top of the mock head orientation.
      this.turnQuat.setFromAxisAngle(UP, loco.turnYaw);
      rig.quaternion.copy(this.turnQuat).multiply(c.tracking.mock.headQuaternion);
      return;
    }

    // Turn about the user's head, not the rig origin: the head's world
    // position stays put while the world rotates around it.
    const head = c.tracking.getHeadPose();
    if (head.valid) this.pivot.copy(head.worldPosition);
    else c.avatar.getEyeAnchorWorldPosition(this.pivot, c.config.embodyOffset);
    this.turnQuat.setFromAxisAngle(UP, delta);
    this.offset.copy(rig.position).sub(this.pivot).applyQuaternion(this.turnQuat);
    rig.position.copy(this.pivot).add(this.offset);
    rig.quaternion.premultiply(this.turnQuat).normalize();
    rig.updateMatrixWorld(true);
    c.tracking.refreshHeadWorldPose();
  }
}
