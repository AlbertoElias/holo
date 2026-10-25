// Accessible names of the controls that automated checks find by role.
// The apps label their controls from here and the checks look them up from
// here, so a rename changes both or fails to compile.
export const CONTROL_NAMES = {
  startRecording: "Start Recording",
  stopRecording: "Stop Recording",
  play: "Play",
  pause: "Pause",
  returnToAuthorView: "Return to the author's view"
} as const;

export type ControlName = (typeof CONTROL_NAMES)[keyof typeof CONTROL_NAMES];
