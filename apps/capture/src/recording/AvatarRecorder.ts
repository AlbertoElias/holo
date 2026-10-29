import * as THREE from 'three';
import type { RecordingFrame } from '../types/contracts';

import type { SceneObject } from '../objects/SceneObjectRegistry';
import { type AuthoringFrame, AuthoringSampleStore, IDLE_AUTHORING_FRAME } from './authoringSpans';
import type { HeadsetMarkStep } from '../xr/HeadsetHolds';
import { PointDetector, type TrackedHandJointReader } from '../xr/PointDetector';
import type { HandPointSample } from './PointSampleStore';
import { FrameCaptureStore } from './FrameCaptureStore';
import { GltfExportComposer } from './GltfExportComposer';
import { ObjectSampleStore } from './ObjectSampleStore';
import { PointSampleStore } from './PointSampleStore';
import type { PointResolutionReport } from './PointResolver';
import { SceneBubbleSampler, type SceneTrimReport } from './SceneBubbleSampler';

export class AvatarRecorder {
  private readonly frameCaptureStore = new FrameCaptureStore();
  private readonly sceneBubbleSampler = new SceneBubbleSampler();
  private readonly gltfExportComposer = new GltfExportComposer();
  private readonly pointDetector = new PointDetector();
  private readonly objectSamples = new ObjectSampleStore();
  private readonly authoringSamples = new AuthoringSampleStore();
  /**
   * Point evidence for the take, recorded with the frames' `timeSec`. The
   * desktop point action writes its aim holds and inferred motion here; see
   * `PointSampleStore` for the contract.
   */
  readonly pointSamples = new PointSampleStore();

  isEnabled(): boolean {
    return this.frameCaptureStore.isEnabled();
  }

  setEnabled(enabled: boolean): void {
    this.frameCaptureStore.setEnabled(enabled);
    this.pointSamples.setEnabled(enabled);
    this.pointDetector.reset();
  }

  /**
   * Records one step. `hands` (tracked XRHand joints) feeds headset point
   * detection; without it, or for non-`xr-hand` input, no hand samples are kept.
   * `objects` are the event objects, sampled at the same frame index;
   * `authoring` is what the tray and hands were doing (PRD-045). `held` is
   * the headset mark "this": while it holds, its ray (the dominant index's
   * filtered fingertip ray, or the dominant controller's) is a held aim
   * sample, unless the Halo is open meanwhile.
   */
  capture(
    timeSec: number,
    avatar: THREE.Object3D | undefined,
    avatarRoot: THREE.Object3D,
    activeCamera?: THREE.Camera,
    hands?: TrackedHandJointReader,
    objects: readonly SceneObject[] = [],
    authoring?: AuthoringFrame,
    held?: HeadsetMarkStep
  ): void {
    if (!this.frameCaptureStore.isEnabled() || !avatar) {
      return;
    }

    this.sceneBubbleSampler.captureSceneBubbleSample(activeCamera, avatarRoot);
    this.frameCaptureStore.captureFrame(timeSec, avatar, avatarRoot);
    this.objectSamples.capture(avatar, objects);
    // One authoring frame per recorded frame keeps the two stores aligned.
    this.authoringSamples.capture(authoring ?? IDLE_AUTHORING_FRAME);
    let pointing: HandPointSample | undefined;
    if (hands) {
      this.pointDetector.sample(timeSec, hands, (sample) => {
        this.pointSamples.recordHandSample(sample);
        if (held?.state === 'held' && held.input === 'hands' && sample.side === held.side) pointing = sample;
      });
    }
    if (held?.state === 'ended') this.pointSamples.endAim(timeSec);
    if (held?.state !== 'held' || held.paused) return;
    const ray = held.input === 'hands' ? pointing : held.ray;
    // A frame the aiming hand or ray is not tracked is a gap inside the hold.
    if (ray) this.pointSamples.recordAim({ timeSec, side: held.side, input: held.input, origin: ray.origin, direction: ray.direction });
  }

  /** What point resolution decided at the latest export, in take seconds. */
  getLastPointReport(): PointResolutionReport | undefined {
    return this.gltfExportComposer.lastPointReport;
  }

  /** What the latest export's set clip kept and dropped. */
  getLastTrimReport(): SceneTrimReport | undefined {
    return this.sceneBubbleSampler.lastTrimReport;
  }

  /** Off only for a test's untrimmed export of the same take. */
  setTrimHidden(trim: boolean): void {
    this.sceneBubbleSampler.trimHidden = trim;
  }

  getFrames(): RecordingFrame[] {
    return this.frameCaptureStore.getFrames();
  }

  clear(): void {
    this.frameCaptureStore.clear();
    this.sceneBubbleSampler.clear();
    this.pointSamples.clear();
    this.objectSamples.clear();
    this.authoringSamples.clear();
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
      this.pointSamples,
      this.objectSamples,
      this.authoringSamples
    );
  }
}
