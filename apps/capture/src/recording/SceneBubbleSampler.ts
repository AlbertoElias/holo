import * as THREE from 'three';
import { isInChrome } from '@holoim/xr-ui-core';

import { isThreeMesh, isThreeSkinnedMesh } from '../shared/threeTypeGuards';
import { isFiniteVector3Like } from '../shared/math';

const RECORDING_SCENE_BUBBLE_RADIUS = 6;
const MIN_SCENE_SAMPLE_DISTANCE = 0.08;
const MAX_SCENE_SAMPLES = 480;
const OCCLUSION_TEST_MIN_NORMAL_Y_ABS = 0.6;
const OCCLUSION_HIT_MIN_DISTANCE = 0.03;
/** A kept triangle reaching past the bubble with an edge longer than this is split, so the take's set ends near the bubble. */
const MAX_STRADDLING_EDGE = 1;
const MAX_SPLIT_DEPTH = 6;
/**
 * How far past its centre the viewer can draw the set: a performer's dome (the
 * feed's clip on a take whose rim lifts) reaches past the 6 m sphere, as far
 * as the straddling pieces kept above; a camera take is clipped by its
 * sphere alone.
 */
export const PERFORMER_SET_REACH = RECORDING_SCENE_BUBBLE_RADIUS + MAX_STRADDLING_EDGE;
export const CAMERA_SET_REACH = RECORDING_SCENE_BUBBLE_RADIUS;
/** Clip centres closer than this to the previous one add nothing to the reach. */
const MIN_CENTRE_DISTANCE = 0.08;
/** Above this many clipped triangles the enclosure pass is skipped: it casts without a BVH. */
const MAX_ENCLOSURE_TRIANGLES = 60_000;
/** Grid cell of the enclosure pass's ray caster, in metres. */
const ENCLOSURE_CELL = 0.5;
const ENCLOSURE_HIT_MIN_DISTANCE = 1e-4;

/** A vertex a split adds: a blend of one source triangle's three vertices. */
interface SplitVertex {
  source: [number, number, number];
  weights: [number, number, number];
}

/** One mesh's clip in progress: the source triangle being split and the vertices splits have added. */
interface SplitContext {
  positionAttr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  clipMatrix: THREE.Matrix4;
  source: [number, number, number];
  extras: SplitVertex[];
  midpoints: Map<string, number>;
}

/** Where the viewer's clip is centred over the take, and how far past it the set can be drawn. */
export interface SetReach {
  /** Clip centres, x y z flat, in the clip's frame: the sphere's track, or a camera take's origin. */
  centres: ArrayLike<number>;
  radius: number;
}

/** What the latest export's clip kept and dropped, in triangles. */
export interface SceneTrimReport {
  /** Triangles the clip kept before the two passes. */
  clipped: number;
  /** Dropped because no viewer's clip reaches them. */
  outOfReach: number;
  /** Dropped because the set encloses them (under the ground, inside another surface). */
  enclosed: number;
  /** Triangles exported. */
  kept: number;
  /** The enclosure pass did not run (over budget, or turned off). */
  enclosureSkipped: boolean;
  /** Time the two passes took, in milliseconds. */
  ms: number;
}

/**
 * Directions a viewer can look at the set from: straight down, and down at
 * 45° and nearly level from every side. Rays go the other way, from the set
 * toward the viewer: up, up at 45°, and slightly down (the feed's orbit
 * looks up from 8° under its target).
 */
const ENCLOSURE_DIRECTIONS: readonly THREE.Vector3[] = (() => {
  const directions = [new THREE.Vector3(0, 1, 0)];
  for (const elevation of [45, -5]) {
    for (let k = 0; k < 8; k += 1) {
      const azimuth = (k * Math.PI) / 4;
      const e = (elevation * Math.PI) / 180;
      directions.push(new THREE.Vector3(Math.cos(e) * Math.cos(azimuth), Math.sin(e), Math.cos(e) * Math.sin(azimuth)));
    }
  }
  return directions;
})();

export interface SceneBubble {
  group: THREE.Group;
  /** Source scene mesh → its clipped copy in `group`. */
  clippedBySource: Map<THREE.Mesh, THREE.Mesh>;
}

/** A mesh the recorded set draws: visible, not skinned, not chrome. */
function isSetMesh(obj: THREE.Object3D): obj is THREE.Mesh {
  return isThreeMesh(obj) && obj.visible && !isThreeSkinnedMesh(obj) && !isInChrome(obj);
}

export class SceneBubbleSampler {
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpScale = new THREE.Vector3();
  private readonly tmpTriA = new THREE.Vector3();
  private readonly tmpTriB = new THREE.Vector3();
  private readonly tmpTriC = new THREE.Vector3();
  private readonly tmpTriEdgeAB = new THREE.Vector3();
  private readonly tmpTriEdgeAC = new THREE.Vector3();
  private readonly tmpTriNormal = new THREE.Vector3();
  private readonly tmpTriCentroid = new THREE.Vector3();
  private readonly tmpTriangle = new THREE.Triangle();
  private readonly tmpTriBox = new THREE.Box3();
  private readonly tmpTriClosest = new THREE.Vector3();
  private readonly tmpSplitCorner = new THREE.Vector3();
  private readonly tmpAvatarRootPos = new THREE.Vector3();
  private readonly tmpSampleDelta = new THREE.Vector3();
  private readonly occlusionRaycaster = new THREE.Raycaster();
  private readonly sceneBubbleSamples: THREE.Vector3[] = [];
  // Points the bubble always holds, never thinned (a camera take's set origin and admission point).
  private readonly pinnedSamples: THREE.Vector3[] = [];
  /** Source mesh → frame matrix scratch; used only when a take clips in a frame other than the world's. */
  private readonly tmpFramed = new THREE.Matrix4();
  /** The reach and enclosure passes; off only for a test's untrimmed export of the same take. */
  trimHidden = true;
  /** What the latest `collectSceneBubbleGroup` kept and dropped. */
  lastTrimReport: SceneTrimReport | undefined;
  private trimCounts = { clipped: 0, outOfReach: 0 };

  captureSceneBubbleSample(activeCamera: THREE.Camera | undefined, avatarRoot: THREE.Object3D): void {
    if (activeCamera) {
      activeCamera.updateMatrixWorld(true);
      activeCamera.getWorldPosition(this.tmpPos);
      this.appendSceneBubbleSample(this.tmpPos);
    }

    avatarRoot.getWorldPosition(this.tmpAvatarRootPos);
    this.appendSceneBubbleSample(this.tmpAvatarRootPos);
  }

  /** A camera take's bubble point: a camera position in the set's frame. */
  captureSceneBubblePoint(point: THREE.Vector3): void {
    this.appendSceneBubbleSample(point);
  }

  /** A point the bubble keeps for the whole take, however many samples follow. */
  pinSceneBubblePoint(point: THREE.Vector3): void {
    if (isFiniteVector3Like(point)) this.pinnedSamples.push(point.clone());
  }

  clear(): void {
    this.sceneBubbleSamples.length = 0;
    this.pinnedSamples.length = 0;
  }

  createBubbleSphere(): THREE.Mesh {
    const geometry = new THREE.SphereGeometry(RECORDING_SCENE_BUBBLE_RADIUS, 48, 32);
    const material = new THREE.MeshStandardMaterial({
      color: 0x88ccff,
      emissive: 0x224466,
      transparent: true,
      opacity: 0.12,
      side: THREE.DoubleSide,
      depthWrite: false,
      roughness: 0.1,
      metalness: 0.3
    });
    const sphere = new THREE.Mesh(geometry, material);
    sphere.name = 'RecordedBubbleSphere';
    sphere.renderOrder = 999;
    return sphere;
  }

  /**
   * The world model clipped to the recorded bubble, as exported, with each
   * source mesh's clipped copy. Point resolution casts only against these
   * clipped meshes, never the source scene, the bubble sphere or lights.
   *
   * `frame`, when given, re-expresses the clip in another frame (a camera
   * take's set frame, `inverse(worldGroup.matrixWorld)`): the bubble samples
   * are in that frame, and each clipped mesh is posed in it. The occlusion
   * test stays in world space, where the scene it casts against lives.
   * Without it, the world frame is used, as for every performer take.
   *
   * `reach`, when given, then drops what no viewer draws: pieces farther
   * than its radius from every clip centre, and triangles the clipped set
   * encloses (`dropEnclosedTriangles`). Splits are decided by the samples
   * as before, so every vertex within reach is the one exported without it.
   */
  collectSceneBubbleGroup(sceneRoot: THREE.Object3D, frame?: THREE.Matrix4, reach?: SetReach): SceneBubble | undefined {
    if (this.sceneBubbleSamples.length === 0 && this.pinnedSamples.length === 0) return undefined;
    const started = performance.now();
    sceneRoot.updateMatrixWorld(true);
    const group = new THREE.Group();
    group.name = 'RecordedSceneBubble';
    const clippedBySource = new Map<THREE.Mesh, THREE.Mesh>();
    const centres = reach && this.trimHidden ? new ReachCentres(reach) : undefined;
    this.trimCounts = { clipped: 0, outOfReach: 0 };
    sceneRoot.traverse((obj) => {
      // Chrome (wrist glyphs, labels, panels, rays) is view layer, never the event (styleguide 1).
      if (!isSetMesh(obj)) return;
      const bubbleMesh = this.createSceneBubbleMesh(sceneRoot, obj, frame, centres);
      if (bubbleMesh) {
        group.add(bubbleMesh);
        clippedBySource.set(obj, bubbleMesh);
      }
    });
    const enclosure = centres ? this.dropEnclosedTriangles(group, clippedBySource) : { enclosed: 0, skipped: true };
    let kept = 0;
    for (const mesh of clippedBySource.values()) kept += (mesh.geometry.getIndex()?.count ?? 0) / 3;
    this.lastTrimReport = {
      clipped: this.trimCounts.clipped,
      outOfReach: this.trimCounts.outOfReach,
      enclosed: enclosure.enclosed,
      kept,
      enclosureSkipped: enclosure.skipped,
      ms: performance.now() - started
    };
    return group.children.length > 0 ? { group, clippedBySource } : undefined;
  }

  private appendSceneBubbleSample(source: THREE.Vector3): void {
    if (!isFiniteVector3Like(source)) {
      return;
    }

    if (this.sceneBubbleSamples.length > 0) {
      const last = this.sceneBubbleSamples[this.sceneBubbleSamples.length - 1]!;
      this.tmpSampleDelta.subVectors(source, last);
      const minDistanceSq = MIN_SCENE_SAMPLE_DISTANCE * MIN_SCENE_SAMPLE_DISTANCE;
      if (this.tmpSampleDelta.lengthSq() < minDistanceSq) {
        return;
      }
    }

    if (this.sceneBubbleSamples.length >= MAX_SCENE_SAMPLES) {
      const downsampled: THREE.Vector3[] = [];
      for (let i = 0; i < this.sceneBubbleSamples.length; i += 1) {
        if (i % 2 === 0) downsampled.push(this.sceneBubbleSamples[i]!);
      }
      this.sceneBubbleSamples.length = 0;
      this.sceneBubbleSamples.push(...downsampled);
    }

    this.sceneBubbleSamples.push(source.clone());
  }

  private createSceneBubbleMesh(sceneRoot: THREE.Object3D, sourceMesh: THREE.Mesh, frame?: THREE.Matrix4, centres?: ReachCentres): THREE.Mesh | undefined {
    const sourceGeometry = sourceMesh.geometry;
    const positionAttr = sourceGeometry.getAttribute('position');
    if (!positionAttr || positionAttr.count < 3) return undefined;

    const sourceIndex = sourceGeometry.getIndex();
    const indexCount = sourceIndex ? sourceIndex.count : positionAttr.count;
    if (indexCount < 3) return undefined;

    const groups = sourceGeometry.groups.length > 0
      ? sourceGeometry.groups
      : [{ start: 0, count: indexCount, materialIndex: 0 }];
    let groupCursor = 0;
    // Vertices are tested where the bubble samples are: the world, or the frame.
    const clipMatrix = frame ? this.tmpFramed.multiplyMatrices(frame, sourceMesh.matrixWorld) : sourceMesh.matrixWorld;
    // Splitting and compacting rewrite the vertices, so only plain attributes take them; any other mesh keeps its
    // straddling triangles whole and its source vertices.
    const plain = Object.keys(sourceGeometry.morphAttributes).length === 0 &&
      Object.values(sourceGeometry.attributes).every((attr) => !(attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute);
    const split: SplitContext = { positionAttr, clipMatrix, source: [0, 0, 0], extras: [], midpoints: new Map() };

    const keptIndicesByMaterial = new Map<number, number[]>();
    for (let triStart = 0; triStart + 2 < indexCount; triStart += 3) {
      while (
        groupCursor < groups.length - 1 &&
        triStart >= groups[groupCursor]!.start + groups[groupCursor]!.count
      ) {
        groupCursor += 1;
      }
      const group = groups[groupCursor]!;
      if (triStart < group.start || triStart + 2 >= group.start + group.count) {
        continue;
      }

      const i0 = sourceIndex ? sourceIndex.getX(triStart) : triStart;
      const i1 = sourceIndex ? sourceIndex.getX(triStart + 1) : triStart + 1;
      const i2 = sourceIndex ? sourceIndex.getX(triStart + 2) : triStart + 2;

      this.tmpTriA.fromBufferAttribute(positionAttr, i0).applyMatrix4(clipMatrix);
      this.tmpTriB.fromBufferAttribute(positionAttr, i1).applyMatrix4(clipMatrix);
      this.tmpTriC.fromBufferAttribute(positionAttr, i2).applyMatrix4(clipMatrix);

      if (!this.triangleInsideBubble(this.tmpTriA, this.tmpTriB, this.tmpTriC)) {
        continue;
      }

      const materialIndex = group.materialIndex ?? 0;
      let kept = keptIndicesByMaterial.get(materialIndex);
      if (!kept) {
        kept = [];
        keptIndicesByMaterial.set(materialIndex, kept);
      }
      if (plain && this.straddlesWithLongEdge(this.tmpTriA, this.tmpTriB, this.tmpTriC)) {
        split.source = [i0, i1, i2];
        split.midpoints.clear();
        this.keepSplit(split, [i0, i1, i2], 0, kept);
      } else {
        kept.push(i0, i1, i2);
      }
    }
    for (const [materialIndex, kept] of keptIndicesByMaterial) {
      if (kept.length === 0) keptIndicesByMaterial.delete(materialIndex);
    }

    const localPosition = (index: number, target: THREE.Vector3) => this.splitVertexPosition(split, index, target);
    this.removeOccludedTriangles(sceneRoot, sourceMesh, localPosition, keptIndicesByMaterial);
    for (const indices of keptIndicesByMaterial.values()) this.trimCounts.clipped += indices.length / 3;
    if (centres) this.removeOutOfReach(centres, clipMatrix, localPosition, keptIndicesByMaterial);

    if (keptIndicesByMaterial.size === 0) {
      return undefined;
    }

    const clippedGeometry = sourceGeometry.clone();
    clippedGeometry.clearGroups();

    const clippedIndices: number[] = [];
    if (Array.isArray(sourceMesh.material)) {
      const sorted = [...keptIndicesByMaterial.entries()].sort((a, b) => a[0] - b[0]);
      for (const [materialIndex, indices] of sorted) {
        if (indices.length === 0) continue;
        const groupStart = clippedIndices.length;
        clippedIndices.push(...indices);
        clippedGeometry.addGroup(groupStart, indices.length, materialIndex);
      }
    } else {
      for (const indices of keptIndicesByMaterial.values()) {
        clippedIndices.push(...indices);
      }
      if (clippedIndices.length > 0) {
        clippedGeometry.addGroup(0, clippedIndices.length, 0);
      }
    }

    if (clippedIndices.length === 0) {
      return undefined;
    }

    // Only the kept triangles' vertices are exported, so the clipped mesh's bounds are what it draws.
    if (plain) this.compactVertices(clippedGeometry, clippedIndices, positionAttr.count, split.extras);
    clippedGeometry.setIndex(clippedIndices);
    clippedGeometry.computeBoundingBox();
    clippedGeometry.computeBoundingSphere();

    const clippedMesh = new THREE.Mesh(clippedGeometry, sourceMesh.material);
    clippedMesh.name = sourceMesh.name ? `${sourceMesh.name}_RecordedBubble` : 'RecordedBubbleMesh';
    if (frame) {
      clipMatrix.decompose(this.tmpPos, this.tmpQuat, this.tmpScale);
    } else {
      sourceMesh.getWorldPosition(this.tmpPos);
      sourceMesh.getWorldQuaternion(this.tmpQuat);
      sourceMesh.getWorldScale(this.tmpScale);
    }
    clippedMesh.position.copy(this.tmpPos);
    clippedMesh.quaternion.copy(this.tmpQuat);
    clippedMesh.scale.copy(this.tmpScale);
    clippedMesh.castShadow = sourceMesh.castShadow;
    clippedMesh.receiveShadow = sourceMesh.receiveShadow;
    clippedMesh.renderOrder = sourceMesh.renderOrder;
    return clippedMesh;
  }

  /**
   * Whether the clip of `sceneRoot` to the samples so far keeps any triangle:
   * the same draw-group, inside and occlusion tests as
   * `collectSceneBubbleGroup`, stopping at the first triangle kept.
   * A camera take asks this at Record, so a set too far away to clip is
   * refused then instead of failing at export.
   */
  clipsAnything(sceneRoot: THREE.Object3D, frame?: THREE.Matrix4): boolean {
    if (this.sceneBubbleSamples.length === 0 && this.pinnedSamples.length === 0) return false;
    sceneRoot.updateMatrixWorld(true);
    let found = false;
    sceneRoot.traverse((obj) => {
      if (found || !isSetMesh(obj)) return;
      const geometry = obj.geometry;
      const positionAttr = geometry.getAttribute('position');
      if (!positionAttr || positionAttr.count < 3) return;
      const index = geometry.getIndex();
      const count = index ? index.count : positionAttr.count;
      // Triangles are walked against the draw groups exactly as createSceneBubbleMesh walks them.
      const groups = geometry.groups.length > 0 ? geometry.groups : [{ start: 0, count }];
      let groupCursor = 0;
      const matrix = frame ? this.tmpFramed.multiplyMatrices(frame, obj.matrixWorld) : obj.matrixWorld;
      const vertex = (i: number) => (index ? index.getX(i) : i);
      for (let i = 0; i + 2 < count && !found; i += 3) {
        while (groupCursor < groups.length - 1 && i >= groups[groupCursor]!.start + groups[groupCursor]!.count) groupCursor += 1;
        const group = groups[groupCursor]!;
        if (i < group.start || i + 2 >= group.start + group.count) continue;
        this.tmpTriA.fromBufferAttribute(positionAttr, vertex(i)).applyMatrix4(matrix);
        this.tmpTriB.fromBufferAttribute(positionAttr, vertex(i + 1)).applyMatrix4(matrix);
        this.tmpTriC.fromBufferAttribute(positionAttr, vertex(i + 2)).applyMatrix4(matrix);
        if (!this.triangleInsideBubble(this.tmpTriA, this.tmpTriB, this.tmpTriC)) continue;
        // The export then drops what is hidden from above; test that in world space.
        this.tmpTriA.fromBufferAttribute(positionAttr, vertex(i)).applyMatrix4(obj.matrixWorld);
        this.tmpTriB.fromBufferAttribute(positionAttr, vertex(i + 1)).applyMatrix4(obj.matrixWorld);
        this.tmpTriC.fromBufferAttribute(positionAttr, vertex(i + 2)).applyMatrix4(obj.matrixWorld);
        found = !this.isOccludedFromAbove(sceneRoot, obj, this.tmpTriA, this.tmpTriB, this.tmpTriC);
      }
    });
    return found;
  }


  /**
   * A triangle is kept when its closest point lies within the radius of a
   * sample, so coarse geometry (a floor of two triangles per face) stays
   * under the take whatever its tessellation (B-028). A long triangle that
   * reaches past the bubble is split first (`keepSplit`), so the set still
   * ends about a metre past the bubble; on dense meshes this keeps one ring
   * of triangles past the radius.
   */
  private triangleInsideBubble(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): boolean {
    const radiusSq = RECORDING_SCENE_BUBBLE_RADIUS * RECORDING_SCENE_BUBBLE_RADIUS;
    // Any vertex inside settles it cheaply; this is every triangle of a dense mesh near the take.
    if (this.vertexNearAnySample(a, radiusSq) || this.vertexNearAnySample(b, radiusSq) || this.vertexNearAnySample(c, radiusSq)) return true;
    this.tmpTriBox.makeEmpty().expandByPoint(a).expandByPoint(b).expandByPoint(c).expandByScalar(RECORDING_SCENE_BUBBLE_RADIUS);
    this.tmpTriangle.set(a, b, c);
    const near = (sample: THREE.Vector3) =>
      this.tmpTriBox.containsPoint(sample) &&
      this.tmpTriangle.closestPointToPoint(sample, this.tmpTriClosest).distanceToSquared(sample) <= radiusSq;
    return this.pinnedSamples.some(near) || this.sceneBubbleSamples.some(near);
  }

  private vertexNearAnySample(v: THREE.Vector3, radiusSq: number): boolean {
    for (const sample of this.pinnedSamples) {
      if (v.distanceToSquared(sample) <= radiusSq) return true;
    }
    for (const sample of this.sceneBubbleSamples) {
      if (v.distanceToSquared(sample) <= radiusSq) {
        return true;
      }
    }
    return false;
  }

  /**
   * The export's occlusion rule for one triangle given in world space: an
   * upward- or downward-facing triangle with scene geometry (not itself, not
   * chrome) above its centroid is hidden and dropped.
   */
  private isOccludedFromAbove(sceneRoot: THREE.Object3D, sourceMesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): boolean {
    this.tmpTriEdgeAB.subVectors(b, a);
    this.tmpTriEdgeAC.subVectors(c, a);
    this.tmpTriNormal.crossVectors(this.tmpTriEdgeAB, this.tmpTriEdgeAC);
    const triNormalLenSq = this.tmpTriNormal.lengthSq();
    if (triNormalLenSq < 1e-10) return false;
    this.tmpTriNormal.multiplyScalar(1 / Math.sqrt(triNormalLenSq));
    if (Math.abs(this.tmpTriNormal.dot(SceneBubbleSampler.UP)) < OCCLUSION_TEST_MIN_NORMAL_Y_ABS) return false;

    const rc = this.occlusionRaycaster;
    rc.far = RECORDING_SCENE_BUBBLE_RADIUS * 2;
    this.tmpTriCentroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    this.tmpTriCentroid.y += 0.01;
    rc.set(this.tmpTriCentroid, SceneBubbleSampler.UP);
    for (const hit of rc.intersectObject(sceneRoot, true)) {
      if (hit.distance < OCCLUSION_HIT_MIN_DISTANCE) continue;
      if (hit.object === sourceMesh) continue;
      // Chrome is not part of the event; it never hides the floor under it.
      if (isInChrome(hit.object)) continue;
      return true;
    }
    return false;
  }

  /** A kept triangle that reaches past the bubble with a long edge: splitting it keeps the set near the bubble. */
  private straddlesWithLongEdge(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): boolean {
    const maxEdgeSq = Math.max(a.distanceToSquared(b), b.distanceToSquared(c), c.distanceToSquared(a));
    if (maxEdgeSq <= MAX_STRADDLING_EDGE * MAX_STRADDLING_EDGE) return false;
    const radiusSq = RECORDING_SCENE_BUBBLE_RADIUS * RECORDING_SCENE_BUBBLE_RADIUS;
    return !(this.vertexNearAnySample(a, radiusSq) && this.vertexNearAnySample(b, radiusSq) && this.vertexNearAnySample(c, radiusSq));
  }

  /**
   * Splits a triangle into four at its edge midpoints until its pieces are
   * inside the bubble or short, keeping the pieces the bubble reaches. The
   * winding of every piece is its parent's.
   */
  private keepSplit(split: SplitContext, tri: [number, number, number], depth: number, out: number[]): void {
    const [a, b, c] = tri.map((index) => this.splitVertexPosition(split, index, new THREE.Vector3()).applyMatrix4(split.clipMatrix)) as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
    if (!this.triangleInsideBubble(a, b, c)) return;
    if (depth >= MAX_SPLIT_DEPTH || !this.straddlesWithLongEdge(a, b, c)) {
      out.push(...tri);
      return;
    }
    const ab = this.splitMidpoint(split, tri[0], tri[1]);
    const bc = this.splitMidpoint(split, tri[1], tri[2]);
    const ca = this.splitMidpoint(split, tri[2], tri[0]);
    this.keepSplit(split, [tri[0], ab, ca], depth + 1, out);
    this.keepSplit(split, [ab, tri[1], bc], depth + 1, out);
    this.keepSplit(split, [ca, bc, tri[2]], depth + 1, out);
    this.keepSplit(split, [ab, bc, ca], depth + 1, out);
  }

  private splitMidpoint(split: SplitContext, p: number, q: number): number {
    const key = p < q ? `${p}:${q}` : `${q}:${p}`;
    const existing = split.midpoints.get(key);
    if (existing !== undefined) return existing;
    const wp = this.splitWeights(split, p);
    const wq = this.splitWeights(split, q);
    split.extras.push({ source: split.source, weights: [(wp[0] + wq[0]) / 2, (wp[1] + wq[1]) / 2, (wp[2] + wq[2]) / 2] });
    const index = split.positionAttr.count + split.extras.length - 1;
    split.midpoints.set(key, index);
    return index;
  }

  /** A vertex's weights over the source triangle being split. */
  private splitWeights(split: SplitContext, index: number): [number, number, number] {
    if (index >= split.positionAttr.count) return split.extras[index - split.positionAttr.count]!.weights;
    return split.source.map((sourceIndex) => (sourceIndex === index ? 1 : 0)) as [number, number, number];
  }

  /** A vertex's position in the mesh's own space, whether the source's or one a split added. */
  private splitVertexPosition(split: SplitContext, index: number, target: THREE.Vector3): THREE.Vector3 {
    if (index < split.positionAttr.count) return target.fromBufferAttribute(split.positionAttr, index);
    const { source, weights } = split.extras[index - split.positionAttr.count]!;
    target.set(0, 0, 0);
    for (let k = 0; k < 3; k += 1) target.addScaledVector(this.tmpSplitCorner.fromBufferAttribute(split.positionAttr, source[k]!), weights[k]!);
    return target;
  }

  /**
   * Rewrites `geometry`'s attributes to the vertices `indices` uses, in first
   * use order, and renumbers `indices` to match. A split vertex is a blend of
   * its source triangle's values.
   */
  private compactVertices(geometry: THREE.BufferGeometry, indices: number[], sourceCount: number, extras: SplitVertex[]): void {
    const renumbered = new Map<number, number>();
    const used: number[] = [];
    for (let i = 0; i < indices.length; i += 1) {
      let next = renumbered.get(indices[i]!);
      if (next === undefined) {
        next = used.length;
        renumbered.set(indices[i]!, next);
        used.push(indices[i]!);
      }
      indices[i] = next;
    }
    for (const [name, attr] of Object.entries(geometry.attributes)) {
      const source = attr as THREE.BufferAttribute;
      const size = source.itemSize;
      const ArrayType = source.array.constructor as new (length: number) => THREE.TypedArray;
      const array = new ArrayType(used.length * size);
      used.forEach((vertex, j) => {
        const base = j * size;
        if (vertex < sourceCount) {
          for (let k = 0; k < size; k += 1) array[base + k] = source.array[vertex * size + k]!;
          return;
        }
        const { source: corners, weights } = extras[vertex - sourceCount]!;
        let lengthSq = 0;
        for (let k = 0; k < size; k += 1) {
          const value = weights[0] * source.array[corners[0] * size + k]! + weights[1] * source.array[corners[1] * size + k]! + weights[2] * source.array[corners[2] * size + k]!;
          array[base + k] = value;
          lengthSq += value * value;
        }
        // A blended normal is shorter than unit length; restore it.
        if (name === 'normal' && lengthSq > 0) for (let k = 0; k < size; k += 1) array[base + k] = array[base + k]! / Math.sqrt(lengthSq);
      });
      geometry.setAttribute(name, new THREE.BufferAttribute(array, size, source.normalized));
    }
  }

  /**
   * Drops the triangles the clipped set encloses: from each of seven points
   * on the triangle, a ray toward every side a viewer looks from meets an
   * opaque surface of the set from behind (under the ground, inside a rock,
   * a hill's flank under the grass). One ray that escapes, or meets a
   * surface's front, keeps it. The set cast against is the clip, so a ray
   * leaving through the clip's cut edge escapes.
   */
  private dropEnclosedTriangles(group: THREE.Group, clippedBySource: Map<THREE.Mesh, THREE.Mesh>): { enclosed: number; skipped: boolean } {
    group.updateMatrixWorld(true);
    const meshes = [...clippedBySource.values()];
    const caster = EnclosureCaster.build(meshes);
    if (!caster) return { enclosed: 0, skipped: true };
    let enclosed = 0;
    for (const [source, mesh] of clippedBySource) {
      const drop = caster.enclosedTriangles(meshes.indexOf(mesh));
      if (drop.size === 0) continue;
      enclosed += drop.size;
      const geometry = mesh.geometry;
      const index = geometry.getIndex()!;
      const groups = geometry.groups.length > 0 ? geometry.groups : [{ start: 0, count: index.count, materialIndex: 0 }];
      const indices: number[] = [];
      const kept: { start: number; count: number; materialIndex: number }[] = [];
      for (const drawGroup of groups) {
        const start = indices.length;
        for (let i = drawGroup.start; i + 2 < drawGroup.start + drawGroup.count; i += 3) {
          if (drop.has(i / 3)) continue;
          indices.push(index.getX(i), index.getX(i + 1), index.getX(i + 2));
        }
        if (indices.length > start) kept.push({ start, count: indices.length - start, materialIndex: drawGroup.materialIndex ?? 0 });
      }
      if (indices.length === 0) {
        group.remove(mesh);
        clippedBySource.delete(source);
        continue;
      }
      geometry.clearGroups();
      for (const drawGroup of kept) geometry.addGroup(drawGroup.start, drawGroup.count, drawGroup.materialIndex);
      const position = geometry.getAttribute('position');
      const plain = Object.keys(geometry.morphAttributes).length === 0 &&
        Object.values(geometry.attributes).every((attr) => !(attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute);
      if (plain) this.compactVertices(geometry, indices, position.count, []);
      geometry.setIndex(indices);
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    }
    return { enclosed, skipped: false };
  }

  /** Drops the pieces no clip centre reaches: the viewer never draws them. */
  private removeOutOfReach(
    centres: ReachCentres,
    clipMatrix: THREE.Matrix4,
    localPosition: (index: number, target: THREE.Vector3) => THREE.Vector3,
    keptByMaterial: Map<number, number[]>
  ): void {
    for (const [materialIndex, indices] of keptByMaterial) {
      let writeIndex = 0;
      for (let i = 0; i + 2 < indices.length; i += 3) {
        localPosition(indices[i]!, this.tmpTriA).applyMatrix4(clipMatrix);
        localPosition(indices[i + 1]!, this.tmpTriB).applyMatrix4(clipMatrix);
        localPosition(indices[i + 2]!, this.tmpTriC).applyMatrix4(clipMatrix);
        if (!centres.reaches(this.tmpTriA, this.tmpTriB, this.tmpTriC)) {
          this.trimCounts.outOfReach += 1;
          continue;
        }
        indices[writeIndex] = indices[i]!;
        indices[writeIndex + 1] = indices[i + 1]!;
        indices[writeIndex + 2] = indices[i + 2]!;
        writeIndex += 3;
      }
      if (writeIndex === 0) keptByMaterial.delete(materialIndex);
      else indices.length = writeIndex;
    }
  }

  private removeOccludedTriangles(
    sceneRoot: THREE.Object3D,
    sourceMesh: THREE.Mesh,
    localPosition: (index: number, target: THREE.Vector3) => THREE.Vector3,
    keptByMaterial: Map<number, number[]>
  ): void {
    for (const [materialIndex, indices] of keptByMaterial) {
      let writeIndex = 0;
      for (let i = 0; i + 2 < indices.length; i += 3) {
        localPosition(indices[i]!, this.tmpTriA).applyMatrix4(sourceMesh.matrixWorld);
        localPosition(indices[i + 1]!, this.tmpTriB).applyMatrix4(sourceMesh.matrixWorld);
        localPosition(indices[i + 2]!, this.tmpTriC).applyMatrix4(sourceMesh.matrixWorld);

        const occluded = this.isOccludedFromAbove(sceneRoot, sourceMesh, this.tmpTriA, this.tmpTriB, this.tmpTriC);
        if (!occluded) {
          indices[writeIndex] = indices[i]!;
          indices[writeIndex + 1] = indices[i + 1]!;
          indices[writeIndex + 2] = indices[i + 2]!;
          writeIndex += 3;
        }
      }
      if (writeIndex === 0) {
        keptByMaterial.delete(materialIndex);
      } else {
        indices.length = writeIndex;
      }
    }
  }
}

/** The viewer's clip centres over a take, binned so a triangle finds the ones near it. */
class ReachCentres {
  private readonly radius: number;
  private readonly cells = new Map<string, THREE.Vector3[]>();
  private readonly box = new THREE.Box3();
  private readonly triangle = new THREE.Triangle();
  private readonly closest = new THREE.Vector3();

  constructor({ centres, radius }: SetReach) {
    this.radius = radius;
    let last: THREE.Vector3 | undefined;
    for (let i = 0; i + 2 < centres.length; i += 3) {
      const centre = new THREE.Vector3(centres[i]!, centres[i + 1]!, centres[i + 2]!);
      if (!isFiniteVector3Like(centre)) continue;
      if (last && last.distanceToSquared(centre) < MIN_CENTRE_DISTANCE * MIN_CENTRE_DISTANCE) continue;
      last = centre;
      const key = this.key(Math.floor(centre.x / radius), Math.floor(centre.y / radius), Math.floor(centre.z / radius));
      const cell = this.cells.get(key);
      if (cell) cell.push(centre);
      else this.cells.set(key, [centre]);
    }
  }

  /** Whether the triangle comes within the radius of any centre. */
  reaches(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): boolean {
    const r = this.radius;
    this.box.makeEmpty().expandByPoint(a).expandByPoint(b).expandByPoint(c).expandByScalar(r);
    this.triangle.set(a, b, c);
    const rSq = r * r;
    const [x0, y0, z0] = [Math.floor(this.box.min.x / r), Math.floor(this.box.min.y / r), Math.floor(this.box.min.z / r)];
    const [x1, y1, z1] = [Math.floor(this.box.max.x / r), Math.floor(this.box.max.y / r), Math.floor(this.box.max.z / r)];
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        for (let z = z0; z <= z1; z += 1) {
          for (const centre of this.cells.get(this.key(x, y, z)) ?? []) {
            if (!this.box.containsPoint(centre)) continue;
            if (this.triangle.closestPointToPoint(centre, this.closest).distanceToSquared(centre) <= rSq) return true;
          }
        }
      }
    }
    return false;
  }

  private key(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }
}

/** Whether a surface hides what is behind it: drawn, and with no see-through (blend, cutout, transmission). */
function isOpaque(material: THREE.Material | undefined): boolean {
  if (!material || !material.visible) return false;
  if (material.transparent || material.alphaTest > 0) return false;
  const physical = material as THREE.MeshPhysicalMaterial;
  return !(physical.transmission > 0) && !physical.alphaMap;
}

/**
 * The clipped set's triangles in a uniform grid, for casting the enclosure
 * pass's rays (three's raycaster honours each material's side, and this
 * needs the side every hit faces).
 */
class EnclosureCaster {
  private readonly ray = new THREE.Ray();
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly c = new THREE.Vector3();
  private readonly hit = new THREE.Vector3();
  private readonly point = new THREE.Vector3();
  /** The triangle being tested: its corners and centroid. */
  private readonly sampleCorners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] as const;
  private stamp = 0;

  private constructor(
    /** World corners, nine numbers per triangle. */
    private readonly corners: Float32Array,
    /** Unit geometric normals, three per triangle. */
    private readonly normals: Float32Array,
    private readonly opaque: Uint8Array,
    /** The mesh (its index in the list built from) and its triangle number, per triangle. */
    private readonly owner: Uint32Array,
    private readonly local: Uint32Array,
    private readonly firstOf: number[],
    private readonly origin: THREE.Vector3,
    private readonly cell: number,
    private readonly dims: [number, number, number],
    private readonly cellStart: Uint32Array,
    private readonly cellItems: Uint32Array,
    private readonly seen: Uint32Array
  ) {}

  static build(meshes: readonly THREE.Mesh[]): EnclosureCaster | null {
    let count = 0;
    for (const mesh of meshes) count += (mesh.geometry.getIndex()?.count ?? 0) / 3;
    if (count === 0 || count > MAX_ENCLOSURE_TRIANGLES) return null;
    const corners = new Float32Array(count * 9);
    const normals = new Float32Array(count * 3);
    const opaque = new Uint8Array(count);
    const owner = new Uint32Array(count);
    const local = new Uint32Array(count);
    const firstOf: number[] = [];
    const bounds = new THREE.Box3();
    const v = new THREE.Vector3();
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    let t = 0;
    meshes.forEach((mesh, m) => {
      firstOf.push(t);
      const geometry = mesh.geometry;
      const index = geometry.getIndex()!;
      const position = geometry.getAttribute('position');
      const groups = geometry.groups.length > 0 ? geometry.groups : [{ start: 0, count: index.count, materialIndex: 0 }];
      const materialOf = (i: number) => {
        const drawGroup = groups.find((g) => i >= g.start && i < g.start + g.count);
        return Array.isArray(mesh.material) ? mesh.material[drawGroup?.materialIndex ?? 0] : mesh.material;
      };
      for (let i = 0; i + 2 < index.count; i += 3, t += 1) {
        for (let k = 0; k < 3; k += 1) {
          v.fromBufferAttribute(position, index.getX(i + k)).applyMatrix4(mesh.matrixWorld);
          corners.set([v.x, v.y, v.z], t * 9 + k * 3);
          bounds.expandByPoint(v);
        }
        e1.set(corners[t * 9 + 3]! - corners[t * 9]!, corners[t * 9 + 4]! - corners[t * 9 + 1]!, corners[t * 9 + 5]! - corners[t * 9 + 2]!);
        e2.set(corners[t * 9 + 6]! - corners[t * 9]!, corners[t * 9 + 7]! - corners[t * 9 + 1]!, corners[t * 9 + 8]! - corners[t * 9 + 2]!);
        e1.cross(e2);
        const length = e1.length();
        if (length > 1e-12) normals.set([e1.x / length, e1.y / length, e1.z / length], t * 3);
        opaque[t] = length > 1e-12 && isOpaque(materialOf(i)) ? 1 : 0;
        owner[t] = m;
        local[t] = i / 3;
      }
    });
    bounds.expandByScalar(0.01);
    const size = bounds.getSize(new THREE.Vector3());
    // No more than 256 cells along an axis, so a wide set keeps a small grid.
    const cell = Math.max(ENCLOSURE_CELL, Math.max(size.x, size.y, size.z) / 256);
    const dims: [number, number, number] = [Math.max(1, Math.ceil(size.x / cell)), Math.max(1, Math.ceil(size.y / cell)), Math.max(1, Math.ceil(size.z / cell))];
    const cellOf = (value: number, axis: 0 | 1 | 2) => Math.min(dims[axis] - 1, Math.max(0, Math.floor((value - bounds.min.getComponent(axis)) / cell)));
    const counts = new Uint32Array(dims[0] * dims[1] * dims[2] + 1);
    const ranges: number[][] = [];
    for (let i = 0; i < count; i += 1) {
      const range: number[] = [];
      for (let axis = 0 as 0 | 1 | 2; axis < 3; axis = (axis + 1) as 0 | 1 | 2) {
        const values = [corners[i * 9 + axis]!, corners[i * 9 + 3 + axis]!, corners[i * 9 + 6 + axis]!];
        range.push(cellOf(Math.min(...values), axis), cellOf(Math.max(...values), axis));
      }
      ranges.push(range);
      for (let x = range[0]!; x <= range[1]!; x += 1) for (let y = range[2]!; y <= range[3]!; y += 1) for (let z = range[4]!; z <= range[5]!; z += 1) counts[(x * dims[1] + y) * dims[2] + z + 1]! += 1;
    }
    for (let i = 1; i < counts.length; i += 1) counts[i]! += counts[i - 1]!;
    const cellStart = counts.slice();
    const fill = counts.slice();
    const cellItems = new Uint32Array(cellStart[cellStart.length - 1]!);
    ranges.forEach((range, i) => {
      for (let x = range[0]!; x <= range[1]!; x += 1) for (let y = range[2]!; y <= range[3]!; y += 1) for (let z = range[4]!; z <= range[5]!; z += 1) cellItems[fill[(x * dims[1] + y) * dims[2] + z]!++] = i;
    });
    return new EnclosureCaster(corners, normals, opaque, owner, local, firstOf, bounds.min.clone(), cell, dims, cellStart, cellItems, new Uint32Array(count));
  }

  /** The local triangle numbers of mesh `m` that the set encloses. */
  enclosedTriangles(m: number): Set<number> {
    const enclosed = new Set<number>();
    const first = this.firstOf[m]!;
    const end = m + 1 < this.firstOf.length ? this.firstOf[m + 1]! : this.owner.length;
    for (let t = first; t < end; t += 1) {
      if (this.isEnclosed(t)) enclosed.add(this.local[t]!);
    }
    return enclosed;
  }

  private isEnclosed(t: number): boolean {
    const f = this.corners;
    const [a, b, c, centroid] = this.sampleCorners;
    a.fromArray(f, t * 9);
    b.fromArray(f, t * 9 + 3);
    c.fromArray(f, t * 9 + 6);
    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    // The centroid, points 90% of the way to each corner, and each edge's middle nudged 1% inward.
    for (let k = 0; k < 7; k += 1) {
      if (k === 0) this.point.copy(centroid);
      else if (k < 4) this.point.copy(k === 1 ? a : k === 2 ? b : c).lerp(centroid, 0.1);
      else {
        const [p, q] = k === 4 ? [a, b] : k === 5 ? [b, c] : [c, a];
        this.point.copy(p).add(q).multiplyScalar(0.5).lerp(centroid, 0.01);
      }
      for (const direction of ENCLOSURE_DIRECTIONS) {
        if (!this.backHit(this.point, direction, t)) return false;
      }
    }
    return true;
  }

  /** Whether the nearest opaque surface along the ray (other than `self`) is met from behind. */
  private backHit(from: THREE.Vector3, direction: THREE.Vector3, self: number): boolean {
    this.ray.set(from, direction);
    this.stamp += 1;
    if (this.stamp === 0xffffffff) {
      this.seen.fill(0);
      this.stamp = 1;
    }
    const { cell, dims, origin } = this;
    const local = [(from.x - origin.x) / cell, (from.y - origin.y) / cell, (from.z - origin.z) / cell];
    const d = [direction.x, direction.y, direction.z];
    const at = local.map((value) => Math.floor(value));
    const step = d.map((value) => (value > 0 ? 1 : value < 0 ? -1 : 0));
    const tMax = d.map((value, axis) => (value === 0 ? Infinity : ((value > 0 ? at[axis]! + 1 - local[axis]! : local[axis]! - at[axis]!) * cell) / Math.abs(value)));
    const tDelta = d.map((value) => (value === 0 ? Infinity : cell / Math.abs(value)));
    let nearest = Infinity;
    let nearestTri = -1;
    // The ray starts inside the grid (on a triangle of it), and a box once left is never re-entered.
    while (at[0]! >= 0 && at[0]! < dims[0] && at[1]! >= 0 && at[1]! < dims[1] && at[2]! >= 0 && at[2]! < dims[2]) {
      const c = (at[0]! * dims[1] + at[1]!) * dims[2] + at[2]!;
      for (let j = this.cellStart[c]!; j < this.cellStart[c + 1]!; j += 1) {
        const tri = this.cellItems[j]!;
        if (tri === self || !this.opaque[tri] || this.seen[tri] === this.stamp) continue;
        this.seen[tri] = this.stamp;
        const f = this.corners;
        this.a.fromArray(f, tri * 9);
        this.b.fromArray(f, tri * 9 + 3);
        this.c.fromArray(f, tri * 9 + 6);
        if (!this.ray.intersectTriangle(this.a, this.b, this.c, false, this.hit)) continue;
        const distance = this.hit.distanceTo(from);
        if (distance < ENCLOSURE_HIT_MIN_DISTANCE || distance >= nearest) continue;
        nearest = distance;
        nearestTri = tri;
      }
      const axis = tMax[0]! < tMax[1]! ? (tMax[0]! < tMax[2]! ? 0 : 2) : tMax[1]! < tMax[2]! ? 1 : 2;
      // A hit nearer than where the ray leaves this cell is the nearest anywhere.
      if (nearest <= tMax[axis]! || tMax[axis] === Infinity) break;
      at[axis]! += step[axis]!;
      tMax[axis]! += tDelta[axis]!;
    }
    if (nearestTri < 0) return false;
    const n = this.normals;
    return n[nearestTri * 3]! * direction.x + n[nearestTri * 3 + 1]! * direction.y + n[nearestTri * 3 + 2]! * direction.z > 0;
  }
}
