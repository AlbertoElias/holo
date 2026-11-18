/**
 * Plays an imported take (`lib/take.ts`) on any humanoid avatar the audition
 * accepts, as a `SolvedTake` that `writeTake` writes like a directed one.
 *
 * Each bone turns away from the target's own bind by the take's rotation, after
 * a correction that lines the target's bind limb up with the recording
 * avatar's (so a limb that rests at a different angle still points where the
 * performer's did). The hips follow the take's path scaled by leg length, so a
 * crouch, a lean or a step survives; `hips: 'fixed'` instead keeps them at
 * bind, which is what capture's rotation-only `retargetClips` does today, for
 * the loss report to compare against. The face plays through `FaceRig`: the
 * channels the recording kept, on whatever shapes the target has; gaze from the
 * recorded eye bones relative to the head.
 */
import * as THREE from 'three';
import { VRM_HUMANOID_BONES, type VrmHumanoidBone } from '@holoim/meaning';
import type { FaceChannel } from '@holoim/avatar-face';

import type { MotionFrame, Vec3 } from '../../lib/motion-quality.ts';
import type { FaceGaze } from '../../../src/face/faceTypes.ts';
import { resetPose, type LoadedAvatar } from './avatar.ts';
import type { BeatSheet } from './beats.ts';
import type { PerformerTrack, SolvedTake } from './direct.ts';
import { MOTION_JOINTS, quatAt, vecAt, type Take } from './take.ts';

/** The bone each bone's bind aim points to (its first humanoid child that both skeletons have). */
const AIM_CHILD: Partial<Record<VrmHumanoidBone, readonly VrmHumanoidBone[]>> = (() => {
  const out: Partial<Record<VrmHumanoidBone, VrmHumanoidBone[]>> = {
    hips: ['spine'], spine: ['chest', 'upperChest', 'neck'], chest: ['upperChest', 'neck'], upperChest: ['neck'], neck: ['head']
  };
  for (const s of ['left', 'right'] as const) {
    out[`${s}UpperLeg`] = [`${s}LowerLeg`]; out[`${s}LowerLeg`] = [`${s}Foot`]; out[`${s}Foot`] = [`${s}Toes`];
    out[`${s}Shoulder`] = [`${s}UpperArm`]; out[`${s}UpperArm`] = [`${s}LowerArm`]; out[`${s}LowerArm`] = [`${s}Hand`];
    out[`${s}Hand`] = [`${s}MiddleProximal`, `${s}IndexProximal`];
    out[`${s}ThumbMetacarpal`] = [`${s}ThumbProximal`]; out[`${s}ThumbProximal`] = [`${s}ThumbDistal`];
    for (const f of ['Index', 'Middle', 'Ring', 'Little'] as const) { out[`${s}${f}Proximal`] = [`${s}${f}Intermediate`]; out[`${s}${f}Intermediate`] = [`${s}${f}Distal`]; }
  }
  return out;
})();

const EYES = new Set<VrmHumanoidBone>(['leftEye', 'rightEye']);

export interface RecastOptions {
  /** `scaled` (default): the hips follow the take, scaled by leg length. `fixed`: at bind, as rotation-only retargeting. */
  readonly hips?: 'scaled' | 'fixed';
  /** The avatar spec written into the minimal sheet the GLB carries. */
  readonly avatarSpec?: string;
  readonly title?: string;
}

export interface Recast {
  readonly solved: SolvedTake;
  /** Per bone: the bind correction applied, degrees (0 when the target rests as the recording avatar did). */
  readonly correctionDeg: Partial<Record<VrmHumanoidBone, number>>;
  /** Bones of the take the target has no bone for. */
  readonly missing: VrmHumanoidBone[];
  /** Leg length ratio target / source applied to the hips' path. */
  readonly scale: number;
}

const v3 = (v: Vec3 | undefined): THREE.Vector3 | undefined => (v ? new THREE.Vector3(v[0], v[1], v[2]) : undefined);

/** Gaze from the eye bones' rotation relative to the head: yaw + left, pitch + up, radians. */
function gazeAt(take: Take, f: number): FaceGaze {
  const head = quatAt(take.bones.head!, f).invert();
  const one = (eye: 'leftEye' | 'rightEye'): { yaw: number; pitch: number } => {
    const track = take.bones[eye];
    if (!track) return { yaw: 0, pitch: 0 };
    const d = new THREE.Vector3(0, 0, 1).applyQuaternion(head.clone().multiply(quatAt(track, f)));
    return { yaw: Math.atan2(d.x, d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) };
  };
  return { left: one('leftEye'), right: one('rightEye') };
}

export function recastTake(take: Take, a: LoadedAvatar, options: RecastOptions = {}): Recast {
  const hipsMode = options.hips ?? 'scaled';
  resetPose(a);
  a.frame.position.set(0, 0, 0);
  a.frame.quaternion.identity();
  a.frame.updateMatrixWorld(true);

  // Bind corrections: target bind aim → source bind aim, per bone with an aim child both have.
  const correction = new Map<VrmHumanoidBone, THREE.Quaternion>();
  const correctionDeg: Partial<Record<VrmHumanoidBone, number>> = {};
  for (const bone of VRM_HUMANOID_BONES) {
    const tb = a.bind.get(bone);
    const sb = v3(take.measures.bind[bone]);
    if (!tb || !sb) continue;
    const child = AIM_CHILD[bone]?.find((c) => a.bind.has(c) && take.measures.bind[c]);
    if (!child) { correction.set(bone, new THREE.Quaternion()); continue; }
    const aimT = a.bind.get(child)!.rootPosition.clone().sub(tb.rootPosition).normalize();
    const aimS = v3(take.measures.bind[child])!.sub(sb).normalize();
    const c = new THREE.Quaternion().setFromUnitVectors(aimT, aimS);
    correction.set(bone, c);
    correctionDeg[bone] = Number((2 * Math.acos(Math.min(1, Math.abs(c.w))) * THREE.MathUtils.RAD2DEG).toFixed(2));
  }
  const missing = (Object.keys(take.bones) as VrmHumanoidBone[]).filter((b) => !a.bind.has(b));

  // Hips: the target's bind height above its floor, plus the take's displacement from its own bind, scaled.
  const legT = (a.legs.left.thighLength + a.legs.left.shinLength + a.legs.right.thighLength + a.legs.right.shinLength) / 2;
  const scale = legT / take.measures.legLength;
  const hipsBindS = v3(take.measures.bind.hips)!;
  const hipsBindT = a.bind.get('hips')!.rootPosition.clone();

  const frames = take.frames;
  const fps = take.fps;
  const times = new Float32Array(frames).map((_, i) => i / fps);
  const rotations = new Map<THREE.Object3D, Float32Array>();
  const translations = new Map<THREE.Object3D, Float32Array>();
  for (const o of a.rest.keys()) { rotations.set(o, new Float32Array(frames * 4)); translations.set(o, new Float32Array(frames * 3)); }
  const morphing: { node: THREE.Object3D; meshes: THREE.Mesh[] }[] = [];
  a.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.morphTargetInfluences?.length) return;
    const node = a.nodeIndex.has(m) ? m : m.parent!;
    const known = morphing.find((x) => x.node === node);
    if (known) known.meshes.push(m); else morphing.push({ node, meshes: [m] });
  });
  const weights = new Map(morphing.map((m) => [m.node, { targets: m.meshes[0]!.morphTargetInfluences!.length, values: new Float32Array(frames * m.meshes[0]!.morphTargetInfluences!.length), meshes: m.meshes }]));
  const root = { position: new Float32Array(frames * 3), rotation: new Float32Array(frames * 4) };
  const motion: MotionFrame[] = [];

  const bodyQ = a.body.getWorldQuaternion(new THREE.Quaternion());
  const parentQ = new THREE.Quaternion();
  const want = new THREE.Quaternion();
  const d = new THREE.Quaternion();
  const p = new THREE.Vector3();
  for (let f = 0; f < frames; f += 1) {
    resetPose(a);
    for (const bone of VRM_HUMANOID_BONES) {
      if (EYES.has(bone)) continue;
      const track = take.bones[bone];
      const tb = a.bind.get(bone);
      if (!track || !tb) continue;
      // World = body · D · C · B_target, then local under the parent as it is posed now.
      quatAt(track, f, d);
      want.copy(bodyQ).multiply(d).multiply(correction.get(bone)!).multiply(tb.rootQuaternion);
      tb.bone.parent!.getWorldQuaternion(parentQ);
      tb.bone.quaternion.copy(parentQ.invert().multiply(want)).normalize();
      if (bone === 'hips' && hipsMode === 'scaled') {
        vecAt(take.hips, f, p).sub(hipsBindS).multiplyScalar(scale).add(hipsBindT);
        a.body.localToWorld(p);
        tb.bone.position.copy(tb.bone.parent!.worldToLocal(p));
      }
      tb.bone.updateMatrixWorld(true);
    }
    const faceWeights: Partial<Record<FaceChannel, number>> = {};
    for (const [c, w] of Object.entries(take.face) as [FaceChannel, number[]][]) faceWeights[c] = w[f]!;
    a.face.apply(faceWeights, gazeAt(take, f));
    a.frame.updateMatrixWorld(true);

    for (const [o, arr] of rotations) o.quaternion.toArray(arr, f * 4);
    for (const [o, arr] of translations) o.position.toArray(arr, f * 3);
    for (const [, w] of weights) w.values.set(w.meshes[0]!.morphTargetInfluences!, f * w.targets);
    a.frame.position.toArray(root.position, f * 3);
    a.frame.quaternion.toArray(root.rotation, f * 4);
    const joints: MotionFrame['joints'] = {};
    for (const [name, bone] of MOTION_JOINTS) {
      const b = a.humanoid.bone(bone) ?? (name === 'chest' ? a.humanoid.bone('chest') : undefined);
      if (b) joints[name] = b.getWorldPosition(p).toArray() as Vec3;
    }
    motion.push({ timeSec: times[f]!, joints });
  }

  const sheet: BeatSheet = {
    title: options.title ?? `${take.source.file} recast`,
    duration: take.duration,
    fps,
    life: false,
    performers: [{ id: 'performer', avatar: options.avatarSpec ?? a.file, at: [0, 0], facing: 0 }],
    beats: []
  };
  const track: PerformerTrack = { spec: sheet.performers[0]!, avatar: a, rotations, translations, weights, root, reaches: [], motion };
  return { solved: { sheet, fps, times, tracks: [track], props: [], objects: { grips: [], puts: [], aims: [] } }, correctionDeg, missing, scale: Number(scale.toFixed(4)) };
}
