import * as THREE from 'three';

import type { SceneObject } from './SceneObjectRegistry';

/** How fast the body's reach demand rises or falls, per second: a full squat takes half a second. */
export const REACH_RATE_PER_SEC = 2;
/** A reach that has not closed on the prop by now gives up and stands. */
export const REACH_TIMEOUT_SEC = 1.5;
/** The prop is taken once the avatar's palm is this close to its bounds. */
export const REACH_PALM_M = 0.1;
/** The demand rises until the grasp point is within this fraction of the arm's reach of the shoulder. */
export const REACH_TARGET_FRACTION = 0.95;
/** A prop that moves faster than this while it is being reached for is left alone. */
export const REACH_PROP_MAX_MPS = 0.05;
/** A flat-screen pickup from low first steps in until the prop's grasp point is this far ahead of the toes. */
export const REACH_STEP_AHEAD_M = 0.25;
/** A step shorter than this is skipped: the avatar is already close enough. */
export const REACH_STEP_MIN_M = 0.05;
const STEP_PEAK_MPS = 0.7;
const STEP_ACCEL_MPS2 = 2.4;
const STEP_MIN_MPS = 0.15;
// The step's own budget (the reach timeout covers the squat only), and how long the legs get to settle into the idle stance before the feet are planted.
const STEP_TIMEOUT_SEC = 2.5;
const STEP_SETTLE_SEC = 0.3;
// The step gives up and squats from where it stands when the toes stop closing on the prop (a wall).
const STEP_STALL_SEC = 0.4;
// A set-down whose hand is still short goes past the full squat (deeper hips, never more lean) from this demand on.
const DEEP_FROM_DEMAND = 0.85;
// Standing back up with the prop lasts at least this long, so a prop taken at chest height still rises smoothly into the carry pose.
const LIFT_MIN_SEC = 0.25;

/** The relax after a let-go or a cancel takes this long to reach its full rate. */
const RELAX_EASE_SEC = 0.15;

export type ReachPhase = 'idle' | 'step' | 'reach' | 'lift' | 'carry' | 'lower';

/**
 * Flat-screen pickup and set-down from low: the phases and the body's reach
 * demand (0 to 1), which `CrouchState` turns into a crouch and a squat.
 *
 *   idle → step → reach → lift → carry → lower → idle
 *
 * `step` walks the avatar in until the prop is a squat away (skipped when it
 * is close already); `reach` bends toward a prop until the palm is on it; `lift` stands back up
 * holding it; `lower` squats until the held prop is just above a surface. A
 * cancel before the hand arrives goes straight back to `idle`. This class
 * owns the phase and the demand only; `ObjectInteraction` grabs and lets go.
 */
export class DesktopReach {
  phase: ReachPhase = 'idle';
  demand = 0;
  /** 0 to 1: extra depth past a full squat, only while a set-down's hand still can't reach the floor. */
  deepExtra = 0;
  object: SceneObject | null = null;
  /** The pointer that started the reach is still down. */
  pointerDown = false;
  /** Where the hand was sent: the top centre of the prop's bounds when it was reached for. */
  readonly grasp = new THREE.Vector3();
  private sinceSec = 0;
  private liftT = 0;
  private liftFrom = 0;
  private liftWorld = 0;
  private lastPosition: THREE.Vector3 | null = null;
  private stepSpeed = 0;
  private stepSec = 0;
  private settleSec = 0;
  private bestRemaining = Infinity;
  private stalledSec = 0;
  /** The demand's and the extra depth's current rates (per second), so a relax carries on from a squat still going down. */
  private stepBlocked = false;
  private demandVel = 0;
  private deepVel = 0;

  /** True while the hand is meant to be taking the prop, before it is held (the step in included). */
  isReaching(): boolean {
    return this.phase === 'reach' || this.phase === 'step';
  }

  /** True while the avatar is stepping in: its movement is the reach's, not walking. */
  isStepping(): boolean {
    return this.phase === 'step';
  }

  /** True from the grasp until the avatar is standing in the carry pose. */
  isLifting(): boolean {
    return this.phase === 'lift';
  }

  /** `stepM`: how far the avatar must step in first; a step under `REACH_STEP_MIN_M` is skipped. */
  begin(object: SceneObject, pointerDown: boolean, stepM = 0): void {
    this.phase = stepM >= REACH_STEP_MIN_M ? 'step' : 'reach';
    this.stepBlocked = false;
    this.stepSpeed = 0;
    this.stepSec = 0;
    this.settleSec = 0;
    this.bestRemaining = Infinity;
    this.stalledSec = 0;
    this.object = object;
    this.pointerDown = pointerDown;
    this.sinceSec = 0;
    this.lastPosition = null;
  }

  /** Stands the avatar back up with nothing grabbed (or after a let-go). */
  stop(): void {
    this.phase = 'idle';
    this.stepSpeed = 0;
    this.object = null;
    this.pointerDown = false;
    this.lastPosition = null;
  }

  /** Back to standing at once, for modes that bring their own pose. */
  reset(): void {
    this.stop();
    this.demand = 0;
    this.deepExtra = 0;
    this.demandVel = 0;
    this.deepVel = 0;
  }

  /**
   * One step of a reach: true when it should be cancelled (timeout, or the prop
   * moving). `shoulderToGraspM` and `reachM` drive the demand.
   */
  stepReach(deltaSec: number, objectPosition: THREE.Vector3, shoulderToGraspM: number, reachM: number): 'cancel' | 'reaching' {
    if (this.phase === 'reach') this.sinceSec += deltaSec;
    if (this.sinceSec > REACH_TIMEOUT_SEC) return 'cancel';
    if (this.lastPosition && deltaSec > 0 && this.lastPosition.distanceTo(objectPosition) / deltaSec > REACH_PROP_MAX_MPS) return 'cancel';
    this.lastPosition = (this.lastPosition ?? new THREE.Vector3()).copy(objectPosition);
    if (this.phase === 'reach') {
      this.demandVel = shoulderToGraspM > reachM * REACH_TARGET_FRACTION && this.demand < 1 ? REACH_RATE_PER_SEC : 0;
      this.demand = Math.min(1, this.demand + this.demandVel * deltaSec);
    }
    return 'reaching';
  }

  /** The ground ends ahead: the step is over where it stands. */
  blockStep(): void {
    this.stepBlocked = true;
  }

  /**
   * One frame of the step in: how far to move toward the prop this frame, given
   * how far is left (the toes' distance to the stance, measured after last
   * frame's move). Eases up to a walking pace and back down, then waits for the
   * legs to settle before the squat plants the feet. Hands over to `reach` when done.
   */
  stepTowards(deltaSec: number, remainingM: number): number {
    this.stepSec += deltaSec;
    if (remainingM < this.bestRemaining - 0.002) {
      this.bestRemaining = remainingM;
      this.stalledSec = 0;
    } else this.stalledSec += deltaSec;
    const arrived = this.stepBlocked || remainingM <= 0.005 || this.stepSec > STEP_TIMEOUT_SEC || this.stalledSec > STEP_STALL_SEC;
    if (arrived) {
      this.stepSpeed = 0;
      this.settleSec += deltaSec;
      if (this.settleSec >= STEP_SETTLE_SEC) {
        this.phase = 'reach';
        this.sinceSec = 0;
        this.lastPosition = null;
      }
      return 0;
    }
    const brake = Math.sqrt(2 * STEP_ACCEL_MPS2 * Math.max(0, remainingM));
    this.stepSpeed = Math.max(STEP_MIN_MPS, Math.min(this.stepSpeed + STEP_ACCEL_MPS2 * deltaSec, STEP_PEAK_MPS, brake));
    return Math.min(remainingM, this.stepSpeed * deltaSec);
  }

  /** The palm is on the prop: stand up with it. `worldTarget` is whether the hand heads for the grasp point first. */
  beginLift(worldTarget: boolean): void {
    this.phase = 'lift';
    this.liftT = 0;
    this.liftFrom = this.demand;
    this.liftWorld = worldTarget ? 1 : 0;
    this.lastPosition = null;
  }

  /** Stand up: true once the demand is gone. */
  stepLift(deltaSec: number): boolean {
    const duration = Math.max(LIFT_MIN_SEC, this.liftFrom / REACH_RATE_PER_SEC);
    this.liftT = Math.min(1, this.liftT + deltaSec / duration);
    const ease = this.liftT * this.liftT * (3 - 2 * this.liftT);
    this.demand = this.liftFrom * (1 - ease);
    this.deepExtra = Math.max(0, this.deepExtra - REACH_RATE_PER_SEC * deltaSec);
    this.demandVel = 0;
    this.deepVel = 0;
    if (this.liftT >= 1) {
      this.demand = 0;
      this.phase = 'carry';
      return true;
    }
    return false;
  }

  /** How much the hand still heads for the grasp point rather than the carry pose: 1 at the grasp, 0 once standing. */
  worldBlend(): number {
    if (this.phase === 'reach') return 1;
    if (this.phase !== 'lift') return 0;
    return this.liftWorld * (1 - this.liftT * this.liftT * (3 - 2 * this.liftT));
  }

  beginLower(): void {
    this.phase = 'lower';
  }

  /** Squat further while the hand needs it (`needMore`); true once the demand is at its limit. */
  stepLower(deltaSec: number, needMore = true): boolean {
    const deeper = needMore && this.demand >= DEEP_FROM_DEMAND && this.deepExtra < 1;
    this.deepVel = deeper ? 2 * REACH_RATE_PER_SEC : 0;
    this.deepExtra = Math.min(1, this.deepExtra + this.deepVel * deltaSec);
    this.demandVel = needMore && this.demand < 1 ? REACH_RATE_PER_SEC : 0;
    this.demand = Math.min(1, this.demand + this.demandVel * deltaSec);
    return this.demand >= 1;
  }

  /**
   * Idle: the body relaxes back to standing. The rates of the demand and the extra depth turn around at a finite
   * acceleration, from whatever they were (a squat still going down when the prop is let go keeps going a moment), so the hips never reverse in one step.
   */
  relax(deltaSec: number): void {
    const accel = (2 * REACH_RATE_PER_SEC) / RELAX_EASE_SEC;
    if (this.phase === 'idle' || this.phase === 'carry') {
      this.demandVel = Math.max(-REACH_RATE_PER_SEC, this.demandVel - accel * deltaSec);
      this.demand = THREE.MathUtils.clamp(this.demand + this.demandVel * deltaSec, 0, 1);
      if (this.demand <= 0 || this.demand >= 1) this.demandVel = 0;
    }
    if (this.phase !== 'lower') {
      this.deepVel = Math.max(-REACH_RATE_PER_SEC, this.deepVel - accel * deltaSec);
      this.deepExtra = THREE.MathUtils.clamp(this.deepExtra + this.deepVel * deltaSec, 0, 1);
      if (this.deepExtra <= 0 || this.deepExtra >= 1) this.deepVel = 0;
    }
  }
}
