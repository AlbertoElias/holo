import type { SparkModule } from "@holoim/place";
import type { PackedSplats } from "@sparkjsdev/spark";

type Spark = SparkModule;

// A place's detail level on this device (docs/features/hologram-budgets.md,
// "Spike result"): no LoD tree, which costs a phone tens of seconds and most
// of a gigabyte, but the detail thinned to what the device draws. The budgets
// are capture's live-draw budgets (`CapturePlace.lodBudget`), Spark's own
// per-device defaults.

/** Splats this device draws of one place. */
export function placeDrawBudget(S: Spark): number {
  return S.isOculus() ? 500_000 : S.isVisionPro() ? 750_000 : S.isAndroid() ? 1_000_000 : S.isIos() ? 1_500_000 : 2_500_000;
}

/** Spark's splat texture row: a packed array is read in whole rows. */
const ROW = 2048;

/**
 * `splats` with at most `budget` splats: an even stride through the stored
 * order, SH rows kept with their splats. Returns `splats` itself when it fits;
 * otherwise disposes it and returns the thinned copy.
 */
export function thinToBudget(S: Spark, splats: PackedSplats, budget: number): PackedSplats {
  const total = splats.numSplats;
  const source = splats.packedArray;
  if (total <= budget || !source || budget <= 0) return splats;
  const sh1 = splats.extra.sh1 as Uint32Array | undefined;
  const packed = new Uint32Array(Math.ceil(budget / ROW) * ROW * 4);
  const sh = sh1 ? new Uint32Array(budget * 2) : undefined;
  for (let kept = 0; kept < budget; kept += 1) {
    const from = Math.floor((kept * total) / budget);
    packed.set(source.subarray(from * 4, from * 4 + 4), kept * 4);
    if (sh && sh1) {
      sh[kept * 2] = sh1[from * 2]!;
      sh[kept * 2 + 1] = sh1[from * 2 + 1]!;
    }
  }
  const thinned = new S.PackedSplats({ packedArray: packed, numSplats: budget, extra: sh ? { sh1: sh } : {}, splatEncoding: splats.splatEncoding });
  splats.dispose();
  return thinned;
}
