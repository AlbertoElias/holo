import { createRecordingUiState, type HaloAction } from '@holoim/xr-ui-core';

import type { PointSampleStore } from '../recording/PointSampleStore';
import type { RecordingSession } from '../recording/RecordingSession';
import type { UIStateStore } from '../ui/UIStateStore';

export interface HaloActionDeps {
  ui: UIStateStore;
  recording: Pick<RecordingSession, 'toggle'>;
  getPointSamples: () => PointSampleStore;
  /** Simulation time now: an open hold that is undone ends here. */
  getTimeSec: () => number;
}

/** A committed Halo action, for checks: which input committed it and what it did. */
export interface HaloActionRecord {
  input: 'mouse' | 'key' | 'touch' | 'hands' | 'controllers';
  action: HaloAction;
  /** Whether it changed anything (a toggle that ran, a hold undone or restored). */
  done: boolean;
}

/**
 * Capture's Halo (Q20): S records or stops through the Record control's own
 * gate, W undoes the take's last held mark and E restores it. Each says what
 * happened on the status line, since nothing shows a mark live.
 */
export function createHaloActions(deps: HaloActionDeps): { run: (action: HaloAction, input: HaloActionRecord['input']) => boolean; log: HaloActionRecord[] } {
  const log: HaloActionRecord[] = [];
  const run = (action: HaloAction, input: HaloActionRecord['input']): boolean => {
    const state = deps.ui.getState();
    let done = false;
    if (action === 'record') {
      done = createRecordingUiState(state.recordingState, state.recordingMessage).canToggle;
      if (done) deps.recording.toggle();
    } else if (action === 'undo' || action === 'redo') {
      const samples = deps.getPointSamples();
      const recording = state.recordingState === 'recording';
      done = recording && (action === 'undo' ? samples.undoLastHold(deps.getTimeSec()) : samples.redoHold());
      deps.ui.flashNotice(done ? (action === 'undo' ? 'Mark undone' : 'Mark restored') : action === 'undo' ? 'Nothing to undo' : 'Nothing to redo');
    }
    log.push({ input, action, done });
    return done;
  };
  return { run, log };
}
