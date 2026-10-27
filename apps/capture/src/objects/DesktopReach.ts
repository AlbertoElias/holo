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
// Standing back up with the prop lasts at least this long, so a prop taken at chest height still rises smoothly into the carry pose.
const LIFT_MIN_SEC = 0.25;

export type ReachPhase = 'idle' | 'reach' | 'lift' | 'carry' | 'lower';

/**
 * Flat-screen pickup and set-down from low: the phases and the body's reach
 * demand (0 to 1), which `CrouchState` turns into a crouch and a squat.
 *
 *   idle → reach → lift → carry → lower → idle
 *
 * `reach` bends toward a prop until the palm is on it; `lift` stands back up
 * holding it; `lower` squats until the held prop is just above a surface. A
 * cancel before the hand arrives goes straight back to `idle`. This class
 * owns the phase and the demand only; `ObjectInteraction` grabs and lets go.
 */
export class DesktopReach {
  phase: ReachPhase = 'idle';
  demand = 0;
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

  /** True while the hand is meant to be taking the prop, before it is held. */
  isReaching(): boolean {
    return this.phase === 'reach';
  }

  /** True from the grasp until the avatar is standing in the carry pose. */
  isLifting(): boolean {
    return this.phase === 'lift';
  }

  begin(object: SceneObject, pointerDown: boolean): void {
    this.phase = 'reach';
    this.object = object;
    this.pointerDown = pointerDown;
    this.sinceSec = 0;
    this.lastPosition = null;
  }

  /** Stands the avatar back up with nothing grabbed (or after a let-go). */
  stop(): void {
    this.phase = 'idle';
    this.object = null;
    this.pointerDown = false;
    this.lastPosition = null;
  }

  /** Back to standing at once, for modes that bring their own pose. */
  reset(): void {
    this.stop();
    this.demand = 0;
  }

  /**
   * One step of a reach: true when it should be cancelled (timeout, or the prop
   * moving). `shoulderToGraspM` and `reachM` drive the demand.
   */
  stepReach(deltaSec: number, objectPosition: THREE.Vector3, shoulderToGraspM: number, reachM: number): 'cancel' | 'reaching' {
    this.sinceSec += deltaSec;
    if (this.sinceSec > REACH_TIMEOUT_SEC) return 'cancel';
    if (this.lastPosition && deltaSec > 0 && this.lastPosition.distanceTo(objectPosition) / deltaSec > REACH_PROP_MAX_MPS) return 'cancel';
    this.lastPosition = (this.lastPosition ?? new THREE.Vector3()).copy(objectPosition);
    if (shoulderToGraspM > reachM * REACH_TARGET_FRACTION) this.demand = Math.min(1, this.demand + REACH_RATE_PER_SEC * deltaSec);
    return 'reaching';
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

  /** Squat further; true once the demand is at its limit. */
  stepLower(deltaSec: number): boolean {
    this.demand = Math.min(1, this.demand + REACH_RATE_PER_SEC * deltaSec);
    return this.demand >= 1;
  }

  /** Idle: the body relaxes back to standing. */
  relax(deltaSec: number): void {
    if (this.phase === 'idle' || this.phase === 'carry') this.demand = Math.max(0, this.demand - REACH_RATE_PER_SEC * deltaSec);
  }
}
