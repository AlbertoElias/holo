import { createSystem, type Entity } from '@iwsdk/core';
import { type CaptureContext, captureContext, resolveAppMode } from './captureContext';
import { CaptureBody, CaptureCharacter, CaptureHeightFit, CaptureRecording, CaptureSimulation } from './components';

/**
 * Publishes capture's domain state to its ECS components after each step.
 * Reads only plain values and snapshots: never matrices, which would change
 * what later steps compute.
 */
export class CaptureStateSystem extends createSystem({ capture: { required: [CaptureSimulation] } }) {
  private capture!: CaptureContext;

  init(): void {
    this.capture = captureContext(this.world);
  }

  update(): void {
    for (const entity of this.queries.capture.entities) this.publish(entity);
  }

  publish(entity: Entity): void {
    const c = this.capture;
    const frame = c.frame;
    entity.setValue(CaptureSimulation, 'steps', frame.steps);
    entity.setValue(CaptureSimulation, 'elapsedSec', frame.elapsedSec);
    entity.setValue(CaptureSimulation, 'clockMode', c.clockMode());
    entity.setValue(CaptureSimulation, 'appMode', frame.arSpectator ? 'ar' : resolveAppMode(c));
    entity.setValue(CaptureSimulation, 'xrSession', c.xrEntry.sessionMode);

    const character = c.motor.getSnapshot();
    entity.setValue(CaptureCharacter, 'x', character.position.x);
    entity.setValue(CaptureCharacter, 'y', character.position.y);
    entity.setValue(CaptureCharacter, 'z', character.position.z);
    entity.setValue(CaptureCharacter, 'grounded', character.grounded);
    entity.setValue(CaptureCharacter, 'horizontalSpeed', character.horizontalSpeed);
    entity.setValue(CaptureCharacter, 'locomotion', c.animator.getState());
    entity.setValue(CaptureCharacter, 'crouch', c.crouch.amount);

    const solver = c.body.solver.getDebugSnapshot();
    entity.setValue(CaptureBody, 'active', c.body.active);
    entity.setValue(CaptureBody, 'headTracked', c.tracking.getHeadPose().valid);
    entity.setValue(CaptureBody, 'aligned', solver.aligned);
    entity.setValue(CaptureBody, 'translating', solver.translating);
    entity.setValue(CaptureBody, 'turning', solver.turning);
    entity.setValue(CaptureBody, 'bodyYaw', solver.bodyYaw);
    entity.setValue(CaptureBody, 'steps', solver.steps);
    entity.setValue(CaptureBody, 'leftHandSource', c.tracking.getHandPoseSource('left'));
    entity.setValue(CaptureBody, 'rightHandSource', c.tracking.getHandPoseSource('right'));

    const calibration = c.heightFit.calibration;
    entity.setValue(CaptureHeightFit, 'eyeHeight', calibration.eyeHeight ?? -1);
    entity.setValue(CaptureHeightFit, 'avatarScale', c.avatar.xrHeightScale);
    entity.setValue(CaptureHeightFit, 'refitPending', calibration.refitting);
    entity.setValue(CaptureHeightFit, 'sizeLocked', c.recording.isSizeLocked);

    const frames = c.recording.recorder.getFrames();
    entity.setValue(CaptureRecording, 'state', c.ui.getState().recordingState);
    entity.setValue(CaptureRecording, 'frames', frames.length);
    entity.setValue(CaptureRecording, 'lastFrameSec', frames.at(-1)?.timeSec ?? -1);
  }
}
