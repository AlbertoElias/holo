import type { Entity, World } from "@iwsdk/core";
import type { XrUiTarget } from "@holoim/xr-ui-iwsdk";
import type { Object3D, Vector3 } from "three";

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

/** One hologram placed in the space (step 4: up to MAX_PLACED_HOLOGRAMS). */
export interface PlacedHologram {
  /** Feed id. */
  id: string;
  url: string;
  entity: Entity;
  /** The recorded scene's clone under the entity. */
  model: Object3D;
  placement: PlacementState;
  /** Asks the placement system to place it again in front of the viewer. */
  recenterRequested: boolean;
  /** Horizontal half-diagonal of its pointer box at recorded scale. */
  footprintRadius: number;
}

/**
 * Where placed holograms stand: the first placement fixes the stage's front,
 * and the next ones take free places beside it at the same distance.
 */
export interface Stage {
  /** The viewer's spot on the floor at the first placement. */
  origin: Vector3;
  /** Horizontal unit vector toward the first placement. */
  forward: Vector3;
  distanceM: number;
  floorY: number;
}

/** Shared state of one viewer World; systems read it from `world.globals.viewer`. */
export interface ViewerContext {
  mode: XrViewMode;
  /** Audio focus: the hologram last selected. Only it is heard, and the foot controls act on it. */
  focused: Entity | null;
  placed: PlacedHologram[];
  stage: Stage | null;
  /** World width of the foot chip's widest row, which keeps neighbours' chips apart. */
  chipWidthM: number;
  /** Where the UI is drawn; known once the session's first frame shows the viewer. */
  target: XrUiTarget | null;
  /** On a phone: world metres per CSS pixel at the foot reference distance. */
  phoneMetresPerApx: number | null;
}

/** Until the controls lay out their reach row: a generous headset estimate. */
const DEFAULT_CHIP_WIDTH_M = 0.7;

export function createViewerContext(mode: XrViewMode): ViewerContext {
  return { mode, focused: null, placed: [], stage: null, chipWidthM: DEFAULT_CHIP_WIDTH_M, target: null, phoneMetresPerApx: null };
}

export function viewerContext(world: World): ViewerContext {
  return world.globals.viewer as ViewerContext;
}

export function placedRecord(c: ViewerContext, entity: Entity | null): PlacedHologram | null {
  return entity ? (c.placed.find((record) => record.entity === entity) ?? null) : null;
}

export function focusedRecord(c: ViewerContext): PlacedHologram | null {
  return placedRecord(c, c.focused);
}

export function searchingPlacement(sequence = 0): PlacementState {
  return { stage: "searching", mode: null, sequence, position: null };
}
