import * as THREE from 'three';

/**
 * Straight-down ground queries against a static world (the set the avatar walks on).
 *
 * three's raycast tests every triangle of every mesh whose bounds the ray crosses, so on the
 * default terrain each foot probe cost a pass over the whole landscape (1.8 ms a frame for the
 * leg solver's handful of probes). Every ground probe here is vertical, so the world's triangles
 * are bucketed once on an XZ grid (in world space) and a query tests only the few in its cell:
 * a point-in-triangle test and a barycentric height, without allocating.
 *
 * Built lazily per world model and rebuilt when the model's world transform changes (it is
 * centred and scaled after loading); a set is static, so whatever adds a mesh to one calls
 * `invalidate`. Faces keep their winding's normal, as three reports them.
 */
/** The steepest ground the character stands on: a face whose normal's y is at least this (about 78°). */
export const WALKABLE_NORMAL_Y = 0.2;

export class TerrainHeightIndex {
  private static readonly cache = new WeakMap<THREE.Object3D, TerrainHeightIndex>();

  /** The index of `world`, built on first use and again whenever `world` has moved. */
  static of(world: THREE.Object3D): TerrainHeightIndex {
    world.updateWorldMatrix(true, false);
    const cached = TerrainHeightIndex.cache.get(world);
    if (cached && cached.builtFor.equals(world.matrixWorld)) return cached;
    const index = new TerrainHeightIndex(world);
    TerrainHeightIndex.cache.set(world, index);
    return index;
  }

  /** `world` gained or lost meshes (a debug probe): the next query rebuilds its index. */
  static invalidate(world: THREE.Object3D): void {
    TerrainHeightIndex.cache.delete(world);
  }

  private readonly builtFor = new THREE.Matrix4();
  // Per triangle: its three corners (x, y, z) and its unit normal.
  private readonly corners: Float32Array;
  private readonly normals: Float32Array;
  // Cells in rows of `cols`; cell k holds triangles items[offsets[k]..offsets[k+1]).
  private readonly offsets: Int32Array;
  private readonly items: Int32Array;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly cellSize: number;
  private readonly cols: number;
  private readonly rows: number;

  private constructor(world: THREE.Object3D) {
    world.updateWorldMatrix(true, true);
    this.builtFor.copy(world.matrixWorld);
    const corners: number[] = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    world.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
      const position = mesh.geometry?.getAttribute('position');
      if (!position) return;
      const index = mesh.geometry.getIndex();
      const count = index ? index.count : position.count;
      for (let i = 0; i + 2 < count; i += 3) {
        const [ia, ib, ic] = index ? [index.getX(i), index.getX(i + 1), index.getX(i + 2)] : [i, i + 1, i + 2];
        a.fromBufferAttribute(position, ia).applyMatrix4(mesh.matrixWorld);
        b.fromBufferAttribute(position, ib).applyMatrix4(mesh.matrixWorld);
        c.fromBufferAttribute(position, ic).applyMatrix4(mesh.matrixWorld);
        corners.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      }
    });
    this.corners = new Float32Array(corners);
    const triangles = this.corners.length / 9;
    this.normals = new Float32Array(triangles * 3);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    const n = new THREE.Vector3();
    for (let t = 0; t < triangles; t++) {
      const o = t * 9;
      a.fromArray(this.corners, o); b.fromArray(this.corners, o + 3); c.fromArray(this.corners, o + 6);
      THREE.Triangle.getNormal(a, b, c, n).toArray(this.normals, t * 3);
      minX = Math.min(minX, a.x, b.x, c.x); maxX = Math.max(maxX, a.x, b.x, c.x);
      minZ = Math.min(minZ, a.z, b.z, c.z); maxZ = Math.max(maxZ, a.z, b.z, c.z);
    }
    if (!triangles) { minX = minZ = 0; maxX = maxZ = 1; }
    // About four triangles' footprint per cell on an even landscape.
    const side = Math.min(512, Math.max(1, Math.ceil(Math.sqrt(triangles / 4))));
    this.minX = minX;
    this.minZ = minZ;
    this.cellSize = Math.max((maxX - minX) / side, (maxZ - minZ) / side, 1e-6);
    this.cols = Math.max(1, Math.ceil((maxX - minX) / this.cellSize));
    this.rows = Math.max(1, Math.ceil((maxZ - minZ) / this.cellSize));
    // Two passes: count each triangle into every cell its XZ bounds touch, then fill.
    const counts = new Int32Array(this.cols * this.rows + 1);
    const span = (t: number, visit: (k: number) => void) => {
      const o = t * 9, x0 = Math.min(this.corners[o]!, this.corners[o + 3]!, this.corners[o + 6]!), x1 = Math.max(this.corners[o]!, this.corners[o + 3]!, this.corners[o + 6]!);
      const z0 = Math.min(this.corners[o + 2]!, this.corners[o + 5]!, this.corners[o + 8]!), z1 = Math.max(this.corners[o + 2]!, this.corners[o + 5]!, this.corners[o + 8]!);
      for (let row = this.row(z0); row <= this.row(z1); row++) for (let col = this.col(x0); col <= this.col(x1); col++) visit(row * this.cols + col);
    };
    for (let t = 0; t < triangles; t++) span(t, (k) => counts[k + 1]!++);
    for (let k = 1; k < counts.length; k++) counts[k]! += counts[k - 1]!;
    this.offsets = counts;
    this.items = new Int32Array(counts[counts.length - 1]!);
    const fill = counts.slice(0, -1);
    for (let t = 0; t < triangles; t++) span(t, (k) => { this.items[fill[k]!++] = t; });
  }

  /**
   * The highest surface at (x, z) between `topY` and `bottomY` whose normal's y is at least
   * `minNormalY` (as a ray cast down from `topY` would meet first); its height, or undefined.
   * `outNormal`, when given, receives that face's normal.
   */
  heightAt(x: number, z: number, topY: number, bottomY: number, minNormalY: number, outNormal?: THREE.Vector3): number | undefined {
    const col = this.col(x), row = this.row(z);
    if (x < this.minX || z < this.minZ || col >= this.cols || row >= this.rows) return undefined;
    const k = row * this.cols + col;
    let best = -Infinity, bestTriangle = -1;
    for (let i = this.offsets[k]!; i < this.offsets[k + 1]!; i++) {
      const t = this.items[i]!;
      if (this.normals[t * 3 + 1]! < minNormalY) continue;
      const y = this.triangleHeight(t, x, z);
      if (y === undefined || y > topY || y < bottomY || y <= best) continue;
      best = y;
      bestTriangle = t;
    }
    if (bestTriangle < 0) return undefined;
    outNormal?.fromArray(this.normals, bestTriangle * 3);
    return best;
  }

  private triangleHeight(t: number, x: number, z: number): number | undefined {
    const p = this.corners, o = t * 9;
    const ax = p[o]!, az = p[o + 2]!, bx = p[o + 3]!, bz = p[o + 5]!, cx = p[o + 6]!, cz = p[o + 8]!;
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(det) < 1e-12) return undefined; // seen edge-on from above: no ground
    const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
    const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
    const w = 1 - u - v;
    const eps = -1e-6;
    if (u < eps || v < eps || w < eps) return undefined;
    return u * p[o + 1]! + v * p[o + 4]! + w * p[o + 7]!;
  }

  private col(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cellSize)));
  }

  private row(z: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((z - this.minZ) / this.cellSize)));
  }
}
