import * as THREE from 'three';
import type { VrmHumanoidBone } from '@holoim/meaning';
import type { HumanoidSkeleton } from '../avatar/HumanoidSkeleton';

/**
 * Keeps the desktop arms outside the body. The mocap clips were recorded on a slim performer; on a broader avatar
 * (armour, hips, a wide jacket) the swinging hands and elbows pass into the thighs and torso. Once per avatar the skin
 * beside the hips and the torso is measured as an elliptical cross-section (half-width, front and back depth). Each
 * frame, after the animation and the leg IK, each upper arm is opened outwards just enough that the hand clears the
 * hips and the elbow the torso. A hand in front of or behind the body is left alone. The opening is a smooth function
 * of the animated pose, so it adds no jitter, and it costs a handful of vector ops per arm.
 */

/** A body section around the midline, in shares of the hip joints' half-spacing. */
interface Section {
  half: number;
  front: number;
  back: number;
}

/** Skin measured once per avatar, in shares of the hip joints' half-spacing. */
export interface BodyWidths {
  /** Hips and upper thighs, beside which a hanging hand passes. */
  hip: Section;
  /** Spine to chest, beside which the elbow passes. */
  torso: Section;
  /** Hand half-thickness about the forearm's axis. */
  hand: number;
  /** Forearm half-thickness about its axis. */
  elbow: number;
}

const HIP_BONES: VrmHumanoidBone[] = ['hips', 'leftUpperLeg', 'rightUpperLeg'];
const TORSO_BONES: VrmHumanoidBone[] = ['spine', 'chest', 'upperChest'];
/** The most an upper arm is opened (rad): beyond it the arm reads as held out on purpose. */
const MAX_OPEN_RAD = THREE.MathUtils.degToRad(30);
/** Softness of the clearance's onset (share of the hip half-spacing): the opening eases in, it never kinks. */
const SOFTNESS = 0.08;
/** Air left between the hand and the body (share of the hip half-spacing). */
const AIR = 0.05;
/** The section's depth is stretched by this much so the clearance tapers off ahead of and behind the body,
 * rather than dropping to nothing at its edge. */
const DEPTH_TAPER = 1.25;

const SIDES = [
  { sign: 1, upper: 'rightUpperArm', lower: 'rightLowerArm', hand: 'rightHand' },
  { sign: -1, upper: 'leftUpperArm', lower: 'leftLowerArm', hand: 'leftHand' }
] as const;

export class ArmClearance {
  private measuredFor: HumanoidSkeleton | undefined;
  private widths: BodyWidths | undefined;
  private readonly origin = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly shoulder = new THREE.Vector3();
  private readonly elbow = new THREE.Vector3();
  private readonly wrist = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly turn = new THREE.Quaternion();
  private readonly world = new THREE.Quaternion();
  private readonly parent = new THREE.Quaternion();
  /** Per side: the upper arm's local rotation before the last opening, and the one written, so a frame whose
   * animation did not rewrite the arm (a held idle key) starts from the pose, not from last frame's opening. */
  private readonly undo = SIDES.map(() => ({ before: new THREE.Quaternion(), written: new THREE.Quaternion(), ended: new THREE.Quaternion(), active: false }));
  /** Last opening per side (rad), for checks. */
  readonly lastOpenRad = { left: 0, right: 0 };

  /** Measures the avatar's skin once (call with the avatar in its rest pose); a new humanoid measures again. */
  measure(root: THREE.Object3D, humanoid: HumanoidSkeleton | undefined): void {
    if (!humanoid || humanoid === this.measuredFor) return;
    this.measuredFor = humanoid;
    this.widths = undefined;
    const leftLeg = humanoid.bone('leftUpperLeg');
    const rightLeg = humanoid.bone('rightUpperLeg');
    if (!leftLeg || !rightLeg || !humanoid.has('hips', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand')) return;
    root.updateMatrixWorld(true);
    if (!this.frame(leftLeg, rightLeg)) return;
    const half = this.halfSpacing(leftLeg, rightLeg);
    const knee = humanoid.bone('leftLowerLeg');
    const legLength = knee ? leftLeg.getWorldPosition(this.a).distanceTo(knee.getWorldPosition(this.b)) : half * 4;
    const named = new Map<THREE.Bone, VrmHumanoidBone>();
    for (const name of [...HIP_BONES, ...TORSO_BONES, 'leftHand', 'rightHand', 'leftLowerArm', 'rightLowerArm'] as VrmHumanoidBone[]) {
      const bone = humanoid.bone(name);
      if (bone) named.set(bone, name);
    }
    const jointAt = (name: VrmHumanoidBone) => humanoid.bone(name)!.getWorldPosition(new THREE.Vector3());
    const forearm = {
      left: { elbow: jointAt('leftLowerArm'), wrist: jointAt('leftHand') },
      right: { elbow: jointAt('rightLowerArm'), wrist: jointAt('rightHand') }
    };
    const hip = { half: [] as number[], front: [] as number[], back: [] as number[] };
    const torso = { half: [] as number[], front: [] as number[], back: [] as number[] };
    const handRadii: number[] = [];
    const forearmRadii: number[] = [];
    const v = new THREE.Vector3();
    root.traverse((object) => {
      const mesh = object as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh || !mesh.visible) return;
      const position = mesh.geometry.getAttribute('position');
      const skinIndex = mesh.geometry.getAttribute('skinIndex');
      const skinWeight = mesh.geometry.getAttribute('skinWeight');
      if (!position || !skinIndex || !skinWeight) return;
      mesh.skeleton.update();
      for (let i = 0; i < position.count; i++) {
        let best = 0;
        for (let k = 1; k < 4; k++) if (skinWeight.getComponent(i, k) > skinWeight.getComponent(i, best)) best = k;
        const name = named.get(mesh.skeleton.bones[skinIndex.getComponent(i, best)]!);
        if (!name) continue;
        mesh.getVertexPosition(i, v);
        mesh.applyBoneTransform(i, v);
        v.applyMatrix4(mesh.matrixWorld);
        this.a.subVectors(v, this.origin);
        const lateral = Math.abs(this.a.dot(this.right));
        const depth = this.a.dot(this.forward);
        const height = this.a.dot(this.up);
        const section = HIP_BONES.includes(name) ? hip : TORSO_BONES.includes(name) ? torso : undefined;
        if (section) {
          // The hips are measured beside the hips and upper thighs, where a hanging hand passes.
          if (section === hip && (height < -0.55 * legLength || height > 0.25 * legLength)) continue;
          section.half.push(lateral);
          (depth >= 0 ? section.front : section.back).push(Math.abs(depth));
          continue;
        }
        // Hand and forearm thickness: distance from the forearm's own axis, so the rest pose (T, A or hanging)
        // does not matter.
        const { elbow, wrist } = forearm[name.startsWith('left') ? 'left' : 'right'];
        this.b.subVectors(wrist, elbow).normalize();
        this.a.subVectors(v, elbow);
        const radius = this.a.addScaledVector(this.b, -this.a.dot(this.b)).length();
        (name.endsWith('Hand') ? handRadii : forearmRadii).push(Math.min(radius, half * 0.6));
      }
    });
    // The widest skin, less a few stray vertices (a buckle, a strap end).
    const section = (s: typeof hip): Section | undefined => {
      const width = quantile(s.half, 0.98);
      if (!width) return undefined;
      return { half: width / half, front: (quantile(s.front, 0.98) ?? width) / half, back: (quantile(s.back, 0.98) ?? width) / half };
    };
    const hipSection = section(hip);
    const torsoSection = section(torso);
    if (!hipSection || !torsoSection) return;
    this.widths = {
      hip: hipSection,
      torso: torsoSection,
      hand: (quantile(handRadii, 0.5) ?? half * 0.25) / half,
      elbow: (quantile(forearmRadii, 0.9) ?? half * 0.4) / half
    };
  }

  /**
   * Notes each upper arm as the last frame left it, before this frame's animation runs. The mixer skips a value
   * that has not changed (the desktop idle holds its arm key), so a pose a later writer (the point or the carry)
   * left there stands until apply; apply must not take it for the clip's pose and open it again.
   */
  beforeAnimation(humanoid: HumanoidSkeleton | undefined): void {
    if (!humanoid || humanoid !== this.measuredFor) return;
    SIDES.forEach((side, index) => this.undo[index]!.ended.copy(humanoid.bone(side.upper)!.quaternion));
  }

  /** Opens each upper arm until its hand clears the hips and its elbow the torso. Desktop animation path only. */
  apply(humanoid: HumanoidSkeleton | undefined): void {
    const widths = this.widths;
    if (!humanoid || humanoid !== this.measuredFor || !widths) return;
    const leftLeg = humanoid.bone('leftUpperLeg')!;
    const rightLeg = humanoid.bone('rightUpperLeg')!;
    leftLeg.updateWorldMatrix(true, false);
    rightLeg.updateWorldMatrix(true, false);
    if (!this.frame(leftLeg, rightLeg)) return;
    const half = this.halfSpacing(leftLeg, rightLeg);
    SIDES.forEach((side, index) => {
      const upper = humanoid.bone(side.upper)!;
      const undo = this.undo[index]!;
      // The animation left the arm alone this frame: start from the clip's pose under last frame's opening.
      if (undo.active && (upper.quaternion.equals(undo.written) || upper.quaternion.equals(undo.ended))) upper.quaternion.copy(undo.before);
      undo.active = false;
      upper.updateWorldMatrix(true, true);
      upper.getWorldPosition(this.shoulder);
      humanoid.bone(side.lower)!.getWorldPosition(this.elbow);
      humanoid.bone(side.hand)!.getWorldPosition(this.wrist);
      const wristNeed = this.need(this.wrist, side.sign, widths.hip, widths.hand, half);
      const elbowNeed = this.need(this.elbow, side.sign, widths.torso, widths.elbow, half);
      // A turn about the body's forward axis moves a point sideways by its drop below the shoulder per radian.
      const wristDrop = this.shoulder.y - this.wrist.y;
      const elbowDrop = this.shoulder.y - this.elbow.y;
      const angle = Math.min(
        MAX_OPEN_RAD,
        Math.max(wristDrop > half * 0.5 ? wristNeed / wristDrop : 0, elbowDrop > half * 0.5 ? elbowNeed / elbowDrop : 0)
      );
      this.lastOpenRad[side.sign > 0 ? 'right' : 'left'] = angle;
      if (angle <= 1e-4) return;
      undo.before.copy(upper.quaternion);
      // Axis down × outward turns a hanging point outwards for a positive angle.
      this.b.copy(this.right).multiplyScalar(side.sign);
      this.axis.set(0, -1, 0).cross(this.b).normalize();
      this.turn.setFromAxisAngle(this.axis, angle);
      upper.getWorldQuaternion(this.world);
      this.world.premultiply(this.turn);
      upper.parent!.getWorldQuaternion(this.parent);
      upper.quaternion.copy(this.parent.invert().multiply(this.world));
      undo.written.copy(upper.quaternion);
      undo.active = true;
      upper.updateWorldMatrix(false, true);
    });
  }

  /** Skin measured on the current avatar, for checks. */
  measured(): Readonly<BodyWidths> | undefined {
    return this.widths;
  }

  /** Sets the origin (between the hip joints) and the horizontal right and forward axes; false when degenerate. */
  private frame(leftLeg: THREE.Bone, rightLeg: THREE.Bone): boolean {
    leftLeg.getWorldPosition(this.a);
    rightLeg.getWorldPosition(this.b);
    this.origin.addVectors(this.a, this.b).multiplyScalar(0.5);
    this.right.subVectors(this.b, this.a).setY(0);
    if (this.right.lengthSq() < 1e-8) return false;
    this.right.normalize();
    this.forward.crossVectors(this.up, this.right);
    return true;
  }

  private halfSpacing(leftLeg: THREE.Bone, rightLeg: THREE.Bone): number {
    return leftLeg.getWorldPosition(this.a).distanceTo(rightLeg.getWorldPosition(this.b)) / 2;
  }

  /**
   * Smooth outward shortfall of a limb point (of the given thickness) against a body section: the section's
   * half-width beside the body, tapering to nothing ahead of and behind it. ≈0 well clear, ≈the deficit inside.
   */
  private need(point: THREE.Vector3, sign: number, section: Section, thickness: number, half: number): number {
    this.a.subVectors(point, this.origin);
    const lateral = this.a.dot(this.right) * sign;
    const depth = this.a.dot(this.forward);
    const reach = ((depth >= 0 ? section.front : section.back) + thickness + AIR) * DEPTH_TAPER * half;
    const across = 1 - (depth / reach) ** 2;
    const clearance = across > 0 ? (section.half + thickness + AIR) * half * Math.sqrt(across) : 0;
    const deficit = clearance - lateral;
    const soft = SOFTNESS * half;
    return (deficit + Math.sqrt(deficit * deficit + soft * soft)) / 2;
  }
}

function quantile(values: number[], q: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}
