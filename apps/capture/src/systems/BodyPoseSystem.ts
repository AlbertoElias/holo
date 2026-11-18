import { createSystem } from '@iwsdk/core';
import { KEYBOARD_WALK_HEIGHTS_PER_SEC, WALK_SPEED_HEIGHTS_PER_SEC } from '../physics/CharacterMotor';
import { type CaptureContext, captureContext } from './captureContext';

/**
 * Animation, then exactly one lower-body owner: the room-scale body solver
 * (hips, spine, head, legs) in real XR, or the crouch pose and terrain legs
 * on the animation path elsewhere. Never both on the same step.
 */
export class BodyPoseSystem extends createSystem() {
  private capture!: CaptureContext;
  /** Travel speed eased for the crouch pose's walk blend, whose band a stop crosses in a frame or two. */
  private crouchSpeed = 0;

  init(): void {
    this.capture = captureContext(this.world);
  }

  update(deltaSec: number): void {
    const started = performance.now();
    this.pose(deltaSec);
    recordPoseCost(performance.now() - started);
  }

  private pose(deltaSec: number): void {
    const c = this.capture;
    const frame = c.frame;
    const character = frame.character;
    if (frame.arCameraAuthor || !character) return;
    const { body, input, avatar } = c;
    c.animator.update({
      deltaSec,
      grounded: character.grounded,
      velocityY: character.velocityY,
      horizontalSpeed: character.horizontalSpeed,
      targetHorizontalSpeed: character.targetHorizontalSpeed,
      moveIntent: input.moveState.forward || input.moveState.back || input.moveState.left || input.moveState.right,
      vrMode: frame.vrActive,
      // The walk's own target speed, for a clip without a measured gait.
      referenceSpeed: avatar.avatarHeight * (frame.vrActive ? WALK_SPEED_HEIGHTS_PER_SEC : KEYBOARD_WALK_HEIGHTS_PER_SEC)
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
      // The plant is held through the last of the stand-up, until the crouch is gone, so the feet do not snap as the reach ends.
      const plant = (c.crouch.reach > 0 || (avatar.isPlanted && c.crouch.amount > 0.003)) && !moving;
      this.crouchSpeed += (character.horizontalSpeed - this.crouchSpeed) * (1 - Math.exp(-Math.max(0, deltaSec) / CROUCH_SPEED_EASE_SEC));
      avatar.applyCrouchPose(c.crouch.poseAmount, this.crouchSpeed, c.crouch.squat, plant, c.crouch.deepExtra);
      c.terrainLegs.update(avatar, character.grounded, deltaSec, plant, c.crouch.poseAmount > 0.3, c.animator.getGaitState());
    }
  }
}

// The last frames' cost of animation + body IK (ms), for the desktop motion check's per-frame budget.
const POSE_COST_FRAMES = 600;
const poseCosts = new Float32Array(POSE_COST_FRAMES);
let poseCostCount = 0;
function recordPoseCost(ms: number): void {
  poseCosts[poseCostCount % POSE_COST_FRAMES] = ms;
  poseCostCount++;
}

/** Median and p95 of the last frames' animation + IK cost (ms); `reset` starts a fresh window. */
export function samplePoseCost(reset = false): { frames: number; medianMs: number; p95Ms: number } {
  const n = Math.min(poseCostCount, POSE_COST_FRAMES);
  const sorted = Array.from(poseCosts.subarray(0, n)).sort((a, b) => a - b);
  const at = (p: number) => (n ? sorted[Math.min(n - 1, Math.floor(p * n))]! : 0);
  const out = { frames: n, medianMs: at(0.5), p95Ms: at(0.95) };
  if (reset) poseCostCount = 0;
  return out;
}

// Time constant for the crouch pose's eased travel speed (s).
const CROUCH_SPEED_EASE_SEC = 0.15;
