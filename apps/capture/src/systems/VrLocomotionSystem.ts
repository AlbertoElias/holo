import { createSystem } from '@iwsdk/core';
import * as THREE from 'three';
import { type CaptureContext, captureContext } from './captureContext';

const UP = new THREE.Vector3(0, 1, 0);
const REST = { x: 0, y: 0 };

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
  /** Which sides' controllers reported axes last frame. */
  private readonly reporting = { left: false, right: false };
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
      // The session ended: a stick held at the end is let go, so nothing walks on in the next one.
      if (this.wasVrActive) loco.releaseSticks();
      this.wasVrActive = false;
      this.reporting.left = false;
      this.reporting.right = false;
      return;
    }
    if (!this.wasVrActive) {
      loco.resetTurn();
      this.wasVrActive = true;
    }

    // Real controllers write the state the mock hook writes in checks.
    if (c.frame.xrPresenting && !c.tracking.mock.enabled) {
      // A side whose controller was reporting and now is not (it went away, or hands took over) is a stick at
      // rest, not the last value it had. A side that never reported keeps what was written to it.
      const move = this.readSide(c, 'left');
      const turn = this.readSide(c, 'right');
      if (move) loco.setThumbstick({ moveX: move.x, moveY: move.y });
      if (turn) loco.setThumbstick({ turnX: turn.x, turnY: turn.y });
    }

    loco.updateObjectPush(c.objects.isHolding());
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

  /** This side's stick to write, or null to leave it as it is. */
  private readSide(c: CaptureContext, side: 'left' | 'right'): { x: number; y: number } | null {
    // A stick pointing the Halo, or not yet recentred after it, neither walks nor turns.
    if (c.headsetHolds.locomotionBlocked(side)) return REST;
    const axes = c.tracking.getThumbstickAxes(side);
    if (axes) {
      this.reporting[side] = true;
      return axes;
    }
    if (!this.reporting[side]) return null;
    this.reporting[side] = false;
    return REST;
  }
}
