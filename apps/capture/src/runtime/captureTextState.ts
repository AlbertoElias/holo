import * as THREE from 'three';
import { type CaptureContext, resolveAppMode } from '../systems/captureContext';

/** `render_game_to_text`: the simulation state automation checks read. */
export function renderCaptureTextState(c: CaptureContext): string {
  const mode = resolveAppMode(c);
  const character = c.motor.getSnapshot();
  const { avatar, input, crouch, heightFit, tracking, stage } = c;
  const animator = c.animator;
  return JSON.stringify({
    mode: mode === 'desktop-third' ? 'third' : mode === 'desktop-first' ? 'first' : mode,
    character: {
      position: { x: character.position.x, y: character.position.y, z: character.position.z },
      velocityY: character.velocityY,
      grounded: character.grounded
    },
    input: {
      forward: input.moveState.forward,
      back: input.moveState.back,
      left: input.moveState.left,
      right: input.moveState.right,
      crouch: input.isCrouchHeld()
    },
    avatar: {
      x: avatar.avatarRoot.position.x,
      y: avatar.avatarRoot.position.y,
      z: avatar.avatarRoot.position.z,
      yaw: c.camera.lookYaw
    },
    locomotion: {
      state: animator.getState(),
      horizontalSpeed: character.horizontalSpeed,
      targetHorizontalSpeed: character.targetHorizontalSpeed,
      timeScale: animator.getCurrentTimeScale(),
      activeProfile: animator.getActiveProfile(),
      legs: c.terrainLegs.getSnapshot(),
      clip: animator.getClipSnapshot()
    },
    crouch: { amount: crouch.amount, poseAmount: crouch.poseAmount, target: crouch.target, source: crouch.source },
    tracking: { left: c.hands.snapshot('left'), right: c.hands.snapshot('right') },
    heightAdaptation: {
      eyeHeight: heightFit.eyeHeight ?? null,
      scale: avatar.xrHeightScale,
      avatarHeight: avatar.avatarHeight,
      minY: avatar.avatarMinLocalY,
      baseWorldY: avatar.avatarRoot.position.y + avatar.avatarMinLocalY,
      eyeWorld: avatar.getEyeAnchorWorldPosition(new THREE.Vector3(), 0),
      headWorld: tracking.getHeadWorldPosition(new THREE.Vector3()),
      floorHead: tracking.getFloorHeadPosition() ?? null,
      refitPending: heightFit.calibration.refitting,
      recordingSizeLocked: c.recording.isSizeLocked
    },
    mockVr: tracking.mock.snapshot(),
    ar: {
      sessionMode: c.xrEntry.sessionMode,
      worldPosition: { x: stage.worldGroup.position.x, y: stage.worldGroup.position.y, z: stage.worldGroup.position.z }
    }
  });
}
