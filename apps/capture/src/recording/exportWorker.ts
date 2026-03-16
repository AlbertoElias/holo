/**
 * Web Worker: flattens recorded frame data into typed arrays for GLTFExporter.
 * Runs off the main thread so export doesn't block locomotion.
 *
 * Bone transforms are already in local space (captured directly from bone.position / bone.quaternion),
 * so no world-to-local conversion is needed.
 */

import type { RecordingFrame } from '../types/contracts';

interface WorkerInput {
  frames: RecordingFrame[];
  boneNames: string[];
  morphDescriptors: MorphDescriptor[];
  normalizeRootMotion: boolean;
}

interface BoneKeyframes {
  name: string;
  posValues: number[];
  quatValues: number[];
}

interface MorphDescriptor {
  path: string;
  influenceCount: number;
}

interface MorphKeyframes {
  path: string;
  index: number;
  values: number[];
}

interface WorkerOutput {
  rootPosValues: number[];
  rootQuatValues: number[];
  boneKeyframes: BoneKeyframes[];
  morphKeyframes: MorphKeyframes[];
  times: number[];
}

function quatInvert(q: { x: number; y: number; z: number; w: number }) {
  const n = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
  return { x: -q.x / n, y: -q.y / n, z: -q.z / n, w: q.w / n };
}

function quatMul(a: { x: number; y: number; z: number; w: number }, b: { x: number; y: number; z: number; w: number }) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  };
}

function vecApplyQuat(v: { x: number; y: number; z: number }, q: { x: number; y: number; z: number; w: number }) {
  const qx = q.x; const qy = q.y; const qz = q.z; const qw = q.w;
  const ix = qw * v.x + qy * v.z - qz * v.y;
  const iy = qw * v.y + qz * v.x - qx * v.z;
  const iz = qw * v.z + qx * v.y - qy * v.x;
  const iw = -qx * v.x - qy * v.y - qz * v.z;
  return {
    x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
    y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
    z: iz * qw + iw * -qz + ix * -qy - iy * -qx
  };
}

self.onmessage = (e: MessageEvent<WorkerInput>) => {
  const { frames, boneNames, morphDescriptors, normalizeRootMotion } = e.data;
  const t0 = frames.length > 0 ? frames[0]!.timeSec : 0;
  const times = frames.map((f) => f.timeSec - t0);

  // Optional root-motion normalization:
  // - true: center avatar animation around origin (legacy standalone behavior)
  // - false: preserve world-space avatar transform (required when exporting scene geometry)
  const p0 = frames.length > 0
    ? frames[0]!.rootPosition
    : { x: 0, y: 0, z: 0 };

  // Normalize root rotation so the first frame faces forward (identity).
  // q_normalised = inverse(q0) * q
  const q0 = frames.length > 0
    ? frames[0]!.rootQuaternion
    : { x: 0, y: 0, z: 0, w: 1 };
  const q0Inv = quatInvert(q0);

  const rootPosValues: number[] = [];
  const rootQuatValues: number[] = [];
  for (const frame of frames) {
    if (normalizeRootMotion) {
      // Remove first-frame position offset so animation starts at origin
      const dx = frame.rootPosition.x - p0.x;
      const dy = frame.rootPosition.y - p0.y;
      const dz = frame.rootPosition.z - p0.z;
      // Rotate the delta by inverse of first-frame rotation so movement
      // direction is consistent with the normalised facing
      const rp = vecApplyQuat({ x: dx, y: dy, z: dz }, q0Inv);
      rootPosValues.push(rp.x, rp.y, rp.z);

      // Remove first-frame rotation so animation starts facing forward
      const rq = quatMul(q0Inv, frame.rootQuaternion);
      rootQuatValues.push(rq.x, rq.y, rq.z, rq.w);
      continue;
    }

    rootPosValues.push(frame.rootPosition.x, frame.rootPosition.y, frame.rootPosition.z);
    rootQuatValues.push(
      frame.rootQuaternion.x,
      frame.rootQuaternion.y,
      frame.rootQuaternion.z,
      frame.rootQuaternion.w
    );
  }

  const boneKeyframes: BoneKeyframes[] = [];

  for (const name of boneNames) {
    const posValues: number[] = [];
    const quatValues: number[] = [];

    for (const frame of frames) {
      const boneData = frame.bones.find((b) => b.name === name);
      if (!boneData) continue;

      posValues.push(boneData.position.x, boneData.position.y, boneData.position.z);
      quatValues.push(
        boneData.quaternion.x,
        boneData.quaternion.y,
        boneData.quaternion.z,
        boneData.quaternion.w
      );
    }

    if (posValues.length / 3 === times.length) {
      boneKeyframes.push({ name, posValues, quatValues });
    }
  }

  const frameMorphLookup = frames.map((frame) => {
    const pathToInfluences = new Map<string, number[]>();
    for (const morph of frame.morphs) {
      pathToInfluences.set(morph.path, morph.influences);
    }
    return pathToInfluences;
  });

  const morphKeyframes: MorphKeyframes[] = [];
  for (const descriptor of morphDescriptors) {
    const valueTracks: number[][] = Array.from(
      { length: descriptor.influenceCount },
      () => []
    );

    let hasEveryFrame = true;
    for (const morphMap of frameMorphLookup) {
      const influences = morphMap.get(descriptor.path);
      if (!influences) {
        hasEveryFrame = false;
        break;
      }
      for (let i = 0; i < descriptor.influenceCount; i += 1) {
        valueTracks[i]!.push(influences[i] ?? 0);
      }
    }

    if (!hasEveryFrame) continue;
    for (let i = 0; i < descriptor.influenceCount; i += 1) {
      morphKeyframes.push({
        path: descriptor.path,
        index: i,
        values: valueTracks[i]!
      });
    }
  }

  const output: WorkerOutput = {
    rootPosValues,
    rootQuatValues,
    boneKeyframes,
    morphKeyframes,
    times
  };
  self.postMessage(output);
};
