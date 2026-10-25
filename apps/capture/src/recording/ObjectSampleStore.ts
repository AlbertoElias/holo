import * as THREE from 'three';

import type { SceneObject } from '../objects/SceneObjectRegistry';
import type { VrHandSide } from '../types/contracts';

/** One event object's samples, indexed by avatar frame; `null` while it is not in the event. */
export interface ObjectTrackSamples {
  object: SceneObject;
  /** Object pose relative to the avatar model (`avatar.matrixWorld⁻¹ · object.matrixWorld`). */
  relative: Array<THREE.Matrix4 | null>;
  heldBy: Array<VrHandSide | null>;
}

/**
 * Event objects sampled each step, at the same frame index as the avatar
 * frames. Poses are stored relative to the avatar model, because the export
 * frame is not world space: the exporter clones the model and puts the
 * recorded root on it, dropping the model's own offset under the avatar root.
 * Recomposing against the exported avatar keeps the object exactly where it
 * was relative to the hand.
 */
export class ObjectSampleStore {
  private readonly tracks = new Map<SceneObject, ObjectTrackSamples>();
  private frameCount = 0;
  private readonly avatarInverse = new THREE.Matrix4();

  /** Call once per captured avatar frame, after it is stored. */
  capture(avatar: THREE.Object3D, objects: readonly SceneObject[]): void {
    const frameIndex = this.frameCount;
    this.frameCount += 1;
    if (objects.length === 0) return;
    avatar.updateWorldMatrix(true, false);
    this.avatarInverse.copy(avatar.matrixWorld).invert();
    for (const object of objects) {
      if (!object.placed) continue;
      let track = this.tracks.get(object);
      if (!track) {
        track = { object, relative: [], heldBy: [] };
        this.tracks.set(object, track);
      }
      // An object that entered mid-take (PRD-045) has no samples before it.
      while (track.relative.length < frameIndex) {
        track.relative.push(null);
        track.heldBy.push(null);
      }
      object.wrapper.updateWorldMatrix(true, false);
      track.relative.push(new THREE.Matrix4().multiplyMatrices(this.avatarInverse, object.wrapper.matrixWorld));
      track.heldBy.push(object.heldBy);
    }
  }

  /** Tracks padded to `frameCount` frames (an object removed mid-take has nulls after). */
  getTracks(): ObjectTrackSamples[] {
    return [...this.tracks.values()].map((track) => {
      while (track.relative.length < this.frameCount) {
        track.relative.push(null);
        track.heldBy.push(null);
      }
      return track;
    });
  }

  hasSamples(): boolean {
    return this.tracks.size > 0;
  }

  clear(): void {
    this.tracks.clear();
    this.frameCount = 0;
  }
}
