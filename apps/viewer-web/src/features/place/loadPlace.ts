import type * as Spark from "@sparkjsdev/spark";

import { readFloor, type FloorReading } from "./placeAnalysis";
import type { PlaceRequest } from "./placeRequest";

// Loads and reads a scan (docs/features/splat-place.md). Spark arrives by a
// dynamic import, here and nowhere else, so a build with the test hooks off
// drops this whole directory with its only caller and ships no Spark.

export type SparkModule = typeof Spark;

export type LoadedPlace = {
  spark: SparkModule;
  request: PlaceRequest;
  /** Spark's packed splats, 4 words each: kept across remounts, so the file is read and decoded once. */
  packedArray: Uint32Array;
  numSplats: number;
  encoding: Spark.PackedSplats["splatEncoding"];
  /** Each splat's centre in the scan's frame turned to y up, its largest scale, its opacity. */
  centers: Float32Array;
  scale: Float32Array;
  opacity: Float32Array;
  floor: FloorReading;
  loadMs: number;
};

/** Decoded scans kept across remounts: about 36 bytes a splat each. */
const CACHE_ENTRIES = 2;
const cache = new Map<string, Promise<LoadedPlace>>();

async function read(request: PlaceRequest): Promise<LoadedPlace> {
  const started = performance.now();
  const spark = await import("@sparkjsdev/spark");
  const response = await fetch(request.url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
  const fileBytes = await response.arrayBuffer();
  const splats = new spark.PackedSplats({ fileBytes, fileName: new URL(request.url, window.location.href).pathname });
  await splats.initialized;
  const { numSplats, packedArray, splatEncoding } = splats;
  if (!packedArray || numSplats === 0) throw new Error("no splats in the file");
  const centers = new Float32Array(numSplats * 3);
  const scale = new Float32Array(numSplats);
  const opacity = new Float32Array(numSplats);
  const turn = request.flip ? -1 : 1;
  splats.forEachSplat((index, center, scales, _quaternion, alpha) => {
    centers[index * 3] = center.x;
    centers[index * 3 + 1] = center.y * turn;
    centers[index * 3 + 2] = center.z * turn;
    scale[index] = Math.max(scales.x, scales.y, scales.z);
    opacity[index] = alpha;
  });
  return {
    spark,
    request,
    packedArray,
    numSplats,
    encoding: splatEncoding,
    centers,
    scale,
    opacity,
    floor: readFloor(centers, opacity, numSplats),
    loadMs: performance.now() - started
  };
}

/** One read per scan and orientation, shared by every mount of the card; the two most recent are kept. A failure is not kept, so a retry reads again. */
export function loadPlace(request: PlaceRequest): Promise<LoadedPlace> {
  const key = `${request.url}|${request.flip ? 1 : 0}`;
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
