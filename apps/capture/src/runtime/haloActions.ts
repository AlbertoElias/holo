import { createRecordingUiState, type HaloAction } from '@holoim/xr-ui-core';

import type { VrHandSide } from '../types/contracts';

import type { PointHistoryEntry, PointSampleStore } from '../recording/PointSampleStore';
import type { RecordingSession } from '../recording/RecordingSession';
import type { UIStateStore } from '../ui/UIStateStore';
import type { CaptureHistory, HistoryEntry } from './CaptureHistory';

export interface HaloActionDeps {
  ui: UIStateStore;
  recording: Pick<RecordingSession, 'toggle'>;
  getPointSamples: () => PointSampleStore;
  /** Capture's one undo history (docs/features/archive/undo-redo.md): W and E read it. */
  history: CaptureHistory;
  /** The history entry of a mark or trace, for the open-trace rule. */
  entryFor: (point: PointHistoryEntry) => HistoryEntry | undefined;
  /** Simulation time now: an open hold that is undone ends here. */
  getTimeSec: () => number;
  /** Whether any hand's live trace has passed the still extent: what "Nothing traced" asks. Absent: assume something was. */
  anyTraceDrawn?: () => boolean;
}

/** A committed Halo action, for checks: which input committed it and what it did. */
export interface HaloActionRecord {
  input: 'mouse' | 'key' | 'touch' | 'hands' | 'controllers';
  action: HaloAction;
  /** Whether it changed anything (a toggle that ran, an entry undone or restored). */
  done: boolean;
  /** W or E: the entry's kind and status word, when there was one. */
  kind?: HistoryEntry['kind'];
  word?: string;
  /** What the status line said. */
  text?: string;
}

/**
 * Capture's Halo (Q20, PRD-023 v1): S records or stops through the Record
 * control's own gate, W undoes the last authoring action of any kind and E
 * restores it (docs/features/archive/undo-redo.md), NW (Ink) toggles a trace while recording. Each says what happened on
 * the status line, since nothing shows a mark live. `pressSec` is when the
 * Halo was summoned (a headset's press, on the simulation clock), so the
 * gesture that turns Ink off or undoes is not itself traced; flat callers
 * pass none and it is now. `side` is the hand that summoned it.
 */
export function createHaloActions(deps: HaloActionDeps): {
  run: (action: HaloAction, input: HaloActionRecord['input'], pressSec?: number, side?: VrHandSide) => boolean;
  log: HaloActionRecord[];
} {
  const log: HaloActionRecord[] = [];
  const run = (action: HaloAction, input: HaloActionRecord['input'], pressSec?: number, side?: VrHandSide): boolean => {
    const state = deps.ui.getState();
    const recording = state.recordingState === 'recording';
    const samples = deps.getPointSamples();
    let done = false;
    if (action === 'record') {
      done = createRecordingUiState(state.recordingState, state.recordingMessage).canToggle;
      if (done) {
        // An open trace ends at the press, before the take stops.
        if (recording) samples.endTrace(pressSec ?? deps.getTimeSec(), side);
        deps.recording.toggle();
      }
    } else if (action === 'ink') {
      if (!recording) {
        deps.ui.flashNotice('Ink traces while recording');
      } else if (samples.openTrace()) {
        const traced = deps.anyTraceDrawn?.() ?? true;
        samples.endTrace(pressSec ?? deps.getTimeSec(), side);
        done = true;
        deps.ui.flashNotice(traced ? 'Trace kept' : 'Nothing traced');
      } else {
        done = samples.startTrace(deps.getTimeSec(), side);
        if (done) deps.ui.flashNotice('Tracing');
      }
    } else if (action === 'undo' || action === 'redo') {
      if (state.recordingState === 'exporting') {
        deps.ui.flashNotice('Wait for the export');
        log.push({ input, action, done: false, text: 'Wait for the export' });
        return false;
      }
      // An open trace goes first, even if a mark (or anything) came after it began.
      const open = action === 'undo' && recording ? samples.openTraceEntry() : null;
      const preferred = open ? deps.entryFor(open) : undefined;
      const step = action === 'undo' ? deps.history.undo({ timeSec: pressSec ?? deps.getTimeSec() }, preferred) : deps.history.redo();
      deps.ui.flashNotice(step.text);
      log.push({ input, action, done: step.done, ...(step.entry ? { kind: step.entry.kind, word: step.entry.word } : {}), text: step.text });
      return step.done;
    }
    log.push({ input, action, done });
    return done;
  };
  return { run, log };
}
