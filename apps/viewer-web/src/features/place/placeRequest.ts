// A scanned place around a take (docs/features/splat-place.md): which splat
// the feed card shows, read from the page URL. Dev and e2e builds only; the
// caller gates on `testHooks`, so the production bundle never asks.

import { PLACE_FIT_WAIT_MS } from "./placeGate";

export type PlaceRequest = {
  url: string;
  /**
   * `placeFlip`: true when the file's y and z axes point down and back (3DGS
   * training output), turned half a revolution about x; false when y is up;
   * null to let the scan say which way is up, falling back to its format's convention.
   */
  flip: boolean | null;
  /** Hand nudges from the default placement, metres and degrees. */
  nudge: { x: number; y: number; z: number; yawDeg: number };
  /** `placeY` is in the URL: when the scan's floor cannot be found, it is the floor's height in the scan, metres, y up. */
  floorGiven: boolean;
  /** How long the cloche fit waits for the scan, ms (`placeWait`; a loaded machine needs longer). */
  waitMs: number;
};

/** What is placed; the wait belongs to the card's fit. */
export type PlaceScan = Omit<PlaceRequest, "waitMs">;

/** What is read and decoded: the same file, turned the same way, is one cache entry. */
export type PlaceSource = Pick<PlaceRequest, "url" | "flip">;

function number(value: string | null): number {
  const parsed = value === null ? 0 : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** `placeWait`, ms: a positive number up to two minutes; anything else is the default. */
function waitOf(value: string | null): number {
  const wait = number(value);
  return wait > 0 ? Math.min(wait, 120_000) : PLACE_FIT_WAIT_MS;
}

/**
 * `?place=<url>` puts a splat around the first card; `placeFor=<id>` picks
 * another. Which way is up is read from the scan; `placeFlip=0|1` says it
 * instead. `placeX`, `placeY`, `placeZ` and `placeYaw` correct the default placement by hand. A scan
 * with no clear floor shows only with `placeY` (its floor's height in the scan).
 * `placeWait` lengthens the fit's wait for the scan, in ms.
 */
export function readPlaceRequest(search: string, card: { id: string; first: boolean }): PlaceRequest | null {
  const params = new URLSearchParams(search);
  const url = params.get("place");
  if (!url) return null;
  const only = params.get("placeFor");
  if (only ? only !== card.id : !card.first) return null;
  const flip = params.get("placeFlip");
  const placeY = params.get("placeY");
  return {
    url,
    // Only 0 or 1 says which way is up; anything else leaves it to the scan.
    flip: flip === "1" ? true : flip === "0" ? false : null,
    nudge: { x: number(params.get("placeX")), y: number(placeY), z: number(params.get("placeZ")), yawDeg: number(params.get("placeYaw")) },
    // Only a real number stands in for a floor that cannot be found; `placeY=` or `placeY=abc` is no floor at all.
    floorGiven: placeY !== null && placeY.trim() !== "" && Number.isFinite(Number(placeY)),
    waitMs: waitOf(params.get("placeWait"))
  };
}
