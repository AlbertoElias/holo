import type { HaloAction, HaloLayout, Handedness } from "@holoim/xr-ui-core";

import type { HouseLook } from "../avatar/houseLook";
import type { StageSpot, UiViewModel } from "../types/contracts";
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
  /** A scanned place (`.spz` or `.ply`) replaces the set (docs/features/splat-capture.md). */
  loadPlaceFile: (file: File) => void;
  loadTrayFiles: (files: File[]) => void;
  loadTrayUrls: (urls: string[]) => void;
  /** The dock's Tray glyph opened or closed the tray (flat screens). */
  setTrayOpen: (open: boolean) => void;
  /** A click or tap on a tray slot summons it. */
  summonTraySlot: (slot: number) => void;
  /** Selfie mode: 1-tap stages a tray slot beside the avatar in frame (docs/features/selfie-prop-staging.md). */
  stageTraySlot: (slot: number, spot: StageSpot) => void;
  /** Selfie mode: loads a prop URL into the tray and stages it immediately in 1 tap. */
  stagePropUrl: (url: string, spot: StageSpot) => void;
  /** Puts all staged event props back into the tray (undoable). */
  clearStagedProps: () => void;
  /** A tray slot dragged up off the row: its item leaves the tray (docs/features/archive/tray-remove.md). */
  removeTraySlot: (slot: number) => void;
  /** The dock's Put back: the held prop goes back into the tray. */
  putBackHeld: () => void;
  toggleFaceCamera: () => void;
  /** Switches between face + hands tracking and face-only without reloading (docs/features/selfie-gestures.md). */
  setBodycamEnabled: (enabled: boolean) => void;
  setHandedness: (handedness: Handedness) => void;
  toggleXr: (mode: "vr" | "ar") => void;
  /** The look panel picked a look for the house base; false when refused (docs/features/your-look.md). */
  setLook: (next: HouseLook) => boolean;
  /** "From a photo" in the look panel: the device's picker opens (docs/features/directed-performance.md, slice 5b). */
  pickLookPhoto: () => void;
  /** "Previous look": the look from before the last photo. */
  previousLook: () => void;
  /** The look panel's height from the screen's bottom in CSS pixels, 0 when closed: the view frames the avatar above it. */
  setLookPanelHeight: (px: number) => void;
}
