// Pose score for a deliberate index point, from tracked XRHand joint
// positions. Pure math over plain vectors so offline tools can score raw
// input recordings with the same numbers the runtime uses.

export interface PointVec3 {
  x: number;
  y: number;
  z: number;
}

/** Joint positions of one hand, any shared rigid frame. Missing joints are undefined. */
export interface PointHandJoints {
  thumbTip?: PointVec3 | undefined;
  index: FingerChain;
  middle: FingerChain;
  ring: FingerChain;
  pinky: FingerChain;
}

export interface FingerChain {
  proximal?: PointVec3 | undefined;
  intermediate?: PointVec3 | undefined;
  distal?: PointVec3 | undefined;
  tip?: PointVec3 | undefined;
}

export interface PointPoseScore {
  /** In [0, 1]: index extended, the other three curled, no pinch. */
  score: number;
  indexStraightness: number;
  curl: number;
  pinchDistance: number;
}

// Straightness is chord over path length of proximal → tip: about 0.98 for a
// straight finger, 0.4–0.7 for a curled one.
const INDEX_EXTENDED_FROM = 0.84;
const INDEX_EXTENDED_TO = 0.94;
const OTHER_CURLED_FROM = 0.9;
const OTHER_CURLED_TO = 0.72;
// Thumb tip to index tip, in metres: a pinch closes it below 2–3 cm.
const PINCH_CLOSED = 0.03;
const PINCH_OPEN = 0.05;

export function scorePointPose(hand: PointHandJoints): PointPoseScore | undefined {
  const indexStraightness = straightness(hand.index);
  const middle = straightness(hand.middle);
  const ring = straightness(hand.ring);
  const pinky = straightness(hand.pinky);
  if (indexStraightness === undefined || middle === undefined || ring === undefined || !hand.thumbTip || !hand.index.tip) {
    return undefined;
  }
  const extended = smoothstep(INDEX_EXTENDED_FROM, INDEX_EXTENDED_TO, indexStraightness);
  const curledMiddle = smoothstep(OTHER_CURLED_FROM, OTHER_CURLED_TO, middle);
  const curledRing = smoothstep(OTHER_CURLED_FROM, OTHER_CURLED_TO, ring);
  // The little finger often stays half open in a relaxed point.
  const curledPinky = pinky === undefined ? 1 : Math.max(0.5, smoothstep(OTHER_CURLED_FROM, OTHER_CURLED_TO, pinky));
  const curl = Math.min(curledMiddle, curledRing) * curledPinky;
  const pinchDistance = distance(hand.thumbTip, hand.index.tip);
  const open = smoothstep(PINCH_CLOSED, PINCH_OPEN, pinchDistance);
  return { score: extended * curl * open, indexStraightness, curl, pinchDistance };
}

/**
 * The index ray: from the fingertip along proximal → tip, which stays stable
 * when only the distal joint flexes. Returns false when joints are missing.
 */
export function indexRay(index: FingerChain, origin: PointVec3, direction: PointVec3): boolean {
  const { proximal, tip } = index;
  if (!proximal || !tip) return false;
  const dx = tip.x - proximal.x;
  const dy = tip.y - proximal.y;
  const dz = tip.z - proximal.z;
  const length = Math.hypot(dx, dy, dz);
  if (!(length > 1e-4)) return false;
  origin.x = tip.x;
  origin.y = tip.y;
  origin.z = tip.z;
  direction.x = dx / length;
  direction.y = dy / length;
  direction.z = dz / length;
  return true;
}

function straightness(chain: FingerChain): number | undefined {
  const { proximal, intermediate, distal, tip } = chain;
  if (!proximal || !intermediate || !distal || !tip) return undefined;
  const path = distance(proximal, intermediate) + distance(intermediate, distal) + distance(distal, tip);
  if (!(path > 1e-4)) return undefined;
  return distance(proximal, tip) / path;
}

function distance(a: PointVec3, b: PointVec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Hermite step from 0 at `edge0` to 1 at `edge1`; edges may be descending. */
function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
