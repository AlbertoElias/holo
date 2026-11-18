/**
 * A recorded take in the authoring tool's own terms (slice 4a of
 * docs/features/directed-performance.md). A capture export is baked into the
 * avatar it was recorded on: local rotations on that avatar's bones and
 * weights on its own shapes. `importTake` reads it back into something no
 * avatar owns:
 *
 * - per frame, each humanoid bone's rotation away from its bind pose, in the
 *   performer's body frame (+Z forward, +Y up, +X the performer's left), so
 *   the same numbers turn any other humanoid's bone the same way;
 * - the hips' path in that frame, and the performer's measures, so a body of
 *   another size can scale it;
 * - the face as canonical channels (`FaceChannel`), recovered from the shapes
 *   the recording avatar has;
 * - the 18 motion-quality joints, for the reports, and the take's own beats.
 *
 * Bind poses come from the skins' inverse bind matrices: a recorded file's
 * nodes hold a pose from the take, not the bind. Nothing here edits capture.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FACE_CHANNELS, type FaceChannel } from '@holoim/avatar-face';
import { VRM_HUMANOID_BONES, type VrmHumanoidBone } from '@holoim/meaning';

import { HumanoidSkeleton } from '../../../src/avatar/HumanoidSkeleton.ts';
import type { JointName, MotionFrame, Vec3 } from '../../lib/motion-quality.ts';
import { withoutTextures } from './avatar.ts';
import { parseGlb } from './gltf-read.ts';

export const TAKE_VERSION = 1;
/** Sole below the lowest foot or toe bone, metres, where a file gives no floor. */
const SOLE = 0.02;

/** The motion-quality joints, by the humanoid bone each is read from (as `direct.ts` and capture's body samples). */
export const MOTION_JOINTS: ReadonlyArray<readonly [JointName, VrmHumanoidBone]> = [
  ['head', 'head'], ['neck', 'neck'], ['chest', 'upperChest'], ['hips', 'hips'],
  ['leftShoulder', 'leftUpperArm'], ['rightShoulder', 'rightUpperArm'], ['leftElbow', 'leftLowerArm'], ['rightElbow', 'rightLowerArm'],
  ['leftWrist', 'leftHand'], ['rightWrist', 'rightHand'], ['leftHip', 'leftUpperLeg'], ['rightHip', 'rightUpperLeg'],
  ['leftKnee', 'leftLowerLeg'], ['rightKnee', 'rightLowerLeg'], ['leftAnkle', 'leftFoot'], ['rightAnkle', 'rightFoot'],
  ['leftToe', 'leftToes'], ['rightToe', 'rightToes']
];

export interface TakeMeasures {
  /** Bind hips height above the bind's floor (just under its lowest foot or toe bone), metres. */
  readonly hipHeight: number;
  /** Upper leg to foot, metres (mean of both sides). */
  readonly legLength: number;
  /** Upper arm to hand, metres (mean of both sides). */
  readonly armLength: number;
  /** Bind position of each humanoid bone in the body frame: the aim of each limb. */
  readonly bind: Partial<Record<VrmHumanoidBone, Vec3>>;
}

/** A span the take found in its own motion: the wrists and head move, or they hold. */
export interface TakeBeat {
  readonly id: string;
  readonly kind: 'move' | 'hold';
  readonly from: number;
  readonly to: number;
  /** Where the head points over the span: degrees, yaw + toward the performer's left, pitch + up. */
  readonly look: { readonly yaw: number; readonly pitch: number };
  /** Peak wrist speed over the span, m/s. */
  readonly peakWristSpeed: number;
}

export interface Take {
  readonly version: number;
  readonly source: { readonly file: string; readonly sha256: string; readonly generator?: string; readonly frames: number; readonly fps: number; readonly duration: number; readonly trimmed: { readonly from: number; readonly to: number }; readonly faceChannels: number; readonly faceShapes: string[] };
  readonly fps: number;
  readonly duration: number;
  readonly frames: number;
  readonly measures: TakeMeasures;
  /** Per bone: frames × 4, the rotation away from bind in the body frame (q_now · q_bind⁻¹). */
  readonly bones: Partial<Record<VrmHumanoidBone, number[]>>;
  /** frames × 3: the hips in the body frame of the first frame, metres. */
  readonly hips: number[];
  /** Per channel that the recording avatar has a shape for: frames weights. */
  readonly face: Partial<Record<FaceChannel, number[]>>;
  /** The 18 motion joints per frame, in the same frame. */
  readonly joints: Partial<Record<JointName, number[]>>;
  readonly beats: TakeBeat[];
  /** What edits made this take from its source, when it was edited (`edit-take.ts`). */
  readonly edited?: unknown;
}

const round = (v: number, places = 5): number => Number(v.toFixed(places));

/** The +Z/+Y frame of a performer from its bind: +X from the right upper leg to the left one, flattened. */
function bodyBasis(left: THREE.Vector3, right: THREE.Vector3): THREE.Quaternion {
  const x = left.clone().sub(right).setY(0).normalize();
  const y = new THREE.Vector3(0, 1, 0);
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

interface Rig {
  readonly scene: THREE.Group;
  readonly clip: THREE.AnimationClip | undefined;
  readonly humanoid: HumanoidSkeleton;
  readonly bones: Map<VrmHumanoidBone, THREE.Bone>;
  /** Bind world matrix of every joint of every skin, in the scene's frame as loaded. */
  readonly bindWorld: Map<THREE.Object3D, THREE.Matrix4>;
  readonly faceMeshes: THREE.Mesh[];
  readonly duration: number;
}

/** Runs the loader with its texture and sparse-accessor warnings quiet (textures are stripped on purpose); every other warning still shows. */
const silence = async <T>(fn: () => Promise<T>): Promise<T> => {
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { if (!/texture|image|sparse/i.test(String(args[0]))) warn(...args); };
  try { return await fn(); } finally { console.warn = warn; }
};

async function loadRecording(bytes: Uint8Array): Promise<Rig> {
  const gltf = await silence(() => new GLTFLoader().parseAsync(withoutTextures(bytes), ''));
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const humanoid = HumanoidSkeleton.bind(scene, { json: gltf.parser.json, associations: gltf.parser.associations as never });
  const bones = new Map<VrmHumanoidBone, THREE.Bone>();
  for (const name of VRM_HUMANOID_BONES) { const b = humanoid.bone(name); if (b) bones.set(name, b); }
  const missing = (['hips', 'spine', 'head', 'leftUpperArm', 'leftHand', 'rightUpperArm', 'rightHand', 'leftUpperLeg', 'leftFoot', 'rightUpperLeg', 'rightFoot'] as const).filter((b) => !bones.has(b));
  if (missing.length) throw new Error(`no performer to import: the declared humanoid lacks ${missing.join(', ')}`);

  // glTF: a joint's world matrix at bind is the skinned mesh node's world matrix times the inverse of its inverse bind matrix.
  const bindWorld = new Map<THREE.Object3D, THREE.Matrix4>();
  const faceMeshes: THREE.Mesh[] = [];
  scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh && m.skeleton) {
      m.skeleton.bones.forEach((bone, j) => {
        if (bindWorld.has(bone)) return;
        bindWorld.set(bone, m.matrixWorld.clone().multiply(m.skeleton.boneInverses[j]!.clone().invert()));
      });
    }
    if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).morphTargetDictionary) faceMeshes.push(o as THREE.Mesh);
  });
  const clip = gltf.animations[0];
  return { scene, clip, humanoid, bones, bindWorld, faceMeshes, duration: clip?.duration ?? 0 };
}

/** The bind world matrix of an object: its skin's, else its parent's bind times its own file transform. */
function bindOf(rig: Rig, o: THREE.Object3D, cache: Map<THREE.Object3D, THREE.Matrix4>, fileLocal: Map<THREE.Object3D, THREE.Matrix4>): THREE.Matrix4 {
  const known = rig.bindWorld.get(o) ?? cache.get(o);
  if (known) return known;
  const local = fileLocal.get(o) ?? new THREE.Matrix4();
  const m = o.parent ? bindOf(rig, o.parent, cache, fileLocal).clone().multiply(local) : local.clone();
  cache.set(o, m);
  return m;
}

/** Face channel of a shape name, when it is one (ARKit and viseme names, case-insensitive). */
const CHANNEL_BY_NAME = new Map(FACE_CHANNELS.map((c) => [c.toLowerCase(), c] as const));
const channelOf = (name: string): FaceChannel | undefined => CHANNEL_BY_NAME.get(name.toLowerCase());

export interface ImportOptions {
  /** Frames per second to resample at; default 30. */
  readonly fps?: number;
}

/** Reads a capture-recorded GLB's declared performer into a `Take`. */
export async function importTake(file: string, options: ImportOptions = {}): Promise<Take> {
  const bytes = new Uint8Array(await readFile(file));
  const json = parseGlb(bytes).json as { asset?: { generator?: string } };
  const rig = await loadRecording(bytes);
  if (!rig.clip) throw new Error(`${basename(file)}: no animation to import`);
  const keyTimes = rig.clip.tracks[0]?.times;
  const recordedFps = keyTimes && keyTimes.length > 1 ? Math.round((keyTimes.length - 1) / (keyTimes[keyTimes.length - 1]! - keyTimes[0]!)) : 30;
  const fps = options.fps ?? 30;

  // Every node's local transform as the file holds it (the pose the bind falls back on for non-joints).
  const fileLocal = new Map<THREE.Object3D, THREE.Matrix4>();
  rig.scene.traverse((o) => fileLocal.set(o, o.matrix.clone()));
  const cache = new Map<THREE.Object3D, THREE.Matrix4>();
  const bindPos = new Map<VrmHumanoidBone, THREE.Vector3>();
  const bindQuat = new Map<VrmHumanoidBone, THREE.Quaternion>();
  for (const [name, bone] of rig.bones) {
    const m = bindOf(rig, bone, cache, fileLocal);
    const p = new THREE.Vector3(); const q = new THREE.Quaternion(); const s = new THREE.Vector3();
    m.decompose(p, q, s);
    bindPos.set(name, p); bindQuat.set(name, q);
  }

  // The body frame: the bind's facing and the floor under its feet, placed where the performer stands on the first frame.
  const mixer = new THREE.AnimationMixer(rig.scene);
  const action = mixer.clipAction(rig.clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  // Clamped just inside the clip: at exactly its duration a mixer reads the first frame again.
  const poseAt = (t: number): void => { mixer.setTime(Math.min(t, rig.duration - 1e-6)); rig.scene.updateMatrixWorld(true); };
  const basisBind = bodyBasis(bindPos.get('leftUpperLeg')!, bindPos.get('rightUpperLeg')!);
  // The bind's floor, by the same rule as the take's below: y = 0 when the feet stand near it, else just under
  // the lowest foot or toe bone (a bind foot is often pitched, toes down).
  const feetBones = (['leftFoot', 'rightFoot', 'leftToes', 'rightToes'] as const).filter((b) => rig.bones.has(b));
  const floorOf = (low: number): number => (Math.abs(low) < 0.3 ? 0 : low - SOLE);
  const floorBind = floorOf(Math.min(...feetBones.map((b) => bindPos.get(b)!.y)));

  // The performer may stand anywhere and face any way in the recording; the body frame is the first frame's
  // feet midpoint on the floor, and the first frame's hips facing.
  const w = (b: VrmHumanoidBone): THREE.Vector3 => rig.bones.get(b)!.getWorldPosition(new THREE.Vector3());
  const trim = trimSnaps(rig.duration, fps, (t) => { poseAt(t); return [...rig.bones.values()].map((b) => b.getWorldPosition(new THREE.Vector3())); });
  const frames = Math.max(1, Math.floor((trim.to - trim.from) * fps + 1e-6) + 1);
  poseAt(trim.from);
  const basis0 = bodyBasis(w('leftUpperLeg'), w('rightUpperLeg'));
  const feet0 = w('leftFoot').add(w('rightFoot')).multiplyScalar(0.5);
  // y = 0 is the recording's floor (the scene's y = 0) when the feet stand near it; a take recorded on a
  // raised stage instead puts the floor just under the lower toe of the first frame.
  const low0 = Math.min(...feetBones.map((b) => w(b).y));
  const origin = new THREE.Vector3(feet0.x, floorOf(low0), feet0.z);
  const toBody = basis0.clone().invert();
  const bindToBody = basisBind.clone().invert();

  const measures: TakeMeasures = (() => {
    const dist = (a: VrmHumanoidBone, b: VrmHumanoidBone): number => bindPos.get(a)!.distanceTo(bindPos.get(b)!);
    const bind: Partial<Record<VrmHumanoidBone, Vec3>> = {};
    const bindFeet = bindPos.get('leftFoot')!.clone().add(bindPos.get('rightFoot')!).multiplyScalar(0.5).setY(floorBind);
    for (const [name, p] of bindPos) {
      const v = p.clone().sub(bindFeet).applyQuaternion(bindToBody);
      bind[name] = [round(v.x), round(v.y), round(v.z)];
    }
    return {
      hipHeight: round(bindPos.get('hips')!.y - floorBind),
      // Thigh plus shin, as the recast measures its target's legs.
      legLength: round((dist('leftUpperLeg', 'leftLowerLeg') + dist('leftLowerLeg', 'leftFoot') + dist('rightUpperLeg', 'rightLowerLeg') + dist('rightLowerLeg', 'rightFoot')) / 2),
      armLength: round((dist('leftUpperArm', 'leftHand') + dist('rightUpperArm', 'rightHand')) / 2),
      bind
    };
  })();

  // Face: per channel, the shape it drives on the mesh with the most face shapes.
  const faceMesh = [...rig.faceMeshes].sort((a, b) => Object.keys(b.morphTargetDictionary!).filter(channelOf).length - Object.keys(a.morphTargetDictionary!).filter(channelOf).length)[0];
  const faceIndex = new Map<FaceChannel, number>();
  if (faceMesh) for (const [name, i] of Object.entries(faceMesh.morphTargetDictionary!)) { const c = channelOf(name); if (c) faceIndex.set(c, i); }

  const bones: Partial<Record<VrmHumanoidBone, number[]>> = {};
  for (const name of rig.bones.keys()) bones[name] = [];
  const hips: number[] = [];
  const face: Partial<Record<FaceChannel, number[]>> = {};
  for (const c of faceIndex.keys()) face[c] = [];
  const joints: Partial<Record<JointName, number[]>> = {};
  for (const [j] of MOTION_JOINTS) joints[j] = [];

  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();
  for (let f = 0; f < frames; f += 1) {
    poseAt(trim.from + f / fps);
    for (const [name, bone] of rig.bones) {
      // Body-frame rotation now, times the body-frame bind rotation's inverse.
      bone.getWorldQuaternion(q).premultiply(toBody);
      const bindBody = bindToBody.clone().multiply(bindQuat.get(name)!);
      q.multiply(bindBody.invert());
      bones[name]!.push(round(q.x), round(q.y), round(q.z), round(q.w));
    }
    rig.bones.get('hips')!.getWorldPosition(v).sub(origin).applyQuaternion(toBody);
    hips.push(round(v.x), round(v.y), round(v.z));
    for (const [c, i] of faceIndex) face[c]!.push(round(faceMesh!.morphTargetInfluences![i] ?? 0, 4));
    for (const [j, b] of MOTION_JOINTS) {
      // `chest` is the upper chest where the rig has one, else the chest (as the recast reads it).
      const bone = rig.bones.get(b) ?? (j === 'chest' ? rig.bones.get('chest') : undefined);
      if (!bone) continue;
      bone.getWorldPosition(v).sub(origin).applyQuaternion(toBody);
      joints[j]!.push(round(v.x), round(v.y), round(v.z));
    }
  }
  for (const [j] of MOTION_JOINTS) if (!joints[j]!.length) delete joints[j];

  const take: Omit<Take, 'beats'> = {
    version: TAKE_VERSION,
    source: {
      file: basename(file), sha256: createHash('sha256').update(bytes).digest('hex'), ...(json.asset?.generator ? { generator: json.asset.generator } : {}),
      frames: keyTimes?.length ?? 0, fps: recordedFps, duration: round(rig.duration, 3), trimmed: { from: round(trim.from, 3), to: round(trim.to, 3) },
      faceChannels: faceIndex.size, faceShapes: faceMesh ? Object.keys(faceMesh.morphTargetDictionary!) : []
    },
    fps, duration: round((frames - 1) / fps, 4), frames, measures, bones, hips, face, joints
  };
  return { ...take, beats: findBeats(take) };
}

/** A bone moving faster than this between two frames at the take's ends is the recorder starting or stopping, not the performer. */
export const SNAP_SPEED = 4;
const SNAP_WINDOW_SEC = 0.4;

/** The span of the recording to keep: the first and last frames that jump (a pose snapping into place as recording starts or stops) are cut. */
function trimSnaps(duration: number, fps: number, sample: (t: number) => THREE.Vector3[]): { from: number; to: number } {
  const step = 1 / fps;
  const jump = (a: number, b: number): boolean => {
    const pa = sample(a); const pb = sample(b);
    return pa.some((p, i) => p.distanceTo(pb[i]!) / (b - a) > SNAP_SPEED);
  };
  let from = 0;
  for (let t = 0; t + step <= Math.min(duration, SNAP_WINDOW_SEC); t += step) if (jump(t, t + step)) from = t + step;
  let to = duration;
  for (let t = duration; t - step >= Math.max(from, duration - SNAP_WINDOW_SEC); t -= step) if (jump(t - step, t)) to = t - step;
  return { from, to };
}

// ---------------------------------------------------------------------------
// Reading a take

export const quatAt = (track: readonly number[], f: number, out = new THREE.Quaternion()): THREE.Quaternion => out.fromArray(track as number[], f * 4).normalize();
export const vecAt = (track: readonly number[], f: number, out = new THREE.Vector3()): THREE.Vector3 => out.fromArray(track as number[], f * 3);

/** The 18 motion joints of a take as motion-quality frames. */
export function takeMotion(take: Pick<Take, 'frames' | 'fps' | 'joints'>): MotionFrame[] {
  const out: MotionFrame[] = [];
  for (let f = 0; f < take.frames; f += 1) {
    const joints: MotionFrame['joints'] = {};
    for (const [j, track] of Object.entries(take.joints) as [JointName, number[]][]) joints[j] = [track[f * 3]!, track[f * 3 + 1]!, track[f * 3 + 2]!];
    out.push({ timeSec: f / take.fps, joints });
  }
  return out;
}

/** Where the head points: the bind's forward (+Z) turned by the head's rotation from bind; degrees. */
export function lookAt(take: Pick<Take, 'bones'>, f: number): { yaw: number; pitch: number } {
  const d = new THREE.Vector3(0, 0, 1).applyQuaternion(quatAt(take.bones.head!, f));
  return { yaw: Math.atan2(d.x, d.z) * THREE.MathUtils.RAD2DEG, pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) * THREE.MathUtils.RAD2DEG };
}

/** Speed of a joint at a frame (central difference), m/s. */
export function jointSpeed(take: Pick<Take, 'frames' | 'fps' | 'joints'>, joint: JointName, f: number): number {
  const t = take.joints[joint];
  if (!t) return 0;
  const a = Math.max(0, f - 1);
  const b = Math.min(take.frames - 1, f + 1);
  if (a === b) return 0;
  return Math.hypot(t[b * 3]! - t[a * 3]!, t[b * 3 + 1]! - t[a * 3 + 1]!, t[b * 3 + 2]! - t[a * 3 + 2]!) * take.fps / (b - a);
}

/** Head angular speed at a frame, degrees per second. */
export function headTurnSpeed(take: Pick<Take, 'frames' | 'fps' | 'bones'>, f: number): number {
  const a = Math.max(0, f - 1);
  const b = Math.min(take.frames - 1, f + 1);
  if (a === b) return 0;
  return quatAt(take.bones.head!, a).angleTo(quatAt(take.bones.head!, b)) * THREE.MathUtils.RAD2DEG * take.fps / (b - a);
}

/** Below these the wrists and head count as holding. */
export const HOLD = { wristSpeed: 0.18, headTurn: 25, minSec: 0.4 } as const;

/** Moves and holds: a hold is at least `HOLD.minSec` with both wrists under `HOLD.wristSpeed` and the head under `HOLD.headTurn`. */
export function findBeats(take: Omit<Take, 'beats'>): TakeBeat[] {
  const n = take.frames;
  const still: boolean[] = [];
  const wrist: number[] = [];
  for (let f = 0; f < n; f += 1) {
    const s = Math.max(jointSpeed(take, 'leftWrist', f), jointSpeed(take, 'rightWrist', f));
    wrist.push(s);
    still.push(s < HOLD.wristSpeed && headTurnSpeed(take, f) < HOLD.headTurn);
  }
  // Smooth over single-frame flickers.
  for (let f = 1; f < n - 1; f += 1) if (still[f - 1] === still[f + 1] && still[f] !== still[f - 1]) still[f] = still[f - 1]!;
  const spans: { kind: 'move' | 'hold'; from: number; to: number }[] = [];
  for (let f = 0; f < n; f += 1) {
    const kind = still[f] ? 'hold' : 'move';
    const last = spans[spans.length - 1];
    if (last && last.kind === kind) last.to = f; else spans.push({ kind, from: f, to: f });
  }
  // A hold shorter than the minimum is part of the move around it.
  const minFrames = Math.round(HOLD.minSec * take.fps);
  const merged: typeof spans = [];
  for (const s of spans) {
    const kind = s.kind === 'hold' && s.to - s.from + 1 < minFrames ? 'move' : s.kind;
    const last = merged[merged.length - 1];
    if (last && last.kind === kind) last.to = s.to; else merged.push({ ...s, kind });
  }
  return merged.map((s, i) => {
    let yaw = 0; let pitch = 0; let peak = 0;
    for (let f = s.from; f <= s.to; f += 1) { const l = lookAt(take, f); yaw += l.yaw; pitch += l.pitch; peak = Math.max(peak, wrist[f]!); }
    const k = s.to - s.from + 1;
    return { id: `b${i + 1}`, kind: s.kind, from: round(s.from / take.fps, 3), to: round(s.to / take.fps, 3), look: { yaw: round(yaw / k, 1), pitch: round(pitch / k, 1) }, peakWristSpeed: round(peak, 2) };
  });
}
