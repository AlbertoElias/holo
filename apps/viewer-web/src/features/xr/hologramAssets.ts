import { AnimationMixer, Box3, Vector3 } from "three";
import type { AnimationClip, BufferGeometry, Material, Object3D, Skeleton, Texture } from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

import { drawnBounds } from "../hologram/drawnPoints";
import { decodeGltfAudio, type DecodedGltfAudio } from "../hologram/gltfAudio";
import { isCameraTake, normalizeSceneAtOrigin, rankClipsForPlayback } from "../hologram/hologramScene";
import { prepareAnimatedScene } from "../hologram/object3dUtils";
import { freezeBubbleWrapperMotion } from "../ar/arAnimation";

// Loaded holograms, shared by the gallery's previews and the placed holograms
// (step 4). One GLTF per URL is loaded once and cloned per use; clones share
// its geometry, materials and textures. A clone owns only its skeletons
// (their bone textures) and its mixer, so that is all disposing a clone
// frees. The GLTF itself, and its GPU resources, go only when the last user
// releases its URL.

export interface LoadedHologram {
  gltf: GLTF;
  clips: AnimationClip[];
  audio: DecodedGltfAudio | null;
}

interface CacheEntry {
  promise: Promise<LoadedHologram>;
  users: number;
  loaded: LoadedHologram | null;
}

export class HologramAssetCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

  /** Takes a use of `url`, loading it the first time. Rejects (holding no use) if it fails to load. */
  acquire(url: string): Promise<LoadedHologram> {
    let entry = this.entries.get(url);
    if (!entry) {
      const created: CacheEntry = { users: 0, loaded: null, promise: this.load(url) };
      created.promise.then(
        (loaded) => (created.loaded = loaded),
        () => {
          // A failed load leaves nothing cached: a later try loads again.
          if (this.entries.get(url) === created) this.entries.delete(url);
        }
      );
      this.entries.set(url, created);
      entry = created;
    }
    entry.users += 1;
    const held = entry;
    return held.promise.catch((error: unknown) => {
      held.users -= 1;
      throw error;
    });
  }

  /** Gives back a use; the last one frees the GLTF's geometry, materials and textures. */
  release(url: string): void {
    const entry = this.entries.get(url);
    if (!entry) return;
    entry.users -= 1;
    if (entry.users > 0) return;
    this.entries.delete(url);
    // Still loading: free it once it lands, unless someone takes it again first.
    void entry.promise.then((loaded) => disposeScene(loaded.gltf.scene), () => undefined);
  }

  /** URLs held and their users, for the probe. */
  keys(): Record<string, number> {
    return Object.fromEntries([...this.entries].map(([url, entry]) => [url, entry.users]));
  }

  dispose(): void {
    for (const url of [...this.entries.keys()]) {
      const entry = this.entries.get(url)!;
      entry.users = 1;
      this.release(url);
    }
  }

  private async load(url: string): Promise<LoadedHologram> {
    const gltf = await this.loader.loadAsync(url);
    const audio = await decodeGltfAudio(gltf).catch((error: unknown) => {
      console.warn("[xr-viewer] Failed to decode KHR_audio data:", error);
      return null;
    });
    return { gltf, clips: freezeBubbleWrapperMotion(gltf.animations), audio };
  }
}

/** A clone of a loaded hologram at recorded scale, standing on its feet at the origin. */
export function cloneHologram(loaded: LoadedHologram): Object3D {
  // Recorded scale, never normalised: true scale is fact.
  const root = cloneSkeleton(loaded.gltf.scene);
  prepareAnimatedScene(root);
  normalizeSceneAtOrigin(root, loaded.gltf);
  standOnFeet(root);
  return root;
}

/**
 * A small paused preview for the gallery shelf: a clone posed a third of the
 * way into its clip, scaled to `heightM`, standing on its feet. Its mixer is
 * used once for the pose and dropped. A camera take has no person and no feet:
 * its set stands on its origin, and the set's largest extent (floor to top
 * included) is scaled to `heightM`, the bubble's sphere left out.
 */
export function clonePreview(loaded: LoadedHologram, heightM: number): Object3D {
  const root = cloneSkeleton(loaded.gltf.scene);
  prepareAnimatedScene(root);
  const [clip] = rankClipsForPlayback(loaded.clips);
  if (clip && clip.duration > 0) {
    const mixer = new AnimationMixer(root);
    const action = mixer.clipAction(clip);
    action.play();
    action.time = clip.duration / 3;
    mixer.update(0);
    mixer.stopAllAction();
    mixer.uncacheRoot(root);
  }
  normalizeSceneAtOrigin(root, loaded.gltf);
  const cameraTake = isCameraTake(root);
  // A tile fits the whole recording, terrain included, so it stands on its lowest point.
  if (!cameraTake) standOnLowestPoint(root);
  let extent: number;
  if (cameraTake) {
    const set = drawnBounds(root);
    set.expandByPoint(new Vector3(0, 0, 0));
    extent = Math.max(...set.getSize(new Vector3()).toArray());
  } else {
    extent = new Box3().setFromObject(root, true).getSize(new Vector3()).y;
  }
  const scale = extent > 1e-3 ? heightM / extent : 1;
  root.scale.multiplyScalar(scale);
  root.position.multiplyScalar(scale);
  root.name = "GalleryPreview";
  // The tile's panel takes the pointer.
  (root as Object3D & { pointerEvents?: string }).pointerEvents = "none";
  return root;
}

/** Frees what a clone owns: its skeletons' bone textures. Geometry, materials and textures stay with the cached GLTF. */
export function disposeClone(root: Object3D): void {
  root.removeFromParent();
  const skeletons = new Set<Skeleton>();
  root.traverse((object) => {
    const mesh = object as Object3D & { isSkinnedMesh?: boolean; skeleton?: Skeleton };
    if (mesh.isSkinnedMesh && mesh.skeleton) skeletons.add(mesh.skeleton);
  });
  for (const skeleton of skeletons) skeleton.dispose();
}

/** The GLTF's own GPU resources, once nothing uses it. */
function disposeScene(scene: Object3D): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  scene.traverse((object) => {
    const mesh = object as Object3D & { geometry?: BufferGeometry; material?: Material | Material[]; skeleton?: Skeleton };
    if (mesh.geometry) geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) materials.add(material);
    mesh.skeleton?.dispose();
  });
  for (const material of materials) {
    for (const value of Object.values(material)) {
      if ((value as Texture | null)?.isTexture) textures.add(value as Texture);
    }
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
  for (const geometry of geometries) geometry.dispose();
}

/**
 * normalizeSceneAtOrigin stands a file without a recorded avatar on its
 * bounds, but a skinned mesh's bounds follow bone matrices a fresh clone has
 * not computed, so a person can float about a hip height off the floor.
 * Re-stand it on its posed vertices. A capture's avatar origin is already
 * its recorded floor (B-022): the ground around it may reach below and
 * stays there, unclipped. A camera take's floor is its set's origin, which
 * normalizeSceneAtOrigin leaves in place.
 */
function standOnFeet(root: Object3D): void {
  if (root.getObjectByName("RecordedAvatar") || isCameraTake(root)) return;
  standOnLowestPoint(root);
}

function standOnLowestPoint(root: Object3D): void {
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    const mesh = object as Object3D & { isSkinnedMesh?: boolean; skeleton?: { update(): void } };
    if (mesh.isSkinnedMesh) mesh.skeleton?.update();
  });
  const bounds = new Box3().setFromObject(root, true);
  if (!bounds.isEmpty() && Number.isFinite(bounds.min.y)) root.position.y -= bounds.min.y;
}
