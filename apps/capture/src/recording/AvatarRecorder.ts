import * as THREE from 'three';
import type { RecordingFrame } from '../types/contracts';

import { PointDetector, type TrackedHandJointReader } from '../xr/PointDetector';
import { FrameCaptureStore } from './FrameCaptureStore';
import { GltfExportComposer } from './GltfExportComposer';
import { PointSampleStore } from './PointSampleStore';
import type { PointResolutionReport } from './PointResolver';
import { SceneBubbleSampler } from './SceneBubbleSampler';

export class AvatarRecorder {
  private readonly frameCaptureStore = new FrameCaptureStore();
  private readonly sceneBubbleSampler = new SceneBubbleSampler();
  private readonly gltfExportComposer = new GltfExportComposer();
  private readonly pointDetector = new PointDetector();
  /**
   * Point evidence for the take, recorded with the frames' `timeSec`. The
   * desktop point action writes its aim holds and inferred motion here; see
   * `PointSampleStore` for the contract.
   */
  readonly pointSamples = new PointSampleStore();

  setEnabled(enabled: boolean): void {
    this.frameCaptureStore.setEnabled(enabled);
    this.pointSamples.setEnabled(enabled);
    this.pointDetector.reset();
  }

  /**
   * Records one step. `hands` (tracked XRHand joints) feeds headset point
   * detection; without it, or for non-`xr-hand` input, no hand samples are kept.
   */
  capture(
    timeSec: number,
    avatar: THREE.Object3D | undefined,
    avatarRoot: THREE.Object3D,
    activeCamera?: THREE.Camera,
    hands?: TrackedHandJointReader
  ): void {
    if (!this.frameCaptureStore.isEnabled() || !avatar) {
      return;
    }

    this.sceneBubbleSampler.captureSceneBubbleSample(activeCamera, avatarRoot);
    this.frameCaptureStore.captureFrame(timeSec, avatar, avatarRoot);
    if (hands) this.pointDetector.sample(timeSec, hands, (sample) => this.pointSamples.recordHandSample(sample));
  }

  /** What point resolution decided at the latest export, in take seconds. */
  getLastPointReport(): PointResolutionReport | undefined {
    return this.gltfExportComposer.lastPointReport;
  }

  getFrames(): RecordingFrame[] {
    return this.frameCaptureStore.getFrames();
  }

  clear(): void {
    this.frameCaptureStore.clear();
    this.sceneBubbleSampler.clear();
    this.pointSamples.clear();
    this.pointDetector.reset();
  }

  async exportToGlbBlob(
    avatar: THREE.Object3D,
    sceneRoot?: THREE.Object3D,
    audioData?: { buffer: ArrayBuffer; mimeType: string }
  ): Promise<Blob> {
    return this.gltfExportComposer.exportToGlbBlob(
      avatar,
      this.frameCaptureStore,
      this.sceneBubbleSampler,
      sceneRoot,
      audioData,
      this.pointSamples
    );
  }
}
