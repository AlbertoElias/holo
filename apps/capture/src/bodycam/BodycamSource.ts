import { type BodyFrame, convertLandmarkFrame } from './convert';
import type { LandmarkFrame } from './types';

/** A frame older than this is no longer the author: every hand holds, then eases to rest. */
export const BODYCAM_FRESH_SEC = 0.2;
/** A hand without fresh data holds its last pose this long, then eases to rest. */
export const BODYCAM_HAND_HOLD_SEC = 0.5;
export const BODYCAM_REST_EASE_SEC = 0.4;

/**
 * The camera as a tracking source: the latest landmark frame, how old it is,
 * and its conversion to the avatar's body frame. Armed by the first frame of a
 * page opened with `?input=camera`; released on VR entry. It never touches the
 * avatar: XrTracking reads `current`, the head driver reads `current.head`.
 */
export class BodycamSource {
  private latest: LandmarkFrame | null = null;
  private armed = false;
  private ageSec = Infinity;
  private frames = 0;
  /** The latest fresh frame in the body frame, or null while there is none. */
  current: BodyFrame | null = null;
  /** The step's duration, for hold and ease timing. */
  dtSec = 0;
  /** The body's world yaw (radians, the avatar's look yaw) that body-frame points are rotated by. */
  worldYaw = 0;
  /** The avatar's shoulder width, metres: also what the rest pose scales by. */
  shoulderWidth = 0;

  constructor(readonly enabled: boolean) {}

  /** True once a frame has arrived and until the source is released. */
  isActive(): boolean {
    return this.enabled && this.armed;
  }

  frameCount(): number {
    return this.frames;
  }

  /** A frame from the tracker; ignored unless the page opted in with `?input=camera`. */
  feed(frame: LandmarkFrame): void {
    if (!this.enabled) return;
    this.latest = frame;
    this.ageSec = 0;
    this.armed = true;
    this.frames += 1;
  }

  /** Drops the frame and disarms: VR took over, or the camera stopped. */
  release(): void {
    this.latest = null;
    this.current = null;
    this.armed = false;
    this.ageSec = Infinity;
  }

  /** Once per simulation step, before the hands read `current`. */
  update(dtSec: number, shoulderWidth: number, worldYaw: number): void {
    this.dtSec = dtSec;
    this.worldYaw = worldYaw;
    this.shoulderWidth = shoulderWidth;
    this.ageSec += dtSec;
    this.current = this.armed && this.latest && this.ageSec <= BODYCAM_FRESH_SEC ? convertLandmarkFrame(this.latest, shoulderWidth) : null;
  }
}
