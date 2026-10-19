import * as THREE from 'three';
import { TRACKED_HAND_JOINT_NAMES, type MockVrPoseInput, type TrackedHandJointName, type VrHandSide } from '../types/contracts';

interface MockJoint {
  tracked: boolean;
  hasPosition: boolean;
  hasQuaternion: boolean;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

export interface MockHand {
  tracked: boolean;
  // Relative to the head, in the head's frame.
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  joints: Record<TrackedHandJointName, MockJoint>;
}

/**
 * The deterministic `__setMockVrPose` debug pose: a head and hands that drive
 * VR embodiment without (or alongside) a real XR session.
 */
export class MockVrPose {
  enabled: boolean;
  readonly headPosition = new THREE.Vector3(0, 0, 0);
  readonly headQuaternion = new THREE.Quaternion();
  readonly hands: Record<VrHandSide, MockHand> = {
    left: createHand(-0.2),
    right: createHand(0.2)
  };

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  apply(payload: MockVrPoseInput): void {
    if (typeof payload.enabled === 'boolean') this.enabled = payload.enabled;
    const head = payload.head;
    if (head?.position) this.headPosition.set(head.position.x, head.position.y, head.position.z);
    if (head?.quaternion) this.headQuaternion.set(head.quaternion.x, head.quaternion.y, head.quaternion.z, head.quaternion.w).normalize();
    if (!payload.hands) return;
    for (const side of ['left', 'right'] as const) {
      const next = payload.hands[side];
      if (!next) continue;
      const hand = this.hands[side];
      if (typeof next.tracked === 'boolean') hand.tracked = next.tracked;
      if (next.position) hand.position.set(next.position.x, next.position.y, next.position.z);
      if (next.quaternion) hand.quaternion.set(next.quaternion.x, next.quaternion.y, next.quaternion.z, next.quaternion.w).normalize();
      if (!next.joints) continue;
      for (const jointName of TRACKED_HAND_JOINT_NAMES) {
        const nextJoint = next.joints[jointName];
        if (!nextJoint) continue;
        const joint = hand.joints[jointName];
        if (typeof nextJoint.tracked === 'boolean') joint.tracked = nextJoint.tracked;
        if (nextJoint.position) {
          joint.position.set(nextJoint.position.x, nextJoint.position.y, nextJoint.position.z);
          joint.hasPosition = true;
        }
        if (nextJoint.quaternion) {
          joint.quaternion.set(nextJoint.quaternion.x, nextJoint.quaternion.y, nextJoint.quaternion.z, nextJoint.quaternion.w).normalize();
          joint.hasQuaternion = true;
        }
      }
    }
  }

  /** Heading of the mock head (0 = facing -Z), or undefined looking straight up or down. */
  yaw(): number | undefined {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.headQuaternion).projectOnPlane(new THREE.Vector3(0, 1, 0));
    if (forward.lengthSq() <= 1e-8) return undefined;
    forward.normalize();
    return Math.atan2(-forward.x, -forward.z);
  }

  snapshot(): { enabled: boolean; head: { x: number; y: number; z: number }; leftTracked: boolean; rightTracked: boolean } {
    return {
      enabled: this.enabled,
      head: { x: this.headPosition.x, y: this.headPosition.y, z: this.headPosition.z },
      leftTracked: this.hands.left.tracked,
      rightTracked: this.hands.right.tracked
    };
  }
}

function createHand(x: number): MockHand {
  const joints = {} as Record<TrackedHandJointName, MockJoint>;
  for (const jointName of TRACKED_HAND_JOINT_NAMES) {
    joints[jointName] = { tracked: false, hasPosition: false, hasQuaternion: false, position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  }
  return { tracked: false, position: new THREE.Vector3(x, -0.2, -0.35), quaternion: new THREE.Quaternion(), joints };
}
