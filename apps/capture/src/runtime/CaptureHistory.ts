/**
 * What an authoring action changes (docs/features/undo-redo.md): the event is
 * undone forward in time (the inverse is performed now and recorded), meaning
 * is undone out of the take, and the tray is simply reversed.
 */
export type HistoryKind = 'event' | 'meaning' | 'tray';

/** The outcome of an entry's undo or redo: false, or a reason, when it could not run now (the entry stays). */
export type HistoryStepResult = boolean | { refused: string };

/**
 * One undoable authoring action. A feature joins the history by pushing one of
 * these when its action completes; its brief's Undo section says which.
 */
export interface HistoryEntry {
  kind: HistoryKind;
  /** What the status line calls it: "Put back" reads "Put back undone" and "Put back restored". */
  word: string;
  /** `timeSec`: the simulation time W counts from (a headset's Halo press), where an open mark or trace ends. */
  undo: (at: { timeSec: number }) => HistoryStepResult;
  redo: () => HistoryStepResult;
  /** It can no longer be redone (a newer action, or the history cleared). */
  discard?: () => void;
}

/** What one W or E did, for the status line and the checks. */
export interface HistoryStep {
  action: 'undo' | 'redo';
  /** The entry that ran, or null when there was nothing to take. */
  entry: HistoryEntry | null;
  done: boolean;
  /** The status line's words. */
  text: string;
}

/** Pre-take history keeps at most this many entries (the oldest go). */
export const MAX_HISTORY_ENTRIES = 100;

/**
 * Capture's one chronological undo history: W takes the most recent entry of
 * any kind, E puts back the most recently undone one, and any new entry clears
 * what can be redone. It is cleared when a take starts and when it stops.
 * `flush` hooks let an action still in progress (a resize while the prop is
 * held) commit its entry before W or E reads the stack.
 */
export class CaptureHistory {
  private readonly done: HistoryEntry[] = [];
  private readonly undone: HistoryEntry[] = [];
  private readonly flushers: Array<() => void> = [];
  private readonly clearers: Array<() => void> = [];
  /** Every push, undo and redo since load, in order, for checks. */
  readonly log: Array<{ op: 'push' | 'undo' | 'redo' | 'clear'; kind?: HistoryKind; word?: string; done?: boolean }> = [];

  push(entry: HistoryEntry): void {
    this.done.push(entry);
    if (this.done.length > MAX_HISTORY_ENTRIES) this.done.shift();
    this.dropUndone();
    this.log.push({ op: 'push', kind: entry.kind, word: entry.word });
  }

  /** Registers a hook run before W or E: an action in progress commits its entry. */
  onFlush(flush: () => void): void {
    this.flushers.push(flush);
  }

  /** Registers a hook run when the history is cleared. */
  onClear(clear: () => void): void {
    this.clearers.push(clear);
  }

  flush(): void {
    for (const flush of this.flushers) flush();
  }

  /**
   * The Halo's W: the most recent entry, or `preferred` when given (an open
   * trace goes first, even if a mark began inside it).
   */
  undo(at: { timeSec: number }, preferred?: HistoryEntry): HistoryStep {
    this.flush();
    const entry = preferred && this.done.includes(preferred) ? preferred : (this.done.at(-1) ?? null);
    if (!entry) return { action: 'undo', entry: null, done: false, text: 'Nothing to undo' };
    const result = entry.undo(at);
    const done = result === true;
    if (done) {
      this.done.splice(this.done.indexOf(entry), 1);
      this.undone.push(entry);
    }
    this.log.push({ op: 'undo', kind: entry.kind, word: entry.word, done });
    return { action: 'undo', entry, done, text: done ? `${entry.word} undone` : refusal(result, 'undo') };
  }

  /** The Halo's E: the most recently undone entry, put back. */
  redo(): HistoryStep {
    this.flush();
    const entry = this.undone.at(-1) ?? null;
    if (!entry) return { action: 'redo', entry: null, done: false, text: 'Nothing to redo' };
    const result = entry.redo();
    const done = result === true;
    if (done) {
      this.undone.pop();
      this.done.push(entry);
    }
    this.log.push({ op: 'redo', kind: entry.kind, word: entry.word, done });
    return { action: 'redo', entry, done, text: done ? `${entry.word} restored` : refusal(result, 'redo') };
  }

  /** A take starts or stops: nothing before it can be undone. */
  clear(): void {
    this.done.length = 0;
    this.dropUndone();
    for (const clear of this.clearers) clear();
    this.log.push({ op: 'clear' });
  }

  private dropUndone(): void {
    for (const entry of this.undone.splice(0)) entry.discard?.();
  }

  /** Whether `entry` is still undoable (not undone, not cleared). */
  has(entry: HistoryEntry): boolean {
    return this.done.includes(entry);
  }

  counts(): { done: number; undone: number; words: string[]; undoneWords: string[] } {
    return { done: this.done.length, undone: this.undone.length, words: this.done.map((entry) => entry.word), undoneWords: this.undone.map((entry) => entry.word) };
  }
}

function refusal(result: HistoryStepResult, action: 'undo' | 'redo'): string {
  return typeof result === 'object' ? result.refused : action === 'undo' ? 'Nothing to undo' : 'Nothing to redo';
}
