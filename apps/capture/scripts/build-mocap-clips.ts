/**
 * Replaces the shipped avatar's hand-keyed Idle and Walk with motion-capture
 * loops, and adds the one-shot Leap the desktop jump's arms follow (docs/features/realistic-avatar-motion.md), then the clip library is
 * rebuilt from it (`build-locomotion-library.ts`).
 *
 * Source: the CMU Graphics Lab Motion Capture Database (mocap.cs.cmu.edu,
 * free for any use, raw data not resold), as the original ASF/AMC takes
 * (mocap.cs.cmu.edu/subjects/<subject>/<take>.amc and <subject>.asf). Each
 * take is dumped to JSON by `scripts/mocap/amc-to-dump.ts`; the takes and the
 * dumps stay out of git:
 *
 *   node --import tsx scripts/mocap/amc-to-dump.ts <subject>.asf <take>.amc <dir>/<take>.json
 *   node --import tsx scripts/build-mocap-clips.ts <dir with the JSON dumps>
 *
 * Per loop: the CMU skeleton is rebuilt in three.js under its Mixamo names,
 * one cycle is cut between two left heel strikes (normalized time 0), turned
 * so the travel points at +Z, its seam closed by spreading the end-to-start
 * mismatch over the cycle (a `mirror` loop: its first step closed onto that
 * step mirrored, which then makes the second), and lightly low-passed; then `retargetClips` moves
 * it onto the shipped rig, exactly as an avatar without clips gets them.
 */
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO, type Animation, type Document } from '@gltf-transform/core';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { HumanoidSkeleton } from '../src/avatar/HumanoidSkeleton.ts';
import { retargetClips, type RetargetRig } from '../src/animation/retargetClips.ts';
import { LOCOMOTION_LIBRARY } from './build-locomotion-library.ts';

const SHIPPED = fileURLToPath(new URL('../public/gltf/models/avatar.glb', import.meta.url));

/**
 * One loop: its CMU take and frame range (30 fps), cut at left heel strikes for gaits.
 * `mirror`: the loop is the first half of the range (left strike to right strike) and then that half
 * mirrored left for right, so both legs walk the same step (a recorded cycle is rarely symmetric).
 */
export interface MocapLoop { readonly name: string; readonly take: string; readonly from: number; readonly to: number; readonly mirror?: boolean; readonly sway?: number; readonly once?: boolean }

export const MOCAP_LOOPS: readonly MocapLoop[] = [
  // Subject 7, trial 12, "brisk walk": a 0.9 s cycle at 1.93 m/s, near the desktop walk's 1.8. Its left
  // step is the cleaner one (the right stance bends the knee to 43°, the left to 36°), so it walks that step twice.
  { name: 'Walk', take: '07_12', from: 8, to: 35, mirror: true },
  // Subject 113, trial 21, "standing still": breathing, a slow sway and small weight shifts, arms at
  // the sides. ("Normal waiting", 137_28, fidgets: its hands travel three times as far, in gestures that
  // replay on every stop.)
  // Played at 40% of its sway about the mean pose: the full take drifts the head 5 cm in a frame of view
  // that follows the eyes (the desktop camera and aim), where 2 cm reads as standing still and alive.
  { name: 'Idle', take: '113_21', from: 0, to: 0, sway: 0.4 },
  // Subject 13, trial 42, "jump": a standing jump with a full arm swing that keeps moving through the flight (118_01, the
  // first pick, swings the arms back hard but only to 20° in front, then holds them there). Not a loop (`once`): the
  // squat with the arms going back (frame 24), the arms at their furthest back, 78° behind, as the legs drive (34),
  // lift-off with the arms 73° in front (46), falling through the flight to 22° at touch-down (63), and the absorb (70).
  // The desktop body's jump scrubs its arms through it in step with the game's own jump (JumpArms); no locomotion state
  // plays it, so its name matches none of theirs.
  { name: 'Leap', take: '13_42', from: 14, to: 94, once: true }
];

// CMU bone → Mixamo name (what HumanoidSkeleton binds). Buttocks fold into
// the hips, eyes and the second finger joints are dropped; the first finger
// joints stay unanimated so the retarget can match the palm roll.
const NAMES: Record<string, string> = {
  hip: 'Hips', abdomen: 'Spine', chest: 'Spine1', neck: 'Neck', head: 'Head',
  lCollar: 'LeftShoulder', lShldr: 'LeftArm', lForeArm: 'LeftForeArm', lHand: 'LeftHand',
  rCollar: 'RightShoulder', rShldr: 'RightArm', rForeArm: 'RightForeArm', rHand: 'RightHand',
  lThigh: 'LeftUpLeg', lShin: 'LeftLeg', lFoot: 'LeftFoot', lToe: 'LeftToeBase',
  rThigh: 'RightUpLeg', rShin: 'RightLeg', rFoot: 'RightFoot', rToe: 'RightToeBase',
  lIndex1: 'LeftHandIndex1', lMid1: 'LeftHandMiddle1', lPinky1: 'LeftHandPinky1',
  rIndex1: 'RightHandIndex1', rMid1: 'RightHandMiddle1', rPinky1: 'RightHandPinky1'
};
const STATIC = new Set(['lIndex1', 'lMid1', 'lPinky1', 'rIndex1', 'rMid1', 'rPinky1']);
// Gaussian low-pass over the loop (sigma ≈ 1 frame at 30 fps): removes marker jitter, keeps the heel strike.
const SMOOTH = [0.06, 0.24, 0.4, 0.24, 0.06];
// Idle window search: lengths in frames and the stride between candidate starts.
const IDLE_LENGTHS = [150, 180, 210, 240];
const IDLE_STEP = 5;

interface Dump {
  fps: number;
  rest: Record<string, { parent: string | null; q: number[]; p: number[] }>;
  frames: Array<Record<string, number[]>>;
}

// Blender (z-up, cm) → glTF (y-up, m).
const toYUpQ = (w: number, x: number, y: number, z: number) => new THREE.Quaternion(x, z, -y, w);
const toYUpP = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y).multiplyScalar(0.01);

/** The nearest kept ancestor (buttocks fold into the hips). */
function keptParent(dump: Dump, bone: string): string | null {
  for (let p = dump.rest[bone]!.parent; p; p = dump.rest[p]!.parent) if (NAMES[p]) return p;
  return null;
}

/** World (armature) rotations of every kept bone in one frame. */
function worldRotations(frame: Record<string, number[]>): Map<string, THREE.Quaternion> {
  const out = new Map<string, THREE.Quaternion>();
  for (const bone of Object.keys(NAMES)) {
    const v = frame[bone];
    if (v) out.set(bone, toYUpQ(v[0]!, v[1]!, v[2]!, v[3]!).normalize());
  }
  return out;
}

/** The CMU skeleton at rest under a root, bones named for the humanoid binder. */
function buildSourceRig(dump: Dump): { root: THREE.Group; bones: Map<string, THREE.Bone> } {
  const root = new THREE.Group();
  const bones = new Map<string, THREE.Bone>();
  const restQ = (b: string) => { const q = dump.rest[b]!.q; return toYUpQ(q[0]!, q[1]!, q[2]!, q[3]!).normalize(); };
  const restP = (b: string) => { const p = dump.rest[b]!.p; return toYUpP(p[0]!, p[1]!, p[2]!); };
  for (const b of Object.keys(NAMES)) {
    const bone = new THREE.Bone();
    bone.name = NAMES[b]!;
    bones.set(b, bone);
  }
  for (const [b, bone] of bones) {
    const parent = keptParent(dump, b);
    const parentQ = parent ? restQ(parent) : new THREE.Quaternion();
    const parentP = parent ? restP(parent) : new THREE.Vector3();
    const inv = parentQ.clone().invert();
    bone.quaternion.copy(inv.clone().multiply(restQ(b)));
    bone.position.copy(restP(b).sub(parentP).applyQuaternion(inv));
    (parent ? bones.get(parent)! : root).add(bone);
  }
  root.updateMatrixWorld(true);
  return { root, bones };
}

/** How far a standing take is turned from its rest facing: the mean left-to-right thigh line against the rest's. */
function standingYaw(dump: Dump, from: number, to: number): number {
  const at = (v: readonly number[]) => toYUpP(v[0]!, v[1]!, v[2]!);
  const rest = at(dump.rest.lThigh!.p).sub(at(dump.rest.rThigh!.p));
  const across = new THREE.Vector3();
  for (let f = from; f <= to; f++) {
    const frame = dump.frames[f]!;
    across.add(toYUpP(frame.lThigh![4]!, frame.lThigh![5]!, frame.lThigh![6]!).sub(toYUpP(frame.rThigh![4]!, frame.rThigh![5]!, frame.rThigh![6]!)));
  }
  // The turn about +Y that takes the rest's thigh line onto the take's, which travel's atan2(x, z) also measures.
  return Math.atan2(rest.z, rest.x) - Math.atan2(across.z, across.x);
}

/** Local rotations per kept bone over frames [from, to] (to included), travel turned to +Z. */
function localTrack(dump: Dump, from: number, to: number): Map<string, THREE.Quaternion[]> {
  const hipAt = (f: number) => { const v = dump.frames[f]!.hip!; return toYUpP(v[4]!, v[5]!, v[6]!); };
  const travel = hipAt(to).sub(hipAt(from)).setY(0);
  // A take that does not travel (idle) is turned to the rest facing by its thighs: the subject of 113_21
  // stands about 100° off the capture's axes.
  const yaw = travel.length() > 0.2 ? Math.atan2(travel.x, travel.z) : standingYaw(dump, from, to);
  const unturn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
  const out = new Map<string, THREE.Quaternion[]>();
  for (let f = from; f <= to; f++) {
    const world = worldRotations(dump.frames[f]!);
    for (const [b, q] of world) {
      const parent = keptParent(dump, b);
      const local = parent ? world.get(parent)!.clone().invert().multiply(q) : unturn.clone().multiply(q);
      const list = out.get(b) ?? [];
      // Same hemisphere as the previous key, so slerp and the filter take the short way.
      const prev = list.at(-1);
      if (prev && prev.dot(local) < 0) local.set(-local.x, -local.y, -local.z, -local.w);
      list.push(local);
      out.set(b, list);
    }
  }
  return out;
}

/** Spreads the mismatch between the last key and `end` over the keys, so the last key equals `end`. */
function closeTo(keys: THREE.Quaternion[], end: THREE.Quaternion): THREE.Quaternion[] {
  const n = keys.length - 1;
  const last = keys[n]!.clone();
  if (last.dot(end) < 0) last.set(-last.x, -last.y, -last.z, -last.w);
  const mismatch = end.clone().multiply(last.clone().invert());
  const identity = new THREE.Quaternion();
  return keys.map((q, i) => new THREE.Quaternion().slerpQuaternions(identity, mismatch, i / n).multiply(q));
}

/** Low-passes a closed loop (last key equals the first) as a loop. */
function smoothLoop(keys: THREE.Quaternion[]): THREE.Quaternion[] {
  const n = keys.length - 1;
  const closed = keys.slice(0, n);
  const half = (SMOOTH.length - 1) / 2;
  const smoothed = closed.map((center, i) => {
    let x = 0, y = 0, z = 0, w = 0;
    SMOOTH.forEach((weight, k) => {
      const q = closed[(i + k - half + n) % n]!;
      const s = q.dot(center) < 0 ? -weight : weight;
      x += q.x * s; y += q.y * s; z += q.z * s; w += q.w * s;
    });
    return new THREE.Quaternion(x, y, z, w).normalize();
  });
  return [...smoothed, smoothed[0]!.clone()];
}

// Mirroring in the travel-aligned frame (+Z forward, +Y up): left and right swap, and a rotation's
// lateral (x) axis keeps its sense while the others flip. Every source bone rests unturned, so this holds for local rotations.
const SIDE = /^([lr])([A-Z].*)$/;
const swapSide = (bone: string) => bone.replace(SIDE, (_, s: string, rest: string) => `${s === 'l' ? 'r' : 'l'}${rest}`);
const mirrorQ = (q: THREE.Quaternion) => new THREE.Quaternion(q.x, -q.y, -q.z, q.w);

/** Low-passes an open one-shot track, the ends held. */
function smoothOnce(keys: THREE.Quaternion[]): THREE.Quaternion[] {
  const half = (SMOOTH.length - 1) / 2;
  return keys.map((center, i) => {
    let x = 0, y = 0, z = 0, w = 0;
    SMOOTH.forEach((weight, k) => {
      const q = keys[Math.min(keys.length - 1, Math.max(0, i + k - half))]!;
      const s = q.dot(center) < 0 ? -weight : weight;
      x += q.x * s; y += q.y * s; z += q.z * s; w += q.w * s;
    });
    return new THREE.Quaternion(x, y, z, w).normalize();
  });
}

/** Each bone's keys closed into a loop: end to start, or (mirror) a half closed onto its own mirror and followed by it. */
function loopTracks(local: Map<string, THREE.Quaternion[]>, mirror: boolean): Map<string, THREE.Quaternion[]> {
  const out = new Map<string, THREE.Quaternion[]>();
  if (!mirror) {
    for (const [b, keys] of local) out.set(b, smoothLoop(closeTo(keys, keys[0]!)));
    return out;
  }
  const length = local.values().next().value!.length - 1;
  // The right strike: the frame near mid-cycle whose pose best matches the first frame mirrored.
  const angle = (a: THREE.Quaternion, b: THREE.Quaternion) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b))));
  let half = Math.round(length / 2), best = Infinity;
  for (let m = Math.round(length * 0.4); m <= Math.round(length * 0.6); m++) {
    let cost = 0;
    for (const [b, keys] of local) cost += angle(keys[m]!, mirrorQ(local.get(swapSide(b))![0]!));
    if (cost < best) { best = cost; half = m; }
  }
  const halves = new Map<string, THREE.Quaternion[]>();
  for (const [b, keys] of local) halves.set(b, closeTo(keys.slice(0, half + 1), mirrorQ(local.get(swapSide(b))![0]!)));
  for (const [b, keys] of halves) {
    const first = keys.slice(0, half);
    const second = halves.get(swapSide(b))!.slice(0, half).map(mirrorQ);
    const loop = [...first, ...second, first[0]!.clone()];
    // Same hemisphere key to key, so slerp and the filter take the short way.
    for (let i = 1; i < loop.length; i++) if (loop[i]!.dot(loop[i - 1]!) < 0) loop[i]!.set(-loop[i]!.x, -loop[i]!.y, -loop[i]!.z, -loop[i]!.w);
    out.set(b, smoothLoop(loop));
  }
  return out;
}

/** The idle window whose end pose best matches its start (sum of local angles), so the seam needs the least closing. */
function idleWindow(dump: Dump): { from: number; to: number } {
  const frames = dump.frames.map(worldRotations);
  const angle = (a: THREE.Quaternion, b: THREE.Quaternion) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b))));
  let best = { from: 0, to: IDLE_LENGTHS[0]!, cost: Infinity };
  for (const length of IDLE_LENGTHS) {
    for (let from = 0; from + length < frames.length; from += IDLE_STEP) {
      const a = frames[from]!, b = frames[from + length]!;
      let cost = 0;
      for (const [bone, q] of a) cost += angle(q, b.get(bone)!);
      // Hips travel counts too (1 cm ≈ 1°).
      const pa = dump.frames[from]!.hip!, pb = dump.frames[from + length]!.hip!;
      cost += Math.hypot(pa[4]! - pb[4]!, pa[5]! - pb[5]!) * THREE.MathUtils.degToRad(1);
      if (cost < best.cost) best = { from, to: from + length, cost };
    }
  }
  return best;
}

async function loadTarget(): Promise<RetargetRig> {
  const bytes = await readFile(LOCOMOTION_LIBRARY);
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, '');
  const humanoid = HumanoidSkeleton.bind(gltf.scene, { json: gltf.parser.json, associations: gltf.parser.associations as never });
  humanoid.normalizeFacing(gltf.scene);
  return { root: gltf.scene, humanoid };
}

/** Each bone's keys drawn toward its mean rotation: `sway` 1 keeps the take, 0 holds the mean pose. */
function scaleSway(local: Map<string, THREE.Quaternion[]>, sway: number): Map<string, THREE.Quaternion[]> {
  if (sway === 1) return local;
  for (const keys of local.values()) {
    const mean = new THREE.Vector4();
    for (const q of keys) {
      const sign = q.x * keys[0]!.x + q.y * keys[0]!.y + q.z * keys[0]!.z + q.w * keys[0]!.w < 0 ? -1 : 1;
      mean.x += sign * q.x; mean.y += sign * q.y; mean.z += sign * q.z; mean.w += sign * q.w;
    }
    const centre = new THREE.Quaternion(mean.x, mean.y, mean.z, mean.w).normalize();
    for (const q of keys) q.copy(centre.clone().slerp(q, sway));
  }
  return local;
}

/** One retargeted clip per loop, tracks named by the shipped rig's node names. */
export async function buildMocapClips(dumpDir: string): Promise<{ clips: THREE.AnimationClip[]; ranges: MocapLoop[] }> {
  const target = await loadTarget();
  const clips: THREE.AnimationClip[] = [];
  const ranges: MocapLoop[] = [];
  for (const loop of MOCAP_LOOPS) {
    // A take whose dump is not in the directory keeps its committed clip (writeClips replaces only what was built).
    const file = path.join(dumpDir, `${loop.take}.json`);
    if (!(await access(file).then(() => true, () => false))) {
      console.log(`[mocap] ${loop.name}: no ${loop.take}.json, kept as committed`);
      continue;
    }
    const dump = JSON.parse(await readFile(file, 'utf8')) as Dump;
    const range = loop.to > loop.from ? loop : { ...loop, ...idleWindow(dump) };
    ranges.push({ name: loop.name, take: loop.take, from: range.from, to: range.to, ...(loop.mirror ? { mirror: true } : {}), ...(loop.once ? { once: true } : {}) });
    const { root, bones } = buildSourceRig(dump);
    const humanoid = HumanoidSkeleton.bind(root, {});
    humanoid.normalizeFacing(root);
    const cut = localTrack(dump, range.from, range.to);
    const local = loop.once
      ? new Map([...cut].map(([b, keys]) => [b, smoothOnce(keys)] as const))
      : scaleSway(loopTracks(cut, loop.mirror === true), loop.sway ?? 1);
    const tracks: THREE.KeyframeTrack[] = [];
    const times = Array.from({ length: local.values().next().value!.length }, (_, i) => i / dump.fps);
    for (const [b, keys] of local) {
      if (STATIC.has(b)) continue;
      const values = keys.flatMap((q) => [q.x, q.y, q.z, q.w]);
      tracks.push(new THREE.QuaternionKeyframeTrack(`${bones.get(b)!.name}.quaternion`, times, values));
    }
    const source = new THREE.AnimationClip(loop.name, times.at(-1)!, tracks);
    const { clips: [retargeted] } = retargetClips({ root, humanoid }, [source], target);
    // Retargeted tracks bind by uuid; the glTF channels need node names.
    for (const track of retargeted!.tracks) {
      const [uuid, property] = track.name.split('.');
      const node = target.root.getObjectByProperty('uuid', uuid);
      if (!node?.name) throw new Error(`retargeted track ${track.name} has no named node`);
      track.name = `${node.name}.${property}`;
    }
    clips.push(retargeted!);
  }
  return { clips, ranges };
}

/** Replaces the named animations in `doc` with `clips` (rotation channels, linear). */
export function writeClips(doc: Document, clips: readonly THREE.AnimationClip[]): void {
  const root = doc.getRoot();
  const buffer = root.listBuffers()[0]!;
  const nodes = new Map(root.listNodes().map((n) => [n.getName(), n]));
  for (const clip of clips) {
    // Reuse the animation in place, so the clip order (Idle, Walk, Jump, Fall) holds.
    const animation: Animation = root.listAnimations().find((a) => a.getName() === clip.name) ?? doc.createAnimation(clip.name);
    for (const s of animation.listSamplers()) { s.getInput()?.dispose(); s.getOutput()?.dispose(); s.dispose(); }
    for (const c of animation.listChannels()) c.dispose();
    const input = doc.createAccessor().setType('SCALAR').setArray(new Float32Array(clip.tracks[0]!.times)).setBuffer(buffer);
    for (const track of clip.tracks) {
      const [name, property] = track.name.split('.');
      if (property !== 'quaternion') throw new Error(`unexpected ${track.name}`);
      const node = nodes.get(name!);
      if (!node) throw new Error(`no node ${name} for ${clip.name}`);
      const output = doc.createAccessor().setType('VEC4').setArray(new Float32Array(track.values)).setBuffer(buffer);
      const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
      animation.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath('rotation').setSampler(sampler));
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: build-mocap-clips.ts <dir with the CMU JSON dumps>');
  const { clips, ranges } = await buildMocapClips(path.resolve(dir));
  const io = new NodeIO();
  const doc = await io.read(SHIPPED);
  writeClips(doc, clips);
  await writeFile(SHIPPED, await io.writeBinary(doc));
  for (const r of ranges) console.log(`[mocap] ${r.name}: CMU ${r.take} frames ${r.from}-${r.to}${r.mirror ? " (first half, mirrored)" : ""}, ${clips.find((c) => c.name === r.name)!.duration.toFixed(2)} s (${clips.find((c) => c.name === r.name)!.tracks.length} tracks)`);
}
