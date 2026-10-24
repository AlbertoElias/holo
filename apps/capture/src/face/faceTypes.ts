import type { EyeGaze, FaceChannel } from '@holoim/avatar-face';

export type FaceWeights = Partial<Record<FaceChannel, number>>;
export type FaceGaze = { left: EyeGaze; right: EyeGaze };

/** One reading of a face source; channels it omits are 0 while it is in charge. */
export interface FaceSample {
  weights: FaceWeights;
  gaze?: FaceGaze;
}

export type FaceCameraState = 'off' | 'starting' | 'tracking' | 'no-face' | 'denied' | 'unavailable';

/** Which source supplied the face and the gaze on the latest step. */
export type FaceExpressionSource = 'automation' | 'webcam' | 'liveness';
export type FaceGazeSource = 'automation' | 'webcam' | 'xr-gaze' | 'liveness';
