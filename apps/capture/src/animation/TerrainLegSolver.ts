import * as THREE from 'three';
import type { AvatarRig } from '../avatar/AvatarRig';

// While a reach squat lowers the hips, the feet may be raised this much more (a fraction of height) to stay planted.
const SQUAT_EXTRA_LIFT_RATIO = 0.25;

type Leg = { upper: THREE.Bone; lower: THREE.Bone; foot: THREE.Bone; upInFoot: THREE.Vector3; correction: number };
type LegSample = {
  side: string;
  foot: { x: number; y: number; z: number };
  groundY: number | null;
  correction: number;
  upper: number[];
  lower: number[];
};

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
      if (upper && lower && foot) this.legs.push({ upper, lower, foot, upInFoot: this.up.clone().applyQuaternion(foot.getWorldQuaternion(new THREE.Quaternion()).invert()), correction: 0 });
    }
  }

  update(rig: AvatarRig, grounded: boolean, deltaSec: number, squat = 0): void {
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
        const normal = Math.max(surface.point.y - center.point.y, surface.point.y + sole - foot.y);
        const planted = surface.point.y + sole - foot.y;
        const desired = THREE.MathUtils.clamp(THREE.MathUtils.lerp(normal, planted, squat), -height * 0.18, height * (0.22 + SQUAT_EXTRA_LIFT_RATIO * squat));
        leg.correction = THREE.MathUtils.lerp(leg.correction, desired, 1 - Math.exp(-18 * Math.max(0, deltaSec)));
        const target = foot.clone();
        target.y += leg.correction;
        if (squat > 0) {
          const stand = rig.squatFeet[index === 0 ? 'left' : 'right'];
          target.x = THREE.MathUtils.lerp(target.x, stand.x, squat);
          target.z = THREE.MathUtils.lerp(target.z, stand.z, squat);
        }
        this.solve(leg, target, rig.avatarRoot);
        // Rotate the ankle toward the support normal while near contact.
        const contact = 1 - THREE.MathUtils.smoothstep(target.y - surface.point.y - sole, height * 0.025, height * 0.15);
        const worldRotation = leg.foot.getWorldQuaternion(new THREE.Quaternion());
        const footUp = leg.upInFoot.clone().applyQuaternion(worldRotation);
        const tilt = new THREE.Quaternion().setFromUnitVectors(footUp, surface.normal);
        tilt.slerp(new THREE.Quaternion(), 1 - contact);
        const parentRotation = leg.foot.parent!.getWorldQuaternion(new THREE.Quaternion());
        leg.foot.quaternion.copy(parentRotation.invert().multiply(tilt).multiply(worldRotation)).normalize();
        leg.foot.updateWorldMatrix(false, true);
      } else {
        // No inferred contact during flight or over a ledge.
        leg.correction = 0;
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

  private solve(leg: Leg, target: THREE.Vector3, root: THREE.Object3D): void {
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
    if (pole.lengthSq() < a * a * 0.001) {
      pole.set(0, 0, 1).transformDirection(root.matrixWorld);
      pole.addScaledVector(axis, -pole.dot(axis));
    }
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
