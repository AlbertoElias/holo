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
 * (docs/features/archive/ar-recording.md), a finger held on the screen in phone AR.
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

/**
 * An author-marked trace (PRD-023 v1): the take seconds the author turned Ink
 * on and off, and the hand that summoned the Halo for each toggle (the
 * summoning hand's settle is trimmed at export). `endSec` is undefined while
 * the trace is open.
 */
export interface TraceSpan {
  startSec: number;
  endSec: number | undefined;
  onSide?: VrHandSide;
  offSide?: VrHandSide;
}

/** What `undoLast` or `redoLast` took out or put back. */
export type HistoryKind = 'hold' | 'trace';

/** One hold or trace the take keeps: what capture's history undoes out of the take and restores. */
export type PointHistoryEntry = { kind: 'hold'; hold: AimHold } | { kind: 'trace'; trace: TraceSpan };
type HistoryEntry = PointHistoryEntry;

const entryStart = (entry: HistoryEntry): number => (entry.kind === 'hold' ? entry.hold.samples[0]!.timeSec : entry.trace.startSec);

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
 *   ends. `undoLast` and `redoLast` (the Halo's W and E) take the last hold or
 *   trace out of the take and put it back; a new hold or trace clears what can be redone. While synthesized arm motion is visible (including any
 *   blend back to locomotion), call `recordInferredMotion` each step with the
 *   VRM bones it drives. Aim holds become `recorded` links that override
 *   inferred links over their span; motion runs become `inferred` motion spans.
 */
export class PointSampleStore {
  private enabled = false;
  private readonly handSamples: HandPointSample[] = [];
  private readonly aimHolds: AimHold[] = [];
  /** Author-marked traces, in the order they began. */
  private readonly traces: TraceSpan[] = [];
  /** Holds and traces kept, ordered by when they began: what Undo takes from the end. */
  private readonly history: HistoryEntry[] = [];
  /** Undone entries, most recent last; `redoLast` takes from the end. */
  private readonly undone: HistoryEntry[] = [];
  /** The latest time any writer gave: where a stop closes an open trace. */
  private lastSec = 0;
  /** An open hold was undone while its mark is still held: drop its samples until it is released. */
  private droppingUntilRelease = false;
  private readonly motionRuns: InferredMotionRun[] = [];
  /** A hold or trace began: capture's history (docs/features/undo-redo.md) takes it as a meaning entry. */
  onEntry: ((entry: PointHistoryEntry) => void) | null = null;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.closeOpenHold();
      this.closeOpenTrace(this.lastSec);
    }
  }

  /** The step's simulation time, so a stop can close an open trace where the take ended. */
  noteTime(timeSec: number): void {
    if (timeSec > this.lastSec) this.lastSec = timeSec;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  clear(): void {
    this.handSamples.length = 0;
    this.aimHolds.length = 0;
    this.traces.length = 0;
    this.history.length = 0;
    this.undone.length = 0;
    this.lastSec = 0;
    this.droppingUntilRelease = false;
    this.motionRuns.length = 0;
  }

  recordHandSample(sample: HandPointSample): void {
    if (!this.enabled) return;
    this.noteTime(sample.timeSec);
    this.handSamples.push(copyRaySample(sample));
  }

  /** One step of a held mark. */
  recordAim(sample: AimPointSample): void {
    if (!this.enabled || this.droppingUntilRelease) return;
    this.noteTime(sample.timeSec);
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
    this.undone.length = 0;
    const hold: AimHold = { side: sample.side, input, samples: [copyRaySample(sample)], endSec: undefined };
    this.aimHolds.push(hold);
    this.addEntry({ kind: 'hold', hold });
  }

  /** The hold ended on this step. Safe to call when no hold is open. */
  endAim(timeSec: number): void {
    if (!this.enabled) return;
    this.noteTime(timeSec);
    this.droppingUntilRelease = false;
    const open = this.aimHolds.at(-1);
    if (open && open.endSec === undefined) open.endSec = Math.max(timeSec, open.samples.at(-1)!.timeSec);
  }

  /** The trace still being drawn, or null. */
  openTrace(): TraceSpan | null {
    const last = this.traces.at(-1);
    return last && last.endSec === undefined ? last : null;
  }

  /** Ink on: a trace begins at `sec`, which clears what can be redone. `side` is the hand that summoned the Halo. */
  startTrace(sec: number, side?: VrHandSide): boolean {
    if (!this.enabled || this.openTrace()) return false;
    this.noteTime(sec);
    this.undone.length = 0;
    const trace: TraceSpan = { startSec: sec, endSec: undefined, ...(side ? { onSide: side } : {}) };
    this.traces.push(trace);
    this.addEntry({ kind: 'trace', trace });
    return true;
  }

  /** Ink off: ends the open trace at `sec` (the press of the Halo that turned it off) and returns it; null when none is open. */
  endTrace(sec: number, side?: VrHandSide): TraceSpan | null {
    const open = this.openTrace();
    if (!this.enabled || !open) return null;
    open.endSec = Math.max(sec, open.startSec);
    if (side) open.offSide = side;
    this.noteTime(open.endSec);
    return open;
  }

  /** The entry of the trace still being drawn: W takes it first, even if a hold began inside it. */
  openTraceEntry(): PointHistoryEntry | null {
    const open = this.openTrace();
    return open ? (this.history.find((kept) => kept.kind === 'trace' && kept.trace === open) ?? null) : null;
  }

  /**
   * Takes `entry` out of the take. An open trace ends at `pressSec`; a hold
   * still held ends there too, and the rest of it is ignored until release.
   * False when it is not kept (already undone, or cleared).
   */
  undoEntry(entry: PointHistoryEntry, pressSec: number): boolean {
    if (!this.enabled || !this.history.includes(entry)) return false;
    if (entry.kind === 'trace' && entry.trace.endSec === undefined) entry.trace.endSec = Math.max(pressSec, entry.trace.startSec);
    if (entry.kind === 'hold' && entry.hold.endSec === undefined) {
      entry.hold.endSec = Math.max(pressSec, entry.hold.samples.at(-1)!.timeSec);
      this.droppingUntilRelease = true;
    }
    this.take(entry);
    return true;
  }

  /** Puts an undone `entry` back, in the order it began. False when it is not undone. */
  redoEntry(entry: PointHistoryEntry): boolean {
    if (!this.enabled) return false;
    const index = this.undone.indexOf(entry);
    if (index < 0) return false;
    this.undone.splice(index, 1);
    this.restore(entry);
    return true;
  }

  /** An undone entry can no longer be redone (a newer action came): it stops counting as undone. */
  discardUndone(entry: PointHistoryEntry): void {
    const index = this.undone.indexOf(entry);
    if (index >= 0) this.undone.splice(index, 1);
  }

  /**
   * The take's own last-in order, without capture's history: the open trace,
   * else the entry that began last. Null when there is nothing.
   */
  undoLast(pressSec: number): HistoryKind | null {
    const entry = this.openTraceEntry() ?? this.history.at(-1);
    return entry && this.undoEntry(entry, pressSec) ? entry.kind : null;
  }

  /** Puts the most recently undone hold or trace back. Null when there is none. */
  redoLast(): HistoryKind | null {
    const entry = this.undone.at(-1);
    return entry && this.redoEntry(entry) ? entry.kind : null;
  }

  private addEntry(entry: PointHistoryEntry): void {
    this.history.push(entry);
    this.onEntry?.(entry);
  }

  private restore(entry: HistoryEntry): void {
    // Kept in the order they began, so an undone trace that held a later hold returns before it.
    const at = this.history.findIndex((kept) => entryStart(kept) > entryStart(entry));
    this.history.splice(at < 0 ? this.history.length : at, 0, entry);
    const list: Array<AimHold | TraceSpan> = entry.kind === 'hold' ? this.aimHolds : this.traces;
    const item = entry.kind === 'hold' ? entry.hold : entry.trace;
    const start = (x: AimHold | TraceSpan): number => ('samples' in x ? x.samples[0]!.timeSec : x.startSec);
    const index = list.findIndex((kept) => start(kept) > start(item));
    list.splice(index < 0 ? list.length : index, 0, item);
  }

  private take(entry: HistoryEntry): void {
    const from: Array<AimHold | TraceSpan> = entry.kind === 'hold' ? this.aimHolds : this.traces;
    const item = entry.kind === 'hold' ? entry.hold : entry.trace;
    from.splice(from.indexOf(item), 1);
    this.history.splice(this.history.indexOf(entry), 1);
    this.undone.push(entry);
  }

  /** How many holds the take keeps and how many holds and traces can be redone. */
  holdCounts(): { kept: number; undone: number } {
    return { kept: this.aimHolds.length, undone: this.undone.filter((entry) => entry.kind === 'hold').length };
  }

  /** How many traces the take keeps (an open one counts) and how many can be redone. */
  traceCounts(): { kept: number; undone: number } {
    return { kept: this.traces.length, undone: this.undone.filter((entry) => entry.kind === 'trace').length };
  }

  getTraces(): readonly TraceSpan[] {
    return this.traces;
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
    return this.handSamples.length > 0 || this.aimHolds.length > 0 || this.traces.length > 0 || this.motionRuns.length > 0;
  }

  private closeOpenTrace(sec: number): void {
    const open = this.openTrace();
    if (open) open.endSec = Math.max(sec, open.startSec);
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
