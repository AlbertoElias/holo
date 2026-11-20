import * as THREE from 'three';
import type { VrmHumanoidBone } from '@holoim/meaning';
import type { HumanoidSkeleton } from '../avatar/HumanoidSkeleton';

/**
 * The upper body of a flat-screen jump. The library's jump and fall clips move the legs only, so the desktop body
 * keeps its idle (or walk) arms through the whole jump and reads as stiff. A person swings the arms back through the
 * squat, throws them forward and up as the legs push off, lets them float out to the sides at the top, and holds them
 * out and forward for balance as they land. Each frame, after the clip and the leg pose, this turns the upper arms,
 * elbows and chest by offsets that follow those targets through underdamped springs: the arms whip through the
 * launch and settle with a little follow-through instead of snapping between poses. With every target at rest the
 * offsets settle to zero and the clip plays untouched.
 */

/** Where the jump is, from the body pose system's own jump timing. */
export interface JumpPhase {
  /** Wind-up progress (0..1), held through the launch frame; 0 outside a wind-up. */
  windup: number;
  /** In the air (false through the wind-up and on the ground). */
  airborne: boolean;
  /** Upward speed (m/s) and the speed a jump leaves the ground with. */
  velocityY: number;
  launchSpeed: number;
  /** The landing's hold (0..1, scaled by how hard it was): full from touch-down, easing out with the absorb. */
  landing: number;
}

/** Offsets in degrees: arm swing forward (+) or back (-), arms out to the sides, elbow bend, chest lean forward. */
interface Offsets {
  flex: number;
  abduct: number;
  elbow: number;
  chest: number;
}

const KEYS = ['flex', 'abduct', 'elbow', 'chest'] as const;
/** The springs' natural frequency (rad/s) and damping ratio: a ~0.15 s throw with a little overshoot. */
const SPRING_OMEGA = 2 * Math.PI * 2;
const SPRING_ZETA = 0.62;
/** Below this (degrees) every offset counts as settled and the clip plays untouched. */
const REST_DEG = 0.05;

const SIDES = [
  { sign: 1, upper: 'rightUpperArm', lower: 'rightLowerArm', name: 'right' },
  { sign: -1, upper: 'leftUpperArm', lower: 'leftLowerArm', name: 'left' }
] as const;

export class JumpGesture {
  private readonly value: Offsets = { flex: 0, abduct: 0, elbow: 0, chest: 0 };
  private readonly speed: Offsets = { flex: 0, abduct: 0, elbow: 0, chest: 0 };
  private readonly target: Offsets = { flex: 0, abduct: 0, elbow: 0, chest: 0 };
  private readonly right = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly delta = new THREE.Quaternion();
  private readonly turn = new THREE.Quaternion();
  private readonly world = new THREE.Quaternion();
  private readonly parent = new THREE.Quaternion();
  /**
   * What each bone held before this layer turned it, and what it wrote. Not every clip writes every bone each frame
   * (the jump clips leave the arms alone), so a bone still holding what was written last frame is put back first;
   * otherwise the offsets would pile up frame on frame.
   */
  private readonly undo = new Map<THREE.Bone, { before: THREE.Quaternion; written: THREE.Quaternion; active: boolean }>();

  /** Clears the springs (a respawn, or the body handed to tracking). */
  reset(): void {
    for (const key of KEYS) {
      this.value[key] = 0;
      this.speed[key] = 0;
    }
  }

  update(humanoid: HumanoidSkeleton | undefined, deltaSec: number, phase: JumpPhase, owned: Readonly<Record<'left' | 'right', boolean>>): void {
    this.aim(phase);
    this.step(deltaSec);
    for (const [bone, held] of this.undo) {
      if (held.active && bone.quaternion.equals(held.written)) bone.quaternion.copy(held.before);
      held.active = false;
    }
    if (!humanoid || KEYS.every((key) => Math.abs(this.value[key]) < REST_DEG)) return;
    const leftLeg = humanoid.bone('leftUpperLeg');
    const rightLeg = humanoid.bone('rightUpperLeg');
    if (!leftLeg || !rightLeg) return;
    leftLeg.updateWorldMatrix(true, false);
    rightLeg.updateWorldMatrix(true, false);
    this.right.subVectors(rightLeg.getWorldPosition(this.b), leftLeg.getWorldPosition(this.a)).setY(0);
    if (this.right.lengthSq() < 1e-8) return;
    this.right.normalize();
    this.forward.crossVectors(this.up, this.right);
    const deg = THREE.MathUtils.DEG2RAD;
    // The chest first: the arms hang from it. A forward lean turns the up axis toward `forward`, i.e. about -right.
    const chest = humanoid.bone('chest') ?? humanoid.bone('spine');
    if (chest) this.rotate(chest, this.axis.copy(this.right), -this.value.chest * deg);
    for (const side of SIDES) {
      if (owned[side.name]) continue;
      const upper = humanoid.bone(side.upper as VrmHumanoidBone);
      const lower = humanoid.bone(side.lower as VrmHumanoidBone);
      if (!upper) continue;
      // Out to the side first, then the swing, both about the body's own axes: a hanging arm turned about `right`
      // swings toward `forward`, and turned about `forward` by -sign swings outwards on its own side.
      this.delta.setFromAxisAngle(this.right, this.value.flex * deg);
      this.turn.setFromAxisAngle(this.forward, -side.sign * this.value.abduct * deg);
      this.delta.multiply(this.turn);
      this.rotateBy(upper, this.delta);
      // The elbow bends about the body's right axis as carried by the shoulder's turn: the forearm folds forward.
      if (lower) this.rotate(lower, this.axis.copy(this.right).applyQuaternion(this.delta), this.value.elbow * deg);
    }
  }

  /** The targets for this phase of the jump. */
  private aim(phase: JumpPhase): void {
    const t = this.target;
    t.flex = t.abduct = t.elbow = t.chest = 0;
    const launch = Math.max(1e-3, phase.launchSpeed);
    if (phase.airborne) {
      if (phase.velocityY > 0) {
        // 1 as the feet leave the ground, 0 at the apex: the throw forward and up, easing to a float.
        const rise = THREE.MathUtils.clamp(phase.velocityY / launch, 0, 1);
        t.flex = 40 + 55 * rise;
        t.abduct = 14 + 18 * (1 - rise);
        t.elbow = 32;
        t.chest = -7 * rise;
      } else {
        // Falling: the arms come down a little and out, ready to balance the landing.
        const fall = THREE.MathUtils.clamp(-phase.velocityY / launch, 0, 1);
        t.flex = 45 - 15 * fall;
        t.abduct = 32 + 10 * fall;
        t.elbow = 28;
        t.chest = 4 * fall;
      }
      return;
    }
    if (phase.windup > 0) {
      // The squat: the arms swing back as the knees bend, ready to be thrown.
      const w = THREE.MathUtils.smoothstep(phase.windup, 0, 1);
      t.flex = -42 * w;
      t.abduct = 8 * w;
      t.elbow = 14 * w;
      return;
    }
    if (phase.landing > 0) {
      // The absorb: arms forward and out, the chest folding over the bent knees.
      const e = phase.landing;
      t.flex = 38 * e;
      t.abduct = 30 * e;
      t.elbow = 30 * e;
      t.chest = 8 * e;
    }
  }

  /** Advances each offset's spring toward its target (semi-implicit Euler, sub-stepped for stability). */
  private step(deltaSec: number): void {
    const dt = Math.min(Math.max(0, deltaSec), 0.1);
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      for (const key of KEYS) {
        const accel = SPRING_OMEGA * SPRING_OMEGA * (this.target[key] - this.value[key]) - 2 * SPRING_ZETA * SPRING_OMEGA * this.speed[key];
        this.speed[key] += accel * h;
        this.value[key] += this.speed[key] * h;
      }
    }
  }

  private rotate(bone: THREE.Bone, axis: THREE.Vector3, angle: number): void {
    if (Math.abs(angle) < 1e-5) return;
    this.rotateBy(bone, this.turn.setFromAxisAngle(axis.normalize(), angle));
  }

  /** Turns a bone by a world-space rotation about its own joint, then refreshes its subtree. */
  private rotateBy(bone: THREE.Bone, rotation: THREE.Quaternion): void {
    let held = this.undo.get(bone);
    if (!held) this.undo.set(bone, (held = { before: new THREE.Quaternion(), written: new THREE.Quaternion(), active: false }));
    if (!held.active) held.before.copy(bone.quaternion);
    bone.updateWorldMatrix(true, false);
    bone.getWorldQuaternion(this.world);
    this.world.premultiply(rotation);
    if (bone.parent) {
      bone.parent.getWorldQuaternion(this.parent);
      bone.quaternion.copy(this.parent.invert().multiply(this.world));
    } else bone.quaternion.copy(this.world);
    held.written.copy(bone.quaternion);
    held.active = true;
    bone.updateWorldMatrix(false, true);
  }
}
