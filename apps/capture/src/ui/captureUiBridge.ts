import type { HaloAction, HaloLayout, Handedness } from "@holoim/xr-ui-core";

import type { UiViewModel } from "../types/contracts";
import type { FlatHaloView } from "./flatHalo";

export interface CaptureUiBridge {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => UiViewModel;
  refitHeight: () => boolean;
  toggleRecording: () => void;
  /** The Halo a held B summons: the overlay draws its ring. */
  halo: { subscribe: (listener: () => void) => () => void; getSnapshot: () => FlatHaloView; layout: HaloLayout };
  /** The dock's Halo glyph committed an action. */
  runHaloAction: (action: HaloAction, input: "mouse" | "touch") => void;
  recenterAr: () => void;
  loadObjectFile: (file: File) => void;
  loadTrayFiles: (files: File[]) => void;
  toggleFaceCamera: () => void;
  setHandedness: (handedness: Handedness) => void;
  toggleXr: (mode: "vr" | "ar") => void;
}
