/**
 * Writes `public/gltf/animations/locomotion.glb`, the clip library retargeted
 * onto avatars without their own locomotion clips
 * (docs/features/locomotion-retarget.md): the shipped avatar's skeleton, rest
 * pose and Idle/Walk/Jump/Fall clips, with one skinned triangle in place of
 * its meshes (so GLTFLoader still makes the joints bones) and no materials.
 *
 * `test:avatars:bind` fails when the committed library drifts from
 * `avatar.glb`; rerun this after re-authoring the shipped clips.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';

const SHIPPED = fileURLToPath(new URL('../public/gltf/models/avatar.glb', import.meta.url));
export const LOCOMOTION_LIBRARY = fileURLToPath(new URL('../public/gltf/animations/locomotion.glb', import.meta.url));
const KEPT_MESH_NODE = 'Wolf3D_Body';

export async function buildLocomotionLibrary(): Promise<Uint8Array> {
  const io = new NodeIO();
  const doc = await io.read(SHIPPED);
  const root = doc.getRoot();
  const kept = root.listNodes().find((n) => n.getName() === KEPT_MESH_NODE);
  const skin = kept?.getSkin();
  if (!kept || !skin) throw new Error(`${KEPT_MESH_NODE} with a skin not found in avatar.glb`);

  for (const node of root.listNodes()) if (node !== kept && node.getMesh()) node.dispose();
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const target of prim.listTargets()) target.dispose();
      prim.dispose();
    }
    mesh.dispose();
  }
  for (const material of root.listMaterials()) material.dispose();
  for (const texture of root.listTextures()) texture.dispose();

  const buffer = root.listBuffers()[0]!;
  const hipsJoint = Math.max(0, skin.listJoints().findIndex((j) => j.getName() === 'Hips'));
  const accessor = (type: 'VEC3' | 'VEC4', array: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>) =>
    doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const primitive = doc.createPrimitive()
    .setAttribute('POSITION', accessor('VEC3', new Float32Array([0, 1, 0, 0.01, 1, 0, 0, 1.01, 0])))
    .setAttribute('JOINTS_0', accessor('VEC4', new Uint16Array([hipsJoint, 0, 0, 0, hipsJoint, 0, 0, 0, hipsJoint, 0, 0, 0])))
    .setAttribute('WEIGHTS_0', accessor('VEC4', new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])));
  kept.setName('LocomotionLibrarySkin').setMesh(doc.createMesh('LocomotionLibrarySkin').addPrimitive(primitive));

  // Accessors only the removed meshes used.
  for (const a of root.listAccessors()) {
    if (a.listParents().every((p) => p.propertyType === 'Root')) a.dispose();
  }
  return io.writeBinary(doc);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const bytes = await buildLocomotionLibrary();
  await writeFile(LOCOMOTION_LIBRARY, bytes);
  console.log(`[locomotion-library] wrote ${LOCOMOTION_LIBRARY} (${bytes.byteLength} bytes)`);
}
