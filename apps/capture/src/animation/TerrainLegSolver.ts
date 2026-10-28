import * as THREE from 'three';
import type { AvatarRig } from '../avatar/AvatarRig';

type Leg = { upper: THREE.Bone; lower: THREE.Bone; foot: THREE.Bone; upInFoot: THREE.Vector3; correction: number; planted: boolean; plantCorrection: number; heldTarget: THREE.Vector3; heldQuat: THREE.Quaternion; release: number };
type LegSample = {
  side: string;
  foot: { x: number; y: number; z: number };
  groundY: number | null;
  correction: number;
  upper: number[];
  lower: number[];
};

/** A released plant eases the foot back to the animation over this long. */
const PLANT_RELEASE_SEC = 0.15;

/** Post-animation, leg-only terrain adaptation. No calibration or root ownership. */
export class TerrainLegSolver {
  private avatar: THREE.Object3D | undefined;
  private legs: Leg[] = [];
  private readonly originals = new Map<THREE.Bone, THREE.Quaternion>();
  private readonly ray = new THREE.Raycaster();
  private readonly down = new THREE.Vector3(0, -1, 0);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly normalMatrix = new THREE.Matrix3();
  private samples: LegSample[] = [];

  restore(): void {
    for (const [bone, quaternion] of this.originals) bone.quaternion.copy(quaternion);
    this.originals.clear();
  }

  getSnapshot(): readonly LegSample[] { return this.samples; }

  attach(rig: AvatarRig): void {
    rig.avatarRoot.updateWorldMatrix(true, true);
    this.avatar = rig.avatar;
    this.legs = [];
    for (const side of ['left', 'right'] as const) {
      const upper = rig.bone(`${side}UpperLeg`), lower = rig.bone(`${side}LowerLeg`), foot = rig.bone(`${side}Foot`);
      if (upper && lower && foot) this.legs.push({ upper, lower, foot, upInFoot: this.up.clone().applyQuaternion(foot.getWorldQuaternion(new THREE.Quaternion()).invert()), correction: 0, planted: false, plantCorrection: 0, heldTarget: new THREE.Vector3(), heldQuat: new THREE.Quaternion(), release: 0 });
    }
  }

  /** `plant`: a reach is driving the pose; each foot stays where it stood when the reach began. */
  update(rig: AvatarRig, grounded: boolean, deltaSec: number, plant = false, bent = false): void {
    if (this.avatar !== rig.avatar) this.attach(rig);
    this.samples = [];
    if (!rig.worldModel || !rig.avatar) return;
    rig.avatarRoot.updateWorldMatrix(true, true);
    const height = rig.avatarHeight;
    const root = rig.avatarRoot.getWorldPosition(new THREE.Vector3());
    // Sample only around the support plane, never from the top of the room.
    const baseY = root.y + rig.avatarMinLocalY;
    const center = this.surface(rig.worldModel, root.x, baseY, root.z, height);
    for (const [index, leg] of this.legs.entries()) {
      const foot = leg.foot.getWorldPosition(new THREE.Vector3());
      const surface = grounded ? this.surface(rig.worldModel, foot.x, baseY, foot.z, height) : undefined;
      if (surface && center) {
        for (const bone of [leg.upper, leg.lower, leg.foot]) this.originals.set(bone, bone.quaternion.clone());
        const sole = height * 0.035;
        // Preserve the authored swing arc, shifting it by local terrain elevation.
        let target: THREE.Vector3;
        if (plant) {
          // Planted at the start of the reach, at the height the foot stood at then.
          if (!leg.planted) {
            leg.planted = true;
            leg.plantCorrection = leg.correction;
          }
          const stand = rig.plantFeet[index === 0 ? 'left' : 'right'];
          target = new THREE.Vector3(stand.x, stand.y + leg.plantCorrection, stand.z);
          leg.correction = target.y - foot.y;
          leg.heldTarget.copy(target);
          leg.heldQuat.copy(rig.plantFootQuats[index === 0 ? 'left' : 'right']);
          leg.release = 1;
        } else {
          leg.planted = false;
          const desired = THREE.MathUtils.clamp(Math.max(surface.point.y - center.point.y, surface.point.y + sole - foot.y), -height * 0.18, height * 0.22);
          leg.correction = THREE.MathUtils.lerp(leg.correction, desired, 1 - Math.exp(-18 * Math.max(0, deltaSec)));
          target = foot.clone();
          target.y += leg.correction;
          // Letting go of a plant eases the foot from where it was held to where the animation has it, not a snap.
          if (leg.release > 0) {
            leg.release = Math.max(0, leg.release - deltaSec / PLANT_RELEASE_SEC);
            target.lerp(leg.heldTarget, leg.release * leg.release * (3 - 2 * leg.release));
          }
        }
        this.solve(leg, target, rig.facingWorld(new THREE.Vector3()), plant || bent);
        if (plant) {
          // A planted foot keeps its orientation: at a deep squat the shin folds so far that tilting it toward the floor would spin it.
          const planted = rig.plantFootQuats[index === 0 ? 'left' : 'right'];
          const parentRotation = leg.foot.parent!.getWorldQuaternion(new THREE.Quaternion());
          leg.foot.quaternion.copy(parentRotation.invert().multiply(planted)).normalize();
          leg.foot.updateWorldMatrix(false, true);
        } else {
          // Rotate the ankle toward the support normal while near contact.
          const contact = 1 - THREE.MathUtils.smoothstep(target.y - surface.point.y - sole, height * 0.025, height * 0.15);
          const worldRotation = leg.foot.getWorldQuaternion(new THREE.Quaternion());
          const footUp = leg.upInFoot.clone().applyQuaternion(worldRotation);
          const tilt = new THREE.Quaternion().setFromUnitVectors(footUp, surface.normal);
          tilt.slerp(new THREE.Quaternion(), 1 - contact);
          const parentRotation = leg.foot.parent!.getWorldQuaternion(new THREE.Quaternion());
          const free = tilt.multiply(worldRotation);
          if (leg.release > 0) free.slerp(leg.heldQuat, leg.release * leg.release * (3 - 2 * leg.release));
          leg.foot.quaternion.copy(parentRotation.invert().multiply(free)).normalize();
          leg.foot.updateWorldMatrix(false, true);
        }
      } else {
        // No inferred contact during flight or over a ledge.
        leg.correction = 0;
        leg.planted = false;
        leg.release = 0;
      }
      const resolved = leg.foot.getWorldPosition(new THREE.Vector3());
      this.samples.push({ side: index === 0 ? 'left' : 'right', foot: { x: resolved.x, y: resolved.y, z: resolved.z }, groundY: surface?.point.y ?? null, correction: leg.correction, upper: leg.upper.quaternion.toArray(), lower: leg.lower.quaternion.toArray() });
    }
  }

  private surface(world: THREE.Object3D, x: number, y: number, z: number, height: number) {
    this.ray.set(new THREE.Vector3(x, y + height * 0.28, z), this.down);
    this.ray.near = 0;
    this.ray.far = height * 0.55;
    for (const hit of this.ray.intersectObject(world, true)) {
      if (!hit.face) continue;
      this.normalMatrix.getNormalMatrix(hit.object.matrixWorld);
      const normal = hit.face.normal.clone().applyNormalMatrix(this.normalMatrix);
      if (normal.y >= Math.cos(THREE.MathUtils.degToRad(40))) return { point: hit.point, normal };
    }
    return undefined;
  }

  private solve(leg: Leg, target: THREE.Vector3, facing: THREE.Vector3, kneesForward: boolean): void {
    const hip = leg.upper.getWorldPosition(new THREE.Vector3());
    const knee = leg.lower.getWorldPosition(new THREE.Vector3());
    const ankle = leg.foot.getWorldPosition(new THREE.Vector3());
    const a = hip.distanceTo(knee), b = knee.distanceTo(ankle);
    if (a < 1e-5 || b < 1e-5) return;
    const axis = target.clone().sub(hip);
    const distance = THREE.MathUtils.clamp(axis.length(), Math.abs(a - b) + 1e-5, a + b - 1e-5);
    if (axis.lengthSq() < 1e-10) return;
    axis.normalize();
    const pole = knee.clone().sub(hip).addScaledVector(axis, -knee.clone().sub(hip).dot(axis));
    // A knee bends forward. A deep squat folds the leg so far that the folded knee lies on the axis or behind it; keep the bend plane forward then, never flip the knee backward.
    const forward = facing.clone().addScaledVector(axis, -facing.dot(axis));
    if (forward.lengthSq() > 1e-6 && (kneesForward || pole.lengthSq() < a * a * 0.001 || pole.dot(forward) < 0)) pole.copy(forward);
    if (pole.lengthSq() < 1e-10) return;
    pole.normalize();
    const along = (a * a + distance * distance - b * b) / (2 * distance);
    const bend = Math.sqrt(Math.max(0, a * a - along * along));
    const kneeTarget = hip.clone().addScaledVector(axis, along).addScaledVector(pole, bend);
    this.aim(leg.upper, knee.clone().sub(hip), kneeTarget.clone().sub(hip));
    const newKnee = leg.lower.getWorldPosition(new THREE.Vector3());
    const newAnkle = leg.foot.getWorldPosition(new THREE.Vector3());
    const reachableTarget = hip.clone().addScaledVector(axis, distance);
    this.aim(leg.lower, newAnkle.sub(newKnee), reachableTarget.sub(newKnee));
  }

  private aim(bone: THREE.Bone, from: THREE.Vector3, to: THREE.Vector3): void {
    if (from.lengthSq() < 1e-10 || to.lengthSq() < 1e-10) return;
    const world = bone.getWorldQuaternion(new THREE.Quaternion());
    const parent = bone.parent!.getWorldQuaternion(new THREE.Quaternion());
    const delta = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
    bone.quaternion.copy(parent.invert().multiply(delta).multiply(world)).normalize();
    bone.updateWorldMatrix(false, true);
  }
}
