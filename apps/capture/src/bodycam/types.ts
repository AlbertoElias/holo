/**
 * What a camera tracker hands the avatar, one frame at a time: MediaPipe's
 * pose world landmarks, per-hand world landmarks, and a head rotation from the
 * face model. Slice 1 feeds synthetic frames; the live models fill the same
 * type.
 *
 * Every 3D value is in MediaPipe's camera frame, in metres, as the author
 * faces an unmirrored camera: x toward the image's right, y down, z away from
 * the camera. "Left" and "right" always name the author's own sides.
 */
export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface Point2 {
  x: number;
  y: number;
}

/** [x, y, z, w]. */
export type Quat4 = readonly [number, number, number, number];

export interface PoseLandmarks {
  /** 33 points, metres, hip-centre origin. */
  world: readonly Point3[];
  /** 33 points, normalised image coordinates (0..1): where each landmark sits in the picture. */
  image: readonly Point2[];
}

export interface HandLandmarks {
  /** 21 points, metres, hand-centre origin. */
  world: readonly Point3[];
  /** The wrist in normalised image coordinates; matched to the pose's wrists to pick the side. */
  imageWrist: Point2;
  /** The index fingertip in normalised image coordinates, for the clip report's aim at the lens. */
  imageIndexTip?: Point2;
  /** MediaPipe's own handedness label, kept for the report only: it assumes a mirrored picture, so it reads reversed here. */
  label?: string;
}

export interface LandmarkFrame {
  pose?: PoseLandmarks | null;
  /** Zero, one or two detected hands, in no particular order and with no trustworthy handedness. */
  hands?: readonly HandLandmarks[];
  /** The head's rotation in the camera frame; identity is facing the camera, upright. */
  head?: Quat4 | null;
}

export type Vec3Tuple = readonly [number, number, number];
