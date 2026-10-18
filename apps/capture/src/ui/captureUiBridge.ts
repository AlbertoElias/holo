import type { UiViewModel } from "../types/contracts";

export interface CaptureUiBridge {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => UiViewModel;
  toggleRecording: () => void;
  recenterAr: () => void;
}
