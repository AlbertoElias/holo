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
  /** Thigh skin radius about the hip-to-knee axis: a crouch-walk swings the thigh up beside a hanging hand. */
  thigh: number;
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
  private readonly wristAxis = new THREE.Vector3();
  private readonly elbowAxis = new THREE.Vector3();
  private readonly spine = new THREE.Vector3();
  private readonly neck = new THREE.Vector3();
  private readonly turn = new THREE.Quaternion();
  private readonly world = new THREE.Quaternion();
  private readonly parent = new THREE.Quaternion();
  /** Per side: the upper arm's local rotation before the last opening, and the one written, so a frame whose
   * animation did not rewrite the arm (a held idle key) starts from the pose, not from last frame's opening. */
  private readonly undo = SIDES.map(() => ({ before: new THREE.Quaternion(), written: new THREE.Quaternion(), active: false }));
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
    const thighRadii: number[] = [];
    const thighAxis = {
      left: { hip: jointAt('leftUpperLeg'), knee: humanoid.bone('leftLowerLeg')?.getWorldPosition(new THREE.Vector3()) },
      right: { hip: jointAt('rightUpperLeg'), knee: humanoid.bone('rightLowerLeg')?.getWorldPosition(new THREE.Vector3()) }
    };
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
        if (name === 'leftUpperLeg' || name === 'rightUpperLeg') {
          const { hip: top, knee: bottom } = thighAxis[name === 'leftUpperLeg' ? 'left' : 'right'];
          if (bottom) thighRadii.push(distanceToSegment(v, top, bottom, this.b));
        }
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
      thigh: (quantile(thighRadii, 0.9) ?? half) / half,
      hand: (quantile(handRadii, 0.5) ?? half * 0.25) / half,
      elbow: (quantile(forearmRadii, 0.9) ?? half * 0.4) / half
    };
  }

  /**
   * Opens each upper arm until its hand clears the hips and its elbow the torso. Desktop animation path only.
   * An arm the point or the carry holds (`owned`) is theirs: their IK aims it, and they keep the pose they found
   * as the one to return to, so opening it would feed their own write back to them as the clip's pose.
   */
  apply(humanoid: HumanoidSkeleton | undefined, owned: Readonly<Record<'left' | 'right', boolean>> = { left: false, right: false }): void {
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
      const name = side.sign > 0 ? 'right' : 'left';
      if (owned[name]) {
        undo.active = false;
        this.lastOpenRad[name] = 0;
        return;
      }
      if (undo.active && upper.quaternion.equals(undo.written)) upper.quaternion.copy(undo.before);
      undo.active = false;
      upper.updateWorldMatrix(true, true);
      upper.getWorldPosition(this.shoulder);
      humanoid.bone(side.lower)!.getWorldPosition(this.elbow);
      humanoid.bone(side.hand)!.getWorldPosition(this.wrist);
      const thigh = humanoid.bone(side.sign > 0 ? 'rightUpperLeg' : 'leftUpperLeg')!;
      const knee = humanoid.bone(side.sign > 0 ? 'rightLowerLeg' : 'leftLowerLeg');
      const wristNeed = Math.max(
        this.need(this.wrist, side.sign, widths.hip, widths.hand, half, this.origin),
        knee ? this.thighNeed(this.wrist, thigh, knee, side.sign, (widths.thigh + widths.hand + AIR) * half, half) : 0
      );
      // The torso is measured about the spine, which a crouch leans forward of the hips.
      const elbowNeed = this.need(this.elbow, side.sign, widths.torso, widths.elbow, half, this.spineAt(humanoid, this.elbow.y));
      // Each point is turned outwards about the axis that moves it outwards fastest: perpendicular to the outward
      // direction and to its own reach from the shoulder. It moves by that reach's share across the outward
      // direction per radian, so an arm swung back or forward (a crouch-walk's swing) opens as readily as a hanging one.
      this.b.copy(this.right).multiplyScalar(side.sign);
      const wristAngle = this.angleFor(this.wrist, wristNeed, half, this.wristAxis);
      const elbowAngle = this.angleFor(this.elbow, elbowNeed, half, this.elbowAxis);
      const angle = Math.min(MAX_OPEN_RAD, Math.max(wristAngle, elbowAngle));
      this.lastOpenRad[side.sign > 0 ? 'right' : 'left'] = angle;
      if (angle <= 1e-4) return;
      undo.before.copy(upper.quaternion);
      // Both points' axes, weighted by the turn each asks for, so the axis never jumps when the other point leads.
      this.axis.copy(this.wristAxis).multiplyScalar(wristAngle).addScaledVector(this.elbowAxis, elbowAngle).normalize();
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

  /**
   * The angle (rad) that moves `point` outwards (this.b) by `need`, and the axis to turn it about; 0 when the point
   * lies on the shoulder's outward line, where no turn of the upper arm moves it outwards.
   */
  private angleFor(point: THREE.Vector3, need: number, half: number, axis: THREE.Vector3): number {
    this.a.subVectors(point, this.shoulder);
    axis.crossVectors(this.a, this.b);
    const lever = axis.length();
    if (lever < half * 0.3 || need <= 0) return 0;
    axis.divideScalar(lever);
    return need / lever;
  }

  /**
   * Smooth outward shortfall of a point against its own side's thigh, a capsule about the hip-to-knee axis: full
   * beside the thigh, tapering to nothing ahead of, behind, above or below it (past the hip or the knee).
   */
  private thighNeed(point: THREE.Vector3, hip: THREE.Bone, knee: THREE.Bone, sign: number, radius: number, half: number): number {
    hip.getWorldPosition(this.spine);
    knee.getWorldPosition(this.neck);
    const length = this.spine.distanceTo(this.neck);
    if (length < 1e-6) return 0;
    this.axis.subVectors(this.neck, this.spine).divideScalar(length);
    this.a.subVectors(point, this.spine);
    const along = this.a.dot(this.axis);
    // Off the ends the capsule rounds off over one radius.
    const beyond = along < 0 ? -along : along > length ? along - length : 0;
    this.a.addScaledVector(this.axis, -along);
    this.b.copy(this.right).multiplyScalar(sign);
    const lateral = this.a.dot(this.b);
    const across = Math.sqrt(Math.max(0, this.a.lengthSq() - lateral * lateral));
    const reach = radius * DEPTH_TAPER;
    const fade = 1 - (across / reach) ** 2 - (beyond / reach) ** 2;
    const clearance = fade > 0 ? radius * Math.sqrt(fade) : 0;
    const deficit = clearance - lateral;
    const soft = SOFTNESS * half;
    return (deficit + Math.sqrt(deficit * deficit + soft * soft)) / 2;
  }

  /** The point on the spine (hips to neck) at the given height, falling back to the hips' midpoint. */
  private spineAt(humanoid: HumanoidSkeleton, y: number): THREE.Vector3 {
    const neck = humanoid.bone('neck') ?? humanoid.bone('upperChest') ?? humanoid.bone('chest');
    if (!neck) return this.spine.copy(this.origin);
    neck.getWorldPosition(this.neck);
    const rise = this.neck.y - this.origin.y;
    if (rise < 1e-4) return this.spine.copy(this.origin);
    const t = THREE.MathUtils.clamp((y - this.origin.y) / rise, 0, 1);
    return this.spine.lerpVectors(this.origin, this.neck, t);
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
  private need(point: THREE.Vector3, sign: number, section: Section, thickness: number, half: number, centre: THREE.Vector3): number {
    this.a.subVectors(point, centre);
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

function distanceToSegment(point: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, scratch: THREE.Vector3): number {
  scratch.subVectors(b, a);
  const lengthSq = scratch.lengthSq();
  const t = lengthSq > 0 ? THREE.MathUtils.clamp(scratch.dot(point) - scratch.dot(a), 0, lengthSq) / lengthSq : 0;
  return scratch.multiplyScalar(t).add(a).distanceTo(point);
}
