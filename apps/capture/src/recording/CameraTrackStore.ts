import * as THREE from 'three';

import { isFiniteQuaternionLike, isFiniteVector3Like } from '../shared/math';

/** One step of the author's camera, in the set's frame. */
export interface CameraSample {
  timeSec: number;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

const tmpInverse = new THREE.Matrix4();
const tmpPose = new THREE.Matrix4();
const tmpScale = new THREE.Vector3();

/**
 * The camera author's path: per step the XR camera's pose in the set's frame,
 * `inverse(worldGroup.matrixWorld) · xrCamera.matrixWorld`, so where the set
 * was placed in the room never enters the take. A pose that is not finite
 * (tracking lost, an emulator's first frames) is skipped, never written.
 *
 * The vertical field of view is read once per take, at its first valid
 * frame, from the first view's projection matrix: `2·atan(1/P[5])`. Phone
 * projections are off-centre and three's `fov` is stale, so it is never read
 * per frame.
 */
export class CameraTrackStore {
  private samples: CameraSample[] = [];
  private fov: number | null = null;

  /** Stores the step if the pose is finite; returns whether it did. */
  capture(timeSec: number, setWorld: THREE.Matrix4, cameraWorld: THREE.Matrix4, firstViewProjection: THREE.Matrix4 | undefined): boolean {
    tmpInverse.copy(setWorld).invert();
    tmpPose.multiplyMatrices(tmpInverse, cameraWorld);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    tmpPose.decompose(position, quaternion, tmpScale);
    if (!isFiniteVector3Like(position) || !isFiniteQuaternionLike(quaternion)) return false;
    quaternion.normalize();
    if (this.fov === null && firstViewProjection) this.fov = yfovFromProjection(firstViewProjection);
    this.samples.push({ timeSec, position, quaternion });
    return true;
  }

  getSamples(): readonly CameraSample[] {
    return this.samples;
  }

  /** Radians, or null until a valid projection has been seen. */
  getYfov(): number | null {
    return this.fov;
  }

  clear(): void {
    this.samples = [];
    this.fov = null;
  }
}

function yfovFromProjection(projection: THREE.Matrix4): number | null {
  const p5 = projection.elements[5]!;
  if (!Number.isFinite(p5) || p5 <= 0) return null;
  return 2 * Math.atan(1 / p5);
}
