import { createSystem } from '@iwsdk/core';
import { type CaptureContext, captureContext } from './captureContext';

/**
 * XR session lifecycle and the tracked head. Entry and exit reset every
 * owner synchronously, in one fixed order, before any pose math this step.
 */
export class XrSessionSystem extends createSystem() {
  private capture!: CaptureContext;
  private inArSession = false;
  private session: XRSession | null = null;
  private referenceSpace: XRReferenceSpace | null = null;

  private readonly onSessionEnd = (): void => {
    this.capture.input.onXrSessionEnded();
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
      c.vrChrome.show('ar');
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
      c.ar.onExited();
      c.vrChrome.hide();
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
