import * as THREE from 'three';

import { isThreeBone, isThreeMesh } from '../shared/threeTypeGuards';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

import { GLTFAudioPlugin } from './GLTFAudioPlugin';
import { GLTFHumanoidPlugin } from './GLTFHumanoidPlugin';
import { GLTFMeaningPlugin } from './GLTFMeaningPlugin';
import { GLTFObjectsPlugin } from './GLTFObjectsPlugin';
import { type AuthoringSampleStore, findAuthoringSpans, neutralizeAuthoringSpans, toAuthoringSpans } from './authoringSpans';
import { buildObjectExports, type ObjectExport } from './objectExport';
import type { ObjectSampleStore } from './ObjectSampleStore';
import { FrameCaptureStore } from './FrameCaptureStore';
import type { PointSampleStore } from './PointSampleStore';
import { type MeaningDraft, PointResolver, type PointResolutionReport } from './PointResolver';
import { SceneBubbleSampler } from './SceneBubbleSampler';
import { nextFrame } from '../shared/async';

interface MorphExportBinding {
  uuid: string;
  influenceCount: number;
  influenceNamesByIndex: string[];
}

export class GltfExportComposer {
  private readonly pointResolver = new PointResolver();
  /** What point resolution decided for the latest export; undefined before one or for a take without point samples. */
  lastPointReport: PointResolutionReport | undefined;

  async exportToGlbBlob(
    avatar: THREE.Object3D,
    frameStore: FrameCaptureStore,
    bubbleSampler: SceneBubbleSampler,
    sceneRoot?: THREE.Object3D,
    audioData?: { buffer: ArrayBuffer; mimeType: string },
    pointStore?: PointSampleStore,
    objectStore?: ObjectSampleStore,
    authoringStore?: AuthoringSampleStore
  ): Promise<Blob> {
    this.lastPointReport = undefined;
    await nextFrame();

    // Hands-in-menu motion (PRD-045): one rewritten copy of the frames feeds
    // both the export worker and point resolution, so marks match the arm.
    const recorded = frameStore.getFrames();
    const authoringFrames = authoringStore?.getFrames() ?? [];
    const frameSpans = authoringFrames.length === recorded.length ? findAuthoringSpans(authoringFrames) : [];
    const frames = frameSpans.length > 0 ? neutralizeAuthoringSpans(recorded, authoringFrames, frameSpans) : recorded;
    pointStore?.dropHandSamplesWithin(toAuthoringSpans(frameSpans, recorded));
    // The extension's spans are in take seconds, like presence and holds.
    const authoring = toAuthoringSpans(frameSpans, recorded, true);
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

    // Bones by traversal order, which the frame store shares; names may repeat.
    const boneUuids: string[] = [];
    const boneNames: string[] = [];
    clone.traverse((obj) => {
      if (!isThreeBone(obj)) return;
      boneUuids.push(obj.uuid);
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
      boneKeyframes: Array<{ index: number; name: string; posValues: number[]; quatValues: number[] }>;
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
      const uuid = boneUuids[bk.index];
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

    // Event objects: wrapper nodes whose tracks share the take's one clip, so
    // every player (and USDZ, which converts the first clip) keeps them in sync.
    let objects: ObjectExport | undefined;
    if (objectStore?.hasSamples()) {
      objects = buildObjectExports(objectStore.getTracks(), { times, rootPosValues, rootQuatValues, avatarScale: clone.scale });
      tracks.push(...objects.tracks);
    }

    const clip = new THREE.AnimationClip('RecordedMotion', -1, tracks);
    const scene = new THREE.Scene();
    scene.add(clone);
    scene.add(bubbleSphere);
    const sceneBubble = sceneRoot ? bubbleSampler.collectSceneBubbleGroup(sceneRoot) : undefined;
    if (sceneBubble) {
      scene.add(sceneBubble.group);
    }
    for (const node of objects?.nodes ?? []) scene.add(node);
    this.addRecordedSceneLights(scene);

    // Resolution runs here, on the main thread, before parse: it needs the
    // clipped meshes and the avatar, and the plugin maps its objects to the
    // writer's node indices. Root motion is normalized without a world
    // model, so scene anchors are skipped and only body anchors remain.
    let meaning: MeaningDraft | undefined;
    if (pointStore?.hasSamples()) {
      scene.updateMatrixWorld(true);
      const { draft, report } = this.pointResolver.resolve({
        frames,
        store: pointStore,
        avatar,
        exportAvatar: clone,
        sceneMeshes: normalizeRootMotion || !sceneBubble ? [] : [...sceneBubble.clippedBySource.values()]
      });
      this.lastPointReport = report;
      if (draft.marks.length > 0 || draft.spans.length > 0) meaning = draft;
    }

    return new Promise<Blob>((resolve, reject) => {
      const exporter = new GLTFExporter();
      if (audioData && audioData.buffer.byteLength > 0) {
        exporter.register((writer) => new GLTFAudioPlugin(writer, audioData.buffer, audioData.mimeType));
      }
      exporter.register((writer) => new GLTFHumanoidPlugin(writer));
      if (meaning) {
        const draft = meaning;
        exporter.register((writer) => new GLTFMeaningPlugin(writer, draft));
      }
      if ((objects && objects.drafts.length > 0) || authoring.length > 0) {
        const drafts = objects?.drafts ?? [];
        exporter.register((writer) => new GLTFObjectsPlugin(writer, drafts, authoring));
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
