import type { TrackedHandJointName, VrHandSide } from '../types/contracts';
import type { HandLandmarks, LandmarkFrame, Point2, Point3, Quat4, Vec3Tuple } from './types';

// MediaPipe pose landmark indices.
const LEFT_SHOULDER = 11;
const RIGHT_SHOULDER = 12;
const LEFT_WRIST = 15;
const RIGHT_WRIST = 16;
const NOSE = 0;
const LEFT_EAR = 7;
const RIGHT_EAR = 8;
/**
 * Head yaw per unit of the nose's offset from the ear midpoint over the ear span, in the picture. Fitted against the
 * face model's yaw on every face-tracked frame of the spike clip (2,242 frames, r 0.96, median error 2.4 deg).
 */
const POSE_YAW_DEG_PER_EAR_SPAN = -53;
/** Past full profile the nose crosses the near ear and the ratio no longer means a larger turn. */
const MAX_POSE_YAW_DEG = 90;
/** Ears closer than this in the picture (normalised units) leave the ratio meaningless. */
const MIN_EAR_SPAN = 0.02;
/** A hand whose wrist lies further than this (normalised image units) from both pose wrists belongs to nobody. */
const MAX_WRIST_MATCH = 0.2;
const MIN_SHOULDER_WIDTH_M = 0.1;

/** MediaPipe hand landmarks 1..20 by WebXR joint name; 0 is the wrist. The finger metacarpals are not synthesised. */
const FINGERS = ['index', 'middle', 'ring', 'pinky'] as const;
export const HAND_JOINT_FOR_LANDMARK: ReadonlyArray<TrackedHandJointName> = [
  'wrist',
  'thumb-metacarpal',
  'thumb-phalanx-proximal',
  'thumb-phalanx-distal',
  'thumb-tip',
  ...FINGERS.flatMap((finger) => [`${finger}-finger-phalanx-proximal`, `${finger}-finger-phalanx-intermediate`, `${finger}-finger-phalanx-distal`, `${finger}-finger-tip`] as const)
];

/** One hand in the avatar's body frame, from the shoulder midpoint, scaled to the avatar. */
export interface BodyHand {
  wrist: Vec3Tuple;
  joints: Partial<Record<TrackedHandJointName, Vec3Tuple>>;
}

/**
 * The avatar's body frame is yaw-only and right-handed, as the avatar faces
 * -Z: x is the avatar's right, y up, z back. Positions are metres on the
 * avatar's scale, relative to its shoulder midpoint, with the author's own
 * body turn taken out; the head rotation is relative to that body turn.
 */
export interface BodyFrame {
  hands: Partial<Record<VrHandSide, BodyHand>>;
  head: Quat4 | null;
  /** The author's shoulder-line yaw, radians, positive turned to their left. */
  bodyYaw: number;
}

/** Camera frame to the body frame's axes: a half turn about z. */
const toBody = (p: Point3): [number, number, number] => [-p.x, -p.y, p.z];

const yawBy = (v: readonly [number, number, number], angle: number): [number, number, number] => {
  const [x, y, z] = v;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [x * c + z * s, y, -x * s + z * c];
};

const multiply = (a: Quat4, b: Quat4): Quat4 => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
];

const dist = (a: Point2, b: Point2): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Which side each hand belongs to, by nearest pose wrist, never by a
 * handedness label (raw camera frames are unmirrored, so the label is
 * reversed). Two hands take the pairing with the smaller total distance.
 */
export function assignHandSides(hands: readonly HandLandmarks[], poseImage: readonly Point2[]): Array<VrHandSide | null> {
  const left = poseImage[LEFT_WRIST];
  const right = poseImage[RIGHT_WRIST];
  if (!left || !right) return hands.map(() => null);
  const cost = (hand: HandLandmarks, side: VrHandSide): number => dist(hand.imageWrist, side === 'left' ? left : right);
  const pick = (hand: HandLandmarks): VrHandSide | null => {
    const l = cost(hand, 'left');
    const r = cost(hand, 'right');
    return Math.min(l, r) > MAX_WRIST_MATCH ? null : l <= r ? 'left' : 'right';
  };
  const [a, b] = hands;
  if (!a) return [];
  if (!b) return [pick(a)];
  const straight = cost(a, 'left') + cost(b, 'right');
  const crossed = cost(a, 'right') + cost(b, 'left');
  const sides: Array<VrHandSide | null> = straight <= crossed ? ['left', 'right'] : ['right', 'left'];
  for (const [i, hand] of [a, b].entries()) if (cost(hand, sides[i]!) > MAX_WRIST_MATCH) sides[i] = null;
  return [...sides, ...hands.slice(2).map(() => null)];
}

/**
 * A yaw-only head rotation (camera frame, as `LandmarkFrame.head`) from the pose's nose and ears, for frames where the
 * face model finds no face: it loses the face past about 55 deg of turn, while the pose keeps the nose and ears up to
 * full profile. Pitch and roll read level. Null without a usable pose.
 */
export function headYawFromPose(image: readonly Point2[] | undefined): Quat4 | null {
  const nose = image?.[NOSE];
  const left = image?.[LEFT_EAR];
  const right = image?.[RIGHT_EAR];
  if (!nose || !left || !right) return null;
  const span = Math.hypot(left.x - right.x, left.y - right.y);
  if (span < MIN_EAR_SPAN) return null;
  const offset = (nose.x - (left.x + right.x) / 2) / span;
  const yawDeg = Math.max(-MAX_POSE_YAW_DEG, Math.min(MAX_POSE_YAW_DEG, POSE_YAW_DEG_PER_EAR_SPAN * offset));
  const half = (yawDeg * Math.PI) / 360;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

/**
 * One landmark frame to the avatar's body frame, scaled by shoulder width.
 * Hands need the pose (it places the wrist and picks the side); the head does
 * not, but takes its yaw from the pose when the face model found no face.
 * Returns no hands when the pose is missing or degenerate.
 */
export function convertLandmarkFrame(frame: LandmarkFrame, avatarShoulderWidth: number): BodyFrame {
  const result: BodyFrame = { hands: {}, head: null, bodyYaw: 0 };
  const pose = frame.pose;
  const head = frame.head ?? headYawFromPose(pose?.image);
  const lShoulder = pose?.world[LEFT_SHOULDER];
  const rShoulder = pose?.world[RIGHT_SHOULDER];
  if (!pose || !lShoulder || !rShoulder) {
    if (head) result.head = head;
    return result;
  }
  const l = toBody(lShoulder);
  const r = toBody(rShoulder);
  const across: [number, number, number] = [r[0] - l[0], 0, r[2] - l[2]];
  const width = Math.hypot(r[0] - l[0], r[1] - l[1], r[2] - l[2]);
  result.bodyYaw = Math.atan2(-across[2], across[0]);
  if (head) {
    const [x, y, z, w] = head;
    // The same half turn about z, applied to a rotation, then the body's turn taken out.
    const half = -result.bodyYaw / 2;
    result.head = multiply([0, Math.sin(half), 0, Math.cos(half)], [-x, -y, z, w]);
  }
  if (width < MIN_SHOULDER_WIDTH_M || avatarShoulderWidth <= 0) return result;
  const scale = avatarShoulderWidth / width;
  const mid: [number, number, number] = [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2, (l[2] + r[2]) / 2];
  const place = (point: Point3, origin: readonly [number, number, number]): [number, number, number] => {
    const b = toBody(point);
    return yawBy([(b[0] - origin[0]) * scale, (b[1] - origin[1]) * scale, (b[2] - origin[2]) * scale], -result.bodyYaw);
  };

  const hands = (frame.hands ?? []).slice(0, 2);
  const sides = assignHandSides(hands, pose.image);
  for (const [i, hand] of hands.entries()) {
    const side = sides[i];
    const wristPose = pose.world[side === 'left' ? LEFT_WRIST : RIGHT_WRIST];
    if (!side || !wristPose || hand.world.length < 21) continue;
    const wrist = place(wristPose, mid);
    const wristHand = toBody(hand.world[0]!);
    const joints: BodyHand['joints'] = {};
    for (const [index, name] of HAND_JOINT_FOR_LANDMARK.entries()) {
      const shape = place(hand.world[index]!, wristHand);
      joints[name] = [wrist[0] + shape[0], wrist[1] + shape[1], wrist[2] + shape[2]];
    }
    result.hands[side] = { wrist, joints };
  }
  return result;
}
