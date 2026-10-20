import type { UIStateStore } from '../ui/UIStateStore';
import { XrHeightCalibration } from './XrHeightCalibration';

interface HeightFitDeps {
  ui: UIStateStore;
  // A real (not mock) VR session is presenting.
  isRealVrPresenting: () => boolean;
  isRecordingSizeLocked: () => boolean;
}

/** The avatar's fitted eye height and the rules for asking to refit it. */
export class HeightFit {
  readonly calibration = new XrHeightCalibration();
  // Tracking space revision the current fit belongs to; a reset or visibility
  // change starts a new one.
  referenceRevision = -1;

  constructor(private readonly deps: HeightFitDeps) {}

  get eyeHeight(): number | undefined {
    return this.calibration.eyeHeight;
  }

  /**
   * Refit from the next neutral posture. Refused outside real VR, while a
   * recording holds the size, and while a fit is pending.
   */
  requestRefit(): boolean {
    const calibration = this.calibration;
    if (!this.deps.isRealVrPresenting() || this.deps.isRecordingSizeLocked()) return false;
    if (calibration.refitting || calibration.eyeHeight === undefined) return false;
    calibration.requestRefit();
    this.deps.ui.setHeightFit({ enabled: false, pending: true, eyeHeight: calibration.eyeHeight ?? null });
    return true;
  }
}
