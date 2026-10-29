/**
 * Node half of the locomotion retarget check (docs/features/locomotion-retarget.md),
 * run by `test:avatars:bind`:
 *   - the committed clip library equals what `build-locomotion-library.ts`
 *     makes from `avatar.glb` (no drift after re-authoring the clips);
 *   - retargeting onto a rig identical to the shipped one gives the library's
 *     keys back (1e-5) and no other tracks;
 *   - on every mappable fixture, each retargeted clip puts every canonical
 *     bone within 1.5 cm of the library's pose (hips-relative, root frame) at
 *     eleven times per clip, with T-pose and A-pose arms corrected;
 *   - the rest-pose correction reported per limb is the arm angle difference.
 */
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM_HUMANOID_BONES, type VrmHumanoidBone } from '../../../../packages/meaning/src/index.ts';

import { HumanoidSkeleton } from '../../src/avatar/HumanoidSkeleton.ts';
import { retargetClips, type RetargetRig } from '../../src/animation/retargetClips.ts';
import { LOCOMOTION_LIBRARY, buildLocomotionLibrary } from '../build-locomotion-library.ts';
import type { FixtureInfo } from './avatar-fixtures.ts';

const POSE_TOLERANCE_M = 0.015;
const KEY_TOLERANCE = 1e-5;
const SAMPLES_PER_CLIP = 10;
// Identical geometry to the shipped rig: the retargeted clips must be the library's own.
const IDENTITY_FIXTURES = ['mixamo-prefixed', 'vroid', 'biped', 'meta', 'arkit', 'cc4', 'vrm1-declared', 'duplicate-names'];
// End sites compared with the bones: a fingertip shows a palm roll the wrist cannot.
const TIPS = ['leftMiddleDistal', 'leftThumbDistal', 'rightMiddleDistal', 'rightThumbDistal'] as const;
// Upper-arm correction a fixture must report: the shipped arms rest 54.7° below horizontal.
const SHIPPED_ARM_DEG = 54.7;

interface LoadedRig extends RetargetRig { readonly clips: THREE.AnimationClip[] }

async function loadRig(bytes: Uint8Array): Promise<LoadedRig> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  const root = gltf.scene;
  const humanoid = HumanoidSkeleton.bind(root, { json: gltf.parser.json, associations: gltf.parser.associations as never });
  humanoid.normalizeFacing(root);
  return { root, humanoid, clips: gltf.animations };
}

function poseAt(rig: RetargetRig, clip: THREE.AnimationClip, time: number): Map<string, THREE.Vector3> {
  const mixer = new THREE.AnimationMixer(rig.root);
  const action = mixer.clipAction(clip).play();
  mixer.setTime(time);
  rig.root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(rig.root.matrixWorld).invert();
  const out = new Map<string, THREE.Vector3>();
  for (const b of VRM_HUMANOID_BONES) {
    const bone = rig.humanoid.bone(b);
    if (bone) out.set(b, bone.getWorldPosition(new THREE.Vector3()).applyMatrix4(toRoot));
  }
  for (const b of TIPS) {
    const tip = rig.humanoid.tip(b);
    if (tip) out.set(`${b}Tip`, tip.getWorldPosition(new THREE.Vector3()).applyMatrix4(toRoot));
  }
  action.stop();
  mixer.uncacheRoot(rig.root);
  return out;
}

export interface RetargetRow {
  fixture: string;
  clips: string;
  worstCm: number;
  worstAt: string;
  correctionDeg: Partial<Record<VrmHumanoidBone, number>>;
  failures: string[];
}

export async function checkLocomotionRetarget(fixtures: readonly FixtureInfo[]): Promise<{ rows: RetargetRow[]; failures: string[] }> {
  const failures: string[] = [];
  const committed = new Uint8Array(await readFile(LOCOMOTION_LIBRARY));
  const built = await buildLocomotionLibrary();
  if (Buffer.compare(Buffer.from(committed), Buffer.from(built)) !== 0) {
    failures.push('public/gltf/animations/locomotion.glb differs from avatar.glb: run scripts/build-locomotion-library.ts');
  }
  const library = await loadRig(committed);
  if (library.clips.map((c) => c.name).join() !== 'Idle,Walk,Jump,Fall') failures.push(`library clips ${library.clips.map((c) => c.name).join()}`);

  const rows: RetargetRow[] = [];
  for (const fixture of fixtures.filter((f) => f.name !== 'unmappable')) {
    const fail: string[] = [];
    const target = await loadRig(new Uint8Array(await readFile(fixture.file)));
    if (fixture.expect.ownClips ? target.clips.length !== 4 : target.clips.length !== 0) {
      fail.push(`has ${target.clips.length} clips of its own`);
    }
    const { clips, correctionDeg } = retargetClips(library, library.clips, target);
    // Bones the fixture maps to other nodes than the shipped rig (Unreal's inserted chest) sit elsewhere by design.
    const remapped = new Set(Object.keys(fixture.expect.bonesByName ?? {}));
    let worst = 0;
    let worstAt = '';
    for (const source of library.clips) {
      const clip = clips.find((c) => c.name === source.name);
      if (!clip) { fail.push(`no retargeted ${source.name}`); continue; }
      if (IDENTITY_FIXTURES.includes(fixture.name)) {
        const keysOf = (rig: RetargetRig, c: THREE.AnimationClip) => new Map(c.tracks.map((t) => {
          const node = THREE.PropertyBinding.findNode(rig.root, THREE.PropertyBinding.parseTrackName(t.name).nodeName) as THREE.Object3D;
          const bone = VRM_HUMANOID_BONES.find((b) => rig.humanoid.bone(b) === node);
          return [bone ?? t.name, t] as const;
        }));
        const want = keysOf(library, source);
        const got = keysOf(target, clip);
        if ([...got.keys()].sort().join() !== [...want.keys()].sort().join()) {
          fail.push(`${source.name} animates ${[...got.keys()].join(',')} instead of ${[...want.keys()].join(',')}`);
        }
        for (const [bone, track] of want) {
          const other = got.get(bone);
          if (!other) continue;
          const dev = Math.max(...track.values.map((v, i) => Math.abs(v - (other.values[i] ?? Infinity))));
          if (!(dev <= KEY_TOLERANCE) || other.times.length !== track.times.length) fail.push(`${source.name} ${String(bone)} keys deviate ${dev.toExponential(1)}`);
        }
      }
      for (let k = 0; k <= SAMPLES_PER_CLIP; k++) {
        const time = (source.duration * k) / SAMPLES_PER_CLIP;
        const want = poseAt(library, source, time);
        const got = poseAt(target, clip, time);
        const wantHips = want.get('hips')!;
        const gotHips = got.get('hips')!;
        for (const [bone, w] of want) {
          const g = got.get(bone);
          if (!g || remapped.has(bone.replace(/Tip$/, ''))) continue;
          const d = w.clone().sub(wantHips).distanceTo(g.clone().sub(gotHips));
          if (d > worst) { worst = d; worstAt = `${source.name}@${time.toFixed(2)}s ${bone}`; }
        }
      }
    }
    if (worst > POSE_TOLERANCE_M) fail.push(`${worstAt} is ${(worst * 100).toFixed(1)} cm from the library pose`);
    // The upper-arm turn is the angle between the fixture's rest arm and the shipped one.
    const below = THREE.MathUtils.degToRad(fixture.expect.armBelowHorizontalDegrees ?? SHIPPED_ARM_DEG);
    const forward = THREE.MathUtils.degToRad(fixture.expect.armForwardDegrees ?? 0);
    const shippedBelow = THREE.MathUtils.degToRad(SHIPPED_ARM_DEG);
    const cos = Math.cos(below) * Math.cos(forward) * Math.cos(shippedBelow) + Math.sin(below) * Math.sin(shippedBelow);
    const wantArm = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, cos)));
    for (const side of ['left', 'right'] as const) {
      const got = correctionDeg[`${side}UpperArm`] ?? 0;
      if (Math.abs(got - wantArm) > 1) fail.push(`${side} upper arm corrected ${got}° (want ${wantArm.toFixed(1)}°)`);
    }
    for (const bone of ['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg'] as const) {
      if (correctionDeg[bone]) fail.push(`${bone} corrected ${correctionDeg[bone]}° on a rig with the shipped legs`);
    }
    rows.push({
      fixture: fixture.name,
      clips: clips.map((c) => `${c.name}:${c.tracks.length}`).join(' '),
      worstCm: +(worst * 100).toFixed(3),
      worstAt,
      correctionDeg,
      failures: fail
    });
    failures.push(...fail.map((f) => `${fixture.name}: ${f}`));
  }
  return { rows, failures };
}
