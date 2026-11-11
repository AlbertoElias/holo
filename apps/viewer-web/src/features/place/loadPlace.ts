import { decodeScan, type DecodedScan } from "@holoim/place";

import type { PlaceScan, PlaceSource } from "./placeRequest";

// Loads and reads a scan (docs/features/splat-place.md). Spark arrives by
// `@holoim/place`'s dynamic import, so a build with the test hooks off drops
// this whole directory with its only caller.

export type { SparkModule } from "@holoim/place";

/** A decoded scan as the cache holds it, the same for every placement of that file. */
export type LoadedPlace = DecodedScan & { loadMs: number };

/** A decoded scan with the card's placement for it. */
export type PlacedScan = LoadedPlace & { request: PlaceScan };

/** Decoded scans kept across remounts: about 36 bytes a splat each. */
const CACHE_ENTRIES = 2;
const cache = new Map<string, Promise<LoadedPlace>>();

async function read(request: PlaceSource): Promise<LoadedPlace> {
  const started = performance.now();
  const response = await fetch(request.url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
  const bytes = new Uint8Array(await response.arrayBuffer());
  const decoded = await decodeScan({ bytes, fileName: new URL(request.url, window.location.href).pathname, flip: request.flip });
  return { ...decoded, loadMs: performance.now() - started };
}

/** One read per scan and way up asked for (0, 1 or the scan's own), shared by every mount of the card; the two most recent are kept. A failure is not kept, so a retry reads again. */
export function loadPlace(request: PlaceSource): Promise<LoadedPlace> {
  const key = `${request.url}|${request.flip === null ? "read" : request.flip ? 1 : 0}`;
  const kept = cache.get(key);
  if (kept) {
    // Most recently used last.
    cache.delete(key);
    cache.set(key, kept);
    return kept;
  }
  const loading = read(request);
  cache.set(key, loading);
  loading.catch(() => {
    if (cache.get(key) === loading) cache.delete(key);
  });
  for (const oldest of cache.keys()) {
    if (cache.size <= CACHE_ENTRIES) break;
    cache.delete(oldest);
  }
  return loading;
}
