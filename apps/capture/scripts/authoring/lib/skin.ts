/**
 * CPU skinning for measuring: world positions and normals of a mesh with its
 * current morph influences and bone pose (linear blend, as the GPU does).
 * Only for the audition and checks; direction never needs it.
 */
import * as THREE from 'three';

export interface SkinnedSurface {
  readonly mesh: THREE.Mesh;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  /** Dominant joint per vertex (the bone object), or the mesh itself when unskinned. */
  readonly dominant: THREE.Object3D[];
  /** Joints and weights per vertex (the mesh itself, weight 1, when unskinned). */
  readonly influences: ReadonlyArray<ReadonlyArray<readonly [THREE.Object3D, number]>>;
  readonly count: number;
}

const m = new THREE.Matrix4();
const acc = new Float64Array(16);
const add = (arr: Float32Array | Float64Array, i: number, v: number): void => { arr[i] = arr[i]! + v; };

export function skin(mesh: THREE.Mesh): SkinnedSurface {
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const count = pos.count;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const dominant: THREE.Object3D[] = new Array(count);
  const influences: (readonly [THREE.Object3D, number])[][] = new Array(count);
  mesh.updateWorldMatrix(true, false);
  // Morphs (relative, as glTF stores them).
  const base = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) { base[i * 3] = pos.getX(i); base[i * 3 + 1] = pos.getY(i); base[i * 3 + 2] = pos.getZ(i); }
  const morphs = geo.morphAttributes.position;
  const infl = mesh.morphTargetInfluences;
  if (morphs && infl) {
    morphs.forEach((attr, k) => {
      const w = infl[k] ?? 0;
      if (Math.abs(w) < 1e-6) return;
      const rel = geo.morphTargetsRelative;
      for (let i = 0; i < count; i += 1) {
        if (rel) {
          add(base, i * 3, w * attr.getX(i)); add(base, i * 3 + 1, w * attr.getY(i)); add(base, i * 3 + 2, w * attr.getZ(i));
        } else {
          add(base, i * 3, w * (attr.getX(i) - pos.getX(i))); add(base, i * 3 + 1, w * (attr.getY(i) - pos.getY(i))); add(base, i * 3 + 2, w * (attr.getZ(i) - pos.getZ(i)));
        }
      }
    });
  }
  const skinned = (mesh as THREE.SkinnedMesh).isSkinnedMesh ? (mesh as THREE.SkinnedMesh) : undefined;
  if (!skinned) {
    const e = mesh.matrixWorld.elements;
    for (let i = 0; i < count; i += 1) {
      writeTransformed(e, base, i, positions, true);
      if (nrm) { const n = [nrm.getX(i), nrm.getY(i), nrm.getZ(i)]; writeDir(e, n, i, normals); }
      dominant[i] = mesh;
      influences[i] = [[mesh, 1]];
    }
    return { mesh, positions, normals, dominant, influences, count };
  }
  const skeleton = skinned.skeleton;
  // Per bone: matrixWorld · bindMatrixInverse · bone.matrixWorld · boneInverse · bindMatrix.
  const toWorld = new THREE.Matrix4().multiplyMatrices(skinned.matrixWorld, skinned.bindMatrixInverse);
  const per = skeleton.bones.map((bone, b) => new THREE.Matrix4().multiplyMatrices(toWorld, m.multiplyMatrices(bone.matrixWorld, skeleton.boneInverses[b]!)).multiply(skinned.bindMatrix));
  const si = geo.getAttribute('skinIndex');
  const sw = geo.getAttribute('skinWeight');
  for (let i = 0; i < count; i += 1) {
    acc.fill(0);
    let best = -1;
    let bestW = -1;
    const list: (readonly [THREE.Object3D, number])[] = [];
    for (let k = 0; k < 4; k += 1) {
      const w = sw.getComponent(i, k);
      if (w <= 0) continue;
      const b = si.getComponent(i, k);
      const e = per[b]!.elements;
      for (let j = 0; j < 16; j += 1) add(acc, j, w * e[j]!);
      if (w > bestW) { bestW = w; best = b; }
      if (skeleton.bones[b]) list.push([skeleton.bones[b]!, w]);
    }
    writeTransformed(acc, base, i, positions, true);
    if (nrm) writeDir(acc, [nrm.getX(i), nrm.getY(i), nrm.getZ(i)], i, normals);
    dominant[i] = skeleton.bones[best] ?? mesh;
    influences[i] = list;
  }
  return { mesh, positions, normals, dominant, influences, count };
}

function writeTransformed(e: ArrayLike<number>, src: Float32Array, i: number, out: Float32Array, point: boolean): void {
  const x = src[i * 3]!, y = src[i * 3 + 1]!, z = src[i * 3 + 2]!;
  const w = point ? 1 : 0;
  out[i * 3] = e[0]! * x + e[4]! * y + e[8]! * z + e[12]! * w;
  out[i * 3 + 1] = e[1]! * x + e[5]! * y + e[9]! * z + e[13]! * w;
  out[i * 3 + 2] = e[2]! * x + e[6]! * y + e[10]! * z + e[14]! * w;
}

function writeDir(e: ArrayLike<number>, n: number[], i: number, out: Float32Array): void {
  const x = e[0]! * n[0]! + e[4]! * n[1]! + e[8]! * n[2]!;
  const y = e[1]! * n[0]! + e[5]! * n[1]! + e[9]! * n[2]!;
  const z = e[2]! * n[0]! + e[6]! * n[1]! + e[10]! * n[2]!;
  const l = Math.hypot(x, y, z) || 1;
  out[i * 3] = x / l; out[i * 3 + 1] = y / l; out[i * 3 + 2] = z / l;
}

/** Every visible mesh under the avatar. */
export function meshesOf(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.visible) out.push(o as THREE.Mesh); });
  return out;
}
