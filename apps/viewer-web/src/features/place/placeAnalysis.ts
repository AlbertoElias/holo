// What a scan's splats say about the room, read from their centres and
// opacities (docs/features/splat-place.md, Placement). Pure arrays in, numbers
// out: the loader feeds it, and nothing here knows Spark.

/** Height histogram bin, metres. */
export const FLOOR_BIN_METERS = 0.02;
/** A floor peak holds at least this share of the densest bin; a table is a peak too, but floaters below the floor are not. */
export const FLOOR_PEAK_SHARE = 0.2;
/** Splats this close to the floor make up its band, metres. */
export const FLOOR_BAND_METERS = 0.05;

export type FloorReading = {
  found: boolean;
  /** The scan's floor height in the scan's own up-down axis, metres. */
  floorY: number;
  /** The median of the floor band's x and z: the middle of the room's floor. */
  x: number;
  z: number;
};

/**
 * The floor is the lowest density peak of the opacity-weighted height
 * histogram: the floor and a ceiling are the big peaks, a table or shelf a
 * smaller one higher up, and floaters under the floor a thin tail below the
 * threshold. `centers` is x, y, z per splat with y up.
 */
export function readFloor(centers: Float32Array, opacity: Float32Array, count: number): FloorReading {
  const none: FloorReading = { found: false, floorY: 0, x: 0, z: 0 };
  if (count === 0) return none;
  const bins = new Map<number, number>();
  for (let i = 0; i < count; i += 1) {
    const y = centers[i * 3 + 1]!;
    if (!Number.isFinite(y)) continue;
    const bin = Math.floor(y / FLOOR_BIN_METERS);
    bins.set(bin, (bins.get(bin) ?? 0) + opacity[i]!);
  }
  const smooth = (bin: number) => ((bins.get(bin - 1) ?? 0) + 2 * (bins.get(bin) ?? 0) + (bins.get(bin + 1) ?? 0)) / 4;
  let densest = 0;
  for (const bin of bins.keys()) densest = Math.max(densest, smooth(bin));
  if (densest <= 0) return none;
  const threshold = densest * FLOOR_PEAK_SHARE;
  let peak: number | null = null;
  for (const bin of bins.keys()) {
    const here = smooth(bin);
    if (here < threshold || here < smooth(bin - 1) || here <= smooth(bin + 1)) continue;
    if (peak === null || bin < peak) peak = bin;
  }
  if (peak === null) return none;
  // The peak's weighted height over its neighbours, not the bin edge.
  let weight = 0;
  let sum = 0;
  for (let bin = peak - 2; bin <= peak + 2; bin += 1) {
    const w = bins.get(bin) ?? 0;
    weight += w;
    sum += w * (bin + 0.5) * FLOOR_BIN_METERS;
  }
  const floorY = weight > 0 ? sum / weight : (peak + 0.5) * FLOOR_BIN_METERS;
  const xs: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if (Math.abs(centers[i * 3 + 1]! - floorY) > FLOOR_BAND_METERS || opacity[i]! < 0.1) continue;
    xs.push(centers[i * 3]!);
    zs.push(centers[i * 3 + 2]!);
  }
  const median = (values: number[]) => {
    if (values.length === 0) return 0;
    const sorted = Float64Array.from(values).sort();
    return sorted[Math.floor(sorted.length / 2)]!;
  };
  return { found: true, floorY, x: median(xs), z: median(zs) };
}
