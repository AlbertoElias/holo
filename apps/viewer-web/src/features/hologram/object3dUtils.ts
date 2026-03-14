import type { Object3D, Vector3 } from "three";

export function prepareAnimatedScene(root: Object3D): void {
  root.traverse((child) => {
    const maybeMesh = child as { frustumCulled?: boolean };
    if (typeof maybeMesh.frustumCulled === "boolean") {
      maybeMesh.frustumCulled = false;
    }
  });
}

export function isFiniteVector3(vector: Vector3): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

export function getTopLevelAncestor(node: Object3D, root: Object3D): Object3D {
  let current = node;
  while (current.parent && current.parent !== root) {
    current = current.parent;
  }
  return current;
}
