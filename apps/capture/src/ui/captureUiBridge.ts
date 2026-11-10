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
  loadTrayUrls: (urls: string[]) => void;
  /** The dock's Tray glyph opened or closed the tray (flat screens). */
  setTrayOpen: (open: boolean) => void;
  /** A click or tap on a tray slot summons it. */
  summonTraySlot: (slot: number) => void;
  /** A tray slot dragged up off the row: its item leaves the tray (docs/features/archive/tray-remove.md). */
  removeTraySlot: (slot: number) => void;
  /** The dock's Put back: the held prop goes back into the tray. */
  putBackHeld: () => void;
  toggleFaceCamera: () => void;
  setHandedness: (handedness: Handedness) => void;
  toggleXr: (mode: "vr" | "ar") => void;
}
