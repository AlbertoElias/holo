import { createSystem } from '@iwsdk/core';
import { isHandheldSession } from '@holoim/xr-ui-iwsdk';
import { type CaptureContext, captureContext } from './captureContext';

/**
 * XR session lifecycle and the tracked head. Entry and exit reset every
 * owner synchronously, in one fixed order, before any pose math this step.
 */
export class XrSessionSystem extends createSystem() {
  private capture!: CaptureContext;
  private inArSession = false;
  // Decided once per AR session on entry: the flag and a strictly handheld
  // session. A headset in passthrough, or a browser that does not say, is a spectator.
  private cameraAuthor = false;
  private session: XRSession | null = null;
  private referenceSpace: XRReferenceSpace | null = null;

  private readonly onSessionEnd = (): void => {
    this.capture.input.onXrSessionEnded();
    // A take in progress stops and exports now, as Stop does, and the held
    // microphone goes now: no further frame may come to run onExited.
    if (this.cameraAuthor) this.capture.recording.endCameraTake();
    this.capture.recording.releaseHeldMic();
  };

  // A recenter re-origins tracking space; the body realigns rather than
  // walking to the new head position.
  private readonly onReferenceSpaceReset = (): void => {
    this.capture.body.solver.reset();
  };

  init(): void {
    this.capture = captureContext(this.world);
  }

  update(deltaSec: number): void {
    const c = this.capture;
    const frame = c.frame;
    const transition = c.tracking.updateTransition();
    const isAr = c.xrEntry.sessionMode === 'ar';
    if (transition.entered) this.onEntered(isAr);
    if (transition.exited) this.onExited();

    frame.xrPresenting = c.tracking.isXrPresenting();
    frame.arSpectator = isAr && frame.xrPresenting;
    frame.arCameraAuthor = frame.arSpectator && this.cameraAuthor;
    // The AR tap asked for the microphone before it knew whether a session
    // would start; a refused request leaves it open with nothing to use it.
    if (!frame.xrPresenting && c.recording.isMicHeld() && !this.world.sessionRequestPending) c.recording.releaseHeldMic();
    if (frame.arSpectator) {
      c.ui.publishMode('ar');
      c.camera.update(false, true, deltaSec, true);
      c.ar.update();
      return;
    }

    const headPose = c.tracking.updateHeadPose();
    c.camera.lookYaw = c.tracking.syncYaw(c.camera.lookYaw);
    frame.vrActive = c.tracking.isVrEmbodimentActive();
    c.input.tickDesktopFocusRecovery(frame.xrPresenting);
    // Real XR input drives the full-body solver; the mock pose hook keeps the
    // upper-body embodiment.
    c.body.active = frame.xrPresenting && !c.tracking.mock.enabled && c.body.ready && c.motor.hasSpawnResolved();
    frame.bodyTracking = c.body.active && headPose.valid;

    // Rig placement outside real XR. Never overlaps the room-scale body,
    // which only runs while a real session presents.
    const rig = c.stage.cameraRig;
    if (c.tracking.isMockVrOnly()) {
      c.camera.applyVrHeadPoseForMock();
      rig.quaternion.copy(c.tracking.mock.headQuaternion);
    } else if (!frame.xrPresenting) {
      rig.position.set(0, 0, 0);
      rig.rotation.set(0, 0, 0);
      c.camera.ensureDesktopRendererState();
    }
  }

  private onEntered(isAr: boolean): void {
    const c = this.capture;
    this.inArSession = isAr;
    this.bindSession();
    if (isAr) {
      c.ar.onEntered();
      this.cameraAuthor = c.config.arCameraAuthor && isHandheldSession(this.session, { strict: true });
      // The idle performer is not in a camera take; it comes back on exit.
      if (this.cameraAuthor) c.avatar.avatarRoot.visible = false;
      else if (c.config.arCameraAuthor) c.recording.releaseHeldMic();
    } else {
      c.vrChrome.show();
      c.hands.resetRuntimeState();
      c.heightFit.calibration.reset();
      c.crouch.resetBaseline();
      c.body.onXrEntered();
      c.input.onXrEntered();
    }
    c.camera.onXrEntered(isAr);
  }

  private onExited(): void {
    const c = this.capture;
    const exitingAr = this.inArSession;
    this.inArSession = false;
    this.unbindSession();
    if (exitingAr) {
      if (this.cameraAuthor) c.recording.endCameraTake();
      this.cameraAuthor = false;
      c.avatar.avatarRoot.visible = true;
      c.recording.releaseHeldMic();
      c.ar.onExited();
    } else {
      c.vrChrome.hide();
      c.hands.resetRuntimeState();
      c.motor.onXrExited(c.avatar);
      c.crouch.resetBaseline();
      // Normal frame restoration removes the crouch pose before the mixer runs.
      c.crouch.release();
      c.input.onXrExited();
    }
    c.camera.onXrExited();
  }

  private bindSession(): void {
    const xr = this.capture.stage.renderer.xr;
    const session = xr.getSession();
    if (!session || this.session === session) return;
    this.unbindSession();
    this.session = session;
    session.addEventListener('end', this.onSessionEnd);
    this.referenceSpace = xr.getReferenceSpace();
    this.referenceSpace?.addEventListener('reset', this.onReferenceSpaceReset);
  }

  private unbindSession(): void {
    this.referenceSpace?.removeEventListener('reset', this.onReferenceSpaceReset);
    this.referenceSpace = null;
    this.session?.removeEventListener('end', this.onSessionEnd);
    this.session = null;
  }
}
