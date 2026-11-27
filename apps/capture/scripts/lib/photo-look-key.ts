/**
 * The key of the hair outlines in `src/avatar/photoLookOutlines.ts`
 * (docs/features/directed-performance.md, slice 5b): the hash of what the
 * outlines are made from. The authoring command `photo-look-data.ts outlines`
 * writes it beside the outlines, and the phone e2e fails when it no longer
 * matches. It lives outside the offline authoring folder because the e2e
 * reads it, and CI's browser suites must run when one of its inputs changes.
 *
 * The inputs: the shipped house base (dressed in the default look, so a new
 * default look changes it), the three wardrobes, and the avatar-look code
 * that dresses and reads. The authoring CLI's own render code is not an
 * input: a change there shows in the opt-in parity test, not here.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../../', import.meta.url));
const INPUTS = [
  'public/gltf/models/house-base.glb',
  'assets/house-base/wardrobe-slight.glb',
  'assets/house-base/wardrobe-medium.glb',
  'assets/house-base/wardrobe-broad.glb',
  '../../packages/avatar-look/src/dress.ts',
  '../../packages/avatar-look/src/photo.ts',
  '../../packages/avatar-look/src/read.ts',
  '../../packages/avatar-look/src/traits.ts'
];

export async function outlinesKey(): Promise<string> {
  const hash = createHash('sha256');
  for (const input of INPUTS) hash.update(input).update(await readFile(join(APP, input)));
  return hash.digest('hex').slice(0, 16);
}
