import * as THREE from 'three';
import { fitCloche, type ClocheShape } from '@holoim/xr-ui-core';
import { PLACE_STORED_SPLAT_CAP } from '@holoim/contracts';
import { FLOOR_SLACK_METERS, MAX_SPLAT_EXTENT_METERS, SPLAT_EXTENT_SIGMA, type DecodedScan } from '@holoim/place';

import { RECORDING_SCENE_BUBBLE_RADIUS } from '../recording/SceneBubbleSampler';

// The stored crop of a scanned place (docs/features/splat-capture.md, Q5 and
// Q7). The take's floor disc is its reach plus a metre; the dome a viewer fits
// to that disc and the performer is estimated here the way the viewer fits
// it, then swept along the take's path, and every splat inside that sweep's
// box (plus a margin and each splat's own reach) is kept. The scan stands
// with its floor's middle at the set's origin (CapturePlace), so a splat's
// set-frame centre is its y-up centre less that middle. It is kept in the
// file's own frame, so its packed words are copied, never re-encoded. Over the cap, the
// splats furthest from the path go first.

/** The disc reaches this far past the take's path, metres (Q7). */
export const PLACE_REACH_MARGIN = 1;
/** The crop keeps this much past the estimated dome's sweep, metres. */
export const PLACE_CROP_MARGIN = 0.3;
/** Below this a splat adds nothing. */
const MIN_OPACITY = 0.02;
const WORDS_PER_SPLAT = 4;
const SPLAT_TEXTURE_WIDTH = 2048;
/** Path points the thinning measures against: enough for a 60 s walk. */
const MAX_PATH_POINTS = 240;

export type PlaceCrop = {
  packedArray: Uint32Array;
  numSplats: number;
  /** Splats the crop box held before thinning, and how many thinning dropped. */
  inBox: number;
  thinned: number;
  box: { min: THREE.Vector3; max: THREE.Vector3 };
  disc: { center: { x: number; z: number }; radius: number };
  dome: ClocheShape | null;
  cropMs: number;
};

/** The disc a take's reach covers: the centre of its path's box, out to its furthest point plus the margin. */
export function takeReach(path: readonly THREE.Vector3[]): { center: { x: number; z: number }; radius: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of path) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }
  if (!Number.isFinite(minX)) return { center: { x: 0, z: 0 }, radius: PLACE_REACH_MARGIN };
  const center = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
  let furthest = 0;
  for (const point of path) furthest = Math.max(furthest, Math.hypot(point.x - center.x, point.z - center.z));
  return { center, radius: furthest + PLACE_REACH_MARGIN };
}

/**
 * The dome a viewer fits at the take's first frame: the disc's own vertices
 * (centre and rim) within the bubble around the performer, and the
 * performer's reach there, head room included (drawnPoints and motionPoints
 * in the viewer).
 */
export function estimateDome(disc: { center: { x: number; z: number }; radius: number }, first: THREE.Vector3, avatarHeight: number): ClocheShape | null {
  const points: THREE.Vector3[] = [];
  const bubble = RECORDING_SCENE_BUBBLE_RADIUS;
  const add = (point: THREE.Vector3) => {
    if (point.distanceTo(first) <= bubble) points.push(point);
  };
  add(new THREE.Vector3(disc.center.x, 0, disc.center.z));
  for (let i = 0; i < 64; i += 1) {
    const angle = (i / 64) * Math.PI * 2;
    add(new THREE.Vector3(disc.center.x + Math.cos(angle) * disc.radius, 0, disc.center.z + Math.sin(angle) * disc.radius));
  }
  const reach = Math.max(0.6, avatarHeight * 0.4);
  for (const dx of [-reach, reach]) for (const dz of [-reach, reach]) for (const y of [0, avatarHeight * 1.25]) points.push(new THREE.Vector3(first.x + dx, y, first.z + dz));
  return fitCloche(points);
}

function samplePath(path: readonly THREE.Vector3[]): THREE.Vector3[] {
  if (path.length <= MAX_PATH_POINTS) return [...path];
  const step = path.length / MAX_PATH_POINTS;
  return Array.from({ length: MAX_PATH_POINTS }, (_, i) => path[Math.floor(i * step)]!);
}

/**
 * Crops the scan to the take (Q7): the box of the estimated dome swept along
 * the path, floaters under the floor dropped, splats too large to ever show
 * dropped, then thinned to `cap` by distance from the path.
 */
export function cropScanToTake(scan: DecodedScan, path: readonly THREE.Vector3[], avatarHeight: number, cap = PLACE_STORED_SPLAT_CAP): PlaceCrop {
  const started = performance.now();
  const first = path[0] ?? new THREE.Vector3();
  const disc = takeReach(path);
  const dome = estimateDome(disc, first, avatarHeight);
  const sweepMin = new THREE.Vector3(Infinity, Infinity, Infinity);
  const sweepMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const point of path) {
    sweepMin.min(new THREE.Vector3().subVectors(point, first));
    sweepMax.max(new THREE.Vector3().subVectors(point, first));
  }
  if (!Number.isFinite(sweepMin.x)) {
    sweepMin.set(0, 0, 0);
    sweepMax.set(0, 0, 0);
  }
  const base = dome?.base ?? { x: first.x, y: 0, z: first.z };
  const radii = dome?.radii ?? { x: disc.radius, y: avatarHeight * 1.5, z: disc.radius };
  const min = new THREE.Vector3(base.x - radii.x + sweepMin.x, 0, base.z - radii.z + sweepMin.z).addScalar(-PLACE_CROP_MARGIN);
  // Under the scan's own floor are floaters: never drawn, so never kept. The dome's foot stays on the floor as it slides.
  min.y = -FLOOR_SLACK_METERS;
  const max = new THREE.Vector3(base.x + radii.x + sweepMax.x, base.y + radii.y + Math.max(sweepMax.y, 0), base.z + radii.z + sweepMax.z).addScalar(PLACE_CROP_MARGIN);

  const { centers, scale, opacity, floor } = scan;
  const keep: number[] = [];
  for (let i = 0; i < scan.numSplats; i += 1) {
    if (opacity[i]! < MIN_OPACITY) continue;
    const reach = scale[i]! * SPLAT_EXTENT_SIGMA;
    if (reach > MAX_SPLAT_EXTENT_METERS) continue;
    const x = centers[i * 3]! - floor.x;
    const y = centers[i * 3 + 1]! - floor.floorY;
    const z = centers[i * 3 + 2]! - floor.z;
    // Written as what is kept, so a splat with a non-finite centre is dropped too.
    if (!(x >= min.x - reach && x <= max.x + reach && y >= min.y && y <= max.y + reach && z >= min.z - reach && z <= max.z + reach)) continue;
    keep.push(i);
  }
  const inBox = keep.length;
  let kept = keep;
  if (inBox > cap) {
    // Thinned by distance from the path, from the original splats: what is around the person stays.
    const along = samplePath(path.length > 0 ? path : [first]);
    const distance = new Float32Array(inBox);
    keep.forEach((source, slot) => {
      const x = centers[source * 3]! - floor.x;
      const z = centers[source * 3 + 2]! - floor.z;
      let nearest = Infinity;
      for (const point of along) nearest = Math.min(nearest, (x - point.x) ** 2 + (z - point.z) ** 2);
      distance[slot] = nearest;
    });
    const order = Array.from({ length: inBox }, (_, slot) => slot).sort((a, b) => distance[a]! - distance[b]!);
    kept = order.slice(0, cap).sort((a, b) => a - b).map((slot) => keep[slot]!);
  }
  const rows = Math.max(1, Math.ceil(kept.length / SPLAT_TEXTURE_WIDTH)) * SPLAT_TEXTURE_WIDTH;
  const packedArray = new Uint32Array(rows * WORDS_PER_SPLAT);
  kept.forEach((source, slot) => {
    packedArray.set(scan.packedArray.subarray(source * WORDS_PER_SPLAT, source * WORDS_PER_SPLAT + WORDS_PER_SPLAT), slot * WORDS_PER_SPLAT);
  });
  return { packedArray, numSplats: kept.length, inBox, thinned: inBox - kept.length, box: { min, max }, disc, dome, cropMs: performance.now() - started };
}
