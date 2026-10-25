// Helpers for the contract tests; not part of the package's surface.
import { loadMsdfAtlas, type BmFont } from "@holoim/design-tokens/msdf";
import { isChrome } from "@holoim/xr-ui-core";
import { type Color, type Material, type Mesh, type Object3D, SRGBColorSpace, type ShaderMaterial } from "three";

/** The real figtree-400 atlas metrics (the PNG is not loaded in tests). */
export async function figtree400(): Promise<BmFont> {
  return (await loadMsdfAtlas("figtree-400")).font;
}

export function meshesOf(root: Object3D): Mesh[] {
  const meshes: Mesh[] = [];
  root.traverse((object) => {
    if ((object as Mesh).isMesh) meshes.push(object as Mesh);
  });
  return meshes;
}

export function materialsOf(root: Object3D): Material[] {
  return [...new Set(meshesOf(root).map((mesh) => mesh.material as Material))];
}

/** A material's colour as the sRGB hex a token holds: what a viewer sees, read back. */
export function hexOf(material: Material): string {
  const shader = material as ShaderMaterial;
  const color = shader.isShaderMaterial ? (shader.uniforms.color!.value as Color) : (material as unknown as { color: Color }).color;
  return `#${color.getHexString(SRGBColorSpace)}`;
}

export function everyDescendantIsChrome(root: Object3D): boolean {
  let all = true;
  root.traverse((object) => {
    if (!isChrome(object)) all = false;
  });
  return all;
}

/** Visible only if the object and every ancestor are. */
export function visibleInTree(object: Object3D): boolean {
  for (let node: Object3D | null = object; node; node = node.parent) if (!node.visible) return false;
  return true;
}
