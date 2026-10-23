export type AppMode = 'desktop-third' | 'desktop-first' | 'vr' | 'mock-vr' | 'ar';

export type DesktopViewMode = 'third' | 'first';
export type VrHandSide = 'left' | 'right';

export const TRACKED_HAND_JOINT_NAMES = [
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
] as const;

export type TrackedHandJointName = (typeof TRACKED_HAND_JOINT_NAMES)[number];

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface CharacterSnapshot {
  position: Vec3Like;
  velocityY: number;
  grounded: boolean;
  horizontalSpeed: number;
  targetHorizontalSpeed: number;
  jumpQueued: boolean;
  avatarVisualOffsetY: number;
}

export interface HandPoseSnapshot {
  poseValid: boolean;
  targetPosition: Vec3Like;
  targetQuaternion: QuatLike;
  bonePosition: Vec3Like | null;
  sensorPosition: Vec3Like | null;
  jointTrackedCount?: number;
  calibrated?: boolean;
  pinchDistanceMeters?: number | null;
  fingerTips?: {
    thumb: Vec3Like | null;
    index: Vec3Like | null;
    middle: Vec3Like | null;
    ring: Vec3Like | null;
    pinky: Vec3Like | null;
  };
  retargetDataQuality?: {
    trackedSegments: number;
    heldSegments: number;
    fallbackSegments: number;
  };
  fingerLocalQuaternions?: {
    thumb: QuatLike | null;
    index: QuatLike | null;
    middle: QuatLike | null;
  };
}

export interface UiViewModel {
  mode: AppMode;
  controls: string;
  loadState: 'loading' | 'ready' | 'warning' | 'error';
  warning: string | null;
  recordingState: 'idle' | 'recording' | 'exporting';
  recordingMessage: string | null;
  heightFit: { enabled: boolean; pending: boolean; eyeHeight: number | null };
  micPermission: 'pending' | 'granted' | 'denied';
}

export interface BoneTransform {
  name: string;
  position: Vec3Like;
  quaternion: QuatLike;
}

export interface MorphTransform {
  path: string;
  influences: number[];
}

export interface RecordingFrame {
  timeSec: number;
  rootPosition: Vec3Like;
  rootQuaternion: QuatLike;
  bones: BoneTransform[];
  morphs: MorphTransform[];
}

// Tracked joints and the avatar bones at the same anatomical joints, in world
// space, for comparing how closely the avatar follows the user's hands.
// Input behind a hand pose: real XRHand joints, a controller, the
// deterministic mock payload, the last valid pose held through a dropout, a
// neutral pose shown before any tracking, or nothing.
export type HandPoseSource = 'xr-hand' | 'controller' | 'mock' | 'held' | 'fallback' | 'none';

export type HandSample = {
  source: HandPoseSource;
  tracked: Partial<Record<TrackedHandJointName, [number, number, number]>>;
  avatar: Partial<Record<TrackedHandJointName, [number, number, number]>>;
};

export type Vec3Tuple = [number, number, number];

// 'hands': close-ups of both hands; 'body': a third-person view that follows
// the avatar with the tracked head path drawn over it.
export type SpectatorViewMode = 'off' | 'hands' | 'body' | 'body-fixed';

// One frame of the VR body for fidelity checks, in world space. `trackedHead`
// is the app's own reading of the XR views (the check's ground truth comes
// from the recording itself); `rig` maps tracking space to world.
export type BodySample = {
  active: boolean;
  rig: { position: Vec3Tuple; quaternion: [number, number, number, number] };
  trackedHead: { local: Vec3Tuple; world: Vec3Tuple; worldQuaternion: [number, number, number, number] } | null;
  root: Vec3Tuple;
  bones: Partial<Record<string, Vec3Tuple>>;
  eyes: { left: Vec3Tuple; right: Vec3Tuple } | null;
  // True ground surface height and normal under each ankle and toe.
  ground: Partial<Record<'root' | 'leftAnkle' | 'rightAnkle' | 'leftToe' | 'rightToe', { y: number; normal: Vec3Tuple }>>;
  // Solver state, for diagnosis only; checks measure the bones instead.
  solver: { aligned: boolean; translating: boolean; turning: boolean; bodyYaw: number; steps: number; swinging: { left: boolean; right: boolean } };
  dims: { legLength: number; ankleHeight: number; toeHeight: number; toeForward: number; eyeHeight: number; hipHeight: number; stanceWidth: number } | null;
};

export type MockVrPoseInput = {
  enabled?: boolean;
  head?: { position?: Vec3Like; quaternion?: QuatLike };
  hands?: Partial<
    Record<
      VrHandSide,
      {
        tracked?: boolean;
        position?: Vec3Like;
        quaternion?: QuatLike;
        joints?: Partial<Record<TrackedHandJointName, { tracked?: boolean; position?: Vec3Like; quaternion?: QuatLike }>>;
      }
    >
  >;
};

export type MockInputState = {
  forward?: boolean;
  back?: boolean;
  left?: boolean;
  right?: boolean;
  crouch?: boolean;
  jump?: boolean;
  // Desktop point action: hold it, steer the body yaw, and set the aim pitch.
  point?: boolean;
  lookYaw?: number;
  aimPitch?: number;
  /** VR thumbstick axes, −1..1 (`moveY` forward-positive). */
  thumbstick?: { moveX?: number; moveY?: number; turnX?: number };
  turnMode?: 'snap' | 'smooth';
};
