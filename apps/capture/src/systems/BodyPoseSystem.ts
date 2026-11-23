import { createSystem } from '@iwsdk/core';
import * as THREE from 'three';
import type { JumpPhase } from '../animation/JumpArms';
import { WALK_HEIGHTS_PER_SEC } from '../physics/CharacterMotor';
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
  /** Seconds since the feet left the ground, and the wind-up bend they left it with; the push-off unwinds it. */
  private sinceTakeoff = Infinity;
  private takeoffBend = 0;
  private lastBend = 0;
  private wasGrounded = true;
  /** The wind-up's last bend and the seconds since: the launch frame can still read grounded, so it holds the squat. */
  private windupBend = 0;
  private sinceWindup = Infinity;
  /** This frame's jump timing, for the arms' recorded swing. */
  private readonly phase: JumpPhase = { windup: 0, airborne: false, velocityY: 0, launchSpeed: 0 };

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
      referenceSpeed: avatar.avatarHeight * WALK_HEIGHTS_PER_SEC,
      position: avatar.avatarRoot.position,
      travelLocalYaw: frame.travelLocalYaw,
      // A reach's squat is the planted crouch pose's: its step in plays the upright walk, not the crouch walk clips.
      crouch: c.crouch.reach > 0 || avatar.isPlanted ? 0 : c.crouch.poseAmount,
      // The desktop reach, carry, set-down and aim are tuned from a still upper body: the idle's sway eases out for them.
      // The first-person eye rides the head, so the sway there would only rock the view and the aim at its centre.
      // A crouch holds it too: the third-person view follows the eye at once, not through the sway's slow look filter.
      // A point whose ray starts at the eye loses the sway at once; a touch's ray starts at the view, which eases with it.
      aimHeld: (input.isPointHeld() || c.point.ownedSide() !== null) && !input.getPointScreenAim(),
      holdStill: c.camera.desktopViewMode === 'first' || input.isPointHeld() || c.point.ownedSide() !== null || c.objects.carry.getWeight() > 0 || c.crouch.reach > 0 || avatar.isPlanted || c.crouch.poseAmount > CROUCH_HOLD_STILL
    });
    if (!body.active && body.posed) {
      body.solver.restoreBindPose();
      body.posed = false;
    }
    if (frame.bodyTracking) {
      body.posed = true;
      c.jumpArms.reset();
      body.solver.setWalkTrajectory(c.animator.getWalkTrajectory());
      body.solver.solve(body.head, avatar.avatarRoot.position, deltaSec, body.groundSampler, c.config.embodyOffset, character.grounded);
    } else if (!body.active) {
      // A reach plants the feet where they stood when it began, from the first bend to the end of the stand-up.
      // Walking away unplants them at once: a foot left behind would snap to the stride when the stand-up ends.
      const moving = input.moveState.forward || input.moveState.back || input.moveState.left || input.moveState.right;
      // The plant is held through the last of the stand-up, until the crouch is gone, so the feet do not snap as the reach ends.
      const jump = this.jumpBend(deltaSec, character.grounded, character.velocityY);
      // The push-off still extends legs that stand on their feet; only the tuck after it folds them under the hips.
      const airborne = !character.grounded && jump > 0 && this.sinceTakeoff >= PUSH_OFF_SEC;
      const poseAmount = Math.max(c.crouch.poseAmount, jump);
      // A jump's wind-up and landing bend the knees over feet that stay where they stood.
      const jumpPlant = character.grounded && jump > 0.02 && !moving;
      const plant = ((c.crouch.reach > 0 || (avatar.isPlanted && c.crouch.amount > 0.003)) || jumpPlant) && !moving;
      this.crouchSpeed += (character.horizontalSpeed - this.crouchSpeed) * (1 - Math.exp(-Math.max(0, deltaSec) / CROUCH_SPEED_EASE_SEC));
      avatar.applyCrouchPose(poseAmount, this.crouchSpeed, c.crouch.squat, plant, c.crouch.deepExtra, airborne, c.animator.getClipCrouch());
      c.terrainLegs.update(avatar, character.grounded, deltaSec, plant, poseAmount > 0.3, c.animator.getGaitState());
      // Desktop arms come from the clip alone; in XR the tracked hands own them.
      if (!frame.vrActive) {
        // An arm the point or the carry holds is theirs to aim (they run after this, from the pose they found).
        const pointing = c.point.ownedSide();
        const owned = { left: pointing === 'left', right: pointing === 'right' || c.objects.carry.getWeight() > 0 };
        this.phase.velocityY = character.velocityY;
        this.phase.launchSpeed = c.motor.jumpLaunchSpeed;
        c.armClearance.restore(avatar.humanoid);
        c.jumpArms.update(avatar.humanoid, deltaSec, this.phase, owned);
        c.armClearance.apply(avatar.humanoid, owned);
      }
    }
  }

  /**
   * The crouch a flat-screen jump adds (0..1): a squat through the wind-up; a push-off that straightens the legs over
   * the first tenth of a second in the air, the hips rising with them rather than snapping up; legs drawn up a little
   * toward the apex (none at take-off or touch-down, where they push off and reach for the ground); and on landing a
   * dip as deep as the fall was hard, in over a tenth of a second and out over a few tenths.
   */
  private jumpBend(deltaSec: number, grounded: boolean, velocityY: number): number {
    const bend = this.jumpBendRaw(deltaSec, grounded, velocityY);
    this.lastBend = bend;
    this.wasGrounded = grounded;
    return bend;
  }

  private jumpBendRaw(deltaSec: number, grounded: boolean, velocityY: number): number {
    const motor = this.capture.motor;
    const impact = motor.takeLanding();
    if (impact > LANDING_MIN_SPEED) {
      this.sinceLanding = 0;
      this.landingPeak = THREE.MathUtils.clamp(impact / LANDING_FULL_SPEED, LANDING_MIN_PEAK, 1);
    } else this.sinceLanding += Math.max(0, deltaSec);
    if (grounded) this.sinceTakeoff = Infinity;
    else if (this.wasGrounded) {
      this.sinceTakeoff = 0;
      this.takeoffBend = this.lastBend;
    } else this.sinceTakeoff += Math.max(0, deltaSec);
    const phase = this.phase;
    phase.windup = 0;
    // A jump's throw starts with the feet leaving the ground; a step off a ledge (or a bump on a slope that lifts the
    // feet for a frame or two) only once the fall has lasted, so walking over terrain does not flick the arms.
    phase.airborne = !grounded && (this.sinceWindup + this.sinceTakeoff < JUMP_THROW_SEC || this.sinceTakeoff >= FALL_ARMS_SEC);
    if (this.capture.frame.vrActive) return 0;
    const windup = motor.jumpWindup;
    if (windup > 0) {
      this.sinceWindup = 0;
      this.windupBend = JUMP_WINDUP_DEPTH * THREE.MathUtils.smoothstep(windup, 0, 1);
      phase.windup = windup;
      return this.windupBend;
    }
    this.sinceWindup += Math.max(0, deltaSec);
    if (grounded && this.sinceWindup < LAUNCH_GRACE_SEC) {
      phase.windup = 1;
      return this.windupBend;
    }
    if (!grounded) {
      if (this.sinceTakeoff < PUSH_OFF_SEC) return this.takeoffBend * (1 - THREE.MathUtils.smoothstep(this.sinceTakeoff, 0, PUSH_OFF_SEC));
      const rise = THREE.MathUtils.smoothstep(this.sinceTakeoff, PUSH_OFF_SEC, PUSH_OFF_SEC + TUCK_IN_SEC);
      return JUMP_TUCK_DEPTH * rise * Math.max(0, 1 - Math.abs(velocityY) / Math.max(1e-3, motor.jumpLaunchSpeed));
    }
    const t = this.sinceLanding;
    if (t >= LANDING_ATTACK_SEC + LANDING_RELEASE_SEC) return 0;
    const envelope = t < LANDING_ATTACK_SEC
      ? THREE.MathUtils.smoothstep(t, 0, LANDING_ATTACK_SEC)
      : 1 - THREE.MathUtils.smoothstep(t - LANDING_ATTACK_SEC, 0, LANDING_RELEASE_SEC);
    return LANDING_DEPTH * this.landingPeak * envelope;
  }
}

// A jump's wind-up squats to this crouch amount; the legs straighten over PUSH_OFF_SEC after lift-off, then draw up
// to JUMP_TUCK_DEPTH at the apex, eased in over TUCK_IN_SEC. A deeper tuck reads as sitting in the air.
const JUMP_WINDUP_DEPTH = 0.6;
const PUSH_OFF_SEC = 0.12;
const TUCK_IN_SEC = 0.15;
const LAUNCH_GRACE_SEC = 0.1;
const JUMP_TUCK_DEPTH = 0.3;
// The arms' throw belongs to a jump whose wind-up ended within this long of the take-off; any other fall raises
// them only after FALL_ARMS_SEC in the air.
const JUMP_THROW_SEC = 0.5;
const FALL_ARMS_SEC = 0.25;
// A landing at LANDING_FULL_SPEED (m/s, a jump's own touch-down) dips to LANDING_DEPTH; slower ones less, down to
// LANDING_MIN_PEAK of it, and a step down slower than LANDING_MIN_SPEED not at all.
const LANDING_FULL_SPEED = 3.4;
const LANDING_MIN_SPEED = 1.2;
const LANDING_MIN_PEAK = 0.3;
const LANDING_DEPTH = 0.6;
const LANDING_ATTACK_SEC = 0.12;
const LANDING_RELEASE_SEC = 0.35;

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

// Above this crouch pose amount the idle's sway eases out.
const CROUCH_HOLD_STILL = 0.01;

// Time constant for the crouch pose's eased travel speed (s).
const CROUCH_SPEED_EASE_SEC = 0.15;
