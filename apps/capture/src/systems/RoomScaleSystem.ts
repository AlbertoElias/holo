import { createSystem } from '@iwsdk/core';
import * as THREE from 'three';
import { HEAD_TRACKING_JUMP_METERS } from '../body/BodyTracking';
import { headYawFromQuaternion } from '../xr/XrTracking';
import { type CaptureContext, captureContext } from './captureContext';

/**
 * Real-XR room-scale body, before physics: (re)align the world-locked rig on
 * the first tracked frame or after a tracking jump, then plan the root's move
 * toward the head for the character motor to carry out.
 */
const UP = new THREE.Vector3(0, 1, 0);

export class RoomScaleSystem extends createSystem() {
  private capture!: CaptureContext;
  private readonly bodyPosition = new THREE.Vector3();
  private readonly rootPosition = new THREE.Vector3();
  private readonly eyeWorld = new THREE.Vector3();
  private readonly localHead = new THREE.Vector3();

  init(): void {
    this.capture = captureContext(this.world);
  }

  update(deltaSec: number): void {
    const c = this.capture;
    if (c.frame.arSpectator) return;
    if (!c.frame.bodyTracking) {
      c.body.displacement.set(0, 0, 0);
      return;
    }
    const { body, tracking, motor, avatar, config } = c;
    const pose = tracking.getHeadPose();
    const jumped = body.hasPrevHeadLocal && pose.localPosition.distanceTo(body.prevHeadLocal) > HEAD_TRACKING_JUMP_METERS;
    body.prevHeadLocal.copy(pose.localPosition);
    body.hasPrevHeadLocal = true;
    motor.getCharacterBodyPosition(this.bodyPosition);
    const rootPosition = this.rootPosition.set(
      this.bodyPosition.x,
      this.bodyPosition.y + motor.getAvatarVisualOffsetY() + avatar.heightVisualOffsetY,
      this.bodyPosition.z
    );
    if (!body.solver.isAligned || jumped) {
      // Put the tracked eyes on the avatar's standing eyes, body facing the head.
      // World facing is the local head yaw plus any thumbstick rig turn.
      const yaw = headYawFromQuaternion(pose.localQuaternion, c.camera.lookYaw) + c.locomotion.turnYaw;
      const rig = c.stage.cameraRig;
      // Preserve any thumbstick turn: the rig's yaw is the locomotion
      // state's, and the local head offset must be rotated by it.
      rig.quaternion.setFromAxisAngle(UP, c.locomotion.turnYaw);
      body.solver.getStandingEyeWorld(rootPosition, yaw, body.groundSampler, this.eyeWorld);
      this.eyeWorld.y += config.embodyOffset;
      this.localHead.copy(pose.localPosition).applyQuaternion(rig.quaternion);
      rig.position.copy(this.eyeWorld).sub(this.localHead);
      // Tracking space's floor is the avatar's visual base (the height fit's
      // contract): the camera sits at the user's real eye height above it.
      rig.position.y = rootPosition.y + avatar.avatarMinLocalY + config.embodyOffset;
      rig.updateMatrixWorld(true);
      tracking.refreshHeadWorldPose();
      body.copyHead(pose);
      avatar.syncAvatarPoseFromCharacter(this.bodyPosition, yaw, motor.getAvatarVisualOffsetY(), config.avatarForwardOffset);
      body.solver.align(body.head, rootPosition, body.groundSampler);
    }
    body.copyHead(pose);
    body.solver.planRoot(body.head, rootPosition, deltaSec, body.groundSampler, body.displacement);
  }
}
