import * as THREE from 'three';
import type { CaptureContext } from '../systems/captureContext';
import type { HandPoseSource, TrackedHandJointName, VrHandSide } from '../types/contracts';

const TIPS = ['thumb-tip', 'index-finger-tip', 'middle-finger-tip', 'ring-finger-tip', 'pinky-finger-tip'] as const;
type Tuple = [number, number, number];

export interface BodycamHandSnapshot {
  source: HandPoseSource;
  poseValid: boolean;
  /** The camera's joints placed in the world (the wrist and the five fingertips). */
  tracked: Partial<Record<TrackedHandJointName, Tuple>>;
  /** The avatar's own bones on the same joints. */
  avatar: Partial<Record<TrackedHandJointName, Tuple>>;
}

/** What `__sampleBodycam` returns: the camera source, both hands, the head and the body, for the bodycam check. */
export interface BodycamSnapshot {
  /** The page opted in with `?input=camera`. */
  enabled: boolean;
  /** A frame has arrived and the source has not been released. */
  active: boolean;
  frames: number;
  cameraDriven: boolean;
  /** VR embodiment (a session or the mock pose): must stay false for a camera avatar. */
  vrActive: boolean;
  xrPresenting: boolean;
  hands: Record<VrHandSide, BodycamHandSnapshot>;
  /** Head and neck bones' world rotations [x, y, z, w], or null without those bones. */
  head: { head: [number, number, number, number] | null; neck: [number, number, number, number] | null };
  body: { lookYaw: number; rootYaw: number; rootPosition: Tuple; hipsY: number | null };
  /** The flat-screen camera's right axis in the world: where "on the right of the screen" points. */
  screenRight: Tuple;
  /** Avatar shoulder width, metres. */
  shoulderWidth: number;
  /** Capture's simulation clock, seconds: what the recorded frames' times are on. */
  simSec: number;
  /** The view camera's forward axis in the world, and the avatar's facing (where its face points), both unit vectors. */
  viewForward: Tuple;
  faceForward: Tuple;
  /** The canvas is flipped like a selfie preview. */
  canvasFlipped: boolean;
  /** Only with `includeRecorded`: what the recorder holds so far, per frame (the take's own `handSources`). */
  recorded?: { times: number[]; left: string[]; right: string[]; withoutSources: number };
}

const quat = (bone: THREE.Object3D | undefined): [number, number, number, number] | null => {
  if (!bone) return null;
  const q = bone.getWorldQuaternion(new THREE.Quaternion());
  return [q.x, q.y, q.z, q.w];
};

export function sampleBodycam(c: CaptureContext, includeRecorded = false): BodycamSnapshot {
  const sample = c.hands.sample();
  const pick = (joints: Partial<Record<TrackedHandJointName, Tuple>>): Partial<Record<TrackedHandJointName, Tuple>> => {
    const out: Partial<Record<TrackedHandJointName, Tuple>> = {};
    for (const name of ['wrist', ...TIPS] as const) if (joints[name]) out[name] = joints[name]!;
    return out;
  };
  const hand = (side: VrHandSide): BodycamHandSnapshot => ({
    source: sample[side].source,
    poseValid: c.tracking.getHandTrackingState(side).poseValid,
    tracked: pick(sample[side].tracked),
    avatar: pick(sample[side].avatar)
  });
  const left = c.avatar.getBoneWorldPosition('leftUpperArm', new THREE.Vector3());
  const right = c.avatar.getBoneWorldPosition('rightUpperArm', new THREE.Vector3());
  const hips = c.avatar.getBoneWorldPosition('hips', new THREE.Vector3());
  const root = c.avatar.avatarRoot;
  const screenRight = new THREE.Vector3().setFromMatrixColumn(c.stage.desktopCamera.matrixWorld, 0).normalize();
  const viewForward = new THREE.Vector3(0, 0, -1).transformDirection(c.stage.desktopCamera.matrixWorld);
  const faceForward = c.avatar.facingWorld(new THREE.Vector3());
  const frames = includeRecorded ? c.recording.recorder.getFrames() : [];
  const recorded = includeRecorded
    ? {
        times: frames.map((f) => f.timeSec),
        left: frames.map((f) => f.handSources?.left ?? 'missing'),
        right: frames.map((f) => f.handSources?.right ?? 'missing'),
        withoutSources: frames.filter((f) => !f.handSources).length
      }
    : undefined;
  return {
    enabled: c.tracking.camera.enabled,
    active: c.tracking.camera.isActive(),
    frames: c.tracking.camera.frameCount(),
    cameraDriven: c.tracking.isCameraDriven(),
    vrActive: c.frame.vrActive,
    xrPresenting: c.frame.xrPresenting,
    hands: { left: hand('left'), right: hand('right') },
    head: { head: quat(c.avatar.bone('head')), neck: quat(c.avatar.bone('neck')) },
    body: { lookYaw: c.camera.lookYaw, rootYaw: root.rotation.y, rootPosition: [root.position.x, root.position.y, root.position.z], hipsY: hips ? hips.y : null },
    screenRight: [screenRight.x, screenRight.y, screenRight.z],
    shoulderWidth: left && right ? left.distanceTo(right) : 0,
    simSec: c.frame.elapsedSec,
    viewForward: [viewForward.x, viewForward.y, viewForward.z],
    faceForward: [faceForward.x, faceForward.y, faceForward.z],
    canvasFlipped: c.stage.renderer.domElement.style.transform === 'scaleX(-1)',
    ...(recorded ? { recorded } : {})
  };
}
