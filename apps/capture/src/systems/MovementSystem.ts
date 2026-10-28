import { createSystem } from '@iwsdk/core';
import * as THREE from 'three';
import { type CaptureContext, captureContext } from './captureContext';

const CROUCH_MOVE_SPEED_AT_FULL = 0.75;
const CROUCH_MIN_EFFECT_THRESHOLD = 0.05;

/**
 * Crouch, then the character motor: input movement, gravity, jumps and the
 * room-scale body's planned displacement, collision-aware through Rapier.
 * Places the avatar root on the result and carries the world-locked rig.
 */
export class MovementSystem extends createSystem() {
  private capture!: CaptureContext;
  private readonly bodyPosition = new THREE.Vector3();
  private readonly inputMovement = new THREE.Vector3();
  private readonly stickMove = { x: 0, z: 0 };

  init(): void {
    this.capture = captureContext(this.world);
  }

  update(deltaSec: number): void {
    const c = this.capture;
    const frame = c.frame;
    if (frame.arSpectator) return;
    const { motor, input, body, avatar, config } = c;

    // A flat-screen reach's step in is a displacement, not input: it moves the avatar without counting as walking.
    const reachStep = frame.vrActive ? null : c.objects.takeReachStep();
    c.crouch.update(deltaSec, frame.vrActive, input.isCrouchHeld(), c.tracking.getCurrentHeadLocalY(), c.objects.reachDemand());
    const crouchAmount = c.crouch.amount;
    const stick = frame.vrActive ? c.locomotion.moveVector(this.stickMove) : { x: 0, z: 0 };
    motor.update(deltaSec, c.camera.lookYaw, input.moveState, input.consumeJumpQueued(), {
      moveSpeedMultiplier: 1 - (1 - CROUCH_MOVE_SPEED_AT_FULL) * crouchAmount,
      allowJump: true,
      stickToTerrain: crouchAmount >= CROUCH_MIN_EFFECT_THRESHOLD,
      ...(frame.bodyTracking ? { externalDisplacement: body.displacement } : reachStep ? { externalDisplacement: reachStep } : {}),
      ...(stick.x !== 0 || stick.z !== 0 ? { analogMove: stick } : {})
    });
    frame.character = motor.getSnapshot();

    motor.getCharacterBodyPosition(this.bodyPosition);
    if (body.active) {
      // The rig carries tracked space along only with motion the user did not
      // make physically: input movement and ground height. Where a wall stops
      // the body, the view is not pushed back; the body waits there.
      const rig = c.stage.cameraRig;
      motor.getLastInputMovement(this.inputMovement);
      rig.position.x += this.inputMovement.x;
      rig.position.z += this.inputMovement.z;
      // Tracking space's floor is the avatar's visual base, as the height fit
      // maps it, so slopes, steps and jumps carry the view along.
      rig.position.y = this.bodyPosition.y + motor.getAvatarVisualOffsetY() + avatar.heightVisualOffsetY + avatar.avatarMinLocalY + config.embodyOffset;
      c.tracking.refreshHeadWorldPose();
      body.copyHead(c.tracking.getHeadPose());
    }
    // The forward offset applies in every view so the model faces the look
    // direction; without it, first person and VR see the avatar's sides swapped.
    const yaw = frame.bodyTracking || (body.active && body.solver.isAligned) ? body.solver.bodyYaw : c.camera.lookYaw;
    avatar.syncAvatarPoseFromCharacter(this.bodyPosition, yaw, motor.getAvatarVisualOffsetY(), config.avatarForwardOffset);
  }
}
