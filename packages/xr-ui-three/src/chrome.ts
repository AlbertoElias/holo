// The one way every chrome material and object is made (styleguide 2, 6): a
// MeshBasicMaterial in a token colour, converted to linear once by
// `tokenColor`, never tone-mapped, and every object marked as chrome so the
// recorder, the exporter and point resolution skip it.
import { chromeMaterial, tokenColor } from "@holoim/design-tokens/three";
import { markChromeTree } from "@holoim/xr-ui-core";
import { DoubleSide, FrontSide, MeshBasicMaterial, type Object3D } from "three";

export interface ChromeMaterialOptions {
  /** A token's sRGB hex (`tokens.color.gold`), never a hand-copied value. */
  color: string;
  /** 0 to 1; default 1. */
  opacity?: number;
  /** The geometry carries RGBA vertex colours (itemSize 4) whose alpha shapes the fill. */
  vertexColors?: boolean;
  /** Force `transparent` on, for layers that must sort by `renderOrder` even at opacity 1. */
  transparent?: boolean;
  /** An invisible material still takes raycasts (hit areas). */
  visible?: boolean;
  doubleSided?: boolean;
}

/** Whether a chrome material blends: translucent, vertex alpha, or forced. */
function blends(material: MeshBasicMaterial, forced: boolean): boolean {
  return forced || material.opacity < 1 || material.vertexColors;
}

/**
 * Chrome's only material: flat colour, `toneMapped: false`, `transparent`
 * when its opacity is under 1 or it carries vertex alpha, and then no depth
 * write, so layers sort by `renderOrder`.
 */
export function createChromeMaterial({ color, opacity = 1, vertexColors = false, transparent = false, visible = true, doubleSided = false }: ChromeMaterialOptions): MeshBasicMaterial {
  const material = new MeshBasicMaterial({
    color: tokenColor(color),
    ...chromeMaterial,
    opacity,
    vertexColors,
    visible,
    side: doubleSided ? DoubleSide : FrontSide
  });
  material.userData.forceTransparent = transparent;
  applyBlending(material);
  return material;
}

function applyBlending(material: MeshBasicMaterial): void {
  const blending = blends(material, material.userData.forceTransparent === true);
  if (material.transparent !== blending) {
    material.transparent = blending;
    // `transparent` changes the compiled program (the OPAQUE define).
    material.needsUpdate = true;
  }
  material.depthWrite = !blending;
}

/** Sets a chrome material's opacity, switching it between blended and opaque as needed. */
export function setChromeOpacity(material: MeshBasicMaterial, opacity: number): void {
  material.opacity = opacity;
  applyBlending(material);
}

/** Sets a chrome material's colour from a token's sRGB hex (converted to linear once). */
export function setChromeColor(material: MeshBasicMaterial, hex: string): void {
  material.color.copy(tokenColor(hex));
}

/** Marks an object and every descendant as chrome: call after every build and rebuild. */
export function finishChrome<T extends Object3D>(root: T): T {
  return markChromeTree(root);
}
