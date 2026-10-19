import * as THREE from 'three';
import type { AvatarRig } from '../avatar/AvatarRig';
import { headYawFromQuaternion, type XrHeadPose } from '../xr/XrSessionService';
import type { BodySample, Vec3Tuple } from '../types/contracts';
import { type BodyFault, type BodyHeadInput, type GroundSampler, VrBodySolver } from './VrBodySolver';

// A tracked head that jumps this far in one frame was re-origined (recenter or
// tracking recovery); realign the rig instead of walking the body there.
export const HEAD_TRACKING_JUMP_METERS = 0.5;

// Avatar bones reported by sample(), by sample key.
const BODY_SAMPLE_BONES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['head', ['Head']],
  ['headTop', ['HeadTop_End']],
  ['neck', ['Neck']],
  ['chest', ['Spine2']],
  ['hips', ['Hips']],
  ['leftShoulder', ['LeftArm']],
  ['rightShoulder', ['RightArm']],
  ['leftHip', ['LeftUpLeg']],
  ['rightHip', ['RightUpLeg']],
  ['leftKnee', ['LeftLeg']],
  ['rightKnee', ['RightLeg']],
  ['leftAnkle', ['LeftFoot']],
  ['rightAnkle', ['RightFoot']],
  ['leftToe', ['LeftToeBase']],
  ['rightToe', ['RightToeBase']]
];

/**
 * The full-body solver's state across a frame. Real XR input drives it; the
 * mock pose hook and desktop keep the animation path (crouch + terrain legs).
 */
export class BodyTracking {
  readonly solver: VrBodySolver;
  // The solver found the bones it needs (measured once, at load).
  ready = false;
  // Real XR with a resolved spawn: the solver owns hips, spine, head and legs.
  active = false;
  // The solver posed the skeleton last frame; when it stops, its bones go back
  // to bind for the animation path.
  posed = false;
  readonly head: BodyHeadInput = { worldPosition: new THREE.Vector3(), worldQuaternion: new THREE.Quaternion(), yaw: 0 };
  // Root move planned toward the head, applied through the character motor.
  readonly displacement = new THREE.Vector3();
  readonly prevHeadLocal = new THREE.Vector3();
  hasPrevHeadLocal = false;
  private readonly raycaster = new THREE.Raycaster();
  readonly groundSampler: GroundSampler;

  constructor(private readonly avatar: AvatarRig, avatarForwardOffset: number) {
    this.solver = new VrBodySolver(avatar, avatarForwardOffset);
    this.groundSampler = (x, z, outNormal) => avatar.sampleTerrainYAt(x, z, this.raycaster, outNormal);
  }

  /** Bind pose is measured before any animation writes the skeleton. */
  measureBindPose(): void {
    this.ready = this.solver.measureBindPose();
    if (!this.ready) console.warn('VR body solver disabled: expected spine, head, eye, or leg bones were not found.');
  }

  copyHead(pose: XrHeadPose): void {
    this.head.worldPosition.copy(pose.worldPosition);
    this.head.worldQuaternion.copy(pose.worldQuaternion);
    this.head.yaw = headYawFromQuaternion(pose.worldQuaternion, this.head.yaw);
  }

  /** A new XR session aligns the body afresh. */
  onXrEntered(): void {
    this.solver.reset();
    this.hasPrevHeadLocal = false;
  }

  setFaults(faults: readonly string[]): void {
    this.solver.faults.clear();
    for (const fault of faults) this.solver.faults.add(fault as BodyFault);
  }

  /** One frame of the VR body for fidelity checks, in world space. */
  sample(rig: THREE.Object3D, pose: XrHeadPose): BodySample {
    const tuple = (v: THREE.Vector3): Vec3Tuple => [v.x, v.y, v.z];
    const scratch = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const avatar = this.avatar;
    const bones: BodySample['bones'] = {};
    for (const [key, names] of BODY_SAMPLE_BONES) {
      const bone = avatar.findBone(names);
      if (bone) bones[key] = tuple(bone.getWorldPosition(scratch));
    }
    const leftEye = avatar.leftEyeAnchor;
    const rightEye = avatar.rightEyeAnchor;
    const ground: BodySample['ground'] = {};
    const root = avatar.avatarRoot.position;
    for (const key of ['root', 'leftAnkle', 'rightAnkle', 'leftToe', 'rightToe'] as const) {
      const at = key === 'root' ? tuple(root) : bones[key];
      if (!at) continue;
      const y = avatar.sampleTerrainYAt(at[0], at[2], this.raycaster, normal);
      if (y !== undefined) ground[key] = { y: y - 0.01, normal: tuple(normal) };
    }
    const debug = this.solver.getDebugSnapshot();
    const q = rig.quaternion;
    const hq = pose.worldQuaternion;
    return {
      active: this.active,
      rig: { position: tuple(rig.position), quaternion: [q.x, q.y, q.z, q.w] },
      trackedHead: pose.valid ? { local: tuple(pose.localPosition), world: tuple(pose.worldPosition), worldQuaternion: [hq.x, hq.y, hq.z, hq.w] } : null,
      root: tuple(avatar.avatarRoot.position),
      bones,
      eyes: leftEye && rightEye ? { left: tuple(leftEye.getWorldPosition(scratch)), right: tuple(rightEye.getWorldPosition(scratch)) } : null,
      ground,
      solver: { aligned: debug.aligned, translating: debug.translating, turning: debug.turning, bodyYaw: debug.bodyYaw, steps: debug.steps, swinging: { left: debug.feet.left.swinging, right: debug.feet.right.swinging } },
      dims: this.solver.dimensions ?? null
    };
  }
}
