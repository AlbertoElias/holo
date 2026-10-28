export type VrTurnMode = 'snap' | 'smooth';

/** Thumbstick axes, −1..1. `moveY` is forward-positive (stick up = +1). */
export interface ThumbstickState {
  moveX: number;
  moveY: number;
  turnX: number;
  /** The turn stick's forward axis: it pushes and pulls a held prop. */
  turnY: number;
}

export const STICK_DEADZONE = 0.15;
export const SNAP_TURN_RAD = Math.PI / 6;
const SNAP_TRIGGER = 0.7;
const SNAP_REARM = 0.4;
const SMOOTH_TURN_RATE_RAD = (Math.PI / 2) * 1.2;

const clampUnit = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(-1, v)) : 0);

/**
 * VR thumbstick locomotion state: analog move vector plus snap/smooth
 * turning. Real gamepad axes and the deterministic mock hook both write
 * the same state, so IWER checks exercise the production path.
 */
export class VrLocomotion {
  readonly thumbstick: ThumbstickState = { moveX: 0, moveY: 0, turnX: 0, turnY: 0 };
  /** −1..1 push on a held prop this frame: the turn stick held mostly forward or back while a prop is held. */
  objectPush = 0;
  turnMode: VrTurnMode = 'snap';
  /** Accumulated turn applied to the camera rig, radians. */
  turnYaw = 0;
  snapCount = 0;
  private snapArmed = true;

  setThumbstick(patch: Partial<ThumbstickState>): void {
    if (patch.moveX !== undefined) this.thumbstick.moveX = clampUnit(patch.moveX);
    if (patch.moveY !== undefined) this.thumbstick.moveY = clampUnit(patch.moveY);
    if (patch.turnX !== undefined) this.thumbstick.turnX = clampUnit(patch.turnX);
    if (patch.turnY !== undefined) this.thumbstick.turnY = clampUnit(patch.turnY);
  }

  /**
   * While a prop is held, the turn stick locks to its stronger axis: forward
   * or back pushes and pulls the prop and does not turn.
   */
  updateObjectPush(holding: boolean): void {
    const { turnX, turnY } = this.thumbstick;
    this.objectPush = holding && Math.abs(turnY) > STICK_DEADZONE && Math.abs(turnY) > Math.abs(turnX) ? turnY : 0;
  }

  setTurnMode(mode: VrTurnMode): void {
    this.turnMode = mode;
    this.snapArmed = true;
  }

  resetTurn(): void {
    this.turnYaw = 0;
    this.snapCount = 0;
    this.snapArmed = true;
  }

  /** Deadzoned move vector: x = strafe right, z = forward, magnitude ≤ 1. */
  moveVector(out: { x: number; z: number }): { x: number; z: number } {
    const { moveX, moveY } = this.thumbstick;
    const mag = Math.hypot(moveX, moveY);
    if (mag <= STICK_DEADZONE) {
      out.x = 0;
      out.z = 0;
      return out;
    }
    const scaled = Math.min(1, (mag - STICK_DEADZONE) / (1 - STICK_DEADZONE)) / mag;
    out.x = moveX * scaled;
    out.z = moveY * scaled;
    return out;
  }

  /** Advances turning for one step; returns the yaw delta to apply to the rig. */
  updateTurn(deltaSec: number): number {
    const turnX = this.objectPush !== 0 ? 0 : this.thumbstick.turnX;
    let delta = 0;
    if (this.turnMode === 'smooth') {
      if (Math.abs(turnX) > STICK_DEADZONE) delta = -turnX * SMOOTH_TURN_RATE_RAD * deltaSec;
    } else if (this.snapArmed && Math.abs(turnX) >= SNAP_TRIGGER) {
      delta = -Math.sign(turnX) * SNAP_TURN_RAD;
      this.snapArmed = false;
      this.snapCount += 1;
    }
    if (Math.abs(turnX) <= SNAP_REARM) this.snapArmed = true;
    this.turnYaw += delta;
    return delta;
  }
}
