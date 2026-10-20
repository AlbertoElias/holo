import { createComponent, Types } from '@iwsdk/core';

// Capture's domain state as native ECS components on one `capture` entity, so
// IWSDK's ECS tools (find, query, snapshot, diff, set) inspect and drive the
// real simulation. Values are published after each step by
// CaptureStateSystem; fields marked "control" are requests that
// CaptureControlSystem applies before the next step, with the same rules as
// the UI. Positions use Float64 so published values match the simulation.

export const CaptureSimulation = createComponent('CaptureSimulation', {
  steps: { type: Types.Int32, default: 0 },
  elapsedSec: { type: Types.Float64, default: 0 },
  clockMode: { type: Types.String, default: 'realtime' },
  appMode: { type: Types.String, default: 'desktop-third' },
  xrSession: { type: Types.String, default: 'none' }
}, 'Capture simulation clock, view mode and XR session (published).');

export const CaptureCharacter = createComponent('CaptureCharacter', {
  x: { type: Types.Float64, default: 0 },
  y: { type: Types.Float64, default: 0 },
  z: { type: Types.Float64, default: 0 },
  grounded: { type: Types.Boolean, default: false },
  horizontalSpeed: { type: Types.Float64, default: 0 },
  locomotion: { type: Types.String, default: 'idle' },
  crouch: { type: Types.Float64, default: 0 }
}, 'Rapier character body and locomotion (published).');

export const CaptureBody = createComponent('CaptureBody', {
  active: { type: Types.Boolean, default: false },
  headTracked: { type: Types.Boolean, default: false },
  aligned: { type: Types.Boolean, default: false },
  translating: { type: Types.Boolean, default: false },
  turning: { type: Types.Boolean, default: false },
  bodyYaw: { type: Types.Float64, default: 0 },
  steps: { type: Types.Int32, default: 0 },
  leftHandSource: { type: Types.String, default: 'none' },
  rightHandSource: { type: Types.String, default: 'none' }
}, 'Room-scale body solver and tracked hand sources (published).');

export const CaptureHeightFit = createComponent('CaptureHeightFit', {
  // Fitted eye height in meters; -1 before a fit.
  eyeHeight: { type: Types.Float64, default: -1 },
  avatarScale: { type: Types.Float64, default: 1 },
  refitPending: { type: Types.Boolean, default: false },
  sizeLocked: { type: Types.Boolean, default: false },
  // Control: set true to ask for a refit; reset to false when applied.
  refitRequested: { type: Types.Boolean, default: false },
  // Outcome of the last requested refit: none, accepted or rejected.
  refitResult: { type: Types.String, default: 'none' }
}, 'Avatar height fit; refitRequested is a control (same rules as the Refit height button).');

export const CaptureRecording = createComponent('CaptureRecording', {
  state: { type: Types.String, default: 'idle' },
  frames: { type: Types.Int32, default: 0 },
  // Simulation time of the last recorded frame; -1 before the first.
  lastFrameSec: { type: Types.Float64, default: -1 },
  // Control: set true to start or stop recording, as the R key does.
  toggleRequested: { type: Types.Boolean, default: false }
}, 'Recording state; toggleRequested is a control (same rules as the record button).');

export const CAPTURE_COMPONENTS = [CaptureSimulation, CaptureCharacter, CaptureBody, CaptureHeightFit, CaptureRecording] as const;
