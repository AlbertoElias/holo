// The small part of the place the card itself reads (docs/features/splat-place.md,
// Load order): whether its cloche fit should wait, and whether a place shows.
// Spark-free, so the card needs nothing from the lazily loaded rest.

export type PlaceGateStatus = "off" | "loading" | "ready" | "failed" | "timeout";

export type PlaceGate = {
  status: PlaceGateStatus;
  /** The set is hidden and a scan is what the dome cuts: zoom counts the glass as the hologram. */
  shows: boolean;
  startedAt: number;
};

/** The fit waits this long for the scan, then runs as it does without one. */
export const PLACE_FIT_WAIT_MS = 5000;

export function createPlaceGate(wanted: boolean): PlaceGate {
  return { status: wanted ? "loading" : "off", shows: false, startedAt: performance.now() };
}
