import type { Entity, World } from "@iwsdk/core";

export type XrViewMode = "vr" | "ar";

export type PlacementStage = "searching" | "placed" | "anchored";
export type PlacementMode = "hit-test" | "floor" | "tap" | "vr-default";

export interface PlacementState {
  stage: PlacementStage;
  mode: PlacementMode | null;
  /** Bumps on every placement, so observers can tell re-placements apart. */
  sequence: number;
  position: [number, number, number] | null;
}

/** Shared state of one viewer World; systems read it from `world.globals.viewer`. */
export interface ViewerContext {
  mode: XrViewMode;
  /** The hologram the controls act on (step 4 adds several). */
  focused: Entity | null;
  placement: PlacementState;
  /** Asks the placement system to place the focused hologram again. */
  recenterRequested: boolean;
}

export function createViewerContext(mode: XrViewMode): ViewerContext {
  return {
    mode,
    focused: null,
    placement: { stage: "searching", mode: null, sequence: 0, position: null },
    recenterRequested: false
  };
}

export function viewerContext(world: World): ViewerContext {
  return world.globals.viewer as ViewerContext;
}
