import * as THREE from 'three';
import { clamp, isFiniteQuaternionLike } from '../shared/math';
import type { ArmIkChain } from '../avatar/AvatarRig';
import { CLAVICLE_LIMIT_DEG, clavicleAngles, elbowPole, type ClavicleAngles } from './armPoseModel';

export type ArmIkOptions = {
  // handWorldQuaternion, when given, is the exact world rotation for the hand
  // bone (palm-aligned from tracked joints); otherwise the target rotation is
  // mapped through the rig's grip offset, as for controllers.
  handWorldQuaternion?: THREE.Quaternion | undefined;
  // Reach stretch: past full reach the arm may lengthen by up to this share
  // of its length, easing in (tanh, slope 1 at full reach, so the wrist never
  // snaps) instead of stopping dead. A height-fitted avatar's arm is about
  // 0.30 of its height against a person's 0.33, so a real long reach runs
  // past it: the Quest 3 hand recording reaches 4-6% (and briefly 19%) past
  // full protraction. A stretching solve also swings the clavicle all the
  // way and stops 1 mm short of straight (not 90% and 1 cm), so the wrist
  // lands on the tracked one. The VR solve passes a small reserve on top of
  // armLengthRatio for both sources; the camera tracker's tracked hands pass
  // 8%; desktop keeps the reach its object and aim checks are tuned on.
  maxStretch?: number;
  // Share of the hand's twist about the forearm (from bind) that the forearm
  // bone rolls by, so the skin twists along the forearm instead of all at the
  // wrist (candy-wrapper). The hand keeps its exact world rotation. 0 keeps the
  // forearm on its minimal-rotation aim.
  forearmTwistShare?: number;
  // The recorded arm model (armPoseModel.ts): the clavicle and the elbow's
  // bend direction from recorded human arms, instead of the reach-driven
  // clavicle swing and the fixed elbow hint. `deltaSec` paces the clavicle's
  // rate limit. Only the VR solve passes it.
  armModel?: { deltaSec: number } | undefined;
  // A constant arm length from bind (ArmIkChain.armLengthFit); maxStretch
  // then adds its reserve on top. 1 or unset keeps the bind lengths.
  armLengthRatio?: number;
};

// The modelled clavicle turns at most this fast, so a jump in the wrist (a
// regained hand, a source switch) does not step the shoulder.
const CLAVICLE_RATE_DEG_PER_SEC = 150;

// The forearm roll stops here, so a twist past anatomy does not wind the elbow.
const MAX_FOREARM_ROLL = THREE.MathUtils.degToRad(90);

export class ArmIkSolver {
  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  private readonly tmpUpperWorld = new THREE.Vector3();
  private readonly tmpElbowWorld = new THREE.Vector3();
  private readonly tmpVecA = new THREE.Vector3();
  private readonly tmpPlace = new THREE.Vector3();
  private readonly tmpVecB = new THREE.Vector3();
  private readonly tmpClampedTarget = new THREE.Vector3();
  private readonly tmpUpperDirWorld = new THREE.Vector3();
  private readonly tmpForeDirWorld = new THREE.Vector3();
  private readonly tmpParentWorldQuat = new THREE.Quaternion();
  private readonly tmpDesiredDirParent = new THREE.Vector3();
  private readonly tmpInvQuat = new THREE.Quaternion();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpQuatB = new THREE.Quaternion();
  private readonly tmpQuatC = new THREE.Quaternion();
  private readonly tmpTorso = new THREE.Quaternion();
  private readonly tmpTorsoInv = new THREE.Quaternion();
  private readonly tmpP = new THREE.Vector3();
  private readonly tmpAcross = new THREE.Vector3();
  private readonly tmpPole = new THREE.Vector3();
  private readonly tmpAxis = new THREE.Vector3();
  private readonly tmpAngles: ClavicleAngles = { elevationDeg: 0, protractionDeg: 0 };

  solve(
    chain: ArmIkChain,
    targetPositionWorld: THREE.Vector3,
    targetQuaternionWorld: THREE.Quaternion,
    avatarRoot: THREE.Group,
    { handWorldQuaternion, maxStretch = 0, forearmTwistShare = 0, armModel, armLengthRatio = 1 }: ArmIkOptions = {}
  ): boolean {
    const lengthRatio = Math.max(1, armLengthRatio);
    const armLength = (chain.upperLength + chain.lowerLength) * lengthRatio;
    if (armModel) this.torsoFrame(chain, this.tmpTorso);
    // Shoulder protraction: as the target nears full reach, swing the
    // clavicle toward it (as a real shoulder does). Without this the pinned
    // shoulder runs out of arm ~10 cm early on a stretch. A stretching
    // (tracked-hand) solve swings all the way: stopping at 90% left the
    // Quest 3 recording's wrists 1-2 cm short on every long reach.
    const fullReach = maxStretch > 0;
    chain.upperArm.getWorldPosition(this.tmpUpperWorld);
    if (armModel) {
      if (chain.hasClavicle) this.poseClavicle(chain, targetPositionWorld, armLength, armModel.deltaSec);
    } else if (chain.shoulderBindAimInParent) {
      const reach = chain.upperLength + chain.lowerLength;
      const dist = this.tmpUpperWorld.distanceTo(targetPositionWorld);
      const factor = THREE.MathUtils.smoothstep(dist / Math.max(reach, 1e-5), 0.75, 1.0);
      this.tmpVecA.subVectors(targetPositionWorld, this.tmpUpperWorld).normalize();
      if (this.aimBoneAtDirection(chain.shoulder, chain.shoulderBindQuaternion, chain.shoulderBindAimInParent, this.tmpVecA)) {
        chain.shoulder.quaternion.slerp(chain.shoulderBindQuaternion, 1 - factor * (fullReach ? 1 : 0.9));
        chain.shoulder.updateMatrixWorld(true);
      }
    }
    chain.upperArm.getWorldPosition(this.tmpUpperWorld);
    this.tmpClampedTarget.copy(targetPositionWorld);

    this.tmpVecA.subVectors(this.tmpClampedTarget, this.tmpUpperWorld);
    const targetDistanceRaw = this.tmpVecA.length();
    if (!Number.isFinite(targetDistanceRaw) || targetDistanceRaw < 1e-5) return false;

    const minReach = Math.max(0.02, Math.abs(chain.upperLength - chain.lowerLength) + 0.01);
    // 1 mm short of straight keeps the elbow's bend plane defined; the 1 cm
    // margin cost a tracked wrist a centimetre on every full reach.
    const maxReach = Math.max(minReach + 0.01, armLength - (fullReach ? 0.001 : 0.01));
    let reserve = 1;
    if (maxStretch > 0 && targetDistanceRaw > maxReach) {
      const room = maxStretch * armLength;
      reserve = (maxReach + room * Math.tanh((targetDistanceRaw - maxReach) / room)) / maxReach;
    }
    // From bind: the constant length fit, then the reach reserve.
    const stretch = lengthRatio * reserve;
    const upperLength = chain.upperLength * stretch;
    const lowerLength = chain.lowerLength * stretch;
    const targetDistance = clamp(targetDistanceRaw, minReach, maxReach * reserve);
    this.tmpVecA.multiplyScalar(1 / targetDistanceRaw);
    this.tmpClampedTarget.copy(this.tmpUpperWorld).addScaledVector(this.tmpVecA, targetDistance);

    if (armModel) this.modelledPole(chain, targetQuaternionWorld, handWorldQuaternion, targetDistance / armLength);
    else this.tmpVecB.copy(chain.elbowHintLocal).applyQuaternion(avatarRoot.quaternion).normalize();
    this.tmpVecB.addScaledVector(this.tmpVecA, -this.tmpVecB.dot(this.tmpVecA));
    if (this.tmpVecB.lengthSq() < 1e-8) {
      this.tmpVecB.crossVectors(this.tmpVecA, this.worldUp);
      if (this.tmpVecB.lengthSq() < 1e-8) {
        this.tmpVecB.set(chain.side === 'left' ? 1 : -1, 0, 0).applyQuaternion(avatarRoot.quaternion);
        this.tmpVecB.addScaledVector(this.tmpVecA, -this.tmpVecB.dot(this.tmpVecA));
      }
    }
    if (this.tmpVecB.lengthSq() < 1e-8) return false;
    this.tmpVecB.normalize();

    const cosAtShoulder = clamp(
      (targetDistance * targetDistance + upperLength * upperLength - lowerLength * lowerLength) /
        (2 * targetDistance * upperLength),
      -1,
      1
    );
    const along = upperLength * cosAtShoulder;
    const perpendicular = Math.sqrt(Math.max(0, upperLength * upperLength - along * along));

    this.tmpElbowWorld.copy(this.tmpUpperWorld).addScaledVector(this.tmpVecA, along).addScaledVector(this.tmpVecB, perpendicular);
    this.tmpUpperDirWorld.subVectors(this.tmpElbowWorld, this.tmpUpperWorld).normalize();
    this.tmpForeDirWorld.subVectors(this.tmpClampedTarget, this.tmpElbowWorld).normalize();

    const upperOk = this.aimBoneAtDirection(chain.upperArm, chain.upperBindQuaternion, chain.upperBindAimInParent, this.tmpUpperDirWorld);
    if (upperOk && (stretch > 1 || chain.stretch > 1)) this.placeChild(chain.foreArm, chain.foreBindPosition, stretch, this.tmpElbowWorld);
    const foreOk = this.aimBoneAtDirection(chain.foreArm, chain.foreBindQuaternion, chain.foreBindAimInParent, this.tmpForeDirWorld);
    if (!upperOk || !foreOk) return false;
    if (stretch > 1 || chain.stretch > 1) this.placeChild(chain.hand, chain.handBindPosition, stretch, this.tmpClampedTarget);
    chain.stretch = stretch;

    chain.foreArm.getWorldQuaternion(this.tmpQuatC);
    if (handWorldQuaternion) this.tmpQuat.copy(handWorldQuaternion);
    else this.tmpQuat.copy(targetQuaternionWorld).multiply(chain.handGripRotationOffset);
    chain.hand.quaternion.copy(this.tmpInvQuat.copy(this.tmpQuatC).invert().multiply(this.tmpQuat));
    if (forearmTwistShare > 0) this.rollForearm(chain, forearmTwistShare);
    if (!isFiniteQuaternionLike(chain.hand.quaternion)) {
      return false;
    }

    chain.hand.updateMatrixWorld(true);
    return true;
  }

  // The arm model's torso frame in world space: a rotation that takes the
  // avatar root's axes (x the avatar's left, y up, z forward) onto the torso
  // bone's current ones.
  private torsoFrame(chain: ArmIkChain, out: THREE.Quaternion): void {
    chain.torso.getWorldQuaternion(out).multiply(this.tmpTorsoInv.copy(chain.torsoBindInRoot).invert());
    this.tmpTorsoInv.copy(out).invert();
  }

  // World direction → the arm's torso frame (x out of the body), in place.
  private toTorso(chain: ArmIkChain, v: THREE.Vector3): THREE.Vector3 {
    v.applyQuaternion(this.tmpTorsoInv);
    if (chain.side === 'right') v.x = -v.x;
    return v;
  }

  private fromTorso(chain: ArmIkChain, v: THREE.Vector3): THREE.Vector3 {
    if (chain.side === 'right') v.x = -v.x;
    return v.applyQuaternion(this.tmpTorso);
  }

  // The clavicle from the recorded model: elevation about the torso's forward
  // axis and protraction about its up axis, from the wrist seen from the bind
  // shoulder (the shoulder bone is at bind here), rate-limited per second.
  private poseClavicle(chain: ArmIkChain, target: THREE.Vector3, armLength: number, deltaSec: number): void {
    this.toTorso(chain, this.tmpP.subVectors(target, this.tmpUpperWorld)).multiplyScalar(1 / armLength);
    const want = clavicleAngles(this.tmpP, this.tmpAngles);
    const last = chain.clavicleAngles;
    if (last) {
      // A step that does not advance time (deltaSec 0) keeps the last angles.
      const room = CLAVICLE_RATE_DEG_PER_SEC * Math.max(0, deltaSec);
      last.elevationDeg += clamp(want.elevationDeg - last.elevationDeg, -room, room);
      last.protractionDeg += clamp(want.protractionDeg - last.protractionDeg, -room, room);
      // Each axis moves on its own, so the combined angle can pass the limit for a few frames.
      const total = Math.hypot(last.elevationDeg, last.protractionDeg);
      if (total > CLAVICLE_LIMIT_DEG) {
        last.elevationDeg *= CLAVICLE_LIMIT_DEG / total;
        last.protractionDeg *= CLAVICLE_LIMIT_DEG / total;
      }
    } else {
      chain.clavicleAngles = { ...want };
    }
    const angles = chain.clavicleAngles!;
    const sign = chain.side === 'left' ? 1 : -1;
    // In avatar-root axes: out × up raises the shoulder tip, out × forward moves it forward.
    const lift = this.tmpQuatB.setFromAxisAngle(this.tmpAxis.set(0, 0, sign), THREE.MathUtils.degToRad(angles.elevationDeg));
    const push = this.tmpQuatC.setFromAxisAngle(this.tmpAxis.set(0, -sign, 0), THREE.MathUtils.degToRad(angles.protractionDeg));
    const turnWorld = this.tmpQuat.copy(this.tmpTorso).multiply(lift.multiply(push)).multiply(this.tmpTorsoInv);
    // local = parent⁻¹ · turn · parent · bind (the parent is the torso bone).
    chain.torso.getWorldQuaternion(this.tmpParentWorldQuat);
    turnWorld.premultiply(this.tmpInvQuat.copy(this.tmpParentWorldQuat).invert()).multiply(this.tmpParentWorldQuat);
    chain.shoulder.quaternion.copy(turnWorld.multiply(chain.shoulderBindQuaternion));
    chain.shoulder.updateMatrixWorld(true);
  }

  // The elbow's bend direction from the recorded model, into tmpVecB (world).
  // tmpVecA holds the shoulder → wrist direction; reach is the wrist's
  // distance over the arm's length.
  private modelledPole(chain: ArmIkChain, targetQuaternion: THREE.Quaternion, handWorldQuaternion: THREE.Quaternion | undefined, reach: number): void {
    const hand = handWorldQuaternion ? this.tmpQuatB.copy(handWorldQuaternion) : this.tmpQuatB.copy(targetQuaternion).multiply(chain.handGripRotationOffset);
    if (chain.palmInHand) hand.multiply(chain.palmInHand);
    this.toTorso(chain, this.tmpAcross.set(1, 0, 0).applyQuaternion(hand)).normalize();
    this.toTorso(chain, this.tmpP.copy(this.tmpVecA)).multiplyScalar(reach);
    if (!elbowPole(this.tmpP, this.tmpAcross, this.tmpPole)) this.tmpPole.set(1, -1, -1);
    this.fromTorso(chain, this.tmpVecB.copy(this.tmpPole));
  }

  /** Puts the arm back at its bind lengths (a stretched arm that stops being solved). */
  restLengths(chain: ArmIkChain): void {
    if (chain.stretch === 1) return;
    chain.foreArm.position.copy(chain.foreBindPosition);
    chain.hand.position.copy(chain.handBindPosition);
    chain.stretch = 1;
    chain.upperArm.updateMatrixWorld(true);
  }

  // A stretched arm puts the joint at its solved world point (any twist bones
  // in between keep their offsets); an unstretched one restores the bind.
  private placeChild(bone: THREE.Bone, bindPosition: THREE.Vector3, stretch: number, worldPoint: THREE.Vector3): void {
    if (stretch > 1 && bone.parent) bone.position.copy(bone.parent.worldToLocal(this.tmpPlace.copy(worldPoint)));
    else bone.position.copy(bindPosition);
    bone.updateMatrixWorld(true);
  }

  // Swing-twist split of the hand's local rotation from bind about the forearm
  // axis (the hand's bind offset); the forearm rolls by a share of the twist and
  // the hand takes the rest, so the hand's world rotation does not change. The
  // twist is unwrapped against the last frame, so it does not jump at 180°.
  private rollForearm(chain: ArmIkChain, share: number): void {
    const axis = this.tmpVecA.copy(chain.handBindPosition);
    if (axis.lengthSq() < 1e-10) return;
    axis.normalize();
    const delta = this.tmpQuatB.copy(chain.hand.quaternion).multiply(this.tmpInvQuat.copy(chain.handBindQuaternion).invert());
    const sign = delta.w < 0 ? -1 : 1;
    let twist = 2 * Math.atan2(sign * (delta.x * axis.x + delta.y * axis.y + delta.z * axis.z), sign * delta.w);
    const previous = chain.wristTwist ?? 0;
    twist += 2 * Math.PI * Math.round((previous - twist) / (2 * Math.PI));
    chain.wristTwist = twist;
    const roll = clamp(twist * share, -MAX_FOREARM_ROLL, MAX_FOREARM_ROLL);
    if (Math.abs(roll) < 1e-6) return;
    const rollQuat = this.tmpQuatC.setFromAxisAngle(axis, roll);
    chain.foreArm.quaternion.multiply(rollQuat);
    chain.hand.quaternion.premultiply(rollQuat.invert());
    chain.foreArm.updateMatrixWorld(true);
  }

  private aimBoneAtDirection(
    bone: THREE.Bone,
    bindQuaternion: THREE.Quaternion,
    bindAimInParent: THREE.Vector3,
    desiredDirectionWorld: THREE.Vector3
  ): boolean {
    if (!bone.parent || desiredDirectionWorld.lengthSq() < 1e-8) return false;
    bone.parent.getWorldQuaternion(this.tmpParentWorldQuat);
    this.tmpDesiredDirParent.copy(desiredDirectionWorld).normalize();
    this.tmpDesiredDirParent.applyQuaternion(this.tmpInvQuat.copy(this.tmpParentWorldQuat).invert()).normalize();
    if (this.tmpDesiredDirParent.lengthSq() < 1e-8) return false;

    this.tmpQuat.setFromUnitVectors(bindAimInParent, this.tmpDesiredDirParent);
    bone.quaternion.copy(this.tmpQuat.multiply(this.tmpQuatB.copy(bindQuaternion)));
    bone.updateMatrixWorld(true);
    return true;
  }

}
