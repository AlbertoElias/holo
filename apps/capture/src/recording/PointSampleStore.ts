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

/**
 * What held the mark "this" (docs/features/ui-redesign.md, slice 5): the
 * desktop point action, a phone's touch and hold, the non-dominant
 * thumb–middle pinch, or the non-dominant trigger; and, in a camera take
 * (docs/features/ar-recording.md), a finger held on the screen in phone AR.
 */
export type AimInput = 'desktop' | 'touch' | 'hands' | 'controllers' | 'screen';

/**
 * One frame of a held mark: the ray that decides the referent. Desktop: the
 * eye-origin aim ray; phone: the camera ray through the finger; hands: the
 * dominant index's filtered fingertip ray; controllers: the dominant target ray;
 * screen (a camera take): the target ray of the finger held on the phone's
 * screen, in the set's frame.
 */
export interface AimPointSample {
  timeSec: number;
  /** The avatar hand that shows the point; it becomes the link's `from`. A camera take's `screen` holds have no hand: any side, ignored. */
  side: VrHandSide;
  /** Default `desktop`. */
  input?: AimInput;
  origin: Vec3Like;
  /** Unit length. */
  direction: Vec3Like;
}

/** A hold: consecutive aim samples between press and release. */
export interface AimHold {
  side: VrHandSide;
  input: AimInput;
  samples: AimPointSample[];
  /** When the hold ended (release, blur, page hidden, pointer lock lost, tracking lost, undo); undefined while held or when recording stopped first. */
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
 * - Held marks (desktop point action, phone touch, headset pinch or
 *   trigger): on each simulation step while the mark is held, call
 *   `recordAim` with its ray and input; call `endAim` on the step the hold
 *   ends. `undoLastHold` and `redoHold` (the Halo's W and E) take the last
 *   hold out of the take and put it back; a new hold clears what can be redone. While synthesized arm motion is visible (including any
 *   blend back to locomotion), call `recordInferredMotion` each step with the
 *   VRM bones it drives. Aim holds become `recorded` links that override
 *   inferred links over their span; motion runs become `inferred` motion spans.
 */
export class PointSampleStore {
  private enabled = false;
  private readonly handSamples: HandPointSample[] = [];
  private readonly aimHolds: AimHold[] = [];
  /** Undone holds, most recent last; `redoHold` takes from the end. */
  private readonly undoneHolds: AimHold[] = [];
  /** An open hold was undone while its mark is still held: drop its samples until it is released. */
  private droppingUntilRelease = false;
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
    this.undoneHolds.length = 0;
    this.droppingUntilRelease = false;
    this.motionRuns.length = 0;
  }

  recordHandSample(sample: HandPointSample): void {
    if (!this.enabled) return;
    this.handSamples.push(copyRaySample(sample));
  }

  /** One step of a held mark. */
  recordAim(sample: AimPointSample): void {
    if (!this.enabled || this.droppingUntilRelease) return;
    const input = sample.input ?? 'desktop';
    const open = this.aimHolds.at(-1);
    const last = open?.samples.at(-1);
    // A headset or touch hold is one held mode, opened and closed by its writer, so a gap in
    // the aiming hand's tracking stays inside it; desktop splits on a gap as a missed release.
    const bridged = input !== 'desktop' || (last !== undefined && sample.timeSec - last.timeSec <= MAX_SAMPLE_GAP_SEC);
    const continues = open && open.endSec === undefined && open.side === sample.side && open.input === input && last && bridged;
    if (continues) {
      open.samples.push(copyRaySample(sample));
      return;
    }
    this.closeOpenHold();
    this.undoneHolds.length = 0;
    this.aimHolds.push({ side: sample.side, input, samples: [copyRaySample(sample)], endSec: undefined });
  }

  /** The hold ended on this step. Safe to call when no hold is open. */
  endAim(timeSec: number): void {
    if (!this.enabled) return;
    this.droppingUntilRelease = false;
    const open = this.aimHolds.at(-1);
    if (open && open.endSec === undefined) open.endSec = Math.max(timeSec, open.samples.at(-1)!.timeSec);
  }

  /**
   * The Halo's W: takes the take's last hold out (ending it first if it is
   * still held, and ignoring the rest of that hold). False when there is none.
   */
  undoLastHold(timeSec: number): boolean {
    if (!this.enabled) return false;
    const last = this.aimHolds.at(-1);
    if (!last) return false;
    if (last.endSec === undefined) {
      last.endSec = Math.max(timeSec, last.samples.at(-1)!.timeSec);
      this.droppingUntilRelease = true;
    }
    this.undoneHolds.push(this.aimHolds.pop()!);
    return true;
  }

  /** The Halo's E: puts the last undone hold back. False when there is none. */
  redoHold(): boolean {
    if (!this.enabled) return false;
    const hold = this.undoneHolds.pop();
    if (!hold) return false;
    // A new hold clears the undone ones, so every kept hold is older than this one.
    this.aimHolds.push(hold);
    return true;
  }

  /** How many holds the take keeps and how many can be redone. */
  holdCounts(): { kept: number; undone: number } {
    return { kept: this.aimHolds.length, undone: this.undoneHolds.length };
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

  /** Drops a hand's samples inside its authoring spans (PRD-045): a reach into the tray is not a point. */
  dropHandSamplesWithin(spans: ReadonlyArray<{ hand: VrHandSide; start: number; end: number }>): void {
    if (spans.length === 0) return;
    const kept = this.handSamples.filter((sample) => !spans.some((span) => span.hand === sample.side && sample.timeSec >= span.start && sample.timeSec <= span.end));
    this.handSamples.length = 0;
    this.handSamples.push(...kept);
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
