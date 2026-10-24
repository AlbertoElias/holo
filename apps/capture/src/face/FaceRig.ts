import * as THREE from 'three';
import {
  MAX_PITCH,
  MAX_YAW,
  type EyeGaze,
  type FaceChannel,
  type FaceStandard,
  type TargetFormula,
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
  unresolvedTargets: string[];
  eyes: { left: boolean; right: boolean; pivotOffsetMm: { left: number | null; right: number | null } };
}

const EYE_BONE_NAMES = {
  left: ['LeftEye', 'leftEye', 'Eye_L', 'eye_L', 'J_Adj_L_FaceEye', 'EyeLeft'],
  right: ['RightEye', 'rightEye', 'Eye_R', 'eye_R', 'J_Adj_R_FaceEye', 'EyeRight']
} as const;
const EYE_MESH_NAMES = { left: ['EyeLeft', 'Eye_L'], right: ['EyeRight', 'Eye_R'] } as const;

/**
 * Drives an avatar's face from canonical weights: every morph target whose
 * name resolves to a known standard, and the eye bones for gaze. Channels the
 * avatar cannot show are routed to the nearest ones it can.
 */
export class FaceRig {
  private readonly morphs: MorphBinding[] = [];
  private readonly unresolved: string[] = [];
  private readonly bound = new Set<FaceChannel>();
  private readonly eyes: { left: EyeBinding | null; right: EyeBinding | null } = { left: null, right: null };
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
      for (const [name, index] of Object.entries(mesh.morphTargetDictionary)) {
        const resolved = resolveMorphTarget(name);
        if (!resolved) {
          this.unresolved.push(`${mesh.name}:${name}`);
          continue;
        }
        this.morphs.push({ mesh, index, name, standard: resolved.standard, formula: resolved.formula, meshBound });
        for (const term of resolved.formula.terms) {
          this.bound.add(term.channel);
          meshBound.add(term.channel);
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
  }

  get hasFace(): boolean {
    return this.morphs.length > 0 || this.eyes.left !== null || this.eyes.right !== null;
  }

  /** Sets every bound morph target from canonical weights (absolute, not additive). */
  setWeights(weights: FaceWeights): void {
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
  setGaze(gaze: { left: EyeGaze; right: EyeGaze }): void {
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
    if (!left || !right) return null;
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
      unresolvedTargets: [...this.unresolved],
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
