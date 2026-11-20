import * as THREE from 'three';
import type { GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import type { ArmClearance } from '../animation/ArmClearance';
import type { FaceDriver } from '../face/FaceDriver';
import type { RecordingSession } from '../recording/RecordingSession';
import type { UIStateStore } from '../ui/UIStateStore';
import type { AvatarRig } from './AvatarRig';
import { HumanoidSkeleton } from './HumanoidSkeleton';
import { avatarMeshRoots, currentHouseLook, dressHouseBase, saveHouseLook, sameHouseLook, prepareHouseTransplant, type HouseLook } from './houseLook';

interface HouseLookDeps {
  loader: GLTFLoader;
  avatar: AvatarRig;
  face: FaceDriver;
  armClearance: ArmClearance;
  recording: RecordingSession;
  ui: UIStateStore;
}

/**
 * Changes the house base's look on the live avatar (docs/features/your-look.md).
 * One change runs at a time; a newer pick makes an older one stop at its next
 * step, so the latest pick always lands last. A change is refused while a
 * take is busy, and a take waits for `settled()` before it starts.
 */
export class HouseLookController {
  private current: HouseLook | null = null;
  private latest = 0;
  private queue: Promise<void> = Promise.resolve();
  // Each live bone's rest pose in the avatar's space, taken at load, before any motion: the fit check compares a new build against it.
  private liveRest = new Map<string, THREE.Matrix4>();
  private lastChangeMs: number | null = null;
  private fitErrorMm: number | null = null;

  constructor(private readonly deps: HouseLookDeps) {}

  /** After the avatar loads: the look step exists only for the house base. */
  attach(): void {
    this.current = currentHouseLook(this.deps.avatar.avatar);
    const live = this.deps.avatar.avatar;
    if (this.current && live) this.liveRest = restPoses(live);
    this.deps.ui.setHouseLook(this.current ? { ...this.current, status: 'ready', message: null } : null);
  }

  get look(): HouseLook | null {
    return this.current;
  }

  /** Settles when no change is in flight. */
  settled(): Promise<void> {
    return this.queue;
  }

  /** False when the avatar is not the house base or a take is busy. */
  setLook(next: HouseLook): boolean {
    if (!this.current || this.deps.recording.isTakeBusy()) return false;
    const id = ++this.latest;
    this.deps.ui.setHouseLook({ ...next, status: 'dressing', message: null });
    this.queue = this.queue.then(() => this.apply(id, next));
    return true;
  }

  private async apply(id: number, next: HouseLook): Promise<void> {
    const stale = () => id !== this.latest;
    if (stale()) return;
    const current = this.current;
    if (current && sameHouseLook(current, next)) {
      this.deps.ui.setHouseLook({ ...next, status: 'ready', message: null });
      return;
    }
    const startedAt = performance.now();
    try {
      const bytes = await dressHouseBase(next);
      if (stale()) return;
      const gltf = await this.deps.loader.parseAsync(bytes, '');
      if (stale()) return;
      this.wear(gltf, next);
      this.lastChangeMs = performance.now() - startedAt;
      saveHouseLook(next);
      console.info(`[look] ${next.look.build} ${next.finish} on the avatar in ${Math.round(performance.now() - startedAt)} ms`);
      if (!stale()) this.deps.ui.setHouseLook({ ...next, status: 'ready', message: null });
    } catch (error) {
      console.error('[look] the look did not change', error);
      if (!stale()) {
        const keep = this.current ?? next;
        this.deps.ui.setHouseLook({ ...keep, status: 'error', message: 'That look did not load. Try again.' });
      }
    }
  }

  /** For the e2e (docs/features/your-look.md): what the live avatar wears, and how well the last change fits the live bones. */
  sample(): { look: HouseLook | null; meshes: string[]; skeletons: number; jawOpen: number[]; lastChangeMs: number | null; fitErrorMm: number | null } {
    const live = this.deps.avatar.avatar;
    const skeletons = new Set<THREE.Skeleton>();
    // The jaw as the meshes in the live tree show it: a face rig still bound to removed meshes leaves these at 0.
    const jawOpen: number[] = [];
    live?.traverse((object) => {
      const mesh = object as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh) skeletons.add(mesh.skeleton);
      const index = (object as THREE.Mesh).morphTargetDictionary?.jawOpen;
      if (index !== undefined) jawOpen.push((object as THREE.Mesh).morphTargetInfluences?.[index] ?? 0);
    });
    return {
      look: this.current,
      meshes: live ? avatarMeshRoots(live).map((root) => root.name) : [],
      skeletons: skeletons.size,
      jawOpen,
      lastChangeMs: this.lastChangeMs,
      fitErrorMm: this.fitErrorMm
    };
  }

  private wear(gltf: GLTF, next: HouseLook): void {
    const { avatar, face, armClearance, recording } = this.deps;
    const live = avatar.avatar;
    const humanoid = avatar.humanoid;
    if (!live || !humanoid) throw new Error('No avatar to dress');
    const fresh: THREE.Object3D = gltf.scene;
    // Throws on a missing bone before anything on the live avatar changes.
    const commit = prepareHouseTransplant(live, fresh);
    // The new body is measured in its own rest pose: the live one is posed by the face and the idle motion.
    const restHumanoid = HumanoidSkeleton.bind(fresh, { json: gltf.parser.json, associations: gltf.parser.associations });
    restHumanoid.normalizeFacing(fresh);
    fresh.updateMatrixWorld(true);
    armClearance.measureFrom(fresh, restHumanoid, humanoid);
    const freshRest = restPoses(fresh);
    commit();
    // The new meshes are on the avatar from here, so the look is the new one even if a refresh below throws.
    this.current = next;
    this.fitErrorMm = liveFitErrorMm(live, freshRest, this.liveRest);
    avatar.refreshMeshes();
    face.rebindMeshes(live);
    recording.forgetLastTake();
  }
}

function restPoses(root: THREE.Object3D): Map<string, THREE.Matrix4> {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const out = new Map<string, THREE.Matrix4>();
  root.traverse((object) => {
    if ((object as THREE.Bone).isBone) out.set(object.name, toRoot.clone().multiply(object.matrixWorld));
  });
  return out;
}

/**
 * How far the meshes now on the live avatar land from their own rest shape
 * when the live bones, at the first build's rest pose, drive them: the largest
 * offset, in millimetres, over every vertex of every skinned mesh. It reads
 * each mesh's actual skeleton, inverse binds and bind matrix after the
 * transplant, so a wrong bone or bind shows here. A bone with no rest pose is
 * a failure (Infinity). Both rest poses are in the avatar's own space, so the
 * live fit scale does not count.
 */
function liveFitErrorMm(live: THREE.Object3D, freshRest: Map<string, THREE.Matrix4>, liveRest: Map<string, THREE.Matrix4>): number | null {
  if (liveRest.size === 0) return null;
  const own = new THREE.Vector3();
  const moved = new THREE.Vector3();
  const vertex = new THREE.Vector3();
  const part = new THREE.Vector3();
  const skin = new THREE.Matrix4();
  let worst = 0;
  live.traverse((object) => {
    const mesh = object as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || worst === Infinity) return;
    const position = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getAttribute('skinIndex');
    const weight = mesh.geometry.getAttribute('skinWeight');
    const bones = mesh.skeleton.bones;
    const moving = bones.map((bone) => liveRest.get(bone.name));
    const rest = bones.map((bone) => freshRest.get(bone.name));
    if (moving.some((m) => !m) || rest.some((m) => !m)) {
      worst = Infinity;
      return;
    }
    for (let v = 0; v < position.count; v++) {
      vertex.fromBufferAttribute(position, v).applyMatrix4(mesh.bindMatrix);
      own.set(0, 0, 0);
      moved.set(0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const w = weight.getComponent(v, k);
        if (w === 0) continue;
        const j = index.getComponent(v, k);
        const inverse = mesh.skeleton.boneInverses[j]!;
        own.addScaledVector(part.copy(vertex).applyMatrix4(skin.multiplyMatrices(rest[j]!, inverse)), w);
        moved.addScaledVector(part.copy(vertex).applyMatrix4(skin.multiplyMatrices(moving[j]!, inverse)), w);
      }
      // own and moved are in the skeleton's space; the mesh's own transform does not change their distance.
      worst = Math.max(worst, own.distanceTo(moved));
    }
  });
  return worst * 1000;
}
