import { createSystem } from '@iwsdk/core';
import * as THREE from 'three';
import { ArmRelease } from '../bodycam/ArmRelease';
import { BodycamHead } from '../bodycam/BodycamHead';
import { type CaptureContext, captureContext } from './captureContext';

/**
 * Arms and fingers follow tracked hands or controllers (or, on desktop, the point action), after the body and
 * camera have their final pose for the step. Never writes head or root, except the neck and head a camera
 * tracker turns (`?input=camera`), which is not VR embodiment.
 */
export class TrackedHandsSystem extends createSystem() {
  private capture!: CaptureContext;
  private readonly head = new BodycamHead();
  private readonly arms = new ArmRelease();
  private readonly leftShoulder = new THREE.Vector3();
  private readonly rightShoulder = new THREE.Vector3();
  private readonly shoulderMid = new THREE.Vector3();

  init(): void {
    this.capture = captureContext(this.world);
  }

  update(): void {
    const c = this.capture;
    // The mirror view follows the camera source; CameraSystem (earlier in the step) reads it next step.
    c.camera.mirrorView = c.tracking.isCameraDriven();
    if (c.frame.arSpectator || !c.motor.hasSpawnResolved()) return;
    if (!c.frame.vrActive) {
      if (c.tracking.isCameraDriven()) {
        c.point.idle();
        this.updateCameraBody();
        return;
      }
      this.head.apply(c.avatar, null, 0, c.frame.deltaSec);
      this.arms.fadeOut(c.frame.deltaSec);
      // Desktop has no tracked hands: the point action drives the right arm.
      c.point.update({
        held: c.input.isPointHeld(),
        aimPitch: c.input.getPointAimPitch(),
        screenAim: c.input.getPointScreenAim(),
        lookYaw: c.camera.lookYaw,
        deltaSec: c.frame.deltaSec,
        timeSec: c.frame.elapsedSec
      });
      return;
    }
    c.point.idle();
    const { tracking, avatar, heightFit, config } = c;
    // Once the height fit maps real meters to the avatar, hand offsets are
    // measured from the tracked head; otherwise from the avatar's eyes.
    const fromTrackedHead = tracking.isXrPresenting() && !tracking.mock.enabled && heightFit.eyeHeight !== undefined;
    c.hands.update((out) => (fromTrackedHead ? tracking.getHeadWorldPosition(out) : avatar.getEyeAnchorWorldPosition(out, config.embodyOffset)));
  }

  // The camera tracker: hands placed from the avatar's shoulders at the avatar's scale, then the head.
  // The body keeps the look yaw; it does not turn, crouch or walk with the author's head.
  private updateCameraBody(): void {
    const c = this.capture;
    const { avatar, tracking } = c;
    if (!avatar.getBoneWorldPosition('leftUpperArm', this.leftShoulder) || !avatar.getBoneWorldPosition('rightUpperArm', this.rightShoulder)) return;
    this.shoulderMid.addVectors(this.leftShoulder, this.rightShoulder).multiplyScalar(0.5);
    tracking.camera.update(c.frame.deltaSec, this.leftShoulder.distanceTo(this.rightShoulder), c.camera.lookYaw);
    this.arms.capture(avatar);
    c.hands.update((out) => out.copy(this.shoulderMid));
    for (const side of ['left', 'right'] as const) this.arms.blend(side, tracking.cameraArmWeight[side]);
    this.head.apply(avatar, tracking.camera.current?.head ?? null, c.camera.lookYaw, c.frame.deltaSec);
  }
}
