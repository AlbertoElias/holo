import { createSystem } from '@iwsdk/core';
import * as THREE from 'three';
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

  /** Seconds since the last landing, and how hard it was (0..1); the absorb plays out from it. */
  private sinceLanding = Infinity;
  private landingPeak = 0;

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
      referenceSpeed: avatar.avatarHeight * (frame.vrActive ? WALK_SPEED_HEIGHTS_PER_SEC : KEYBOARD_WALK_HEIGHTS_PER_SEC),
      position: avatar.avatarRoot.position
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
      const jump = this.jumpBend(deltaSec, character.grounded, character.velocityY);
      const airborne = !character.grounded && jump > 0;
      const poseAmount = Math.max(c.crouch.poseAmount, jump);
      // A jump's wind-up and landing bend the knees over feet that stay where they stood.
      const jumpPlant = character.grounded && jump > 0.02 && !moving;
      const plant = ((c.crouch.reach > 0 || (avatar.isPlanted && c.crouch.amount > 0.003)) || jumpPlant) && !moving;
      this.crouchSpeed += (character.horizontalSpeed - this.crouchSpeed) * (1 - Math.exp(-Math.max(0, deltaSec) / CROUCH_SPEED_EASE_SEC));
      avatar.applyCrouchPose(poseAmount, this.crouchSpeed, c.crouch.squat, plant, c.crouch.deepExtra, airborne);
      c.terrainLegs.update(avatar, character.grounded, deltaSec, plant, poseAmount > 0.3, c.animator.getGaitState());
      // Desktop arms come from the clip alone; in XR the tracked hands own them.
      if (!frame.vrActive) {
        // An arm the point or the carry holds is theirs to aim (they run after this, from the pose they found).
        const pointing = c.point.ownedSide();
        c.armClearance.apply(avatar.humanoid, { left: pointing === 'left', right: pointing === 'right' || c.objects.carry.getWeight() > 0 });
      }
    }
  }

  /**
   * The crouch a flat-screen jump adds (0..1): a squat through the wind-up, legs tucked up toward the apex (none at
   * take-off or touch-down, where they push off and reach for the ground), and on landing a dip as deep as the
   * fall was hard, in quickly and out over a few tenths of a second.
   */
  private jumpBend(deltaSec: number, grounded: boolean, velocityY: number): number {
    const motor = this.capture.motor;
    const impact = motor.takeLanding();
    if (impact > LANDING_MIN_SPEED) {
      this.sinceLanding = 0;
      this.landingPeak = THREE.MathUtils.clamp(impact / LANDING_FULL_SPEED, LANDING_MIN_PEAK, 1);
    } else this.sinceLanding += Math.max(0, deltaSec);
    if (this.capture.frame.vrActive) return 0;
    const windup = motor.jumpWindup;
    if (windup > 0) return JUMP_WINDUP_DEPTH * THREE.MathUtils.smoothstep(windup, 0, 1);
    if (!grounded) return JUMP_TUCK_DEPTH * Math.max(0, 1 - Math.abs(velocityY) / Math.max(1e-3, motor.jumpLaunchSpeed));
    const t = this.sinceLanding;
    if (t >= LANDING_ATTACK_SEC + LANDING_RELEASE_SEC) return 0;
    const envelope = t < LANDING_ATTACK_SEC
      ? THREE.MathUtils.smoothstep(t, 0, LANDING_ATTACK_SEC)
      : 1 - THREE.MathUtils.smoothstep(t - LANDING_ATTACK_SEC, 0, LANDING_RELEASE_SEC);
    return LANDING_DEPTH * this.landingPeak * envelope;
  }
}

// A jump's wind-up squats to this crouch amount; the legs tuck to JUMP_TUCK_DEPTH at the apex.
const JUMP_WINDUP_DEPTH = 0.75;
const JUMP_TUCK_DEPTH = 0.5;
// A landing at LANDING_FULL_SPEED (m/s, a jump's own touch-down) dips to LANDING_DEPTH; slower ones less, down to
// LANDING_MIN_PEAK of it, and a step down slower than LANDING_MIN_SPEED not at all.
const LANDING_FULL_SPEED = 3.4;
const LANDING_MIN_SPEED = 1.2;
const LANDING_MIN_PEAK = 0.3;
const LANDING_DEPTH = 0.8;
const LANDING_ATTACK_SEC = 0.07;
const LANDING_RELEASE_SEC = 0.32;

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
