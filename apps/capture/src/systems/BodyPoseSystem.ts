import { createSystem } from '@iwsdk/core';
import { type CaptureContext, captureContext } from './captureContext';

/**
 * Animation, then exactly one lower-body owner: the room-scale body solver
 * (hips, spine, head, legs) in real XR, or the crouch pose and terrain legs
 * on the animation path elsewhere. Never both on the same step.
 */
export class BodyPoseSystem extends createSystem() {
  private capture!: CaptureContext;

  init(): void {
    this.capture = captureContext(this.world);
  }

  update(deltaSec: number): void {
    const c = this.capture;
    const frame = c.frame;
    const character = frame.character;
    if (frame.arSpectator || !character) return;
    const { body, input, avatar } = c;
    c.animator.update({
      deltaSec,
      grounded: character.grounded,
      velocityY: character.velocityY,
      horizontalSpeed: character.horizontalSpeed,
      targetHorizontalSpeed: character.targetHorizontalSpeed,
      moveIntent: input.moveState.forward || input.moveState.back || input.moveState.left || input.moveState.right,
      vrMode: frame.vrActive,
      referenceSpeed: avatar.avatarHeight * 1.8
    });
    if (!body.active && body.posed) {
      body.solver.restoreBindPose();
      body.posed = false;
    }
    if (frame.bodyTracking) {
      body.posed = true;
      body.solver.solve(body.head, avatar.avatarRoot.position, deltaSec, body.groundSampler, c.config.embodyOffset, character.grounded);
    } else if (!body.active) {
      // A reach plants the feet where they stood when it began, from the first bend to the end of the stand-up.
      // Walking away unplants them at once: a foot left behind would snap to the stride when the stand-up ends.
      const moving = input.moveState.forward || input.moveState.back || input.moveState.left || input.moveState.right;
      const plant = c.crouch.reach > 0 && !moving;
      avatar.applyCrouchPose(c.crouch.poseAmount, character.horizontalSpeed, c.crouch.squat, plant, c.crouch.deepExtra);
      c.terrainLegs.update(avatar, character.grounded, deltaSec, plant);
    }
  }
}
