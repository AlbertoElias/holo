import * as THREE from 'three';
import { HOLD_DELAY_MS, TOUCH_HOLD_SLOP_APX } from '@holoim/xr-ui-core';
import { screenDistancePx, type ScreenTouch, type ScreenTouchEnd } from '@holoim/xr-ui-iwsdk';

import type { AimPointSample, PointSampleStore } from '../recording/PointSampleStore';
import { isFiniteQuaternionLike, isFiniteVector3Like } from '../shared/math';

interface ScreenHoldsDeps {
  /** The take's held marks. Writes while no take is open are ignored by the store; this also checks `isTakeOpen`. */
  samples: () => PointSampleStore;
  /** A camera take is open: a finger that went down before it, or after it, never marks. */
  isTakeOpen: () => boolean;
  /** The group whose local frame the take is in (the AR world group). */
  setFrame: THREE.Object3D;
  /** The XR view camera: its pose and projection are the screen the finger is on. */
  xrCamera: () => THREE.ArrayCamera;
  /** The screen in CSS px, which on a phone are apx. */
  viewport: () => { width: number; height: number };
  now?: () => number;
}

/** What the hold in progress is, for the check's reports. */
export interface ScreenHoldSnapshot {
  /** `none`: no finger tracked; `pending`: waiting out the hold delay; `dead`: moved past the slop, a drag; `held`: marking. */
  phase: 'none' | 'pending' | 'dead' | 'held';
  /** The pending finger's distance from where it began, on the screen (apx), or null. */
  slopApx: number | null;
}

interface Tracked {
  touch: ScreenTouch;
  /** The finger's direction in the camera's own frame, taken at the touchdown: where it is on the screen. Null only when the camera had no pose then; the first step takes it. */
  baseline: THREE.Vector3 | null;
  /** Rays from touchdown until the hold delay passes; written all at once if it does, so the hold starts at the touch. */
  pending: AimPointSample[];
  held: boolean;
  /** Moved past the slop before the delay: a drag, never a hold. */
  dead: boolean;
  slopApx: number;
}

/**
 * Hold to mark "this" from the phone's camera (docs/features/ar-recording.md,
 * slice 4). Only in a camera take. A finger that did not begin on chrome, is
 * not part of a pinch, stays down `HOLD_DELAY_MS` of wall-clock time
 * (`performance.now()`, as the phone's hold everywhere) and stays within
 * `TOUCH_HOLD_SLOP_APX` of where it began on the screen becomes a hold, and
 * the hold is backdated to the touch. The slop is measured on the screen:
 * the finger's ray direction in the camera's own frame at the start against
 * the same finger's now, projected through the XR camera, so walking or
 * turning with the finger still on the glass does not cancel it. Once held it
 * lasts until the finger lifts, whatever the finger does (as the held-mode
 * machine's `held` phase).
 *
 * One finger is tracked at a time and the others are ignored until it ends;
 * a second finger makes a pinch, which cancels a pending hold and ends a held
 * one where it stood. Each step the hold writes the finger's target ray, in
 * the set's frame, to the take's `PointSampleStore` as a `screen` aim hold;
 * a ray that is not finite is skipped, never written. A hold still down when
 * the take stops or the session ends is closed at that time.
 */
export class ScreenHolds {
  private tracked: Tracked | null = null;
  private readonly setInverse = new THREE.Matrix4();
  private readonly cameraQuaternion = new THREE.Quaternion();
  private readonly localDirection = new THREE.Vector3();
  private readonly worldRay = new THREE.Ray();

  constructor(private readonly deps: ScreenHoldsDeps) {}

  snapshot(): ScreenHoldSnapshot {
    const t = this.tracked;
    if (!t) return { phase: 'none', slopApx: null };
    return { phase: t.held ? 'held' : t.dead ? 'dead' : 'pending', slopApx: t.baseline ? Math.round(t.slopApx * 10) / 10 : null };
  }

  /** A finger went down (`ScreenInputSystem.onTouchStart`), at simulation time `timeSec`. */
  touchStart(touch: ScreenTouch, timeSec: number): void {
    if (this.tracked) return;
    if (touch.beganOnChrome || touch.pinched || !this.deps.isTakeOpen()) return;
    const first = this.sample(touch.downRay, timeSec);
    // The camera as the last frame left it: the touch event carries no viewer pose of its own, and a frame's turn is a fraction of the slop.
    const baseline = this.cameraFrameDirection(touch.downRay.direction);
    this.tracked = { touch, baseline, pending: first ? [first] : [], held: false, dead: false, slopApx: 0 };
  }

  /** The finger lifted, or the session ended with it down: a hold is closed here, a pending one forgotten. */
  touchEnd(touch: ScreenTouch, _end: ScreenTouchEnd, timeSec: number): void {
    const t = this.tracked;
    if (!t || t.touch !== touch) return;
    this.tracked = null;
    if (t.held) this.deps.samples().endAim(timeSec);
  }

  /** Once per simulation step of a camera take, after the camera was recorded. */
  step(timeSec: number): void {
    const t = this.tracked;
    if (!t) return;
    if (!this.deps.isTakeOpen()) {
      // The take stopped under the finger; the store closed its hold when it closed.
      this.tracked = null;
      return;
    }
    if (t.touch.pinched) {
      if (t.held) this.deps.samples().endAim(timeSec);
      this.tracked = null;
      return;
    }
    const camera = this.deps.xrCamera();
    camera.updateMatrixWorld(true);
    // Tracking lost: no pose to read the screen from, and no sample to write.
    if (!camera.matrixWorld.elements.every(Number.isFinite)) return;
    const ray = t.touch.ray;
    if (!isFiniteVector3Like(ray.origin) || !isFiniteVector3Like(ray.direction)) return;

    if (t.held) {
      this.write(t.touch.ray, timeSec);
      return;
    }
    if (t.dead) return;
    camera.getWorldQuaternion(this.cameraQuaternion);
    if (!isFiniteQuaternionLike(this.cameraQuaternion)) return;
    if (!t.baseline) {
      t.baseline = ray.direction.clone().applyQuaternion(this.cameraQuaternion.clone().invert());
    } else {
      // Where the finger began, as the camera sees it now: its direction in the camera's frame at the start, turned with the camera.
      this.worldRay.set(ray.origin, this.localDirection.copy(t.baseline).applyQuaternion(this.cameraQuaternion));
      t.slopApx = screenDistancePx(this.worldRay, ray, camera, this.deps.viewport());
      if (!Number.isFinite(t.slopApx)) return;
      if (t.slopApx > TOUCH_HOLD_SLOP_APX) {
        t.dead = true;
        t.pending.length = 0;
        return;
      }
    }
    const sample = this.sample(ray, timeSec);
    if (sample) t.pending.push(sample);
    if ((this.deps.now ?? performance.now.bind(performance))() - t.touch.downAt < HOLD_DELAY_MS) return;
    // The delay passed with the finger inside the slop: a hold since the touch.
    t.held = true;
    const store = this.deps.samples();
    for (const backdated of t.pending) store.recordAim(backdated);
    t.pending = [];
  }

  /** A world direction in the XR camera's own frame, or null when the camera has no finite pose. */
  private cameraFrameDirection(direction: THREE.Vector3): THREE.Vector3 | null {
    const camera = this.deps.xrCamera();
    camera.updateMatrixWorld(true);
    if (!camera.matrixWorld.elements.every(Number.isFinite)) return null;
    camera.getWorldQuaternion(this.cameraQuaternion);
    if (!isFiniteQuaternionLike(this.cameraQuaternion)) return null;
    const local = direction.clone().applyQuaternion(this.cameraQuaternion.clone().invert());
    return isFiniteVector3Like(local) ? local : null;
  }

  private write(ray: THREE.Ray, timeSec: number): void {
    const sample = this.sample(ray, timeSec);
    if (sample) this.deps.samples().recordAim(sample);
  }

  /** The ray in the set's frame as an aim sample, or null when it is not finite. */
  private sample(ray: THREE.Ray, timeSec: number): AimPointSample | null {
    if (!isFiniteVector3Like(ray.origin) || !isFiniteVector3Like(ray.direction)) return null;
    this.deps.setFrame.updateWorldMatrix(true, false);
    this.setInverse.copy(this.deps.setFrame.matrixWorld).invert();
    const origin = ray.origin.clone().applyMatrix4(this.setInverse);
    const direction = ray.direction.clone().transformDirection(this.setInverse);
    if (!isFiniteVector3Like(origin) || !isFiniteVector3Like(direction)) return null;
    // A camera has no hand: the side is a placeholder the camera resolver ignores.
    return { timeSec, side: 'right', input: 'screen', origin, direction };
  }
}
