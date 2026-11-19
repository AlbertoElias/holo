import { createSystem } from '@iwsdk/core';
import * as THREE from 'three';
import { KEYBOARD_WALK_HEIGHTS_PER_SEC, WALK_SPEED_HEIGHTS_PER_SEC } from '../physics/CharacterMotor';
import { type CaptureContext, captureContext } from './captureContext';

const CROUCH_MOVE_SPEED_AT_FULL = 0.75;
const CROUCH_MIN_EFFECT_THRESHOLD = 0.05;
// Keyboard walking reaches full speed in about a quarter second: an instant start or stop reads as a pop on every joint.
const KEYBOARD_ACCELERATION_MS2 = 12;
// A desktop body walking sideways turns to face where it goes (it has only a forward walk); past this angle from the
// look it backs up facing the look instead. The gap either side keeps an analog direction near the boundary from flipping.
const BACK_UP_ENTER_RAD = THREE.MathUtils.degToRad(120);
const BACK_UP_EXIT_RAD = THREE.MathUtils.degToRad(105);
// How quickly the body turns toward its travel (s), and back to the look once it stops.
const TRAVEL_TURN_SEC = 0.1;
const SETTLE_TURN_SEC = 0.25;

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
  /** The desktop body's turn from the look yaw toward its travel (rad). */
  private travelTurn = 0;
  private backingUp = false;

  init(): void {
    this.capture = captureContext(this.world);
  }

  update(deltaSec: number): void {
    const c = this.capture;
    const frame = c.frame;
    if (frame.arCameraAuthor) return;
    const { motor, input, body, avatar, config } = c;

    // A flat-screen reach's step in is a displacement, not input: it moves the avatar without counting as walking.
    const taken = c.objects.takeReachStep();
    const reachStep = frame.vrActive ? null : taken;
    c.crouch.update(deltaSec, frame.vrActive, input.isCrouchHeld(), c.tracking.getCurrentHeadLocalY(), c.objects.reachDemand(), c.objects.reachDeep());
    const crouchAmount = c.crouch.amount;
    const stick = frame.vrActive ? c.locomotion.moveVector(this.stickMove) : { x: 0, z: 0 };
    motor.update(deltaSec, c.camera.lookYaw, input.moveState, input.consumeJumpQueued(), {
      moveSpeedMultiplier: (1 - (1 - CROUCH_MOVE_SPEED_AT_FULL) * crouchAmount) * (frame.vrActive ? 1 : KEYBOARD_WALK_HEIGHTS_PER_SEC / WALK_SPEED_HEIGHTS_PER_SEC),
      allowJump: true,
      ...(frame.vrActive ? {} : { maxAccelerationMS2: KEYBOARD_ACCELERATION_MS2 }),
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
    const tracked = frame.bodyTracking || (body.active && body.solver.isAligned);
    // First person, XR and a reach keep the body on the look: the view and the reach are aimed from it.
    const turn = tracked || frame.vrActive ? 0 : this.desktopTravelTurn(deltaSec, c.camera.desktopViewMode === 'first' || c.objects.reachDemand() > 0);
    const yaw = tracked ? body.solver.bodyYaw : c.camera.lookYaw + turn;
    avatar.syncAvatarPoseFromCharacter(this.bodyPosition, yaw, motor.getAvatarVisualOffsetY(), config.avatarForwardOffset);
  }

  /**
   * The desktop body's turn toward the keys' travel: a person walking sideways turns and walks forward that way, where
   * the forward walk played sideways would scissor the legs across each other. Backing up keeps the look's facing and
   * plays the walk backward. Standing still, the body turns back to the look, the way reach, carry and aim expect it.
   */
  private desktopTravelTurn(deltaSec: number, onLook: boolean): number {
    const move = this.capture.input.moveState;
    const across = (move.left ? 1 : 0) - (move.right ? 1 : 0);
    const along = (move.forward ? 1 : 0) - (move.back ? 1 : 0);
    let target = 0;
    let sec = SETTLE_TURN_SEC;
    if (!onLook && (across !== 0 || along !== 0)) {
      const travel = Math.atan2(across, along);
      this.backingUp = Math.abs(travel) > (this.backingUp ? BACK_UP_EXIT_RAD : BACK_UP_ENTER_RAD);
      target = this.backingUp ? travel - Math.sign(travel || 1) * Math.PI : travel;
      sec = TRAVEL_TURN_SEC;
    } else this.backingUp = false;
    const delta = Math.atan2(Math.sin(target - this.travelTurn), Math.cos(target - this.travelTurn));
    this.travelTurn += delta * (1 - Math.exp(-Math.max(0, deltaSec) / sec));
    return this.travelTurn;
  }
}
