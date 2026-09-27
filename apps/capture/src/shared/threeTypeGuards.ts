import type * as THREE from 'three';

type ThreeObjectFlags = {
  isBone?: boolean;
  isMesh?: boolean;
  isSkinnedMesh?: boolean;
};

export function isThreeBone(object: THREE.Object3D | null | undefined): object is THREE.Bone {
  return (object as ThreeObjectFlags | null | undefined)?.isBone === true;
}

export function isThreeMesh(object: THREE.Object3D | null | undefined): object is THREE.Mesh {
  return (object as ThreeObjectFlags | null | undefined)?.isMesh === true;
}

export function isThreeSkinnedMesh(object: THREE.Object3D | null | undefined): object is THREE.SkinnedMesh {
  return (object as ThreeObjectFlags | null | undefined)?.isSkinnedMesh === true;
}
