import type * as Spark from "@sparkjsdev/spark";

import { readFloor, readUpright, turnCenters, type FloorReading } from "./analysis.js";

// Decodes a scan and reads it (docs/features/splat-place.md, splat-capture.md).
// Spark arrives by a dynamic import, here and nowhere else in the package, so
// an app's first chunk never carries it: the import is reached only once a
// scan is asked for.

export type SparkModule = typeof Spark;

/** Spark itself, loaded once on first use. */
export function loadSpark(): Promise<SparkModule> {
  return import("@sparkjsdev/spark");
}

/** A decoded scan and what its splats say about the room. */
export type DecodedScan = {
  spark: SparkModule;
  /** Spark's packed splats, 4 words each, in the file's own frame. */
  packedArray: Uint32Array;
  numSplats: number;
  encoding: Spark.PackedSplats["splatEncoding"];
  /** Each splat's centre in the scan's frame turned to y up, its largest scale, its opacity. */
  centers: Float32Array;
  scale: Float32Array;
  opacity: Float32Array;
  floor: FloorReading;
  /** The half turn about x the file was given, and who decided it: the caller, the scan, or (when the scan could not tell) its format. */
  flip: boolean;
  upright: "given" | "read" | "format";
  decodeMs: number;
};

/**
 * The format's convention, for a scan that cannot say which way is up: SPZ is
 * written y up by Niantic's library, PLY, SPLAT and KSPLAT as the trainers
 * write them, y down. Producers differ (Spark's example SPZs are y down).
 */
export function placeFlipDefault(fileName: string): boolean {
  const path = fileName.split(/[?#]/)[0]?.toLowerCase() ?? "";
  return !path.endsWith(".spz");
}

/** The splat count a PLY's header declares, read before decoding; null when the bytes are not a PLY header. */
export function plyVertexCount(bytes: Uint8Array): number | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.byteLength, 4096)));
  const lines = head.split(/\r?\n/);
  if (lines[0]?.trim() !== "ply") return null;
  // Read as the header's own lines, so a comment cannot claim a count the decoder will not use.
  let count: number | null = null;
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (line === "end_header") return count;
    const words = line.split(/\s+/);
    if (words[0] !== "element" || words[1] !== "vertex") continue;
    if (count !== null || words.length !== 3 || !/^\d+$/.test(words[2]!)) return null;
    count = Number(words[2]);
  }
  // No end of header in the window: not a scan this checks.
  return null;
}

/**
 * Decodes the bytes of a `.spz`, `.ply` (or another format Spark reads) and
 * reads which way is up and where the floor is. `flip` null lets the scan say.
 */
export async function decodeScan(input: { bytes: Uint8Array; fileName: string; flip: boolean | null }): Promise<DecodedScan> {
  const started = performance.now();
  const spark = await loadSpark();
  const splats = new spark.PackedSplats({ fileBytes: input.bytes, fileName: input.fileName });
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
  let flip = input.flip;
  let upright: DecodedScan["upright"] = "given";
  let floor: FloorReading | null = null;
  let turned: Float32Array | null = null;
  if (flip === null) {
    // The scan says which way is up: each way's floor is read anyway, so the chosen one is kept.
    turned = turnCenters(centers, numSplats);
    const reading = readUpright(centers, turned, opacity, numSplats);
    flip = reading.flip ?? placeFlipDefault(input.fileName);
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
    floor: floor?.found ? floor : readFloor(upCenters, opacity, numSplats, true),
    flip,
    upright,
    decodeMs: performance.now() - started
  };
}
