/**
 * A noise floor for morph normal deltas (B-096). Blender writes a normal delta for every vertex whose shading moves
 * at all, so most rows of the house base's face shapes were float noise around the shape: 84% of its sparse NORMAL
 * rows were under 0.002, and they made the file 2.70 MB against the 1.80 MB bar. A delta under 0.002 turns the normal
 * by at most about 0.1°, which changes N·L by less than one 8-bit step (1/255), so the shading does not change on
 * screen. `build.py` keeps the same kind of floor for positions (1e-6 m).
 */
import type { Document } from '@gltf-transform/core';

/** A normal delta whose largest component is under this is set to zero. */
export const NORMAL_FLOOR = 0.002;

/** Sets to zero each morph NORMAL row whose largest component is under `floor`. Returns the number of rows changed. */
export function quietMorphNormals(doc: Document, floor = NORMAL_FLOOR): number {
  let changed = 0;
  const done = new Set<object>();
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const target of prim.listTargets()) {
        const normal = target.getAttribute('NORMAL');
        if (!normal || done.has(normal)) continue;
        done.add(normal);
        const array = normal.getArray();
        if (!array) continue;
        let kept = 0;
        for (let i = 0; i + 2 < array.length; i += 3) {
          const big = Math.max(Math.abs(array[i]!), Math.abs(array[i + 1]!), Math.abs(array[i + 2]!));
          if (big > 0 && big < floor) { array[i] = 0; array[i + 1] = 0; array[i + 2] = 0; changed += 1; } else if (big > 0) kept += 1;
        }
        normal.setArray(array);
        // Sparse only where it is smaller: a kept row costs its 12 bytes and a 2- or 4-byte index.
        if (kept * 3 < array.length / 3) normal.setSparse(true);
      }
    }
  }
  return changed;
}
