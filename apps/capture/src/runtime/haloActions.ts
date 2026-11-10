import { createRecordingUiState, type HaloAction } from '@holoim/xr-ui-core';

import type { VrHandSide } from '../types/contracts';

import type { PointSampleStore } from '../recording/PointSampleStore';
import type { RecordingSession } from '../recording/RecordingSession';
import type { UIStateStore } from '../ui/UIStateStore';

export interface HaloActionDeps {
  ui: UIStateStore;
  recording: Pick<RecordingSession, 'toggle'>;
  getPointSamples: () => PointSampleStore;
  /** Simulation time now: an open hold that is undone ends here. */
  getTimeSec: () => number;
  /** Whether any hand's live trace has passed the still extent: what "Nothing traced" asks. Absent: assume something was. */
  anyTraceDrawn?: () => boolean;
}

/** A committed Halo action, for checks: which input committed it and what it did. */
export interface HaloActionRecord {
  input: 'mouse' | 'key' | 'touch' | 'hands' | 'controllers';
  action: HaloAction;
  /** Whether it changed anything (a toggle that ran, a hold undone or restored). */
  done: boolean;
}

/**
 * Capture's Halo (Q20, PRD-023 v1): S records or stops through the Record
 * control's own gate, W undoes the take's last mark or trace and E restores
 * it, NW (Ink) toggles a trace while recording. Each says what happened on
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
      const kind = recording ? (action === 'undo' ? samples.undoLast(pressSec ?? deps.getTimeSec()) : samples.redoLast()) : null;
      done = kind !== null;
      const text = kind === 'trace' ? (action === 'undo' ? 'Trace undone' : 'Trace restored') : kind === 'hold' ? (action === 'undo' ? 'Mark undone' : 'Mark restored') : action === 'undo' ? 'Nothing to undo' : 'Nothing to redo';
      deps.ui.flashNotice(text);
    }
    log.push({ input, action, done });
    return done;
  };
  return { run, log };
}
