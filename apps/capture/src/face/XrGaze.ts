import * as THREE from 'three';

/**
 * The WebXR eye-gaze ray (Quest Browser `gaze-tracking`, an input source
 * with targetRayMode 'gaze'), in world space. XR poses are relative to the
 * reference space, which the camera rig places in the world.
 */
export class XrGaze {
  private readonly origin = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly matrix = new THREE.Matrix4();
  private valid = false;

  constructor(private readonly rig: THREE.Object3D) {}

  noteXrFrame(frame: XRFrame, referenceSpace: XRReferenceSpace | null): void {
    this.valid = false;
    if (!referenceSpace) return;
    for (const source of frame.session.inputSources) {
      if (source.targetRayMode !== 'gaze') continue;
      const pose = frame.getPose(source.targetRaySpace, referenceSpace);
      if (!pose) return;
      this.matrix.fromArray(pose.transform.matrix).premultiply(this.rig.matrixWorld);
      this.origin.setFromMatrixPosition(this.matrix);
      // Target rays point down their local -Z.
      this.direction.set(0, 0, -1).transformDirection(this.matrix);
      this.valid = true;
      return;
    }
  }

  /** The point the author looks at, `distance` metres along the ray. */
  lookPoint(out: THREE.Vector3, distance = 2): THREE.Vector3 | null {
    if (!this.valid) return null;
    return out.copy(this.direction).multiplyScalar(distance).add(this.origin);
  }

  clear(): void {
    this.valid = false;
  }
}
