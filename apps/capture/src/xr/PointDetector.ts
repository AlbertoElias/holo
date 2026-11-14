import * as THREE from 'three';
import type { HandPointSample } from '../recording/PointSampleStore';
import type { HandPoseSource, TrackedHandJointName, VrHandSide } from '../types/contracts';
import { type FingerChain, indexRay, type PointHandJoints, type PointVec3, scorePointPose } from './pointPose';

/** The slice of `XrTracking` the detector reads. */
export interface TrackedHandJointReader {
  getHandPoseSource(side: VrHandSide): HandPoseSource;
  getTrackedHandJointPosition(side: VrHandSide, jointName: TrackedHandJointName, out: THREE.Vector3): boolean;
}

const SIDES: readonly VrHandSide[] = ['left', 'right'];
type Finger = 'index' | 'middle' | 'ring' | 'pinky';
const CHAIN_JOINTS = ['phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'] as const;
const CHAIN_KEYS = ['proximal', 'intermediate', 'distal', 'tip'] as const;

// Low-pass time constants for the fingertip ray. Tracking jitter is a few
// millimetres at the tip but degrees in direction, so direction smooths more.
const ORIGIN_TIME_CONSTANT_SEC = 0.05;
const DIRECTION_TIME_CONSTANT_SEC = 0.09;
// Camera hands point along wrist to index tip, smoothed longer: on the user's
// clip that ray held 2.6 deg p95 against 4.7 at best for knuckle to tip
// (docs/features/natural-avatar-motion.md, gap 2).
const CAMERA_DIRECTION_TIME_CONSTANT_SEC = 0.25;
// After a gap this long the filter restarts instead of sliding from a stale ray.
const FILTER_RESET_GAP_SEC = 0.25;

interface SideFilter {
  valid: boolean;
  lastTimeSec: number;
  origin: THREE.Vector3;
  direction: THREE.Vector3;
}

/**
 * Point detection: each step, scores each tracked hand for a deliberate
 * index point and emits a filtered fingertip ray. Only real XRHand joints
 * count (`xr-hand`); controllers, the mock pose hook and held poses produce
 * nothing. `cameraHands` also admits `camera-hand`, whose ray runs from the
 * wrist: the camera grading uses it, while a take still records no points
 * from camera hands (docs/features/natural-avatar-motion.md, gap 2).
 * Segmenting into points happens at export, where the whole take is known.
 */
export class PointDetector {
  private readonly filters: Record<VrHandSide, SideFilter> = { left: createFilter(), right: createFilter() };
  private readonly jointScratch = new Map<string, THREE.Vector3>();
  private readonly rawOrigin: PointVec3 = { x: 0, y: 0, z: 0 };
  private readonly rawDirection: PointVec3 = { x: 0, y: 0, z: 0 };
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly options: { cameraHands?: boolean } = {}) {}

  reset(): void {
    for (const side of SIDES) this.filters[side].valid = false;
  }

  sample(timeSec: number, hands: TrackedHandJointReader, emit: (sample: HandPointSample) => void): void {
    for (const side of SIDES) {
      const source = hands.getHandPoseSource(side);
      if (source !== 'xr-hand' && !(this.options.cameraHands && source === 'camera-hand')) continue;
      const camera = source === 'camera-hand';
      const joints = this.readJoints(side, hands);
      const pose = scorePointPose(joints);
      const along = camera ? { ...joints.index, proximal: this.readJoint(side, 'wrist', hands) } : joints.index;
      if (!pose || !indexRay(along, this.rawOrigin, this.rawDirection)) continue;
      const filter = this.filters[side];
      this.filterRay(filter, timeSec, camera ? CAMERA_DIRECTION_TIME_CONSTANT_SEC : DIRECTION_TIME_CONSTANT_SEC);
      emit({
        timeSec,
        side,
        score: pose.score,
        origin: { x: filter.origin.x, y: filter.origin.y, z: filter.origin.z },
        direction: { x: filter.direction.x, y: filter.direction.y, z: filter.direction.z }
      });
    }
  }

  private filterRay(filter: SideFilter, timeSec: number, directionTimeConstantSec: number): void {
    const dt = timeSec - filter.lastTimeSec;
    if (!filter.valid || !(dt >= 0) || dt > FILTER_RESET_GAP_SEC) {
      filter.origin.set(this.rawOrigin.x, this.rawOrigin.y, this.rawOrigin.z);
      filter.direction.set(this.rawDirection.x, this.rawDirection.y, this.rawDirection.z);
    } else {
      const originAlpha = 1 - Math.exp(-dt / ORIGIN_TIME_CONSTANT_SEC);
      const directionAlpha = 1 - Math.exp(-dt / directionTimeConstantSec);
      filter.origin.lerp(this.tmp.set(this.rawOrigin.x, this.rawOrigin.y, this.rawOrigin.z), originAlpha);
      filter.direction.lerp(this.tmp.set(this.rawDirection.x, this.rawDirection.y, this.rawDirection.z), directionAlpha);
      // A reversal can cancel the blend; restart from the raw ray then.
      if (filter.direction.lengthSq() < 1e-8) filter.direction.copy(this.tmp);
      filter.direction.normalize();
    }
    filter.valid = true;
    filter.lastTimeSec = timeSec;
  }

  private readJoint(side: VrHandSide, jointName: TrackedHandJointName, hands: TrackedHandJointReader): THREE.Vector3 | undefined {
    let out = this.jointScratch.get(jointName);
    if (!out) {
      out = new THREE.Vector3();
      this.jointScratch.set(jointName, out);
    }
    return hands.getTrackedHandJointPosition(side, jointName, out) ? out : undefined;
  }

  private readJoints(side: VrHandSide, hands: TrackedHandJointReader): PointHandJoints {
    const read = (jointName: TrackedHandJointName): THREE.Vector3 | undefined => this.readJoint(side, jointName, hands);
    const chain = (finger: Finger): FingerChain => {
      const result: FingerChain = {};
      CHAIN_JOINTS.forEach((joint, i) => {
        result[CHAIN_KEYS[i]!] = read(`${finger}-finger-${joint}` as TrackedHandJointName);
      });
      return result;
    };
    return { thumbTip: read('thumb-tip'), index: chain('index'), middle: chain('middle'), ring: chain('ring'), pinky: chain('pinky') };
  }
}

function createFilter(): SideFilter {
  return { valid: false, lastTimeSec: 0, origin: new THREE.Vector3(), direction: new THREE.Vector3(0, 0, -1) };
}
