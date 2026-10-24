import type { Handedness } from "@holoim/xr-ui-core";

import type { UiViewModel } from "../types/contracts";

export interface CaptureUiBridge {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => UiViewModel;
  refitHeight: () => boolean;
  toggleRecording: () => void;
  recenterAr: () => void;
  loadObjectFile: (file: File) => void;
  loadTrayFiles: (files: File[]) => void;
  toggleFaceCamera: () => void;
  setHandedness: (handedness: Handedness) => void;
  toggleXr: (mode: "vr" | "ar") => void;
}
