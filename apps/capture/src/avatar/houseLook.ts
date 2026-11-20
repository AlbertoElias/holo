// The house base's look on a phone (docs/features/your-look.md): which look
// a page wants, the house base dressed in it by the same code as the AI flow
// (`@holoim/avatar-look`), and the dressed meshes put on the live avatar.
import * as THREE from 'three';
import { FINISHES, parseLook, parseLookKey, type Finish, type LookCard } from '@holoim/avatar-look';

import { isThreeBone, isThreeMesh, isThreeSkinnedMesh } from '../shared/threeTypeGuards';
import { readHouseAvatar } from './houseAvatar';

/** A look card and a finish: everything a creator picks. */
export interface HouseLook {
  readonly look: LookCard;
  readonly finish: Finish;
}

const STORE_KEY = 'holoim.capture.look';

// The undressed wardrobes, one per build, served as plain asset URLs and fetched only for the house base.
const WARDROBES = import.meta.glob('../../assets/house-base/wardrobe-*.glb', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

function wardrobeUrl(build: string): string {
  const url = WARDROBES[`../../assets/house-base/wardrobe-${build}.glb`];
  if (!url) throw new Error(`No house base wardrobe for the ${build} build`);
  return url;
}

function parseFinish(value: unknown): Finish {
  if (typeof value === 'string' && (FINISHES as readonly string[]).includes(value)) return value as Finish;
  throw new Error(`finish must be one of ${FINISHES.join(', ')} (got ${JSON.stringify(value)})`);
}

/**
 * The look `public/gltf/models/house-base.glb` is dressed in: `defaultLook` in
 * `scripts/authoring/house-base/base.json`. That file was made before the
 * dressing wrote the card into its extras, so the card is read from here.
 */
export const SHIPPED_HOUSE_LOOK: LookCard = {
  build: 'medium',
  skin: 'caramel',
  eyes: 'darkBrown',
  hair: { style: 'sweptCrop', colour: 'espresso' },
  glasses: 'none',
  clothing: 'oatmealSlate'
};

/** The look the loaded avatar wears, from its extras; null when it is not the house base. */
export function currentHouseLook(avatar: THREE.Object3D | undefined): HouseLook | null {
  const record = readHouseAvatar(avatar) as ({ look?: unknown; finish?: unknown } & object) | null;
  if (!record) return null;
  try {
    return { look: parseLook(record.look ?? SHIPPED_HOUSE_LOOK, 'avatar look'), finish: parseFinish(record.finish ?? 'clay') };
  } catch {
    return null;
  }
}

/**
 * The look the page asks for: `?look=` (a look key) and `?finish=` first,
 * then the look saved on this device. Parts are independent: a link may set
 * the finish alone. A bad value is left out with a warning, never a failure.
 */
export function wantedHouseLook(search: string = window.location.search): { look?: LookCard; finish?: Finish } {
  const query = new URLSearchParams(search);
  const saved = readSavedLook();
  const out: { look?: LookCard; finish?: Finish } = {};
  const lookKey = query.get('look');
  if (lookKey !== null) {
    try {
      out.look = parseLookKey(lookKey, '?look');
    } catch (error) {
      console.warn(`[look] ${(error as Error).message}; the saved or default look is used`);
    }
  }
  const finish = query.get('finish');
  if (finish !== null) {
    try {
      out.finish = parseFinish(finish);
    } catch (error) {
      console.warn(`[look] ?finish: ${(error as Error).message}; the saved or default finish is used`);
    }
  }
  if (!out.look && saved?.look) out.look = saved.look;
  if (!out.finish && saved?.finish) out.finish = saved.finish;
  return out;
}

function readSavedLook(): Partial<HouseLook> | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { look?: unknown; finish?: unknown };
    return { look: parseLook(value.look, 'saved look'), finish: parseFinish(value.finish) };
  } catch (error) {
    console.warn(`[look] ${(error as Error).message}; the saved look is ignored`);
    return null;
  }
}

/** True when this device has kept a look: the selfie journey then does not open the look panel by itself. */
export function hasSavedHouseLook(): boolean {
  return readSavedLook() !== null;
}

/** Keeps the look on this device for the next take and the next visit. */
export function saveHouseLook(look: HouseLook): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(look));
  } catch {
    // Private browsing or a full store: the look still holds for this page.
  }
}

/** The wanted look with the avatar's own look filling the parts the page does not name. */
export function resolveHouseLook(current: HouseLook, wanted: { look?: LookCard; finish?: Finish }): HouseLook {
  return { look: wanted.look ?? current.look, finish: wanted.finish ?? current.finish };
}

export function sameHouseLook(a: HouseLook, b: HouseLook): boolean {
  return a.finish === b.finish && JSON.stringify(a.look) === JSON.stringify(b.look);
}

// Each build's undressed bytes, fetched once. Dressing changes the document it reads, so each change reads a copy.
const wardrobeBytes = new Map<string, Promise<Uint8Array>>();

function fetchWardrobe(build: string): Promise<Uint8Array> {
  const url = wardrobeUrl(build);
  let bytes = wardrobeBytes.get(url);
  if (!bytes) {
    bytes = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`The ${build} wardrobe did not load (HTTP ${response.status})`);
      return new Uint8Array(await response.arrayBuffer());
    });
    wardrobeBytes.set(url, bytes);
    bytes.catch(() => wardrobeBytes.delete(url));
  }
  return bytes;
}

/** The house base dressed in a look, as GLB bytes: the same dressing as the AI flow's beat sheets. */
export async function dressHouseBase(want: HouseLook): Promise<ArrayBuffer> {
  const [bytes, { WebIO }, avatarLook] = await Promise.all([fetchWardrobe(want.look.build), import('@gltf-transform/core'), import('@holoim/avatar-look')]);
  const io = new WebIO();
  const doc = await io.readBinary(bytes.slice());
  avatarLook.dressAvatar(doc, want.look);
  if (want.finish !== 'clay') avatarLook.applyFinish(doc, want.finish);
  const out = await io.writeBinary(doc);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

/**
 * The avatar's own mesh objects: each glTF mesh node, which GLTFLoader loads
 * as a mesh, or as a group of meshes when it has more than one primitive.
 * Anything held in a bone (a prop in the hand) is not the avatar's own.
 */
export function avatarMeshRoots(root: THREE.Object3D): THREE.Object3D[] {
  const roots = new Set<THREE.Object3D>();
  root.traverse((object) => {
    if (!isThreeSkinnedMesh(object)) return;
    for (let up = object.parent; up && up !== root; up = up.parent) if (isThreeBone(up)) return;
    const parent = object.parent;
    const group = parent && parent !== root && (parent as THREE.Group).isGroup === true && parent.children.every(isThreeMesh);
    roots.add(group ? parent : object);
  });
  return [...roots];
}

function disposeMeshes(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!isThreeMesh(object)) return;
    const mesh = object as THREE.Mesh;
    mesh.geometry.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const value of Object.values(material)) if ((value as THREE.Texture | null)?.isTexture) (value as THREE.Texture).dispose();
      material.dispose();
    }
  });
}

/**
 * Puts a freshly loaded house base's meshes on the live avatar, which keeps
 * its bones (and so every system that holds them). Every mesh is replaced,
 * because meshes cannot be matched by name: a finish adds primitives, and
 * GLTFLoader names a mesh's parts by load order. Each new mesh keeps its own
 * local transform and bind matrix, under the live object of its parent's
 * name, and binds to the live bones of the same names with the new file's
 * inverse binds. Throws before any change when a bone is missing.
 */
export function transplantHouseMeshes(live: THREE.Object3D, fresh: THREE.Object3D): void {
  const liveBones = new Map<string, THREE.Bone>();
  live.traverse((object) => {
    if (isThreeBone(object)) liveBones.set(object.name, object as THREE.Bone);
  });
  const incoming = avatarMeshRoots(fresh);
  const skeletons = new Map<THREE.Skeleton, THREE.Skeleton>();
  for (const root of incoming) {
    root.traverse((object) => {
      if (!isThreeSkinnedMesh(object)) return;
      const skeleton = (object as THREE.SkinnedMesh).skeleton;
      if (skeletons.has(skeleton)) return;
      const bones = skeleton.bones.map((bone) => {
        const match = liveBones.get(bone.name);
        if (!match) throw new Error(`The new look needs the bone "${bone.name}", which the live avatar does not have`);
        return match;
      });
      skeletons.set(skeleton, new THREE.Skeleton(bones, skeleton.boneInverses.map((m) => m.clone())));
    });
  }
  const targets = incoming.map((root) => {
    const parentName = root.parent && root.parent !== fresh ? root.parent.name : '';
    return (parentName ? live.getObjectByName(parentName) : undefined) ?? live;
  });

  // The renderer keeps each skeleton's bone matrices in a texture of its own, which only `dispose` frees.
  const oldSkeletons = new Set<THREE.Skeleton>();
  for (const old of avatarMeshRoots(live)) {
    old.traverse((object) => {
      if (isThreeSkinnedMesh(object)) oldSkeletons.add((object as THREE.SkinnedMesh).skeleton);
    });
    old.removeFromParent();
    disposeMeshes(old);
  }
  for (const skeleton of oldSkeletons) skeleton.dispose();
  incoming.forEach((root, i) => {
    root.traverse((object) => {
      if (!isThreeSkinnedMesh(object)) return;
      const mesh = object as THREE.SkinnedMesh;
      mesh.bind(skeletons.get(mesh.skeleton)!, mesh.bindMatrix.clone());
    });
    targets[i]!.add(root);
  });
  // The export copies this into the take: it names the look the take wears.
  live.userData.holoimAvatar = fresh.userData.holoimAvatar;
  live.updateMatrixWorld(true);
}
