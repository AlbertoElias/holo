import { createSystem, type Entity } from '@iwsdk/core';
import { type CaptureContext, captureContext } from './captureContext';
import { CaptureHeightFit, CaptureRecording } from './components';

/**
 * Applies native control requests (set through IWSDK's ECS tools) before the
 * step runs, through the same services as the UI, so a recording start locks
 * avatar size before the height fit runs this step.
 */
export class CaptureControlSystem extends createSystem({ capture: { required: [CaptureHeightFit, CaptureRecording] } }) {
  private capture!: CaptureContext;

  init(): void {
    this.capture = captureContext(this.world);
  }

  update(): void {
    for (const entity of this.queries.capture.entities) this.apply(entity);
  }

  private apply(entity: Entity): void {
    if (entity.getValue(CaptureHeightFit, 'refitRequested')) {
      entity.setValue(CaptureHeightFit, 'refitRequested', false);
      entity.setValue(CaptureHeightFit, 'refitResult', this.capture.heightFit.requestRefit() ? 'accepted' : 'rejected');
    }
    if (entity.getValue(CaptureRecording, 'toggleRequested')) {
      entity.setValue(CaptureRecording, 'toggleRequested', false);
      this.capture.recording.toggle();
    }
  }
}
