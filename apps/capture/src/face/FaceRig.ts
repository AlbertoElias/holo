import * as THREE from 'three';
import {
  FACE_CHANNELS,
  MAX_PITCH,
  MAX_YAW,
  type EyeGaze,
  type FaceChannel,
  type FaceStandard,
  type TargetFormula,
  arkitFromGaze,
  evaluateTarget,
  resolveMorphTarget,
  routeToBound
} from '@holoim/avatar-face';
import type { FaceGaze, FaceWeights } from './faceTypes';

interface MorphBinding {
  mesh: THREE.Mesh;
  index: number;
  name: string;
  standard: FaceStandard;
  formula: TargetFormula;
  // Channels this mesh's targets show: each mesh routes the rest on its own,
  // so a viseme the teeth carry still moves the head's jaw.
  meshBound: Set<FaceChannel>;
}

interface EyeBinding {
  bone: THREE.Object3D;
  // Bone-local rotation is inverse(parentBind) * gaze * eyeBind, both bind
  // orientations relative to the avatar root; see setGaze.
  parentBind: THREE.Quaternion;
  parentBindInverse: THREE.Quaternion;
  eyeBind: THREE.Quaternion;
  // Distance from the bone origin to the fitted eyeball centre; see pivotOffset.
  pivotOffsetMm: number | null;
}

export interface FaceBindingReport {
  morphTargets: Array<{ mesh: string; name: string; standard: FaceStandard | null }>;
  boundChannels: FaceChannel[];
  // Channels the avatar can neither show nor route to a nearby one.
  unroutableChannels: FaceChannel[];
  unresolvedTargets: string[];
  // Combined targets left at 0 because the same mesh has a target per channel
  // (a VRM "blink" beside "blinkLeft" and "blinkRight").
  suppressedTargets: string[];
  // What turns the eyes: bones, eyeLook morphs, or nothing.
  gazeBy: 'bones' | 'morphs' | 'none';
  eyes: { left: boolean; right: boolean; pivotOffsetMm: { left: number | null; right: number | null } };
}

const EYE_BONE_NAMES = {
  left: ['LeftEye', 'leftEye', 'Eye_L', 'eye_L', 'J_Adj_L_FaceEye', 'EyeLeft'],
  right: ['RightEye', 'rightEye', 'Eye_R', 'eye_R', 'J_Adj_R_FaceEye', 'EyeRight']
} as const;
const EYE_MESH_NAMES = { left: ['EyeLeft', 'Eye_L'], right: ['EyeRight', 'Eye_R'] } as const;
const HEAD_BONE_NAMES = ['Head', 'head', 'J_Bip_C_Head', 'CC_Base_Head'] as const;
const GAZE_CHANNELS = new Set<FaceChannel>(FACE_CHANNELS.filter((channel) => channel.startsWith('eyeLook')));

/**
 * Drives an avatar's face from canonical weights: every morph target whose
 * name resolves to a known standard, and the eye bones for gaze. Channels the
 * avatar cannot show are routed to the nearest ones it can.
 */
export class FaceRig {
  private readonly morphs: MorphBinding[] = [];
  private readonly unresolved: string[] = [];
  private readonly suppressed: string[] = [];
  private readonly suppressedBindings: MorphBinding[] = [];
  private readonly bound = new Set<FaceChannel>();
  private readonly eyes: { left: EyeBinding | null; right: EyeBinding | null } = { left: null, right: null };
  // Morph-only rigs aim their gaze from the head: its bind orientation
  // relative to the avatar root, as for the eyes' parents.
  private head: { bone: THREE.Object3D; bindInverse: THREE.Quaternion } | null = null;
  private readonly gazeQuat = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly tmpPosition = new THREE.Vector3();
  private readonly tmpDirection = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();

  constructor(avatar: THREE.Object3D) {
    avatar.updateMatrixWorld(true);
    avatar.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.morphTargetDictionary || !mesh.morphTargetInfluences) return;
      const meshBound = new Set<FaceChannel>();
      const meshMorphs: MorphBinding[] = [];
      for (const [name, index] of Object.entries(mesh.morphTargetDictionary)) {
        const resolved = resolveMorphTarget(name);
        if (!resolved) {
          this.unresolved.push(`${mesh.name}:${name}`);
          continue;
        }
        meshMorphs.push({ mesh, index, name, standard: resolved.standard, formula: resolved.formula, meshBound });
      }
      // A target that only combines channels the mesh already shows one by
      // one would add its displacement on top of theirs.
      const single = new Set(meshMorphs.filter((m) => channelsOf(m.formula).size === 1).flatMap((m) => [...channelsOf(m.formula)]));
      for (const binding of meshMorphs) {
        const channels = channelsOf(binding.formula);
        if (channels.size > 1 && [...channels].every((channel) => single.has(channel))) {
          this.suppressed.push(`${mesh.name}:${binding.name}`);
          this.suppressedBindings.push(binding);
          continue;
        }
        this.morphs.push(binding);
        for (const channel of channels) {
          this.bound.add(channel);
          meshBound.add(channel);
        }
      }
    });
    const rootInverse = avatar.getWorldQuaternion(new THREE.Quaternion()).invert();
    for (const side of ['left', 'right'] as const) {
      const bone = findFirst(avatar, EYE_BONE_NAMES[side], (o) => (o as THREE.Bone).isBone === true);
      if (!bone?.parent) continue;
      const eyeBind = rootInverse.clone().multiply(bone.getWorldQuaternion(new THREE.Quaternion()));
      const parentBind = rootInverse.clone().multiply(bone.parent.getWorldQuaternion(new THREE.Quaternion()));
      const eyeMesh = findFirst(avatar, EYE_MESH_NAMES[side], (o) => (o as THREE.Mesh).isMesh === true) as THREE.Mesh | undefined;
      this.eyes[side] = {
        bone,
        parentBind,
        parentBindInverse: parentBind.clone().invert(),
        eyeBind,
        pivotOffsetMm: eyeMesh ? pivotOffset(bone, eyeMesh) : null
      };
    }
    const head = findFirst(avatar, HEAD_BONE_NAMES, (o) => (o as THREE.Bone).isBone === true);
    if (head) this.head = { bone: head, bindInverse: rootInverse.clone().multiply(head.getWorldQuaternion(new THREE.Quaternion())).invert() };
    for (const binding of this.suppressedBindings) binding.mesh.morphTargetInfluences![binding.index] = 0;
  }

  /** Eye bones turn the eyes when both exist; otherwise eyeLook morphs, if any. */
  get gazeBy(): 'bones' | 'morphs' | 'none' {
    if (this.eyes.left && this.eyes.right) return 'bones';
    return [...GAZE_CHANNELS].some((channel) => this.bound.has(channel)) ? 'morphs' : 'none';
  }

  get hasFace(): boolean {
    return this.morphs.length > 0 || this.eyes.left !== null || this.eyes.right !== null;
  }

  /**
   * Sets the face absolutely (not additively): every bound morph target, and
   * the gaze on whichever one thing turns the eyes, so eye bones and eyeLook
   * morphs never both carry it.
   */
  apply(weights: FaceWeights, gaze: FaceGaze): void {
    const by = this.gazeBy;
    const face: FaceWeights = {};
    for (const [channel, value] of Object.entries(weights) as [FaceChannel, number][]) {
      if (!GAZE_CHANNELS.has(channel)) face[channel] = value;
    }
    if (by === 'morphs') Object.assign(face, arkitFromGaze(gaze));
    this.setWeights(face);
    if (by === 'bones') this.setGaze(gaze);
  }

  private setWeights(weights: FaceWeights): void {
    const routed = new Map<Set<FaceChannel>, FaceWeights>();
    for (const binding of this.morphs) {
      let meshWeights = routed.get(binding.meshBound);
      if (!meshWeights) routed.set(binding.meshBound, (meshWeights = routeToBound(weights, binding.meshBound)));
      binding.mesh.morphTargetInfluences![binding.index] = evaluateTarget(binding.formula, meshWeights);
    }
  }

  /**
   * Gaze is yaw (+ toward the avatar's own left) and pitch (+ up) in the
   * head's frame. Set absolutely each frame: local = inverse(parentBind) *
   * gaze * eyeBind, which leaves the eye position unchanged because the bone
   * rotates about its own origin.
   */
  private setGaze(gaze: { left: EyeGaze; right: EyeGaze }): void {
    for (const side of ['left', 'right'] as const) {
      const eye = this.eyes[side];
      if (!eye) continue;
      this.euler.set(-gaze[side].pitch, gaze[side].yaw, 0, 'YXZ');
      this.gazeQuat.setFromEuler(this.euler);
      eye.bone.quaternion.copy(eye.parentBindInverse).multiply(this.gazeQuat).multiply(eye.eyeBind);
    }
  }

  /**
   * Gaze that aims both eyes at a world point (vergence included), in each
   * eye's head frame: the root-aligned bind frame carried by the eye's parent.
   */
  gazeTowardPoint(point: THREE.Vector3): FaceGaze | null {
    const left = this.eyes.left;
    const right = this.eyes.right;
    if (!left || !right) {
      if (this.gazeBy !== 'morphs' || !this.head) return null;
      // No eyes to converge: aim both from the head, in its bind frame.
      const direction = this.tmpDirection.copy(point).sub(this.head.bone.getWorldPosition(this.tmpPosition));
      direction.applyQuaternion(this.head.bone.getWorldQuaternion(this.tmpQuat).multiply(this.head.bindInverse).invert());
      const eye = {
        yaw: THREE.MathUtils.clamp(Math.atan2(direction.x, direction.z), -MAX_YAW, MAX_YAW),
        pitch: THREE.MathUtils.clamp(Math.atan2(direction.y, Math.hypot(direction.x, direction.z)), -MAX_PITCH, MAX_PITCH)
      };
      return { left: eye, right: { ...eye } };
    }
    const toward = (eye: EyeBinding): { yaw: number; pitch: number } => {
      const eyePosition = eye.bone.getWorldPosition(this.tmpPosition);
      const direction = this.tmpDirection.copy(point).sub(eyePosition);
      // Face frame now = parentWorld * inverse(parentBind).
      const frame = eye.bone.parent!.getWorldQuaternion(this.tmpQuat).multiply(eye.parentBindInverse);
      direction.applyQuaternion(frame.invert());
      return {
        yaw: THREE.MathUtils.clamp(Math.atan2(direction.x, direction.z), -MAX_YAW, MAX_YAW),
        pitch: THREE.MathUtils.clamp(Math.atan2(direction.y, Math.hypot(direction.x, direction.z)), -MAX_PITCH, MAX_PITCH)
      };
    };
    return { left: toward(left), right: toward(right) };
  }

  /** Current influences of every bound target, for automation sampling. */
  sampleInfluences(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const binding of this.morphs) out[`${binding.mesh.name}:${binding.name}`] = binding.mesh.morphTargetInfluences![binding.index] ?? 0;
    return out;
  }

  /** Eye bone yaw and pitch relative to bind, recovered from the bone, in radians. */
  sampleGaze(): { left: EyeGaze | null; right: EyeGaze | null } {
    const read = (eye: EyeBinding | null): EyeGaze | null => {
      if (!eye) return null;
      // gaze = parentBind * local * inverse(eyeBind)
      const q = eye.parentBindInverse.clone().invert().multiply(eye.bone.quaternion).multiply(eye.eyeBind.clone().invert());
      const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
      return { yaw: e.y, pitch: -e.x };
    };
    return { left: read(this.eyes.left), right: read(this.eyes.right) };
  }

  report(): FaceBindingReport {
    return {
      morphTargets: this.morphs.map((m) => ({ mesh: m.mesh.name, name: m.name, standard: m.standard })),
      boundChannels: [...this.bound].sort(),
      unroutableChannels: FACE_CHANNELS.filter((channel) => !this.bound.has(channel) && Object.keys(routeToBound({ [channel]: 1 }, this.bound)).length === 0),
      unresolvedTargets: [...this.unresolved],
      suppressedTargets: [...this.suppressed],
      gazeBy: this.gazeBy,
      eyes: {
        left: this.eyes.left !== null,
        right: this.eyes.right !== null,
        pivotOffsetMm: { left: this.eyes.left?.pivotOffsetMm ?? null, right: this.eyes.right?.pivotOffsetMm ?? null }
      }
    };
  }
}

function findFirst(root: THREE.Object3D, names: readonly string[], accept: (o: THREE.Object3D) => boolean): THREE.Object3D | undefined {
  for (const name of names) {
    let found: THREE.Object3D | undefined;
    root.traverse((o) => {
      if (!found && o.name === name && accept(o)) found = o;
    });
    if (found) return found;
  }
  return undefined;
}

// The eyeball's sphere centre relative to the bone origin, by a least-squares
// fit of the outer surface (the mesh also has vertices near its centre).
// Near 0 when the bone sits at the eyeball centre, so rotating it never
// shifts the eye in its socket.
function pivotOffset(bone: THREE.Object3D, mesh: THREE.Mesh): number | null {
  const position = mesh.geometry.getAttribute('position');
  if (!position) return null;
  const pivot = bone.getWorldPosition(new THREE.Vector3());
  const points: THREE.Vector3[] = [];
  let max = 0;
  for (let i = 0; i < position.count; i += 1) {
    // Skinned eye meshes are authored in bind space; the avatar is at bind here.
    const p = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld).sub(pivot);
    points.push(p);
    max = Math.max(max, p.length());
  }
  // |p|^2 = 2 c.p + k, solved through its 4x4 normal equations.
  const sum = new Array<number>(16).fill(0);
  const rhs = new THREE.Vector4(0, 0, 0, 0);
  for (const p of points) {
    if (p.length() < max * 0.5) continue;
    const row = [2 * p.x, 2 * p.y, 2 * p.z, 1];
    const y = p.lengthSq();
    for (let i = 0; i < 4; i += 1) {
      rhs.setComponent(i, rhs.getComponent(i) + row[i]! * y);
      for (let j = 0; j < 4; j += 1) sum[i * 4 + j] = (sum[i * 4 + j] ?? 0) + row[i]! * row[j]!;
    }
  }
  const a = new THREE.Matrix4().set(...(sum as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]));
  if (Math.abs(a.determinant()) < 1e-18) return null;
  const centre = rhs.applyMatrix4(a.invert());
  return Math.round(Math.hypot(centre.x, centre.y, centre.z) * 1e4) / 10;
}

function channelsOf(formula: TargetFormula): Set<FaceChannel> {
  return new Set(formula.terms.map((term) => term.channel));
}
