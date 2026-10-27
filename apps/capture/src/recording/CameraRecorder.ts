import * as THREE from 'three';

import type { SceneObject } from '../objects/SceneObjectRegistry';
import { CameraTrackStore } from './CameraTrackStore';
import { GltfExportComposer } from './GltfExportComposer';
import { ObjectSampleStore } from './ObjectSampleStore';
import { PointSampleStore } from './PointSampleStore';
import type { PointResolutionReport } from './PointResolver';
import { SceneBubbleSampler } from './SceneBubbleSampler';

/**
 * The recorder of a camera take (docs/features/archive/ar-recording.md): the author
 * is a camera, not a performer, so a take is the camera's path, the event
 * objects and the clipped set, all in the set's frame (`setFrame`'s local
 * frame, the AR world group). Where the set was placed in the room never
 * enters the take. A sibling of `AvatarRecorder`, which keeps the performer
 * path.
 */
export class CameraRecorder {
  private readonly track = new CameraTrackStore();
  private readonly sceneBubbleSampler = new SceneBubbleSampler();
  private readonly objectSamples = new ObjectSampleStore();
  private readonly gltfExportComposer = new GltfExportComposer();
  /**
   * The take's held marks: finger holds on the screen, in the set's frame,
   * written by `ScreenHolds` at the same simulation times as the camera
   * samples. Open exactly while the take is.
   */
  readonly pointSamples = new PointSampleStore();
  private enabled = false;
  private originAdded = false;
  /** Where the camera stood when `hasSetInReach` admitted the take, in the set's frame. */
  private admittedAt: THREE.Vector3 | null = null;
  private readonly setInverse = new THREE.Matrix4();
  private readonly cameraPosition = new THREE.Vector3();
  private readonly origin = new THREE.Vector3(0, 0, 0);

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    // A hold still down when the take stops is closed at that moment.
    this.pointSamples.setEnabled(enabled);
  }

  /** What point resolution decided at the latest export, in take seconds. */
  getLastPointReport(): PointResolutionReport | undefined {
    return this.gltfExportComposer.lastPointReport;
  }

  get sampleCount(): number {
    return this.track.getSamples().length;
  }

  /** The take's running time so far: first to latest sample. */
  get elapsedSec(): number {
    const samples = this.track.getSamples();
    return samples.length > 1 ? samples[samples.length - 1]!.timeSec - samples[0]!.timeSec : 0;
  }

  /**
   * Records one step. `xrCamera` is the XR view camera (three's array camera)
   * whose world pose and first view projection are read; `setFrame` is the
   * group whose local frame the take is in. A step with a non-finite camera
   * pose is dropped whole, objects included, so the two stay aligned.
   */
  capture(timeSec: number, setFrame: THREE.Object3D, xrCamera: THREE.ArrayCamera, objects: readonly SceneObject[]): void {
    if (!this.enabled) return;
    setFrame.updateWorldMatrix(true, false);
    xrCamera.updateMatrixWorld(true);
    const firstView = xrCamera.cameras[0]?.projectionMatrix;
    if (!this.track.capture(timeSec, setFrame.matrixWorld, xrCamera.matrixWorld, firstView)) return;

    // The bubble is pinned at the set's origin and follows the camera's path.
    // The points that admitted the take are pinned, so its export clips at
    // least what Record saw within reach.
    if (!this.originAdded) {
      this.sceneBubbleSampler.pinSceneBubblePoint(this.origin);
      if (this.admittedAt) this.sceneBubbleSampler.pinSceneBubblePoint(this.admittedAt);
      this.originAdded = true;
    }
    const last = this.track.getSamples().at(-1)!;
    this.cameraPosition.copy(last.position);
    this.sceneBubbleSampler.captureSceneBubblePoint(this.cameraPosition);
    this.objectSamples.capture(setFrame, objects);
  }

  /**
   * Whether a take started now would hold any of the set: the set clipped to
   * the bubble around its origin and the camera where it stands (Q3 refuses
   * Record when it would not). Call after `clear`: an admitted position is
   * kept for the take's bubble.
   */
  hasSetInReach(setFrame: THREE.Object3D, xrCamera: THREE.Camera, sceneRoot: THREE.Object3D): boolean {
    setFrame.updateWorldMatrix(true, false);
    xrCamera.updateMatrixWorld(true);
    this.setInverse.copy(setFrame.matrixWorld).invert();
    const probe = new SceneBubbleSampler();
    probe.captureSceneBubblePoint(this.origin);
    xrCamera.getWorldPosition(this.cameraPosition).applyMatrix4(this.setInverse);
    probe.captureSceneBubblePoint(this.cameraPosition);
    if (!probe.clipsAnything(sceneRoot, this.setInverse)) return false;
    this.admittedAt = this.cameraPosition.clone();
    return true;
  }

  clear(): void {
    this.track.clear();
    this.sceneBubbleSampler.clear();
    this.objectSamples.clear();
    this.pointSamples.clear();
    this.originAdded = false;
    this.admittedAt = null;
  }

  async exportToGlbBlob(setFrame: THREE.Object3D, sceneRoot: THREE.Object3D, audioData?: { buffer: ArrayBuffer; mimeType: string }): Promise<Blob> {
    setFrame.updateMatrixWorld(true);
    this.setInverse.copy(setFrame.matrixWorld).invert();
    return this.gltfExportComposer.exportCameraTakeToGlbBlob({
      track: this.track,
      bubbleSampler: this.sceneBubbleSampler,
      objectStore: this.objectSamples,
      pointStore: this.pointSamples,
      sceneRoot,
      setInverse: this.setInverse,
      audioData
    });
  }
}
