import * as THREE from 'three';
import type { VrmHumanoidBone } from '@holoim/meaning';
import type { AvatarRig, ArmIkChain, HandFingerRetargetChain } from '../avatar/AvatarRig';
import { ArmIkSolver } from '../ik/ArmIkSolver';
import type { AimInput, PointSampleStore } from '../recording/PointSampleStore';
import { isFiniteQuaternionLike } from '../shared/math';
import type { VrHandSide } from '../types/contracts';
import type { PointCrosshair } from '../ui/PointCrosshair';

/** The bones a desktop point drives, per arm; the dominant hand points (handedness). */
const INFERRED_BONES: Record<VrHandSide, VrmHumanoidBone[]> = {
  left: ['leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand'],
  right: ['rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand']
};
const BLEND_IN_SEC = 0.12;
const BLEND_OUT_SEC = 0.25;
const REACH_FRACTION = 0.97;
const FAR_M = 60;
const EDGE_MARGIN_PX = 24;
// Curl per phalanx of the three fingers tucked under the extended index.
const CURL_RAD = [1.25, 1.45, 1.0];

export interface DesktopPointDeps {
  avatar: AvatarRig;
  desktopCamera: THREE.PerspectiveCamera;
  crosshair: PointCrosshair;
  embodyOffset: number;
  getPointSamples: () => PointSampleStore;
  /** The dominant hand: it points. Read between points, never during one. */
  getHandedness: () => VrHandSide;
}

/** One arm's chains and the bones a point drives on it. */
interface PointArm {
  side: VrHandSide;
  chain: ArmIkChain;
  fingers: HandFingerRetargetChain;
  // The extended index finger: base joint and last joint, as the aim axis.
  knuckle: THREE.Bone;
  fingertip: THREE.Bone;
  driven: Driven[];
  armDriven: Driven[];
  curlAxes: Map<THREE.Bone, THREE.Vector3>;
}

export interface DesktopPointStep {
  held: boolean;
  /** Radians above the horizon; the mouse drives it while the action is held. */
  aimPitch: number;
  lookYaw: number;
  deltaSec: number;
  /** Simulation time of this step (what the recorder stamps frames with). */
  timeSec: number;
  /**
   * A phone's touch and hold (slice 5): the finger, CSS px. The camera ray
   * through it decides the referent and the arm points at where it lands.
   */
  screenAim?: { x: number; y: number } | null;
}

interface Driven {
  bone: THREE.Bone;
  // The pose animation last left on the bone, and what this module last wrote.
  rest: THREE.Quaternion;
  written: THREE.Quaternion;
  hasWritten: boolean;
  target: THREE.Quaternion;
}

/**
 * Desktop point action: while held, the avatar's dominant arm aims along the
 * eye-origin aim ray through the arm IK, the index finger extended and the
 * rest curled, and the ray is recorded for the take. Runs after the camera and
 * before recording, outside VR only; releasing blends the arm back to whatever
 * locomotion animation leaves on it.
 */
export class DesktopPointAction {
  private readonly arms: Partial<Record<VrHandSide, PointArm>> = {};
  /** The arm pointing now, or the one that will; switches only while at rest. */
  private arm: PointArm | undefined;
  private readonly solver = new ArmIkSolver();
  private readonly raycaster = new THREE.Raycaster();
  private weight = 0;
  private wasHeld = false;
  private readonly origin = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  /** Where the arm reaches: the aim itself, or from the shoulder to the landing for a camera ray. */
  private readonly reach = new THREE.Vector3();
  private readonly landing = new THREE.Vector3();
  private readonly ndc = new THREE.Vector2();
  private input: AimInput = 'desktop';
  private landed = false;
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpQ2 = new THREE.Quaternion();
  private readonly tmpQ3 = new THREE.Quaternion();
  private readonly tmpHandQuat = new THREE.Quaternion();

  constructor(private readonly deps: DesktopPointDeps) {}

  /** Builds both arms' chains once the avatar is loaded and still in its bind pose. */
  attach(): void {
    for (const side of ['left', 'right'] as const) {
      const arm = this.buildArm(side);
      if (arm) this.arms[side] = arm;
    }
    this.arm = this.arms[this.deps.getHandedness()];
  }

  private buildArm(side: VrHandSide): PointArm | undefined {
    const { avatar } = this.deps;
    const chain = avatar.createArmIkChain(side);
    const fingers = avatar.createHandFingerRetargetChain(side);
    if (!chain || !fingers) return undefined;
    const indexBones = fingers.entries.filter((entry) => entry.finger === 'index').sort((a, b) => a.segmentIndex - b.segmentIndex);
    const knuckle = indexBones[0]?.bone;
    const fingertip = indexBones.at(-1)?.bone;
    if (!knuckle || !fingertip) return undefined;
    const arm: PointArm = { side, chain, fingers, knuckle, fingertip, driven: [], armDriven: [], curlAxes: new Map() };
    const down = new THREE.Vector3(0, -1, 0);
    for (const bone of [chain.shoulder, chain.upperArm, chain.foreArm, chain.hand]) arm.armDriven.push(this.makeDriven(bone));
    arm.driven.push(...arm.armDriven);
    for (const entry of fingers.entries) {
      if (entry.finger === 'thumb') continue;
      arm.driven.push(this.makeDriven(entry.bone));
      if (entry.finger === 'index' || !entry.bone.parent) continue;
      // Curl turns the finger toward the palm; at bind the palm faces down.
      const parentWorld = entry.bone.parent.getWorldQuaternion(new THREE.Quaternion());
      const palmInParent = down.clone().applyQuaternion(parentWorld.invert());
      const axis = entry.bindAimInParent.clone().normalize().cross(palmInParent);
      if (axis.lengthSq() > 1e-8) arm.curlAxes.set(entry.bone, axis.normalize());
    }
    return arm;
  }

  isAttached(): boolean {
    return Boolean(this.arm);
  }

  /** Hold state for text-state checks. */
  snapshot(): { weight: number; landed: boolean; landing: [number, number, number]; direction: [number, number, number] } {
    return {
      weight: this.weight,
      landed: this.landed,
      landing: [this.landing.x, this.landing.y, this.landing.z],
      direction: [this.direction.x, this.direction.y, this.direction.z]
    };
  }

  /** Called when VR owns the arms: drop the blend and hide chrome. */
  idle(): void {
    this.weight = 0;
    this.wasHeld = false;
    for (const arm of Object.values(this.arms)) for (const driven of arm.driven) driven.hasWritten = false;
    this.deps.crosshair.hide();
  }

  update(step: DesktopPointStep): void {
    // A handedness change takes effect at the next point, never halfway through one.
    if (!step.held && this.weight <= 0) this.arm = this.arms[this.deps.getHandedness()] ?? this.arm;
    const arm = this.arm;
    if (!arm || !this.deps.avatar.avatar) return;
    const { chain } = arm;
    const samples = this.deps.getPointSamples();

    if (step.held) {
      const input: AimInput = step.screenAim ? 'touch' : 'desktop';
      // A switch between mouse and touch mid-hold is a new hold.
      if (this.wasHeld && input !== this.input) samples.endAim(step.timeSec);
      this.input = input;
      this.computeRay(step);
      samples.recordAim({
        timeSec: step.timeSec,
        side: arm.side,
        input,
        origin: { x: this.origin.x, y: this.origin.y, z: this.origin.z },
        direction: { x: this.direction.x, y: this.direction.y, z: this.direction.z }
      });
    } else if (this.wasHeld) {
      samples.endAim(step.timeSec);
    }
    this.wasHeld = step.held;

    const rate = step.held ? 1 / BLEND_IN_SEC : -1 / BLEND_OUT_SEC;
    this.weight = THREE.MathUtils.clamp(this.weight + rate * step.deltaSec, 0, 1);
    if (this.weight <= 0 && !step.held) {
      this.idle();
      return;
    }

    this.captureLocomotionPose(arm);
    this.solveTargetPose(arm);
    const t = this.weight * this.weight * (3 - 2 * this.weight);
    for (const driven of arm.driven) {
      driven.bone.quaternion.copy(driven.rest).slerp(driven.target, t);
      driven.written.copy(driven.bone.quaternion);
      driven.hasWritten = true;
    }
    chain.shoulder.updateMatrixWorld(true);
    samples.recordInferredMotion(step.timeSec, INFERRED_BONES[arm.side]);

    if (step.held) this.showCrosshair();
    else this.deps.crosshair.hide();
  }

  private computeRay(step: DesktopPointStep): void {
    const { avatar, embodyOffset, desktopCamera } = this.deps;
    if (step.screenAim) {
      desktopCamera.updateMatrixWorld(true);
      this.ndc.set((step.screenAim.x / window.innerWidth) * 2 - 1, 1 - (step.screenAim.y / window.innerHeight) * 2);
      this.raycaster.setFromCamera(this.ndc, desktopCamera);
      this.origin.copy(this.raycaster.ray.origin);
      this.direction.copy(this.raycaster.ray.direction).normalize();
    } else {
      avatar.getEyeAnchorWorldPosition(this.origin, embodyOffset);
      const cos = Math.cos(step.aimPitch);
      this.direction.set(-Math.sin(step.lookYaw) * cos, Math.sin(step.aimPitch), -Math.cos(step.lookYaw) * cos).normalize();
    }
    this.landed = false;
    if (avatar.worldModel) {
      this.raycaster.set(this.origin, this.direction);
      this.raycaster.far = FAR_M;
      const hit = this.raycaster.intersectObject(avatar.worldModel, true)[0];
      if (hit) {
        this.landing.copy(hit.point);
        this.landed = true;
      }
    }
    if (!this.landed) this.landing.copy(this.origin).addScaledVector(this.direction, FAR_M);
    this.reach.copy(this.direction);
    if (step.screenAim) {
      // The camera sits behind or beside the avatar: its arm points at what the finger touched.
      this.arm?.chain.upperArm.getWorldPosition(this.tmpA);
      if (this.arm) this.reach.subVectors(this.landing, this.tmpA).normalize();
    }
  }

  /** Animation rewrites only the bones its clips drive; the rest keep what we wrote. */
  private captureLocomotionPose(arm: PointArm): void {
    for (const driven of arm.driven) {
      const untouched = driven.hasWritten && driven.bone.quaternion.equals(driven.written);
      if (!untouched) driven.rest.copy(driven.bone.quaternion);
    }
  }

  private solveTargetPose(arm: PointArm): void {
    const { chain } = arm;
    // Solve from the locomotion pose, whatever blend weight the bones show.
    for (const driven of arm.driven) driven.bone.quaternion.copy(driven.rest);
    chain.shoulder.updateMatrixWorld(true);
    // Reach along the aim direction from the shoulder joint.
    chain.upperArm.getWorldPosition(this.tmpA);
    this.tmpB.copy(this.tmpA).addScaledVector(this.reach, (chain.upperLength + chain.lowerLength) * REACH_FRACTION);
    chain.hand.getWorldQuaternion(this.tmpHandQuat);
    if (this.solver.solve(chain, this.tmpB, this.tmpHandQuat, this.deps.avatar.avatarRoot, this.tmpHandQuat)) {
      // Turn the hand so the index finger runs along the aim.
      this.orientHand(arm);
      for (const driven of arm.armDriven) driven.target.copy(driven.bone.quaternion);
    } else {
      for (const driven of arm.armDriven) driven.target.copy(driven.rest);
    }

    // Index extended (bind), the other fingers curled.
    for (const entry of arm.fingers.entries) {
      const driven = arm.driven.find((d) => d.bone === entry.bone);
      if (!driven) continue;
      const axis = arm.curlAxes.get(entry.bone);
      driven.target.copy(entry.bindQuaternion);
      if (axis) {
        this.tmpQ.setFromAxisAngle(axis, CURL_RAD[Math.min(entry.segmentIndex, CURL_RAD.length - 1)]!);
        driven.target.premultiply(this.tmpQ);
      }
    }
    // update() writes the blend; leave the bones at the locomotion pose.
    for (const driven of arm.driven) {
      if (!isFiniteQuaternionLike(driven.target)) driven.target.copy(driven.rest);
      driven.bone.quaternion.copy(driven.rest);
    }
    chain.shoulder.updateMatrixWorld(true);
  }

  private orientHand(arm: PointArm): void {
    const { chain, knuckle, fingertip } = arm;
    chain.hand.updateMatrixWorld(true);
    knuckle.getWorldPosition(this.tmpA);
    fingertip.getWorldPosition(this.tmpB);
    this.tmpB.sub(this.tmpA);
    if (this.tmpB.lengthSq() < 1e-10) return;
    this.tmpQ.setFromUnitVectors(this.tmpB.normalize(), this.reach);
    chain.hand.getWorldQuaternion(this.tmpQ2);
    this.tmpQ2.premultiply(this.tmpQ);
    chain.hand.parent!.getWorldQuaternion(this.tmpQ3).invert();
    chain.hand.quaternion.copy(this.tmpQ3.multiply(this.tmpQ2));
    chain.hand.updateMatrixWorld(true);
  }

  private makeDriven(bone: THREE.Bone): Driven {
    return { bone, rest: bone.quaternion.clone(), written: bone.quaternion.clone(), hasWritten: false, target: bone.quaternion.clone() };
  }

  private showCrosshair(): void {
    const camera = this.deps.desktopCamera;
    camera.updateMatrixWorld(true);
    this.tmpA.copy(this.landing).project(camera);
    if (this.tmpA.z > 1) {
      this.deps.crosshair.hide();
      return;
    }
    // A ray that leaves the view (third person can aim above the frame) keeps its crosshair at the edge.
    const clampTo = (value: number, size: number): number => THREE.MathUtils.clamp(value, EDGE_MARGIN_PX, size - EDGE_MARGIN_PX);
    this.deps.crosshair.show(
      { x: clampTo(((this.tmpA.x + 1) / 2) * window.innerWidth, window.innerWidth), y: clampTo(((1 - this.tmpA.y) / 2) * window.innerHeight, window.innerHeight) },
      this.landed
    );
  }
}
