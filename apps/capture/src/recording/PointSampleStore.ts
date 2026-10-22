import type { VrmHumanoidBone } from '@holoim/meaning';
import type { Vec3Like, VrHandSide } from '../types/contracts';

/**
 * One tracked-hand frame of a possible point (headset): the filtered
 * fingertip ray in world space and how much the hand looks like a point.
 * Written only for `xr-hand` input with the joints the score needs; a frame
 * without a sample is a tracking gap.
 */
export interface HandPointSample {
  timeSec: number;
  side: VrHandSide;
  /** Pose score in [0, 1]: index extended, the other three curled, no pinch. */
  score: number;
  origin: Vec3Like;
  /** Unit length. */
  direction: Vec3Like;
}

/** One frame of a held desktop point action: the eye-origin aim ray that decides the referent. */
export interface AimPointSample {
  timeSec: number;
  /** The avatar hand that shows the point; it becomes the link's `from`. */
  side: VrHandSide;
  origin: Vec3Like;
  /** Unit length. */
  direction: Vec3Like;
}

/** A desktop hold: consecutive aim samples between press and release. */
export interface AimHold {
  side: VrHandSide;
  samples: AimPointSample[];
  /** When the hold ended (release, blur, page hidden, pointer lock lost); undefined while held or when recording stopped first. */
  endSec: number | undefined;
}

/** Contiguous frames where synthesized motion, not tracking, drove `bones`. */
export interface InferredMotionRun {
  bones: VrmHumanoidBone[];
  startSec: number;
  endSec: number;
}

// Writes further apart than this belong to separate holds or runs, even
// without an explicit end: the writer missed a release.
const MAX_SAMPLE_GAP_SEC = 0.25;

/**
 * Per-take point evidence, written live while recording and read once at
 * export, where it is segmented and resolved into `HOLOIM_meaning` links.
 * Every `timeSec` is the simulation time `AvatarRecorder.capture` receives
 * for the same step (`CaptureFrame.elapsedSec`), so samples line up with
 * recorded frames. Writes while not recording are ignored.
 *
 * Writers:
 * - Headset: `AvatarRecorder.capture` writes `recordHandSample` from
 *   `PointDetector`.
 * - Desktop point action: on each simulation step while the action is held,
 *   call `recordAim` with the eye-origin aim ray; call `endAim` on the step
 *   the hold ends. While synthesized arm motion is visible (including any
 *   blend back to locomotion), call `recordInferredMotion` each step with the
 *   VRM bones it drives. Aim holds become `recorded` links; motion runs
 *   become `inferred` motion spans.
 */
export class PointSampleStore {
  private enabled = false;
  private readonly handSamples: HandPointSample[] = [];
  private readonly aimHolds: AimHold[] = [];
  private readonly motionRuns: InferredMotionRun[] = [];

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.closeOpenHold();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  clear(): void {
    this.handSamples.length = 0;
    this.aimHolds.length = 0;
    this.motionRuns.length = 0;
  }

  recordHandSample(sample: HandPointSample): void {
    if (!this.enabled) return;
    this.handSamples.push(copyRaySample(sample));
  }

  /** Desktop: one step of a held point action. */
  recordAim(sample: AimPointSample): void {
    if (!this.enabled) return;
    const open = this.aimHolds.at(-1);
    const last = open?.samples.at(-1);
    const continues = open && open.endSec === undefined && open.side === sample.side && last && sample.timeSec - last.timeSec <= MAX_SAMPLE_GAP_SEC;
    if (continues) {
      open.samples.push(copyRaySample(sample));
      return;
    }
    this.closeOpenHold();
    this.aimHolds.push({ side: sample.side, samples: [copyRaySample(sample)], endSec: undefined });
  }

  /** Desktop: the hold ended on this step. Safe to call when no hold is open. */
  endAim(timeSec: number): void {
    if (!this.enabled) return;
    const open = this.aimHolds.at(-1);
    if (open && open.endSec === undefined) open.endSec = Math.max(timeSec, open.samples.at(-1)!.timeSec);
  }

  /** Desktop: synthesized motion drove `bones` on this step. */
  recordInferredMotion(timeSec: number, bones: readonly VrmHumanoidBone[]): void {
    if (!this.enabled || bones.length === 0) return;
    const run = this.motionRuns.at(-1);
    if (run && sameBones(run.bones, bones) && timeSec - run.endSec <= MAX_SAMPLE_GAP_SEC && timeSec >= run.endSec) {
      run.endSec = timeSec;
      return;
    }
    this.motionRuns.push({ bones: [...bones], startSec: timeSec, endSec: timeSec });
  }

  getHandSamples(): readonly HandPointSample[] {
    return this.handSamples;
  }

  getAimHolds(): readonly AimHold[] {
    return this.aimHolds;
  }

  getInferredMotionRuns(): readonly InferredMotionRun[] {
    return this.motionRuns;
  }

  hasSamples(): boolean {
    return this.handSamples.length > 0 || this.aimHolds.length > 0 || this.motionRuns.length > 0;
  }

  private closeOpenHold(): void {
    const open = this.aimHolds.at(-1);
    if (open && open.endSec === undefined) open.endSec = open.samples.at(-1)!.timeSec;
  }
}

function copyRaySample<T extends { origin: Vec3Like; direction: Vec3Like }>(sample: T): T {
  return {
    ...sample,
    origin: { x: sample.origin.x, y: sample.origin.y, z: sample.origin.z },
    direction: { x: sample.direction.x, y: sample.direction.y, z: sample.direction.z }
  };
}

function sameBones(a: readonly VrmHumanoidBone[], b: readonly VrmHumanoidBone[]): boolean {
  return a.length === b.length && a.every((bone, i) => bone === b[i]);
}
