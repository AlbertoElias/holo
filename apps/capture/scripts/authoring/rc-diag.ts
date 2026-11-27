// Route (c) trial diagnostic (scratch, not committed): compare solver samples from the shown and collision avatars.
import * as THREE from 'three';
import { loadSheet } from './direct.ts';
import { measureArmBody, skinned } from './lib/arm-quality.ts';
import type { LoadedAvatar } from './lib/avatar.ts';

const { sheet, avatars } = await loadSheet(process.argv[2]!);
for (const p of sheet.performers) {
  const a = avatars.get(p.id)! as LoadedAvatar & { collide?: LoadedAvatar };
  const shown = new Map<string, THREE.SkinnedMesh>();
  a.scene.traverse((o) => { const m = o as THREE.SkinnedMesh; if (m.isSkinnedMesh) shown.set(m.name, m); });
  const meshes: THREE.SkinnedMesh[] = [];
  a.collide!.scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh; const s = shown.get(m.name);
    if (!m.isSkinnedMesh || !s) return;
    m.bind(new THREE.Skeleton(s.skeleton.bones, m.skeleton.boneInverses), m.bindMatrix);
    Object.defineProperty(m, 'matrixWorld', { get: () => s.matrixWorld });
    m.visible = s.visible; meshes.push(m);
  });
  const A = measureArmBody(a); const B = measureArmBody(a, meshes);
  console.log(p.id, 'body', A.body.length, B.body.length, 'arm', A.arm.left.length, B.arm.left.length, 'hand', A.hand.right.length, B.hand.right.length);
  console.log(' restOut', A.restOut, B.restOut, 'hipOut', A.hipOut, B.hipOut);
  console.log(' foreR', A.arms.left.foreRadius, B.arms.left.foreRadius);
  const v = new THREE.Vector3(); const w = new THREE.Vector3();
  const h0 = A.hand.right.map((x) => skinned(x, new THREE.Vector3())); const h1 = B.hand.right.map((x) => skinned(x, new THREE.Vector3()));
  let m = 0; for (let k = 0; k < Math.min(h0.length, h1.length); k++) m = Math.max(m, h0[k]!.distanceTo(h1[k]!));
  console.log(' hand sample max diff mm', (m * 1000).toFixed(2), 'visible shown', [...shown.values()].filter((x) => x.visible).map((x) => x.name).join(','));
  console.log(' collide visible', meshes.filter((x) => x.visible).map((x) => x.name).join(','));
  void v; void w;
}
