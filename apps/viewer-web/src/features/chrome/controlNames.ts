// Accessible names of the viewer's own controls. The viewer labels its
// controls from here and its e2e checks find them from here, so a rename
// changes both. Names shared with capture live in `CONTROL_NAMES`.
import { CONTROL_NAMES } from "@holoim/xr-ui-core";

export const VIEWER_CONTROL_NAMES = {
  play: CONTROL_NAMES.play,
  pause: CONTROL_NAMES.pause,
  free: "Free",
  returnToAuthorView: CONTROL_NAMES.returnToAuthorView,
  viewInAr: "View in your room",
  stepInside: "Step inside",
  highlights: "Highlight what the author points at",
  tiltOn: "Look around by tilting the phone",
  tiltOff: "Stop looking around by tilting",
  soundOn: "Unmute audio",
  soundOff: "Mute audio",
  openUpload: "Upload a hologram",
  submitUpload: "Upload",
  retry: "Try again",
  exitAr: "Exit AR",
  recenter: "Recenter Model",
  trueSize: "Return to true size",
  backToFeed: "Back to Feed"
} as const;
