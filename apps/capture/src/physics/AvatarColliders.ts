import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

import type { HumanoidBoneRef } from '../avatar/HumanoidSkeleton';
import type { VrHandSide } from '../types/contracts';

/** Collision-group bit of the props; avatar parts take bits 1 to 14. The scene keeps Rapier's default groups (every bit). */
export const PROP_BIT = 0x0001;

/** Membership and filter packed as Rapier wants them. */
export const groups = (membership: number, filter: number): number => ((membership & 0xffff) << 16) | (filter & 0xffff);

// Radii as fractions of the avatar's height: about 13 cm of torso and 4.5 cm of palm on a 1.75 m body.
const TORSO_R = 0.075;
const HEAD_R = 0.063;
const UPPER_ARM_R = 0.028;
const FOREARM_R = 0.023;
const PALM_R = 0.026;
const UPPER_LEG_R = 0.043;
const LOWER_LEG_R = 0.031;
const FOOT_R = 0.026;
// A shape is rebuilt when the avatar's height (the XR height fit) or a segment's length changes by more than this fraction.
const RESHAPE_FRACTION = 0.02;
// A part that moves faster than this in one step jumped (respawn, recenter, snap turn, load): it is placed there with no velocity.
const JUMP_MPS = 8;
const JUMP_MIN_M = 0.1;
// The whole body jumps when the hips turn more than this in one step.
const JUMP_TURN_RAD = THREE.MathUtils.degToRad(20);

interface PartSpec {
  side?: VrHandSide;
  /** The holding arm, excluded from a prop let go from that hand. */
  arm?: boolean;
  leg?: boolean;
  from: HumanoidBoneRef;
  /** End of the segment, the first of these the avatar has; a sphere sits midway when `sphere`. */
  to: HumanoidBoneRef[];
  radius: number;
  sphere?: boolean;
}

const SPECS: PartSpec[] = [
  { from: 'hips', to: ['neck', 'upperChest', 'chest'], radius: TORSO_R },
  { from: 'head', to: ['headTip'], radius: HEAD_R, sphere: true },
  ...(['left', 'right'] as const).flatMap((side): PartSpec[] => [
    { side, arm: true, from: `${side}UpperArm`, to: [`${side}LowerArm`], radius: UPPER_ARM_R },
    { side, arm: true, from: `${side}LowerArm`, to: [`${side}Hand`], radius: FOREARM_R },
    { side, arm: true, from: `${side}Hand`, to: [`${side}MiddleProximal`], radius: PALM_R, sphere: true },
    { side, leg: true, from: `${side}UpperLeg`, to: [`${side}LowerLeg`], radius: UPPER_LEG_R },
    { side, leg: true, from: `${side}LowerLeg`, to: [`${side}Foot`], radius: LOWER_LEG_R },
    { side, leg: true, from: `${side}Foot`, to: [`${side}Toes`, `${side}FootTip`], radius: FOOT_R }
  ])
];

interface Part {
  spec: PartSpec;
  bit: number;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider | null;
  shape: RAPIER.Shape | null;
  length: number;
  /** Where it was after the last step, and where it is sent for the coming one. */
  from: { position: THREE.Vector3; rotation: THREE.Quaternion };
  to: { position: THREE.Vector3; rotation: THREE.Quaternion };
  /** The segment's direction, so the roll about it carries over frame to frame. */
  axis: THREE.Vector3;
  speed: number;
  placed: boolean;
}

/** The avatar the colliders follow. */
export interface AvatarBones {
  bone(ref: HumanoidBoneRef): THREE.Object3D | undefined;
  /** Foot to head top in metres; changes only with the XR height fit. */
  readonly avatarHeight: number;
}

/**
 * The avatar in the prop world: a kinematic capsule per limb segment and the
 * torso, a sphere for the head and each palm. They follow the bones' final
 * pose for the step, so a moving part carries its velocity into the props it
 * hits; nothing pushes them back. Each part is a collision-group bit that a
 * prop can stop accepting (the holding arm at release, until it is clear).
 */
export class AvatarColliders {
  private readonly parts: Part[] = [];
  private height = 0;
  private hipsYaw: number | null = null;
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly hipsQ = new THREE.Quaternion();
  private readonly fwd = new THREE.Vector3();

  constructor(private readonly world: RAPIER.World, private readonly bones: AvatarBones) {
    for (const [i, spec] of SPECS.entries()) {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      const pose = () => ({ position: new THREE.Vector3(), rotation: new THREE.Quaternion() });
      this.parts.push({ spec, bit: 1 << (i + 1), body, collider: null, shape: null, length: 0, from: pose(), to: pose(), axis: new THREE.Vector3(0, 1, 0), speed: 0, placed: false });
    }
  }

  /** Every avatar part's bit. */
  get allBits(): number {
    return this.parts.reduce((bits, part) => bits | part.bit, 0);
  }

  /** The hand, forearm and upper arm of `side`. */
  armBits(side: VrHandSide): number {
    return this.parts.reduce((bits, part) => (part.spec.arm && part.spec.side === side ? bits | part.bit : bits), 0);
  }

  /** Both legs and feet. */
  get legBits(): number {
    return this.parts.reduce((bits, part) => (part.spec.leg ? bits | part.bit : bits), 0);
  }

  /** The bits of the parts that have a collider. */
  get liveBits(): number {
    return this.parts.reduce((bits, part) => (part.collider ? bits | part.bit : bits), 0);
  }

  /** The bits of the parts moving faster than `mps` over the coming step. */
  movingBits(mps: number): number {
    return this.parts.reduce((bits, part) => (part.collider && part.speed > mps ? bits | part.bit : bits), 0);
  }

  /**
   * Reads every part's pose for the coming step from its bones. Returns the
   * bits of the parts that jumped there (placed with no velocity), which
   * props should ignore until clear.
   */
  sync(deltaSec: number): number {
    const height = this.bones.avatarHeight;
    if (!(height > 0.1) || !this.bones.bone('hips')) return 0;
    const reshape = Math.abs(height - this.height) > this.height * RESHAPE_FRACTION;
    if (reshape) this.height = height;
    const turned = this.turnedTooFar();
    const jumpM = Math.max(JUMP_MIN_M, JUMP_MPS * deltaSec);
    let jumped = 0;
    for (const part of this.parts) {
      if (!this.segment(part.spec)) {
        if (part.collider) this.world.removeCollider(part.collider, false);
        part.collider = null;
        part.shape = null;
        part.placed = false;
        continue;
      }
      const length = this.a.distanceTo(this.b);
      if (!part.collider || reshape || Math.abs(length - part.length) > Math.max(part.length * RESHAPE_FRACTION, 0.005)) this.build(part, length);
      this.dir.subVectors(this.b, this.a);
      if (this.dir.lengthSq() > 1e-10) this.dir.normalize();
      else this.dir.copy(part.axis);
      const position = this.a.add(this.b).multiplyScalar(0.5);
      if (!part.placed) {
        part.to.rotation.setFromUnitVectors(this.up, this.dir);
      } else {
        // The smallest turn from last step's axis: a capsule hanging straight down can't flip about itself.
        part.to.rotation.premultiply(this.q.setFromUnitVectors(part.axis, this.dir));
      }
      part.axis.copy(this.dir);
      const moved = part.placed ? part.to.position.distanceTo(position) : Infinity;
      part.to.position.copy(position);
      if (!part.placed || turned || moved > jumpM) {
        part.body.setTranslation(position, false);
        part.body.setRotation(part.to.rotation, false);
        part.from.position.copy(position);
        part.from.rotation.copy(part.to.rotation);
        part.speed = 0;
        part.placed = true;
        jumped |= part.bit;
      } else {
        part.speed = deltaSec > 0 ? moved / deltaSec : 0;
      }
    }
    return jumped;
  }

  /** Sends every part `fraction` of the way to its pose for this step, for one substep. */
  substep(fraction: number): void {
    for (const part of this.parts) {
      if (!part.collider) continue;
      this.a.lerpVectors(part.from.position, part.to.position, fraction);
      this.q.slerpQuaternions(part.from.rotation, part.to.rotation, fraction);
      part.body.setNextKinematicTranslation(this.a);
      part.body.setNextKinematicRotation(this.q);
    }
  }

  /** After the step: this step's pose is where the next one starts. */
  settle(): void {
    for (const part of this.parts) {
      part.from.position.copy(part.to.position);
      part.from.rotation.copy(part.to.rotation);
    }
  }

  /** The bits, among `bits`, of the parts that `shape` at that pose overlaps where they were last sent. */
  overlaps(shape: RAPIER.Shape, position: RAPIER.Vector, rotation: RAPIER.Rotation, bits: number): number {
    let hit = 0;
    for (const part of this.parts) {
      if (!(part.bit & bits) || !part.shape) continue;
      if (shape.intersectsShape(position, rotation, part.shape, part.to.position, part.to.rotation)) hit |= part.bit;
    }
    return hit;
  }

  private build(part: Part, length: number): void {
    if (part.collider) this.world.removeCollider(part.collider, false);
    const radius = part.spec.radius * this.height;
    part.shape = part.spec.sphere ? new RAPIER.Ball(radius) : new RAPIER.Capsule(length / 2, radius);
    const desc = part.spec.sphere ? RAPIER.ColliderDesc.ball(radius) : RAPIER.ColliderDesc.capsule(length / 2, radius);
    part.collider = this.world.createCollider(desc.setCollisionGroups(groups(part.bit, PROP_BIT)).setFriction(0.6), part.body);
    part.length = length;
  }

  /** The hips turned further than a body can in one step. */
  private turnedTooFar(): boolean {
    const hips = this.bones.bone('hips');
    if (!hips) return false;
    hips.getWorldQuaternion(this.hipsQ);
    this.fwd.set(0, 0, 1).applyQuaternion(this.hipsQ);
    const yaw = Math.atan2(this.fwd.x, this.fwd.z);
    const last = this.hipsYaw;
    this.hipsYaw = yaw;
    if (last === null) return false;
    return Math.abs(Math.atan2(Math.sin(yaw - last), Math.cos(yaw - last))) > JUMP_TURN_RAD;
  }

  /** The part's segment ends into `a` and `b`; false when a bone is missing. */
  private segment(spec: PartSpec): boolean {
    const from = this.bones.bone(spec.from);
    const to = spec.to.map((ref) => this.bones.bone(ref)).find(Boolean);
    if (!from || !to) return false;
    from.getWorldPosition(this.a);
    to.getWorldPosition(this.b);
    return Number.isFinite(this.a.x + this.a.y + this.a.z + this.b.x + this.b.y + this.b.z);
  }
}
