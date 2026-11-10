// A scanned place around a take (docs/features/splat-place.md): which splat
// the feed card shows, read from the page URL. Dev and e2e builds only; the
// caller gates on `testHooks`, so the production bundle never asks.

export type PlaceRequest = {
  url: string;
  /** The file's y and z axes point down and back (3DGS training output): turned half a revolution about x. */
  flip: boolean;
  /** Hand nudges from the default placement, metres and degrees. */
  nudge: { x: number; y: number; z: number; yawDeg: number };
};

/** SPZ is y-up like three; PLY, SPLAT and KSPLAT are as the trainers write them, y down. */
export function placeFlipDefault(url: string): boolean {
  const path = url.split(/[?#]/)[0]?.toLowerCase() ?? "";
  return !path.endsWith(".spz");
}

function number(value: string | null): number {
  const parsed = value === null ? 0 : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * `?place=<url>` puts a splat around the first card; `placeFor=<id>` picks
 * another. `placeFlip=0|1`, `placeX`, `placeY`, `placeZ` and `placeYaw`
 * correct the fixed orientation and the default placement by hand.
 */
export function readPlaceRequest(search: string, card: { id: string; first: boolean }): PlaceRequest | null {
  const params = new URLSearchParams(search);
  const url = params.get("place");
  if (!url) return null;
  const only = params.get("placeFor");
  if (only ? only !== card.id : !card.first) return null;
  const flip = params.get("placeFlip");
  return {
    url,
    flip: flip === null ? placeFlipDefault(url) : flip === "1",
    nudge: { x: number(params.get("placeX")), y: number(params.get("placeY")), z: number(params.get("placeZ")), yawDeg: number(params.get("placeYaw")) }
  };
}
