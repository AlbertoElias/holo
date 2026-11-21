import * as THREE from 'three';
import { clamp } from '../shared/math';
import { CLAVICLE_PROTRACTION, ELBOW_POLE, PROTRACTION_RANGE, WRIST_RANGE } from './armPoseCoefficients';

/**
 * The VR arm pose from recorded human arms (CMU mocap, fitted by
 * `scripts/mocap/fit-arm-pose.ts`). Everything is in the torso frame of one
 * arm: x out of the body (mirrored per side), y up, z forward. `p` is the
 * wrist from the shoulder over the arm's length.
 */

// A small fixed pole (down, back, a little out) added to the fitted one, so the
// direction stays defined where the fit's pole lies along the arm.
const POLE_PRIOR = new THREE.Vector3(0.3, -1, -0.6).normalize().multiplyScalar(0.12);

// Clavicle elevation follows the shoulder rhythm (the CMU clavicle elevation does
// not follow the wrist): it starts once the arm is 30° up from hanging and
// reaches its most, 25°, near overhead.
const ELEVATION_MAX_DEG = 25;
const ELEVATION_START = THREE.MathUtils.degToRad(30);
const ELEVATION_FULL = THREE.MathUtils.degToRad(170);
// The clavicle's combined angle from bind eases into this limit (no kink).
export const CLAVICLE_LIMIT_DEG = 30;
const CLAVICLE_SOFT_START_DEG = 22;
// On a full reach the shoulder blade moves toward the target (the recorded
// reaches stay comfortable, so the fit does not show this): from 92% of the
// arm's length the clavicle turns toward the wrist, up to the limit at 112%.
const REACH_PUSH_START = 0.92;
const REACH_PUSH_FULL = 1.12;

const features = new Array<number>(13);

function fillFeatures(p: THREE.Vector3, across?: THREE.Vector3): number {
  const x = clamp(p.x, WRIST_RANGE[0]![0], WRIST_RANGE[0]![1]);
  const y = clamp(p.y, WRIST_RANGE[1]![0], WRIST_RANGE[1]![1]);
  const z = clamp(p.z, WRIST_RANGE[2]![0], WRIST_RANGE[2]![1]);
  features[0] = 1;
  features[1] = x;
  features[2] = y;
  features[3] = z;
  features[4] = x * x;
  features[5] = x * y;
  features[6] = x * z;
  features[7] = y * y;
  features[8] = y * z;
  features[9] = z * z;
  if (!across) return 10;
  features[10] = across.x;
  features[11] = across.y;
  features[12] = across.z;
  return 13;
}

/**
 * The direction the elbow bends toward, square to the shoulder–wrist line and
 * unit length; `across` is the palm's pinky-to-index direction. Returns false
 * only for a wrist on the shoulder.
 */
export function elbowPole(p: THREE.Vector3, across: THREE.Vector3, out: THREE.Vector3): boolean {
  const axisLength = p.length();
  if (axisLength < 1e-5) return false;
  const n = fillFeatures(p, across);
  out.copy(POLE_PRIOR);
  for (let i = 0; i < n; i++) {
    const row = ELBOW_POLE[i]!;
    out.x += features[i]! * row[0];
    out.y += features[i]! * row[1];
    out.z += features[i]! * row[2];
  }
  const along = out.dot(p) / (axisLength * axisLength);
  out.addScaledVector(p, -along);
  if (out.lengthSq() < 1e-10) {
    // Last resort (a pole exactly along the arm): straight out of the body.
    out.set(1, 0, 0).addScaledVector(p, -p.x / (axisLength * axisLength));
    if (out.lengthSq() < 1e-10) out.set(0, 0, -1);
  }
  out.normalize();
  return true;
}

export type ClavicleAngles = { elevationDeg: number; protractionDeg: number };

/** The clavicle's elevation and protraction from bind, in degrees, in a human range. */
export function clavicleAngles(p: THREE.Vector3, out: ClavicleAngles): ClavicleAngles {
  const n = fillFeatures(p);
  let protraction = 0;
  for (let i = 0; i < n; i++) protraction += features[i]! * CLAVICLE_PROTRACTION[i]!;
  protraction = clamp(protraction, PROTRACTION_RANGE[0], PROTRACTION_RANGE[1]);
  const length = p.length();
  const fromHanging = length > 1e-5 ? Math.acos(clamp(-p.y / length, -1, 1)) : 0;
  let elevation = ELEVATION_MAX_DEG * THREE.MathUtils.smoothstep(fromHanging, ELEVATION_START, ELEVATION_FULL);
  const push = length > 1e-5 ? CLAVICLE_LIMIT_DEG * THREE.MathUtils.smoothstep(length, REACH_PUSH_START, REACH_PUSH_FULL) : 0;
  if (push > 0) {
    protraction = clamp(protraction + (push * p.z) / length, -CLAVICLE_LIMIT_DEG, CLAVICLE_LIMIT_DEG);
    elevation = Math.min(elevation + (push * Math.max(0, p.y)) / length, CLAVICLE_LIMIT_DEG);
  }
  const total = Math.hypot(elevation, protraction);
  const scale = total > CLAVICLE_SOFT_START_DEG ? softLimit(total) / total : 1;
  out.elevationDeg = elevation * scale;
  out.protractionDeg = protraction * scale;
  return out;
}

// Slope 1 at the soft start, approaching the limit.
function softLimit(value: number): number {
  const room = CLAVICLE_LIMIT_DEG - CLAVICLE_SOFT_START_DEG;
  return CLAVICLE_SOFT_START_DEG + room * Math.tanh((value - CLAVICLE_SOFT_START_DEG) / room);
}
