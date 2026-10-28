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
    thumbstick: {
      moveX: c.locomotion.thumbstick.moveX,
      moveY: c.locomotion.thumbstick.moveY,
      turnX: c.locomotion.thumbstick.turnX,
      turnMode: c.locomotion.turnMode,
      turnYaw: c.locomotion.turnYaw,
      snapCount: c.locomotion.snapCount,
      rigYaw: Math.atan2(
        2 * (stage.cameraRig.quaternion.w * stage.cameraRig.quaternion.y + stage.cameraRig.quaternion.x * stage.cameraRig.quaternion.z),
        1 - 2 * (stage.cameraRig.quaternion.y * stage.cameraRig.quaternion.y + stage.cameraRig.quaternion.x * stage.cameraRig.quaternion.x)
      ),
      headWorld: tracking.getHeadWorldPosition(new THREE.Vector3())
    },
    avatar: {
      x: avatar.avatarRoot.position.x,
      y: avatar.avatarRoot.position.y,
      z: avatar.avatarRoot.position.z,
      yaw: c.camera.lookYaw
    },
    point: { held: input.isPointHeld(), aimPitch: input.getPointAimPitch(), viewPitch: c.camera.firstPersonPitch, ...c.point.snapshot() },
    locomotion: {
      state: animator.getState(),
      horizontalSpeed: character.horizontalSpeed,
      targetHorizontalSpeed: character.targetHorizontalSpeed,
      timeScale: animator.getCurrentTimeScale(),
      activeProfile: animator.getActiveProfile(),
      legs: c.terrainLegs.getSnapshot(),
      clip: animator.getClipSnapshot()
    },
    pose: reachPoseSnapshot(c),
    camera: { y: c.stage.desktopCamera.position.y, pitchDeg: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(c.stage.desktopCamera.getWorldDirection(new THREE.Vector3()).y, -1, 1))) },
    crouch: { amount: crouch.amount, poseAmount: crouch.poseAmount, squat: crouch.squat, target: crouch.target, source: crouch.source },
    tracking: { left: c.hands.snapshot('left'), right: c.hands.snapshot('right') },
    objects: {
      items: c.objects.interaction.snapshot(),
      hands: c.objects.interaction.handSnapshot(),
      grab: { left: c.objects.grabInput.get('left'), right: c.objects.grabInput.get('right') },
      carryWeight: c.objects.carry.getWeight(),
      reach: c.objects.interaction.reachSnapshot(),
      physics: c.objects.physicsStats(),
      tray: { ...c.objects.tray.snapshot(), gesture: c.objects.trayGesture.snapshot() }
    },
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
      worldPosition: { x: stage.worldGroup.position.x, y: stage.worldGroup.position.y, z: stage.worldGroup.position.z },
      // Camera author mode (docs/features/archive/ar-recording.md), for the AR recording check.
      cameraAuthor: c.frame.arCameraAuthor,
      spectator: c.frame.arSpectator,
      performerHidden: !avatar.avatarRoot.visible,
      placementSettled: c.ar.isSettled(),
      interactionMode: (stage.renderer.xr.getSession() as (XRSession & { interactionMode?: string }) | null)?.interactionMode ?? null,
      recordingState: c.ui.getState().recordingState,
      recordingMessage: c.ui.getState().recordingMessage,
      notice: c.ui.getState().notice,
      takeKind: c.recording.kind,
      cameraSamples: c.recording.cameraRecorder.sampleCount,
      // The camera take's running time (first to latest camera sample), and its screen holds (slice 4).
      takeSec: c.recording.cameraRecorder.elapsedSec,
      screenHold: c.screenHolds.snapshot(),
      screenHolds: c.recording.cameraRecorder.pointSamples.holdCounts(),
      micPermission: c.ui.getState().micPermission,
      micHeld: c.recording.isMicHeld()
    }
  });
}

/** Debug: toes, hips-to-neck spine pitch from vertical (degrees) and the shoulder, for the flat-screen reach checks. */
function reachPoseSnapshot(c: CaptureContext) {
  const { avatar } = c;
  const at = (ref: Parameters<typeof avatar.bone>[0]) => {
    const bone = avatar.bone(ref);
    return bone ? bone.getWorldPosition(new THREE.Vector3()) : null;
  };
  const hips = at('hips');
  const neck = at('neck') ?? at('head');
  const shoulder = at('rightUpperArm');
  const head = at('head');
  const ankles = (['left', 'right'] as const).map((side) => at(`${side}Foot`));
  const toes = (['left', 'right'] as const).map((side) => at(`${side}Toes`));
  const knees = (['left', 'right'] as const).map((side) => at(`${side}LowerLeg`));
  const thighs = (['left', 'right'] as const).map((side) => at(`${side}UpperLeg`));
  let spinePitchDeg: number | null = null;
  if (hips && neck) {
    const v = neck.clone().sub(hips);
    spinePitchDeg = THREE.MathUtils.radToDeg(Math.atan2(Math.hypot(v.x, v.z), v.y));
  }
  const fromVertical = (a: THREE.Vector3 | null, b: THREE.Vector3 | null) => {
    if (!a || !b) return null;
    const d = b.clone().sub(a);
    return THREE.MathUtils.radToDeg(Math.atan2(Math.hypot(d.x, d.z), d.y));
  };
  const torsoPitchDeg = fromVertical(hips, head);
  const xyz = (v: THREE.Vector3 | null) => (v ? { x: v.x, y: v.y, z: v.z } : null);
  return { spinePitchDeg, torsoPitchDeg, hips: xyz(hips), head: xyz(head), shoulder: xyz(shoulder), toes: toes.map(xyz), ankles: ankles.map(xyz), knees: knees.map(xyz), thighs: thighs.map(xyz) };
}
