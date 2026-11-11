import { Euler, Quaternion, Vector3 } from "three";

import type { PlacedScan } from "./loadPlace";
import { FLOOR_SLACK_METERS, MAX_SPLAT_EXTENT_METERS, SPLAT_EXTENT_SIGMA, type DomeShape } from "@holoim/place";

/** Splats kept after the crop (docs/features/archive/splat-place.md, Memory). */
export const PLACE_SPLAT_CAP = 1_500_000;
/** The crop keeps this much past the swept dome, plus each splat's own extent, metres: it only lowers the count, the shader is the edge. */
export const CROP_MARGIN_METERS = 0.3;
/** Below this a splat adds nothing. */
const MIN_OPACITY = 0.02;
/** Words per packed splat, and the texel row Spark's arrays are padded to. */
const WORDS_PER_SPLAT = 4;
const SPLAT_TEXTURE_WIDTH = 2048;

export type Placement = {
  /** The scan's floor-centre, y up, where it stands in the take's world. */
  at: Vector3;
  /** Turns the scan's file axes onto the world's: the flip, then the yaw. */
  rotation: Quaternion;
  /** Where the mesh's origin goes: `at` less the rotated floor-centre. */
  position: Vector3;
};

/**
 * Puts the scan's floor on the take's floor and the middle of its floor band
 * under the dome's foot, nudged by hand. Scale is never touched: a scan is
 * metric.
 */
export function placeOnFloor(place: PlacedScan, dome: DomeShape, takeFloorY: number): Placement {
  const { nudge } = place.request;
  const { flip } = place;
  const at = new Vector3(dome.base.x + nudge.x, takeFloorY + nudge.y, dome.base.z + nudge.z);
  const yaw = yawOf(place);
  const turn = new Quaternion(flip ? 1 : 0, 0, 0, flip ? 0 : 1);
  const rotation = yaw.clone().multiply(turn);
  const position = at.clone().sub(new Vector3(place.floor.x, place.floor.floorY, place.floor.z).applyQuaternion(yaw));
  return { at, rotation, position };
}

function yawOf(place: PlacedScan): Quaternion {
  return new Quaternion().setFromEuler(new Euler(0, (place.request.nudge.yawDeg * Math.PI) / 180, 0));
}

export type CroppedPlace = {
  packedArray: Uint32Array;
  numSplats: number;
  /** The kept splats' world centres and largest scales, for the report. */
  centers: Float32Array;
  scale: Float32Array;
};

/**
 * The coarse crop at load: splats whose centre is within the box the dome
 * sweeps over the take (plus a margin), then every k-th when still over the
 * cap. Splats too big to ever pass the extent test are dropped as background.
 */
export function cropToSweep(place: PlacedScan, placement: Placement, dome: DomeShape, sweep: { min: Vector3; max: Vector3 }, cap = PLACE_SPLAT_CAP): CroppedPlace {
  const yaw = yawOf(place);
  const min = new Vector3(dome.base.x - dome.radii.x, 0, dome.base.z - dome.radii.z).add(sweep.min).addScalar(-CROP_MARGIN_METERS);
  // Under the scan's own floor are floaters: never drawn, so never kept.
  min.y = placement.at.y - FLOOR_SLACK_METERS;
  const max = new Vector3(dome.base.x + dome.radii.x, dome.base.y + dome.radii.y, dome.base.z + dome.radii.z).add(sweep.max).addScalar(CROP_MARGIN_METERS);
  const point = new Vector3();
  const keep: number[] = [];
  for (let i = 0; i < place.numSplats; i += 1) {
    if (place.opacity[i]! < MIN_OPACITY || place.scale[i]! * SPLAT_EXTENT_SIGMA > MAX_SPLAT_EXTENT_METERS) continue;
    // The centre in y up, less the floor middle, then turned by the yaw: the scan in the take's world.
    point.set(place.centers[i * 3]! - place.floor.x, place.centers[i * 3 + 1]! - place.floor.floorY, place.centers[i * 3 + 2]! - place.floor.z).applyQuaternion(yaw).add(placement.at);
    // The splat's reach counts, not just its centre, so the crop is never what ends a splat the shader would show. The floor side keeps the slack only.
    const reach = place.scale[i]! * SPLAT_EXTENT_SIGMA;
    // Written as what is kept, so a splat with a non-finite centre is dropped too.
    if (!(point.x >= min.x - reach && point.x <= max.x + reach && point.y >= min.y && point.y <= max.y + reach && point.z >= min.z - reach && point.z <= max.z + reach)) continue;
    keep.push(i);
  }
  const stride = Math.max(1, Math.ceil(keep.length / cap));
  const kept = stride === 1 ? keep : keep.filter((_, order) => order % stride === 0);
  const rows = Math.max(1, Math.ceil(kept.length / SPLAT_TEXTURE_WIDTH)) * SPLAT_TEXTURE_WIDTH;
  const packedArray = new Uint32Array(rows * WORDS_PER_SPLAT);
  const centers = new Float32Array(kept.length * 3);
  const scale = new Float32Array(kept.length);
  kept.forEach((source, slot) => {
    packedArray.set(place.packedArray.subarray(source * WORDS_PER_SPLAT, source * WORDS_PER_SPLAT + WORDS_PER_SPLAT), slot * WORDS_PER_SPLAT);
    point.set(place.centers[source * 3]! - place.floor.x, place.centers[source * 3 + 1]! - place.floor.floorY, place.centers[source * 3 + 2]! - place.floor.z).applyQuaternion(yaw).add(placement.at);
    centers[slot * 3] = point.x;
    centers[slot * 3 + 1] = point.y;
    centers[slot * 3 + 2] = point.z;
    scale[slot] = place.scale[source]!;
  });
  return { packedArray, numSplats: kept.length, centers, scale };
}
