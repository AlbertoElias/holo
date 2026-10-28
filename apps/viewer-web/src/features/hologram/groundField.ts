// The feed's rim follows the ground (styleguide 3.4): the recorded ground,
// read once per model into a grid, and the rim the cloche bends onto from it
// every frame. Ground is what the author could stand on: upward-facing,
// opaque triangles of the recorded scene, joined to the cells under the
// author's feet through the take. A post, a wall's top, a roof, a boat or a
// slab buried under the ground is not joined, so it drops out; opaque water
// at the shore is joined and counts. Nothing is raycast: the triangles are
// drawn into the cells.
import { tokens } from "@holoim/design-tokens";
import {
  CLOCHE_RIM_BINS,
  clocheRimRaw,
  easeClocheRim,
  isInChrome,
  smoothClocheRim,
  type ClocheShape
} from "@holoim/xr-ui-core";
import { Matrix4, Vector3 } from "three";
import type { AnimationClip, BufferGeometry, Material, Mesh, Object3D } from "three";

import { isInsideRecordedObject } from "../objects/recordedObjects";
import { sampleTake } from "./drawnPoints";

const RIM = tokens.edge.cloche.rim;
const FOOT_BONE = /(Left|Right)(Foot|ToeBase)$/;
/** Seconds between two field builds of different cards: a second build waits a frame. */
const BUILD_SPACING_MS = 16;

export type GroundBox = { minX: number; maxX: number; minZ: number; maxZ: number };

export type GroundField = {
  /** The ground's height at world (x, z): the highest joined ground triangle over it, NaN where there is none (outside the grid included). */
  heightAt(x: number, z: number): number;
  /** The normal's y of the ground's top triangle at (x, z), NaN off the ground. */
  normalYAt(x: number, z: number): number;
  box: GroundBox;
  columns: number;
  rows: number;
  /** Triangles drawn into the grid. */
  candidates: number;
  /** Cells the flood fill reached from the author's feet. */
  reached: number;
  buildMs: number;
};

/** The meshes that may be ground: the recorded scene's, without the avatar, recorded objects, the bubble or chrome. */
function groundMeshes(sceneBubble: Object3D): Mesh[] {
  const meshes: Mesh[] = [];
  sceneBubble.traverse((child) => {
    const mesh = child as Mesh & { isSkinnedMesh?: boolean };
    if (!mesh.isMesh || mesh.isSkinnedMesh || !mesh.geometry?.getAttribute("position")) return;
    if (isInChrome(child) || isInsideRecordedObject(child)) return;
    for (let node: Object3D | null = child; node; node = node.parent) {
      if (!node.visible || node.name === "RecordedBubbleSphere" || node.name === "RecordedAvatar" || node.name === "RecordedAuthorCamera") return;
    }
    meshes.push(mesh);
  });
  return meshes;
}

/** Glass and thin water are not ground: see-through materials drop out. */
function isGroundMaterial(material: Material | undefined): boolean {
  if (!material || !material.visible) return false;
  const transmission = (material as Material & { transmission?: number }).transmission ?? 0;
  return material.opacity >= RIM.minOpacity && transmission <= 0;
}

/** Index ranges of a mesh's ground materials. */
function groundRanges(mesh: Mesh, geometry: BufferGeometry, count: number): Array<[number, number]> {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  if (geometry.groups.length === 0 || !Array.isArray(mesh.material)) return isGroundMaterial(materials[0]) ? [[0, count]] : [];
  return geometry.groups
    .filter((group) => isGroundMaterial(materials[group.materialIndex ?? 0]))
    .map((group) => [group.start, Math.min(count, group.start + group.count)] as [number, number]);
}

let lastBuildEnd = -Infinity;

/** Whether a field may be built now; another card's build this frame defers it by one. */
export function groundFieldBudget(now = performance.now()): boolean {
  return now - lastBuildEnd >= BUILD_SPACING_MS;
}

/**
 * Reads the ground over `box` into 0.2 m cells, up to four heights each,
 * and floods it from `seeds` (the author's feet through the take): the
 * triangles under a joined height are the ground. The cells index them, so
 * the ground's height anywhere is its triangles' own, as drawn, not a
 * cell's: a low-poly scene's creases and facets stand where they are.
 * Null when there is no candidate ground or too much of it (logged).
 */
export function buildGroundField(sceneBubble: Object3D, { box, seeds }: { box: GroundBox; seeds: readonly Vector3[] }): GroundField | null {
  const started = performance.now();
  const cell = RIM.cell;
  const columns = Math.max(1, Math.ceil((box.maxX - box.minX) / cell));
  const rows = Math.max(1, Math.ceil((box.maxZ - box.minZ) / cell));
  const cells = columns * rows;
  // A path box no dome reaches (a broken or hostile export) is not allocated.
  if (!(cells <= RIM.maxCells)) {
    console.info(`[holoim] rim: a ${columns} × ${rows} cell grid is over ${RIM.maxCells} cells; the cloche keeps a flat foot`);
    return null;
  }
  const depth = RIM.layers;
  const layers = new Float32Array(cells * depth).fill(Number.NaN);
  const counts = new Uint8Array(cells);
  const slotGeneration = new Uint32Array(cells * depth);

  /** A height into a cell's layers; the layer it joined, or −1 when it was dropped under a full cell. */
  const insert = (index: number, height: number): number => {
    const at = index * depth;
    const count = counts[index]!;
    for (let k = 0; k < count; k += 1) {
      if (Math.abs(layers[at + k]! - height) <= RIM.layerMerge) {
        layers[at + k] = Math.max(layers[at + k]!, height);
        return at + k;
      }
    }
    if (count < depth) {
      layers[at + count] = height;
      counts[index] = count + 1;
      return at + count;
    }
    // Full: the highest heights stay, so the top surface is never lost to what is buried under it.
    let lowest = 0;
    for (let k = 1; k < depth; k += 1) if (layers[at + k]! < layers[at + lowest]!) lowest = k;
    if (height <= layers[at + lowest]!) return -1;
    layers[at + lowest] = height;
    // The triangles that joined the dropped layer no longer belong to the one replacing it: a new generation.
    slotGeneration[at + lowest] = slotGeneration[at + lowest]! + 1;
    return at + lowest;
  };

  // The triangles, world xyz, and per cell a list of those over it with the layer each joined there.
  let triangles = new Float32Array(9 * 1024);
  /** Each triangle's normal's y, for telling a lip from a steep face. */
  let normalsY = new Float32Array(1024);
  let triangleCount = 0;
  const head = new Int32Array(cells).fill(-1);
  let entryTriangle = new Int32Array(4096);
  let entrySlot = new Int32Array(4096);
  let entryGeneration = new Int32Array(4096);
  let entryNext = new Int32Array(4096);
  let entryCount = 0;
  const grow = (array: Int32Array) => {
    const next = new Int32Array(array.length * 2);
    next.set(array);
    return next;
  };
  const enter = (index: number, triangle: number, slot: number) => {
    if (entryCount === entryTriangle.length) {
      entryTriangle = grow(entryTriangle);
      entrySlot = grow(entrySlot);
      entryGeneration = grow(entryGeneration);
      entryNext = grow(entryNext);
    }
    entryTriangle[entryCount] = triangle;
    entrySlot[entryCount] = slot;
    entryGeneration[entryCount] = slot >= 0 ? slotGeneration[slot]! : 0;
    entryNext[entryCount] = head[index]!;
    head[index] = entryCount;
    entryCount += 1;
  };

  sceneBubble.updateWorldMatrix(true, true);
  const meshes = groundMeshes(sceneBubble);
  let candidates = 0;
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute("position");
    const index = mesh.geometry.index;
    candidates += (index ? index.count : position.count) / 3;
  }
  if (candidates === 0) return null;
  if (candidates > RIM.maxCandidates) {
    console.info(`[holoim] rim: ${Math.round(candidates)} candidate triangles is over ${RIM.maxCandidates}; the cloche keeps a flat foot`);
    return null;
  }

  let entries = 0;
  // One triangle into the cells it covers, when it faces up; true when it lies over the grid.
  const drawTriangle = (a: Vector3, b: Vector3, c: Vector3, flip: number): boolean => {
    // Face normal: (b − a) × (c − a).
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    const nx = uy * vz - uz * vy;
    const ny = (uz * vx - ux * vz) * flip;
    const nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length === 0 || ny < RIM.groundNormalY * length) return false;
    const minX = Math.min(a.x, b.x, c.x), maxX = Math.max(a.x, b.x, c.x);
    const minZ = Math.min(a.z, b.z, c.z), maxZ = Math.max(a.z, b.z, c.z);
    // A non-finite vertex would poison the entry budget.
    if (!Number.isFinite(minX + maxX + minZ + maxZ + a.y + b.y + c.y)) return false;
    if (maxX < box.minX || minX > box.maxX || maxZ < box.minZ || minZ > box.maxZ) return false;
    const area = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
    if (Math.abs(area) < 1e-12) return false;
    if (triangleCount * 9 === triangles.length) {
      const next = new Float32Array(triangles.length * 2);
      next.set(triangles);
      triangles = next;
      const nextNormals = new Float32Array(normalsY.length * 2);
      nextNormals.set(normalsY);
      normalsY = nextNormals;
    }
    const triangle = triangleCount;
    triangles.set([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z], triangle * 9);
    normalsY[triangle] = ny / length;
    triangleCount += 1;
    // Into every cell it overlaps, each joining the cell's layers: at the cell's centre where it covers it,
    // else at its nearest point to the centre (the weights clamped onto it), so a sliver stays connected.
    const i0 = Math.max(0, Math.floor((minX - box.minX) / cell));
    const i1 = Math.min(columns - 1, Math.floor((maxX - box.minX) / cell));
    const j0 = Math.max(0, Math.floor((minZ - box.minZ) / cell));
    const j1 = Math.min(rows - 1, Math.floor((maxZ - box.minZ) / cell));
    // Huge triangles cover many cells each: past the budget the field is abandoned, not drawn.
    entries += (i1 - i0 + 1) * (j1 - j0 + 1);
    if (!(entries <= RIM.maxEntries)) return false;
    // A cell of the bounding rectangle is overlapped unless one edge's line leaves it wholly outside.
    const side = Math.sign(area);
    const half = cell / 2;
    const outside = (p: Vector3, q: Vector3, px: number, pz: number) => {
      const dx = q.x - p.x, dz = q.z - p.z;
      return side * (dx * (pz - p.z) - dz * (px - p.x)) + half * (Math.abs(dx) + Math.abs(dz)) < 0;
    };
    for (let j = j0; j <= j1; j += 1) {
      const pz = box.minZ + (j + 0.5) * cell;
      for (let i = i0; i <= i1; i += 1) {
        const px = box.minX + (i + 0.5) * cell;
        if (outside(a, b, px, pz) || outside(b, c, px, pz) || outside(c, a, px, pz)) continue;
        const w1 = ((px - a.x) * (c.z - a.z) - (c.x - a.x) * (pz - a.z)) / area;
        const w2 = ((b.x - a.x) * (pz - a.z) - (px - a.x) * (b.z - a.z)) / area;
        const u0 = Math.max(1 - w1 - w2, 0), u1 = Math.max(w1, 0), u2 = Math.max(w2, 0);
        const sum = u0 + u1 + u2;
        const index = j * columns + i;
        enter(index, triangle, insert(index, (a.y * u0 + b.y * u1 + c.y * u2) / sum));
      }
    }
    return true;
  };

  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const matrix = new Matrix4();
  let drawn = 0;
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute("position");
    const index = geometry.index;
    const count = index ? index.count : position.count;
    const indices = index?.array ?? null;
    matrix.copy(mesh.matrixWorld);
    // A mirrored transform flips the winding, and with it which way is up.
    const flip = matrix.determinant() < 0 ? -1 : 1;
    const e = matrix.elements;
    // Plain arrays read directly; interleaved or normalised ones through the attribute.
    const raw = !(position as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute && !position.normalized && position.itemSize === 3 ? position.array : null;
    const read = (vertex: number, out: Vector3) => {
      const x = raw ? raw[vertex * 3]! : position.getX(vertex);
      const y = raw ? raw[vertex * 3 + 1]! : position.getY(vertex);
      const z = raw ? raw[vertex * 3 + 2]! : position.getZ(vertex);
      out.set(e[0]! * x + e[4]! * y + e[8]! * z + e[12]!, e[1]! * x + e[5]! * y + e[9]! * z + e[13]!, e[2]! * x + e[6]! * y + e[10]! * z + e[14]!);
    };
    for (const [start, end] of groundRanges(mesh, geometry, count)) {
      for (let i = start; i + 2 < end; i += 3) {
        read(indices ? indices[i]! : i, a);
        read(indices ? indices[i + 1]! : i + 1, b);
        read(indices ? indices[i + 2]! : i + 2, c);
        if (drawTriangle(a, b, c, flip)) drawn += 1;
        if (!(entries <= RIM.maxEntries)) break;
      }
      if (!(entries <= RIM.maxEntries)) break;
    }
    if (!(entries <= RIM.maxEntries)) break;
  }
  if (!(entries <= RIM.maxEntries)) {
    console.info(`[holoim] rim: the ground covers over ${RIM.maxEntries} cell entries; the cloche keeps a flat foot`);
    return null;
  }
  // Flood from the author's feet: a neighbour's layer within a step joins.
  const joined = new Uint8Array(cells * depth);
  const queue = new Int32Array(cells * depth);
  let tail = 0;
  for (const seed of seeds) {
    const si = Math.floor((seed.x - box.minX) / cell);
    const sj = Math.floor((seed.z - box.minZ) / cell);
    // The ground the feet stand on: the nearest layer at or under them, in the cell or just beside it.
    let best = -1;
    let bestGap = Infinity;
    for (let dj = -2; dj <= 2; dj += 1) {
      for (let di = -2; di <= 2; di += 1) {
        const i = si + di;
        const j = sj + dj;
        if (i < 0 || i >= columns || j < 0 || j >= rows) continue;
        const index = j * columns + i;
        for (let k = 0; k < counts[index]!; k += 1) {
          const height = layers[index * depth + k]!;
          const gap = Math.abs(height - seed.y) + Math.hypot(di, dj) * cell;
          if (height <= seed.y + RIM.step && gap < bestGap) {
            bestGap = gap;
            best = index * depth + k;
          }
        }
      }
    }
    if (best >= 0 && bestGap <= RIM.step + 3 * cell && !joined[best]) {
      joined[best] = 1;
      queue[tail++] = best;
    }
  }
  const step = RIM.step;
  const spread = (slot: number) => {
    const index = (slot / depth) | 0;
    const height = layers[slot]!;
    const i = index % columns;
    const j = (index / columns) | 0;
    const iFrom = i > 0 ? -1 : 0;
    const iTo = i < columns - 1 ? 1 : 0;
    const jFrom = j > 0 ? -1 : 0;
    const jTo = j < rows - 1 ? 1 : 0;
    for (let dj = jFrom; dj <= jTo; dj += 1) {
      for (let di = iFrom; di <= iTo; di += 1) {
        const neighbour = index + dj * columns + di;
        const at = neighbour * depth;
        const count = counts[neighbour]!;
        for (let k = 0; k < count; k += 1) {
          if (joined[at + k] || Math.abs(layers[at + k]! - height) > step) continue;
          joined[at + k] = 1;
          queue[tail++] = at + k;
        }
      }
    }
  };
  for (let head = 0; head < tail; head += 1) spread(queue[head]!);

  // The ground: the triangles under a joined layer somewhere.
  const ground = new Uint8Array(triangleCount);
  for (let entry = 0; entry < entryCount; entry += 1) {
    const slot = entrySlot[entry]!;
    if (slot >= 0 && entryGeneration[entry] === slotGeneration[slot] && joined[slot]) ground[entryTriangle[entry]!] = 1;
  }
  let reached = 0;
  for (let index = 0; index < cells; index += 1) {
    for (let k = 0; k < counts[index]!; k += 1) {
      if (!joined[index * depth + k]) continue;
      reached += 1;
      break;
    }
  }
  if (reached === 0) return null;

  let topTriangle = -1;
  const heightAt = (x: number, z: number): number => {
    const i = Math.floor((x - box.minX) / cell);
    const j = Math.floor((z - box.minZ) / cell);
    topTriangle = -1;
    if (i < 0 || j < 0 || i >= columns || j >= rows) return Number.NaN;
    let top = -Infinity;
    for (let entry = head[j * columns + i]!; entry >= 0; entry = entryNext[entry]!) {
      const triangle = entryTriangle[entry]!;
      if (!ground[triangle]) continue;
      const at = triangle * 9;
      const ax = triangles[at]!, ay = triangles[at + 1]!, az = triangles[at + 2]!;
      const bx = triangles[at + 3]!, by = triangles[at + 4]!, bz = triangles[at + 5]!;
      const cx = triangles[at + 6]!, cy = triangles[at + 7]!, cz = triangles[at + 8]!;
      const area = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
      const w1 = ((x - ax) * (cz - az) - (cx - ax) * (z - az)) / area;
      const w2 = ((bx - ax) * (z - az) - (x - ax) * (bz - az)) / area;
      const w0 = 1 - w1 - w2;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      const height = ay * w0 + by * w1 + cy * w2;
      if (height > top) {
        top = height;
        topTriangle = triangle;
      }
    }
    return top > -Infinity ? top : Number.NaN;
  };
  const normalYAt = (x: number, z: number): number => {
    heightAt(x, z);
    return topTriangle >= 0 ? normalsY[topTriangle]! : Number.NaN;
  };

  lastBuildEnd = performance.now();
  return { heightAt, normalYAt, box, columns, rows, candidates: drawn, reached, buildMs: lastBuildEnd - started };
}

const fieldCache = new WeakMap<Object3D, Map<string, GroundField | null>>();

/** One field per model and placement: cards of the same hologram share it. */
export function cachedGroundField(source: Object3D, key: string, build: () => GroundField | null): GroundField | null {
  let fields = fieldCache.get(source);
  if (!fields) fieldCache.set(source, (fields = new Map()));
  if (!fields.has(key)) fields.set(key, build());
  return fields.get(key) ?? null;
}

export type TakeSample = { seconds: number; bubble: Vector3; feet: Vector3 };

/** The bubble's centre and the author's feet (the lowest foot bone, else the avatar's origin, on its floor) through the take. */
export function takeSamples(root: Object3D, clips: readonly AnimationClip[], count: number): TakeSample[] {
  const bubble = root.getObjectByName("RecordedBubbleSphere");
  const avatar = root.getObjectByName("RecordedAvatar");
  if (!bubble || !avatar) return [];
  const feet: Object3D[] = [];
  avatar.traverse((node) => {
    if (FOOT_BONE.test(node.name)) feet.push(node);
  });
  const samples: TakeSample[] = [];
  const read = (seconds: number) => {
    root.updateWorldMatrix(true, true);
    const at = avatar.getWorldPosition(new Vector3());
    if (feet.length > 0) {
      const scratch = new Vector3();
      at.set(0, Infinity, 0);
      let x = 0;
      let z = 0;
      for (const foot of feet) {
        foot.getWorldPosition(scratch);
        x += scratch.x / feet.length;
        z += scratch.z / feet.length;
        at.y = Math.min(at.y, scratch.y);
      }
      at.x = x;
      at.z = z;
    }
    samples.push({ seconds, bubble: bubble.getWorldPosition(new Vector3()), feet: at });
  };
  if (clips.some((clip) => clip.duration > 0)) sampleTake(root, clips, count, read);
  else read(0);
  return samples;
}

export type RimTake = {
  field: GroundField;
  /** The lowest rim per bin over the take: what Follow frames. */
  framing: Float32Array;
  /** The largest lift anywhere on the take's path. */
  maxLift: number;
  /** Decided once: a take whose rim lifts draws no shade (5.1) and is clipped by the bent dome. */
  lifts: boolean;
};

/** The rim the take wants with the bubble shifted by `shift` since the fit. */
export function rimTarget(shape: ClocheShape, field: GroundField, shift: Vector3, raw: Float32Array, out: Float32Array): Float32Array {
  clocheRimRaw(shape, (x, z) => lipHeight(shape, field, x + shift.x, z + shift.z, shift) - shift.y, raw);
  return smoothClocheRim(raw, out);
}

/** How finely the lip is looked for, inward from the foot's edge. */
const LIP_STEP = 0.05;

/**
 * The ground under a point of the foot's edge, world: where the edge stands
 * past the ground's edge (a cliff, a terrace), the lip's height measured
 * inward toward the foot's centre, up to `fillShare` of the dome's width.
 */
function lipHeight(shape: ClocheShape, field: GroundField, x: number, z: number, shift: Vector3): number {
  const here = field.heightAt(x, z);
  if (Number.isFinite(here)) return here;
  const dx = shape.base.x + shift.x - x;
  const dz = shape.base.z + shift.z - z;
  const length = Math.hypot(dx, dz);
  if (length < 1e-6) return Number.NaN;
  const reach = Math.min(RIM.fillShare * Math.max(shape.radii.x, shape.radii.z), length);
  for (let along = LIP_STEP; along <= reach + 1e-6; along += LIP_STEP) {
    let height = field.heightAt(x + (dx / length) * along, z + (dz / length) * along);
    if (!Number.isFinite(height)) continue;
    // A face steeper than a lip can be (a prop's foot sunk beside the ground's edge) is not the lip.
    if (field.normalYAt(x + (dx / length) * along, z + (dz / length) * along) < RIM.lipNormalY) continue;
    // The lip is where the ground continues inward: an isolated hit (a facet of a prop's sunk foot under it) is not.
    if (!Number.isFinite(field.heightAt(x + (dx / length) * (along + LIP_STEP), z + (dz / length) * (along + LIP_STEP)))) continue;
    // Ground rising more than its run within a step is a flank (a prop's sunk foot beside the ground's edge), not
    // the lip: the lip is the flank's top.
    for (let next = along + LIP_STEP; next <= reach + 1e-6; next += LIP_STEP) {
      const above = field.heightAt(x + (dx / length) * next, z + (dz / length) * next);
      if (!(above - height > LIP_STEP)) break;
      height = above;
    }
    return height;
  }
  return Number.NaN;
}

/** The path's rims, at load: the framing rim (the lowest per bin) and whether the take's rim lifts at all. */
export function readRimTake(shape: ClocheShape, field: GroundField, samples: readonly TakeSample[], fittedCentre: Vector3): RimTake {
  const framing = new Float32Array(CLOCHE_RIM_BINS).fill(Infinity);
  const raw = new Float32Array(CLOCHE_RIM_BINS);
  const target = new Float32Array(CLOCHE_RIM_BINS);
  const shift = new Vector3();
  let maxLift = 0;
  for (const sample of samples) {
    shift.copy(sample.bubble).sub(fittedCentre);
    rimTarget(shape, field, shift, raw, target);
    for (let bin = 0; bin < CLOCHE_RIM_BINS; bin += 1) {
      framing[bin] = Math.min(framing[bin]!, target[bin]!);
      maxLift = Math.max(maxLift, target[bin]!);
    }
  }
  for (let bin = 0; bin < CLOCHE_RIM_BINS; bin += 1) if (!Number.isFinite(framing[bin]!)) framing[bin] = 0;
  return { field, framing, maxLift, lifts: maxLift > RIM.shadeLift };
}

/**
 * The rim through playback: the target from the field where the bubble is
 * now, eased over time, snapping on a loop or seek, a bubble jump, reduced
 * motion or the first frame. `heights` is what the cloche and the clip read.
 */
export class RimMotion {
  readonly heights = new Float32Array(CLOCHE_RIM_BINS);
  readonly target = new Float32Array(CLOCHE_RIM_BINS);
  /** The ground's lift per bin before smoothing, for the e2e checks. */
  readonly raw = new Float32Array(CLOCHE_RIM_BINS);
  private readonly lastShift = new Vector3();
  private lastPlayback: number | null = null;
  /** The last update's cost, its mean, its worst and the last 600, in milliseconds. */
  readonly timing = { lastMs: 0, meanMs: 0, maxMs: 0, frames: 0, recent: new Float32Array(600) };

  constructor(private readonly shape: ClocheShape, private readonly field: GroundField) {}

  /** `advanceS`: how far the take's time should have moved this frame (the frame times its speed, 0 paused); any other change is a loop or a seek. */
  update(shift: Vector3, { dtS, playbackS, advanceS, reducedMotion }: { dtS: number; playbackS: number; advanceS: number; reducedMotion: boolean }): Float32Array {
    const started = performance.now();
    rimTarget(this.shape, this.field, shift, this.raw, this.target);
    const first = this.lastPlayback === null;
    // A loop or a seek: the take's time moved other than the frame moved it, by more than a millisecond.
    const skipped = !first && Math.abs(playbackS - this.lastPlayback! - advanceS) > 1e-3;
    const jumped = !first && shift.distanceTo(this.lastShift) > RIM.jump;
    easeClocheRim(this.heights, this.target, dtS, first || skipped || jumped || reducedMotion);
    this.lastPlayback = playbackS;
    this.lastShift.copy(shift);
    const spent = performance.now() - started;
    const timing = this.timing;
    timing.frames += 1;
    timing.lastMs = spent;
    timing.meanMs += (spent - timing.meanMs) / timing.frames;
    timing.maxMs = Math.max(timing.maxMs, spent);
    timing.recent[(timing.frames - 1) % timing.recent.length] = spent;
    return this.heights;
  }
}
