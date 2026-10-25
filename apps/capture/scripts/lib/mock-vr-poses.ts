import type { HandPoseSnapshot, MockVrPoseInput, QuatLike, TrackedHandJointName, Vec3Like, VrHandSide } from '../../src/types/contracts';

type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';
type CurlsByFinger = Record<FingerName, number[]>;
type HandJoints = NonNullable<NonNullable<MockVrPoseInput['hands']>[VrHandSide]>['joints'];
type JointMap = NonNullable<HandJoints>;
// The hand part of a render_game_to_text snapshot; older snapshots named the
// bone and sensor positions `bone` and `sensor`.
export type HandTracking = Partial<HandPoseSnapshot> & { bone?: Vec3Like | null; sensor?: Vec3Like | null };
type HandInput = { position: Vec3Like; quaternion: QuatLike };

const TRACKED_HAND_JOINT_NAMES: readonly TrackedHandJointName[] = [
  'wrist',
  'thumb-metacarpal',
  'thumb-phalanx-proximal',
  'thumb-phalanx-distal',
  'thumb-tip',
  'index-finger-metacarpal',
  'index-finger-phalanx-proximal',
  'index-finger-phalanx-intermediate',
  'index-finger-phalanx-distal',
  'index-finger-tip',
  'middle-finger-metacarpal',
  'middle-finger-phalanx-proximal',
  'middle-finger-phalanx-intermediate',
  'middle-finger-phalanx-distal',
  'middle-finger-tip',
  'ring-finger-metacarpal',
  'ring-finger-phalanx-proximal',
  'ring-finger-phalanx-intermediate',
  'ring-finger-phalanx-distal',
  'ring-finger-tip',
  'pinky-finger-metacarpal',
  'pinky-finger-phalanx-proximal',
  'pinky-finger-phalanx-intermediate',
  'pinky-finger-phalanx-distal',
  'pinky-finger-tip'
];

const FINGER_CHAINS: Record<FingerName, TrackedHandJointName[]> = {
  thumb: ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  index: ['index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip'],
  middle: ['middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip'],
  ring: ['ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip'],
  pinky: ['pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip']
};

const FINGER_ROOT_OFFSETS: Record<FingerName, Vec3Like> = {
  thumb: { x: -0.034, y: 0.02, z: 0.02 },
  index: { x: -0.021, y: 0.085, z: 0.014 },
  middle: { x: -0.005, y: 0.084, z: 0.011 },
  ring: { x: 0.017, y: 0.086, z: 0.009 },
  pinky: { x: 0.033, y: 0.079, z: 0.006 }
};

const FINGER_SEGMENT_LENGTHS: Record<FingerName, number[]> = {
  thumb: [0.03, 0.026, 0.022, 0.018],
  index: [0.03, 0.028, 0.024, 0.02],
  middle: [0.032, 0.03, 0.025, 0.02],
  ring: [0.029, 0.027, 0.023, 0.018],
  pinky: [0.024, 0.02, 0.016, 0.012]
};

const OPEN_HAND_CURL: CurlsByFinger = {
  thumb: [0, 0, 0, 0],
  index: [0, 0, 0, 0],
  middle: [0, 0, 0, 0],
  ring: [0, 0, 0, 0],
  pinky: [0, 0, 0, 0]
};

const PINCH_CURL: CurlsByFinger = {
  thumb: [0.2, 0.75, 0.35, 0.1],
  index: [0.15, 1.7, 0.55, 0.4],
  middle: [0, 0, 0, 0],
  ring: [0, 0, 0, 0],
  pinky: [0, 0, 0, 0]
};

const POINTING_CURL: CurlsByFinger = {
  thumb: [0.2, 0.24, 0.2, 0.12],
  index: [0.04, 0.06, 0.05, 0.04],
  middle: [0.72, 0.9, 0.82, 0.66],
  ring: [0.78, 0.98, 0.88, 0.72],
  pinky: [0.84, 1.04, 0.92, 0.75]
};

const INDEX_DROPOUT_JOINTS: TrackedHandJointName[] = [
  'index-finger-phalanx-proximal',
  'index-finger-phalanx-intermediate',
  'index-finger-phalanx-distal',
  'index-finger-tip'
];

export function boneOf(snapshot: HandTracking | null | undefined): Vec3Like | null {
  return snapshot?.bonePosition ?? snapshot?.bone ?? null;
}

export function sensorOf(snapshot: HandTracking | null | undefined): Vec3Like | null {
  return snapshot?.sensorPosition ?? snapshot?.sensor ?? null;
}

export function trackedJointCountOf(snapshot: HandTracking | null | undefined): number {
  return snapshot?.jointTrackedCount ?? 0;
}

export function fingerQuatOf(snapshot: HandTracking | null | undefined, fingerName: keyof NonNullable<HandPoseSnapshot['fingerLocalQuaternions']>): QuatLike | null {
  return snapshot?.fingerLocalQuaternions?.[fingerName] ?? null;
}

export function tipOf(snapshot: HandTracking | null | undefined, fingerName: FingerName): Vec3Like | null {
  return snapshot?.fingerTips?.[fingerName] ?? null;
}

export function retargetQualityOf(snapshot: HandTracking | null | undefined): HandPoseSnapshot['retargetDataQuality'] | null {
  return snapshot?.retargetDataQuality ?? null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function distance(a: Vec3Like | null | undefined, b: Vec3Like | null | undefined): number {
  if (!a || !b) return Number.NaN;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function quatFromAxisAngle(axis: Vec3Like, radians: number): QuatLike {
  const half = radians * 0.5;
  const sinHalf = Math.sin(half);
  return {
    x: axis.x * sinHalf,
    y: axis.y * sinHalf,
    z: axis.z * sinHalf,
    w: Math.cos(half)
  };
}

function quatMultiply(a: QuatLike, b: QuatLike): QuatLike {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  };
}

function normalizeQuat(quaternion: QuatLike): QuatLike {
  const length = Math.hypot(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  if (length < 1e-8) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  return {
    x: quaternion.x / length,
    y: quaternion.y / length,
    z: quaternion.z / length,
    w: quaternion.w / length
  };
}

function rotateVecByQuat(vector: Vec3Like, quaternion: QuatLike): Vec3Like {
  const { x, y, z, w } = quaternion;
  const ix = w * vector.x + y * vector.z - z * vector.y;
  const iy = w * vector.y + z * vector.x - x * vector.z;
  const iz = w * vector.z + x * vector.y - y * vector.x;
  const iw = -x * vector.x - y * vector.y - z * vector.z;
  return {
    x: ix * w + iw * -x + iy * -z - iz * -y,
    y: iy * w + iw * -y + iz * -x - ix * -z,
    z: iz * w + iw * -z + ix * -y - iy * -x
  };
}

export function quatAngleDelta(a: QuatLike | null | undefined, b: QuatLike | null | undefined): number {
  if (!a || !b) return Number.NaN;
  const dot = Math.abs(clamp(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w, -1, 1));
  return 2 * Math.acos(dot);
}

function mirroredX(side: VrHandSide, value: number): number {
  return side === 'left' ? value : -value;
}

function addVec(a: Vec3Like, b: Vec3Like): Vec3Like {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scaleVec(a: Vec3Like, scalar: number): Vec3Like {
  return { x: a.x * scalar, y: a.y * scalar, z: a.z * scalar };
}

function buildHandJoints(side: VrHandSide, wristPosition: Vec3Like, curlsByFinger: CurlsByFinger): JointMap {
  const joints: JointMap = {};
  const curlAxis = { x: 1, y: 0, z: 0 };
  const forward = { x: 0, y: 1, z: 0 };

  joints.wrist = {
    tracked: true,
    position: wristPosition,
    quaternion: { x: 0, y: 0, z: 0, w: 1 }
  };

  for (const fingerName of Object.keys(FINGER_CHAINS) as FingerName[]) {
    const chain = FINGER_CHAINS[fingerName];
    const rootOffset = FINGER_ROOT_OFFSETS[fingerName];
    const lengths = FINGER_SEGMENT_LENGTHS[fingerName];
    const curls = curlsByFinger[fingerName] ?? [];

    let jointPosition = addVec(wristPosition, {
      x: mirroredX(side, rootOffset.x),
      y: rootOffset.y,
      z: rootOffset.z
    });
    let jointWorldQuat = { x: 0, y: 0, z: 0, w: 1 };

    for (let index = 0; index < chain.length; index += 1) {
      const jointName = chain[index]!;
      const localCurl = curls[index] ?? 0;
      if (localCurl !== 0) {
        const localQuat = quatFromAxisAngle(curlAxis, localCurl);
        jointWorldQuat = normalizeQuat(quatMultiply(jointWorldQuat, localQuat));
      }

      joints[jointName] = {
        tracked: true,
        position: jointPosition,
        quaternion: jointWorldQuat
      };

      const nextLength = lengths[index];
      if (nextLength) {
        jointPosition = addVec(
          jointPosition,
          scaleVec(rotateVecByQuat(forward, jointWorldQuat), nextLength)
        );
      }
    }
  }

  for (const jointName of TRACKED_HAND_JOINT_NAMES) {
    if (joints[jointName]) continue;
    joints[jointName] = {
      tracked: true,
      position: wristPosition,
      quaternion: { x: 0, y: 0, z: 0, w: 1 }
    };
  }

  return joints;
}

function buildMockPoseInput({ headQuaternion, leftHand, rightHand, leftCurls, rightCurls }: {
  headQuaternion: QuatLike;
  leftHand: HandInput;
  rightHand: HandInput;
  leftCurls: CurlsByFinger;
  rightCurls: CurlsByFinger;
}): MockVrPoseInput {
  return {
    enabled: true,
    head: {
      position: { x: 0, y: 0, z: 0 },
      quaternion: headQuaternion
    },
    hands: {
      left: {
        tracked: true,
        position: leftHand.position,
        quaternion: leftHand.quaternion,
        joints: buildHandJoints('left', leftHand.position, leftCurls)
      },
      right: {
        tracked: true,
        position: rightHand.position,
        quaternion: rightHand.quaternion,
        joints: buildHandJoints('right', rightHand.position, rightCurls)
      }
    }
  };
}

function clonePose(pose: MockVrPoseInput): MockVrPoseInput {
  return JSON.parse(JSON.stringify(pose));
}

function withJointDropout(pose: MockVrPoseInput, side: VrHandSide, jointNames: TrackedHandJointName[]): MockVrPoseInput {
  const nextPose = clonePose(pose);
  const sideJoints = nextPose?.hands?.[side]?.joints;
  if (!sideJoints) return nextPose;
  for (const jointName of jointNames) {
    const joint = sideJoints[jointName];
    if (!joint) continue;
    joint.tracked = false;
    delete joint.position;
    delete joint.quaternion;
  }
  return nextPose;
}

export function sourcePinchDistanceOf(pose: MockVrPoseInput | null | undefined, side: VrHandSide): number {
  const joints = pose?.hands?.[side]?.joints;
  const thumbTip = joints?.['thumb-tip']?.position;
  const indexTip = joints?.['index-finger-tip']?.position;
  return distance(thumbTip, indexTip);
}

export const relaxedPose: MockVrPoseInput = buildMockPoseInput({
  headQuaternion: { x: 0, y: 0, z: 0, w: 1 },
  leftHand: {
    position: { x: -0.26, y: -0.2, z: -0.42 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 }
  },
  rightHand: {
    position: { x: 0.26, y: -0.2, z: -0.42 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 }
  },
  leftCurls: OPEN_HAND_CURL,
  rightCurls: OPEN_HAND_CURL
});

export const pinchPose: MockVrPoseInput = buildMockPoseInput({
  headQuaternion: { x: 0, y: 0.25, z: 0, w: 0.9682458365518543 },
  leftHand: {
    position: { x: -0.36, y: -0.1, z: -0.25 },
    quaternion: { x: 0, y: 0.3826834323650898, z: 0, w: 0.9238795325112867 }
  },
  rightHand: {
    position: { x: 0.34, y: 0.03, z: -0.2 },
    quaternion: { x: 0, y: -0.25881904510252074, z: 0, w: 0.9659258262890683 }
  },
  leftCurls: PINCH_CURL,
  rightCurls: PINCH_CURL
});

export const pointingPose: MockVrPoseInput = buildMockPoseInput({
  headQuaternion: { x: 0, y: 0.25, z: 0, w: 0.9682458365518543 },
  leftHand: {
    position: { x: -0.34, y: -0.12, z: -0.24 },
    quaternion: { x: 0, y: 0.36, z: 0, w: 0.9329523032 }
  },
  rightHand: {
    position: { x: 0.33, y: 0.02, z: -0.18 },
    quaternion: { x: 0, y: -0.22, z: 0, w: 0.9754998711 }
  },
  leftCurls: POINTING_CURL,
  rightCurls: POINTING_CURL
});

export const dropoutPose: MockVrPoseInput = withJointDropout(relaxedPose, 'right', INDEX_DROPOUT_JOINTS);
