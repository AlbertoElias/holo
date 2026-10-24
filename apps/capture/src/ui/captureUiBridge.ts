import type { UiViewModel } from "../types/contracts";

export interface CaptureUiBridge {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => UiViewModel;
  refitHeight: () => boolean;
  toggleRecording: () => void;
  recenterAr: () => void;
  loadObjectFile: (file: File) => void;
}
