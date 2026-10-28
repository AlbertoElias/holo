import * as THREE from 'three';

import { HOLOIM_CREDIT_EXTRAS_KEY, type ObjectCredit, type ObjectHold, type ObjectSpan, RECORDED_OBJECT_NODE_NAME, type RecordedObjectEntry } from '@holoim/objects';

import type { ObjectTrackSamples } from './ObjectSampleStore';

/** One exported object before node indices exist; `GLTFObjectsPlugin` maps `node`. */
export interface ObjectExportDraft extends Omit<RecordedObjectEntry, 'node'> {
  node: THREE.Object3D;
  /** Not part of `HOLOIM_objects`: written to the node's extras and `asset.copyright`. */
  credit?: ObjectCredit | undefined;
}

export interface ObjectExport {
  nodes: THREE.Object3D[];
  tracks: THREE.KeyframeTrack[];
  drafts: ObjectExportDraft[];
}

interface ExportFrameSpace {
  times: number[];
  /** The exported avatar's root tracks (flat xyz / xyzw), as written to the clip. */
  rootPosValues: number[];
  rootQuatValues: number[];
  /** The exported avatar clone's own scale (the model's height-fit scale). */
  avatarScale: THREE.Vector3;
}

// The child that carries a resized object's size, between the wrapper and the model.
export const RECORDED_OBJECT_SIZE_NODE_NAME = 'RecordedObjectSize';
// Sizes this close to 1 are written as no resize.
const SIZE_EPSILON = 1e-4;

/** Consecutive frames where `active(i)` holds, as spans of take seconds. */
function runs(times: number[], length: number, active: (index: number) => boolean): Array<{ first: number; last: number }> {
  const out: Array<{ first: number; last: number }> = [];
  for (let i = 0; i < length; i += 1) {
    if (!active(i)) continue;
    const previous = out.at(-1);
    if (previous && previous.last === i - 1) previous.last = i;
    else out.push({ first: i, last: i });
  }
  return out;
}

/**
 * Each event object becomes a unit-scale `RecordedObject` wrapper node (a
 * clone; the live object stays in capture's scene) with position and
 * rotation tracks in the take's clip. Frame `i` is
 * `exportAvatar(i) · relative(i)`, so the object keeps its pose relative to
 * the avatar's bones. Outside its presence spans (PRD-045) the wrapper gets a
 * STEP scale of 0 and holds the nearest present pose; an object present for
 * the whole take gets no scale track. The rest pose (what a still, or a
 * player that ignores the clip, shows) is the first present pose; for a
 * summoned object it is the last, where it was placed. An object resized
 * during the take gets a `RecordedObjectSize` child between the wrapper and
 * the model with a linear scale track, so the wrapper's visibility steps stay
 * as they are; an object never resized has no such child.
 */
export function buildObjectExports(samples: ObjectTrackSamples[], space: ExportFrameSpace): ObjectExport {
  const { times } = space;
  const out: ObjectExport = { nodes: [], tracks: [], drafts: [] };
  const exportAvatar = new THREE.Matrix4();
  const world = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const rootPosition = new THREE.Vector3();
  const rootQuaternion = new THREE.Quaternion();

  for (const track of samples) {
    const count = times.length;
    const present = runs(times, count, (i) => track.relative[i] != null);
    if (present.length === 0) continue;

    const posValues = new Array<number>(count * 3);
    const quatValues = new Array<number>(count * 4);
    for (let i = 0; i < count; i += 1) {
      const relative = track.relative[i];
      if (!relative) continue;
      rootPosition.fromArray(space.rootPosValues, i * 3);
      rootQuaternion.fromArray(space.rootQuatValues, i * 4);
      exportAvatar.compose(rootPosition, rootQuaternion, space.avatarScale);
      world.multiplyMatrices(exportAvatar, relative).decompose(position, quaternion, scale);
      position.toArray(posValues, i * 3);
      quaternion.normalize().toArray(quatValues, i * 4);
    }
    // Outside presence, hold the nearest present pose so nothing interpolates in from the origin.
    for (let i = 0; i < count; i += 1) {
      if (track.relative[i]) continue;
      const nearest = present.reduce((best, run) => {
        const candidate = i < run.first ? run.first : run.last;
        return Math.abs(candidate - i) < Math.abs(best - i) ? candidate : best;
      }, present[0]!.first);
      for (let k = 0; k < 3; k += 1) posValues[i * 3 + k] = posValues[nearest * 3 + k]!;
      for (let k = 0; k < 4; k += 1) quatValues[i * 4 + k] = quatValues[nearest * 4 + k]!;
      track.size[i] = track.size[nearest] ?? 1;
    }

    const node = new THREE.Group();
    node.name = RECORDED_OBJECT_NODE_NAME;
    if (track.object.credit) node.userData[HOLOIM_CREDIT_EXTRAS_KEY] = track.object.credit;
    const model = track.object.model.clone(true);
    const rest = track.object.origin === 'summoned' ? present.at(-1)!.last : present[0]!.first;
    const resized = track.size.some((value, i) => track.relative[i] != null && Math.abs(value - 1) > SIZE_EPSILON);
    let size: THREE.Group | null = null;
    if (resized) {
      size = new THREE.Group();
      size.name = RECORDED_OBJECT_SIZE_NODE_NAME;
      size.add(model);
      node.add(size);
      // Outside presence the size holds its nearest present value, like the pose.
      size.scale.setScalar(track.size[rest] ?? 1);
    } else {
      node.add(model);
    }
    node.position.fromArray(posValues, rest * 3);
    node.quaternion.fromArray(quatValues, rest * 4);
    node.updateMatrixWorld(true);

    out.tracks.push(new THREE.VectorKeyframeTrack(`${node.uuid}.position`, times, posValues));
    out.tracks.push(new THREE.QuaternionKeyframeTrack(`${node.uuid}.quaternion`, times, quatValues));
    if (size) out.tracks.push(new THREE.VectorKeyframeTrack(`${size.uuid}.scale`, times, track.size.slice(0, count).flatMap((value) => [value, value, value])));
    const wholeTake = present.length === 1 && present[0]!.first === 0 && present[0]!.last === count - 1;
    if (!wholeTake) {
      const scaleValues: number[] = [];
      for (let i = 0; i < count; i += 1) {
        const s = track.relative[i] ? 1 : 0;
        scaleValues.push(s, s, s);
      }
      out.tracks.push(new THREE.VectorKeyframeTrack(`${node.uuid}.scale`, times, scaleValues, THREE.InterpolateDiscrete));
    }

    const presence: ObjectSpan[] = present.map((run) => ({ start: times[run.first]!, end: times[run.last]! }));
    const holds: ObjectHold[] = [];
    for (const hand of ['left', 'right'] as const) {
      for (const run of runs(times, count, (i) => track.heldBy[i] === hand)) holds.push({ hand, start: times[run.first]!, end: times[run.last]! });
    }
    holds.sort((a, b) => a.start - b.start);

    out.nodes.push(node);
    out.drafts.push({
      node,
      credit: track.object.credit,
      name: track.object.name,
      origin: track.object.origin,
      source: track.object.source,
      presence,
      holds
    });
  }
  return out;
}
