import * as THREE from 'three';

import { isThreeBone, isThreeMesh } from '../shared/threeTypeGuards';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

import { GLTFAudioPlugin } from './GLTFAudioPlugin';
import { FrameCaptureStore } from './FrameCaptureStore';
import { SceneBubbleSampler } from './SceneBubbleSampler';
import { nextFrame } from '../shared/async';

interface MorphExportBinding {
  uuid: string;
  influenceCount: number;
  influenceNamesByIndex: string[];
}

export class GltfExportComposer {
  async exportToGlbBlob(
    avatar: THREE.Object3D,
    frameStore: FrameCaptureStore,
    bubbleSampler: SceneBubbleSampler,
    sceneRoot?: THREE.Object3D,
    audioData?: { buffer: ArrayBuffer; mimeType: string }
  ): Promise<Blob> {
    await nextFrame();

    const frames = frameStore.getFrames();
    const normalizeRootMotion = !sceneRoot;

    const clone = SkeletonUtils.clone(avatar);
    clone.name = 'RecordedAvatar';
    clone.traverse((obj) => {
      if (isThreeMesh(obj)) {
        obj.visible = true;
      }
    });

    if (!normalizeRootMotion && frames.length > 0) {
      const first = frames[0]!;
      clone.position.set(first.rootPosition.x, first.rootPosition.y, first.rootPosition.z);
      clone.quaternion.set(
        first.rootQuaternion.x,
        first.rootQuaternion.y,
        first.rootQuaternion.z,
        first.rootQuaternion.w
      );
    } else {
      clone.position.set(0, 0, 0);
      clone.quaternion.set(0, 0, 0, 1);
    }
    clone.updateMatrixWorld(true);

    const boneNameToUuid = new Map<string, string>();
    const boneNames: string[] = [];
    clone.traverse((obj) => {
      if (!isThreeBone(obj)) return;
      boneNameToUuid.set(obj.name, obj.uuid);
      boneNames.push(obj.name);
    });

    const morphPathToBinding = new Map<string, MorphExportBinding>();
    clone.traverse((obj) => {
      if (!isThreeMesh(obj)) return;
      const influences = obj.morphTargetInfluences;
      if (!influences || influences.length === 0) return;
      const influenceNamesByIndex = new Array<string>(influences.length);
      const dictionary = obj.morphTargetDictionary;
      if (dictionary) {
        for (const [name, index] of Object.entries(dictionary)) {
          if (index >= 0 && index < influenceNamesByIndex.length) {
            influenceNamesByIndex[index] = name;
          }
        }
      }
      morphPathToBinding.set(frameStore.buildObjectPath(obj, clone), {
        uuid: obj.uuid,
        influenceCount: influences.length,
        influenceNamesByIndex
      });
    });

    const worker = new Worker(
      new URL('./exportWorker.ts', import.meta.url),
      { type: 'module' }
    );

    const workerResult = await new Promise<{
      rootPosValues: number[];
      rootQuatValues: number[];
      boneKeyframes: Array<{ name: string; posValues: number[]; quatValues: number[] }>;
      morphKeyframes: Array<{ path: string; index: number; values: number[] }>;
      times: number[];
    }>((resolve, reject) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.onerror = () => reject(new Error('Export worker failed'));
      worker.postMessage({
        frames,
        boneNames,
        morphDescriptors: frameStore.collectMorphDescriptors(),
        normalizeRootMotion
      });
    });
    worker.terminate();

    const { rootPosValues, rootQuatValues, boneKeyframes, morphKeyframes, times } = workerResult;

    const tracks: THREE.KeyframeTrack[] = [];
    tracks.push(
      new THREE.VectorKeyframeTrack(`${clone.uuid}.position`, times, rootPosValues)
    );
    tracks.push(
      new THREE.QuaternionKeyframeTrack(`${clone.uuid}.quaternion`, times, rootQuatValues)
    );

    for (const bk of boneKeyframes) {
      const uuid = boneNameToUuid.get(bk.name);
      if (!uuid) continue;
      tracks.push(new THREE.VectorKeyframeTrack(`${uuid}.position`, times, bk.posValues));
      tracks.push(new THREE.QuaternionKeyframeTrack(`${uuid}.quaternion`, times, bk.quatValues));
    }

    for (const mk of morphKeyframes) {
      const binding = morphPathToBinding.get(mk.path);
      if (!binding || mk.index >= binding.influenceCount) continue;
      const morphTargetName = binding.influenceNamesByIndex[mk.index];
      if (!morphTargetName) continue;
      tracks.push(new THREE.NumberKeyframeTrack(`${binding.uuid}.morphTargetInfluences[${morphTargetName}]`, times, mk.values));
    }

    if (tracks.length <= 2) {
      throw new Error('No animation data to export');
    }

    const bubbleSphere = bubbleSampler.createBubbleSphere();
    if (frames.length > 0) {
      const first = frames[0]!;
      bubbleSphere.position.set(first.rootPosition.x, first.rootPosition.y, first.rootPosition.z);
    }
    tracks.push(
      new THREE.VectorKeyframeTrack(`${bubbleSphere.uuid}.position`, times, rootPosValues)
    );

    const clip = new THREE.AnimationClip('RecordedMotion', -1, tracks);
    const scene = new THREE.Scene();
    scene.add(clone);
    scene.add(bubbleSphere);
    if (sceneRoot) {
      const sceneBubble = bubbleSampler.collectSceneBubbleGroup(sceneRoot);
      if (sceneBubble) {
        scene.add(sceneBubble);
      }
    }
    this.addRecordedSceneLights(scene);

    return new Promise<Blob>((resolve, reject) => {
      const exporter = new GLTFExporter();
      if (audioData && audioData.buffer.byteLength > 0) {
        exporter.register((writer) => new GLTFAudioPlugin(writer, audioData.buffer, audioData.mimeType));
      }
      exporter.parse(
        scene,
        (result) => {
          if (result instanceof ArrayBuffer) {
            resolve(new Blob([result], { type: 'model/gltf-binary' }));
          } else {
            resolve(new Blob([JSON.stringify(result)], { type: 'application/json' }));
          }
        },
        reject,
        { animations: [clip], binary: true, trs: true }
      );
    });
  }

  private addRecordedSceneLights(scene: THREE.Scene): void {
    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
    hemi.name = 'RecordedHemisphereLight';
    scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
    keyLight.name = 'RecordedDirectionalLight';
    keyLight.position.set(2, 4, 2);
    keyLight.target.position.set(0, 0, 0);
    scene.add(keyLight);
    scene.add(keyLight.target);
    keyLight.updateMatrixWorld(true);
  }
}
