import * as THREE from 'three';

import { isThreeBone, isThreeMesh } from '../shared/threeTypeGuards';
import type { RecordingFrame } from '../types/contracts';

interface MorphCaptureBinding {
  mesh: THREE.Mesh;
  path: string;
  influenceCount: number;
}

export class FrameCaptureStore {
  private frames: RecordingFrame[] = [];
  private enabled = false;
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private morphCaptureAvatar: THREE.Object3D | null = null;
  private readonly morphCaptureBindings: MorphCaptureBinding[] = [];

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  captureFrame(timeSec: number, avatar: THREE.Object3D, avatarRoot: THREE.Object3D): void {
    this.refreshMorphCaptureBindings(avatar);

    avatarRoot.getWorldPosition(this.tmpPos);
    avatarRoot.getWorldQuaternion(this.tmpQuat);
    const rootPosition = { x: this.tmpPos.x, y: this.tmpPos.y, z: this.tmpPos.z };
    const rootQuaternion = { x: this.tmpQuat.x, y: this.tmpQuat.y, z: this.tmpQuat.z, w: this.tmpQuat.w };

    const bones: RecordingFrame['bones'] = [];
    avatar.traverse((obj) => {
      if (!isThreeBone(obj)) return;
      bones.push({
        name: obj.name,
        position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
        quaternion: { x: obj.quaternion.x, y: obj.quaternion.y, z: obj.quaternion.z, w: obj.quaternion.w }
      });
    });

    const morphs: RecordingFrame['morphs'] = [];
    for (const binding of this.morphCaptureBindings) {
      const influences = binding.mesh.morphTargetInfluences;
      if (!influences || influences.length === 0) continue;

      const values: number[] = [];
      const influenceCount = Math.min(influences.length, binding.influenceCount);
      for (let i = 0; i < influenceCount; i += 1) {
        const value = influences[i] ?? 0;
        values.push(Number.isFinite(value) ? value : 0);
      }
      morphs.push({ path: binding.path, influences: values });
    }

    this.frames.push({
      timeSec,
      rootPosition,
      rootQuaternion,
      bones,
      morphs
    });
  }

  getFrames(): RecordingFrame[] {
    return this.frames;
  }

  clear(): void {
    this.frames = [];
    this.morphCaptureAvatar = null;
    this.morphCaptureBindings.length = 0;
  }

  collectMorphDescriptors(): Array<{ path: string; influenceCount: number }> {
    const pathToCount = new Map<string, number>();
    for (const frame of this.frames) {
      for (const morph of frame.morphs) {
        const previous = pathToCount.get(morph.path) ?? 0;
        if (morph.influences.length > previous) {
          pathToCount.set(morph.path, morph.influences.length);
        }
      }
    }
    return [...pathToCount.entries()].map(([path, influenceCount]) => ({ path, influenceCount }));
  }

  buildObjectPath(node: THREE.Object3D, root: THREE.Object3D): string {
    const segments: number[] = [];
    let current: THREE.Object3D | null = node;

    while (current && current !== root) {
      const parent: THREE.Object3D | null = current.parent;
      if (!parent) break;
      const index = parent.children.indexOf(current);
      if (index < 0) break;
      segments.push(index);
      current = parent;
    }

    segments.reverse();
    return segments.join('/');
  }

  private refreshMorphCaptureBindings(avatar: THREE.Object3D): void {
    if (this.morphCaptureAvatar === avatar && this.morphCaptureBindings.length > 0) return;

    this.morphCaptureAvatar = avatar;
    this.morphCaptureBindings.length = 0;

    avatar.traverse((obj) => {
      if (!isThreeMesh(obj)) return;
      const influences = obj.morphTargetInfluences;
      if (!influences || influences.length === 0) return;

      this.morphCaptureBindings.push({
        mesh: obj,
        path: this.buildObjectPath(obj, avatar),
        influenceCount: influences.length
      });
    });
  }
}
