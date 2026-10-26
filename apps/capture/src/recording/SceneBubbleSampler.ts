import * as THREE from 'three';
import { isInChrome } from '@holoim/xr-ui-core';

import { isThreeMesh, isThreeSkinnedMesh } from '../shared/threeTypeGuards';
import { isFiniteVector3Like } from '../shared/math';

const RECORDING_SCENE_BUBBLE_RADIUS = 6;
const MIN_SCENE_SAMPLE_DISTANCE = 0.08;
const MAX_SCENE_SAMPLES = 480;
const OCCLUSION_TEST_MIN_NORMAL_Y_ABS = 0.6;
const OCCLUSION_HIT_MIN_DISTANCE = 0.03;

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
  private readonly tmpAvatarRootPos = new THREE.Vector3();
  private readonly tmpSampleDelta = new THREE.Vector3();
  private readonly occlusionRaycaster = new THREE.Raycaster();
  private readonly sceneBubbleSamples: THREE.Vector3[] = [];
  /** Source mesh → frame matrix scratch; used only when a take clips in a frame other than the world's. */
  private readonly tmpFramed = new THREE.Matrix4();

  captureSceneBubbleSample(activeCamera: THREE.Camera | undefined, avatarRoot: THREE.Object3D): void {
    if (activeCamera) {
      activeCamera.updateMatrixWorld(true);
      activeCamera.getWorldPosition(this.tmpPos);
      this.appendSceneBubbleSample(this.tmpPos);
    }

    avatarRoot.getWorldPosition(this.tmpAvatarRootPos);
    this.appendSceneBubbleSample(this.tmpAvatarRootPos);
  }

  /** A camera take's bubble point (a camera position in the set's frame, or the set's origin). */
  captureSceneBubblePoint(point: THREE.Vector3): void {
    this.appendSceneBubbleSample(point);
  }

  clear(): void {
    this.sceneBubbleSamples.length = 0;
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
   */
  collectSceneBubbleGroup(sceneRoot: THREE.Object3D, frame?: THREE.Matrix4): SceneBubble | undefined {
    if (this.sceneBubbleSamples.length === 0) return undefined;
    sceneRoot.updateMatrixWorld(true);
    const group = new THREE.Group();
    group.name = 'RecordedSceneBubble';
    const clippedBySource = new Map<THREE.Mesh, THREE.Mesh>();
    sceneRoot.traverse((obj) => {
      // Chrome (wrist glyphs, labels, panels, rays) is view layer, never the event (styleguide 1).
      if (!isSetMesh(obj)) return;
      const bubbleMesh = this.createSceneBubbleMesh(sceneRoot, obj, frame);
      if (bubbleMesh) {
        group.add(bubbleMesh);
        clippedBySource.set(obj, bubbleMesh);
      }
    });
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

  private createSceneBubbleMesh(sceneRoot: THREE.Object3D, sourceMesh: THREE.Mesh, frame?: THREE.Matrix4): THREE.Mesh | undefined {
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
      const kept = keptIndicesByMaterial.get(materialIndex);
      if (kept) {
        kept.push(i0, i1, i2);
      } else {
        keptIndicesByMaterial.set(materialIndex, [i0, i1, i2]);
      }
    }

    this.removeOccludedTriangles(sceneRoot, sourceMesh, positionAttr, keptIndicesByMaterial);

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
   * the same inside test as `collectSceneBubbleGroup`, stopping at the first.
   * A camera take asks this at Record, so a set too far away to clip is
   * refused then instead of failing at export.
   */
  clipsAnything(sceneRoot: THREE.Object3D, frame?: THREE.Matrix4): boolean {
    if (this.sceneBubbleSamples.length === 0) return false;
    sceneRoot.updateMatrixWorld(true);
    let found = false;
    sceneRoot.traverse((obj) => {
      if (found || !isSetMesh(obj)) return;
      const positionAttr = obj.geometry.getAttribute('position');
      if (!positionAttr) return;
      const index = obj.geometry.getIndex();
      const count = index ? index.count : positionAttr.count;
      const matrix = frame ? this.tmpFramed.multiplyMatrices(frame, obj.matrixWorld) : obj.matrixWorld;
      for (let i = 0; i + 2 < count && !found; i += 3) {
        this.tmpTriA.fromBufferAttribute(positionAttr, index ? index.getX(i) : i).applyMatrix4(matrix);
        this.tmpTriB.fromBufferAttribute(positionAttr, index ? index.getX(i + 1) : i + 1).applyMatrix4(matrix);
        this.tmpTriC.fromBufferAttribute(positionAttr, index ? index.getX(i + 2) : i + 2).applyMatrix4(matrix);
        found = this.triangleInsideBubble(this.tmpTriA, this.tmpTriB, this.tmpTriC);
      }
    });
    return found;
  }

  private triangleInsideBubble(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): boolean {
    const radiusSq = RECORDING_SCENE_BUBBLE_RADIUS * RECORDING_SCENE_BUBBLE_RADIUS;
    let insideCount = 0;
    if (this.vertexNearAnySample(a, radiusSq)) insideCount += 1;
    if (this.vertexNearAnySample(b, radiusSq)) insideCount += 1;
    if (insideCount < 2 && this.vertexNearAnySample(c, radiusSq)) insideCount += 1;
    return insideCount >= 2;
  }

  private vertexNearAnySample(v: THREE.Vector3, radiusSq: number): boolean {
    for (const sample of this.sceneBubbleSamples) {
      if (v.distanceToSquared(sample) <= radiusSq) {
        return true;
      }
    }
    return false;
  }

  private removeOccludedTriangles(
    sceneRoot: THREE.Object3D,
    sourceMesh: THREE.Mesh,
    positionAttr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    keptByMaterial: Map<number, number[]>
  ): void {
    const rc = this.occlusionRaycaster;
    rc.far = RECORDING_SCENE_BUBBLE_RADIUS * 2;
    for (const [materialIndex, indices] of keptByMaterial) {
      let writeIndex = 0;
      for (let i = 0; i + 2 < indices.length; i += 3) {
        this.tmpTriA.fromBufferAttribute(positionAttr, indices[i]!).applyMatrix4(sourceMesh.matrixWorld);
        this.tmpTriB.fromBufferAttribute(positionAttr, indices[i + 1]!).applyMatrix4(sourceMesh.matrixWorld);
        this.tmpTriC.fromBufferAttribute(positionAttr, indices[i + 2]!).applyMatrix4(sourceMesh.matrixWorld);

        this.tmpTriEdgeAB.subVectors(this.tmpTriB, this.tmpTriA);
        this.tmpTriEdgeAC.subVectors(this.tmpTriC, this.tmpTriA);
        this.tmpTriNormal.crossVectors(this.tmpTriEdgeAB, this.tmpTriEdgeAC);
        const triNormalLenSq = this.tmpTriNormal.lengthSq();
        if (triNormalLenSq < 1e-10) {
          indices[writeIndex] = indices[i]!;
          indices[writeIndex + 1] = indices[i + 1]!;
          indices[writeIndex + 2] = indices[i + 2]!;
          writeIndex += 3;
          continue;
        }
        this.tmpTriNormal.multiplyScalar(1 / Math.sqrt(triNormalLenSq));
        if (Math.abs(this.tmpTriNormal.dot(SceneBubbleSampler.UP)) < OCCLUSION_TEST_MIN_NORMAL_Y_ABS) {
          indices[writeIndex] = indices[i]!;
          indices[writeIndex + 1] = indices[i + 1]!;
          indices[writeIndex + 2] = indices[i + 2]!;
          writeIndex += 3;
          continue;
        }

        this.tmpTriCentroid.copy(this.tmpTriA).add(this.tmpTriB).add(this.tmpTriC).multiplyScalar(1 / 3);
        this.tmpTriCentroid.y += 0.01;
        rc.set(this.tmpTriCentroid, SceneBubbleSampler.UP);
        const hits = rc.intersectObject(sceneRoot, true);
        let occluded = false;
        for (const hit of hits) {
          if (hit.distance < OCCLUSION_HIT_MIN_DISTANCE) continue;
          if (hit.object === sourceMesh) continue;
          // Chrome is not part of the event; it never hides the floor under it.
          if (isInChrome(hit.object)) continue;
          occluded = true;
          break;
        }

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
