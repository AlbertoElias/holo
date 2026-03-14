import * as THREE from 'three';
import type { RecordingFrame } from '../types/contracts';

import { FrameCaptureStore } from './FrameCaptureStore';
import { GltfExportComposer } from './GltfExportComposer';
import { SceneBubbleSampler } from './SceneBubbleSampler';

export class AvatarRecorder {
  private readonly frameCaptureStore = new FrameCaptureStore();
  private readonly sceneBubbleSampler = new SceneBubbleSampler();
  private readonly gltfExportComposer = new GltfExportComposer();

  setEnabled(enabled: boolean): void {
    this.frameCaptureStore.setEnabled(enabled);
  }

  capture(
    timeSec: number,
    avatar: THREE.Object3D | undefined,
    avatarRoot: THREE.Object3D,
    activeCamera?: THREE.Camera
  ): void {
    if (!this.frameCaptureStore.isEnabled() || !avatar) {
      return;
    }

    this.sceneBubbleSampler.captureSceneBubbleSample(activeCamera, avatarRoot);
    this.frameCaptureStore.captureFrame(timeSec, avatar, avatarRoot);
  }

  getFrames(): RecordingFrame[] {
    return this.frameCaptureStore.getFrames();
  }

  clear(): void {
    this.frameCaptureStore.clear();
    this.sceneBubbleSampler.clear();
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
      audioData
    );
  }
}
