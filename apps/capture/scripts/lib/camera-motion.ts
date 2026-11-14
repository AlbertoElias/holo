import * as THREE from 'three';
import type { BodySample, HandSample, VrHandSide } from '../../src/types/contracts';
import { PointDetector } from '../../src/xr/PointDetector';
import type { JointName, MotionFrame, Vec3 } from './motion-quality';

// The camera avatar as the motion-quality instrument reads it (docs/features/natural-avatar-motion.md, gap 2): the
// avatar's bones from __sampleBody, its wrists against the camera's tracked wrists from __sampleHands, and the app's
// own pointing ray (PointDetector over the camera's hand joints, wrist to tip). Shared by the bodycam check's guard
// and bodycam-avatar-replay.ts, so both grade the same thing.

export type CameraSample = { timeSec: number; body: BodySample; hands: Record<VrHandSide, HandSample> };

const BODY_JOINTS: JointName[] = ['head', 'neck', 'chest', 'hips', 'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist', 'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle', 'leftToe', 'rightToe'];

/** One frame per sample: bones, camera-driven wrists with their tracked input, and the ground under each foot. */
export function cameraMotionFrame(s: CameraSample): MotionFrame {
  const joints: MotionFrame['joints'] = {};
  for (const name of BODY_JOINTS) if (s.body.bones[name]) joints[name] = s.body.bones[name] as Vec3;
  const input: NonNullable<MotionFrame['input']> = {};
  for (const side of ['left', 'right'] as const) {
    const h = s.hands[side];
    if (h.source !== 'camera-hand') continue;
    if (h.avatar.wrist) joints[`${side}Wrist`] = h.avatar.wrist;
    if (h.tracked.wrist) input[`${side}Wrist`] = h.tracked.wrist;
  }
  const g = s.body.ground;
  return { timeSec: s.timeSec, joints, input, ground: { left: g.leftToe?.y ?? g.leftAnkle?.y ?? 0, right: g.rightToe?.y ?? g.rightAnkle?.y ?? 0 } };
}

/** The app's filtered pointing ray per sample and side, where the camera hand gives one. */
export function cameraPointRays(samples: CameraSample[]): Array<Partial<Record<VrHandSide, Vec3>>> {
  const detector = new PointDetector({ cameraHands: true });
  const rays: Array<Partial<Record<VrHandSide, Vec3>>> = samples.map(() => ({}));
  samples.forEach((s, i) => {
    const reader = {
      getHandPoseSource: (side: VrHandSide) => s.hands[side].source,
      getTrackedHandJointPosition: (side: VrHandSide, joint: keyof HandSample['tracked'], out: THREE.Vector3) => {
        const v = s.hands[side].tracked[joint];
        if (v) out.set(...v);
        return Boolean(v);
      }
    };
    detector.sample(s.timeSec, reader, (p) => {
      rays[i]![p.side] = [p.direction.x, p.direction.y, p.direction.z];
    });
  });
  return rays;
}

/**
 * The worst a lost hand may do: no faster a change than the tracked camera hand makes itself (aim clip: tracked wrist
 * p99 66, max 126 m/s²), well under a snap (260 to 325 m/s² when the arm jumped to rest or back in one frame).
 */
export const LOST_HAND_POP_MAX_MS2 = 150;

/**
 * The worst wrist acceleration (m/s²) across frames where the camera has lost that hand, or is just taking it back.
 * popP99 cannot see this: a snap on losing or regaining a hand is two frames in a clip, under the 99th percentile.
 */
export function lostHandPopMax(samples: CameraSample[]): number | null {
  let worst: number | null = null;
  for (const side of ['left', 'right'] as const) {
    for (let i = 1; i + 1 < samples.length; i += 1) {
      const [a, b, c] = [samples[i - 1]!, samples[i]!, samples[i + 1]!];
      if ([a, b, c].every((s) => s.hands[side].source === 'camera-hand')) continue;
      const [p, q, r] = [a, b, c].map((s) => s.body.bones[`${side}Wrist`]);
      const dt = (c.timeSec - a.timeSec) / 2;
      if (!p || !q || !r || dt <= 0) continue;
      const accel = Math.hypot(r[0] - 2 * q[0] + p[0], r[1] - 2 * q[1] + p[1], r[2] - 2 * q[2] + p[2]) / (dt * dt);
      worst = Math.max(worst ?? 0, accel);
    }
  }
  return worst;
}
