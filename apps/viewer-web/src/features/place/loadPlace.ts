import type * as Spark from "@sparkjsdev/spark";

import { readFloor, readUpright, turnCenters, type FloorReading } from "./placeAnalysis";
import { placeFlipDefault, type PlaceScan, type PlaceSource } from "./placeRequest";

// Loads and reads a scan (docs/features/splat-place.md). Spark arrives by a
// dynamic import, here and nowhere else, so a build with the test hooks off
// drops this whole directory with its only caller and ships no Spark.

export type SparkModule = typeof Spark;

/** A decoded scan as the cache holds it, the same for every placement of that file. */
export type LoadedPlace = {
  spark: SparkModule;
  /** Spark's packed splats, 4 words each: kept across remounts, so the file is read and decoded once. */
  packedArray: Uint32Array;
  numSplats: number;
  encoding: Spark.PackedSplats["splatEncoding"];
  /** Each splat's centre in the scan's frame turned to y up, its largest scale, its opacity. */
  centers: Float32Array;
  scale: Float32Array;
  opacity: Float32Array;
  floor: FloorReading;
  /** The half turn about x the file was given, and who decided it: the URL, the scan, or (when the scan could not tell) its format. */
  flip: boolean;
  upright: "given" | "read" | "format";
  loadMs: number;
};

/** A decoded scan with the card's placement for it. */
export type PlacedScan = LoadedPlace & { request: PlaceScan };

/** Decoded scans kept across remounts: about 36 bytes a splat each. */
const CACHE_ENTRIES = 2;
const cache = new Map<string, Promise<LoadedPlace>>();

async function read(request: PlaceSource): Promise<LoadedPlace> {
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
  splats.forEachSplat((index, center, scales, _quaternion, alpha) => {
    centers[index * 3] = center.x;
    centers[index * 3 + 1] = center.y;
    centers[index * 3 + 2] = center.z;
    scale[index] = Math.max(scales.x, scales.y, scales.z);
    opacity[index] = alpha;
  });
  let flip = request.flip;
  let upright: LoadedPlace["upright"] = "given";
  let floor: FloorReading | null = null;
  let turned: Float32Array | null = null;
  if (flip === null) {
    // The scan says which way is up: each way's floor is read anyway, so the chosen one is kept.
    turned = turnCenters(centers, numSplats);
    const reading = readUpright(centers, turned, opacity, numSplats);
    flip = reading.flip ?? placeFlipDefault(request.url);
    upright = reading.flip === null ? "format" : "read";
    floor = flip ? reading.turned.floor : reading.asStored.floor;
  }
  const upCenters = flip ? turned ?? turnCenters(centers, numSplats) : centers;
  return {
    spark,
    packedArray,
    numSplats,
    encoding: splatEncoding,
    centers: upCenters,
    scale,
    opacity,
    floor: floor ?? readFloor(upCenters, opacity, numSplats),
    flip,
    upright,
    loadMs: performance.now() - started
  };
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
