import type {} from '../../src/runtime/automationHooks';

type Quat = [number, number, number, number];
type Vec3 = [number, number, number];
type Matrix = Float32Array;
type Mat16 = [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
type JointPose = { offsetMatrix: Matrix; radius: number };
type HandPose = { jointTransforms: Record<string, JointPose>; gripOffsetMatrix?: Matrix };
type Rigid = { q: Quat; t: Vec3 };
type BlendSide = 'left' | 'right';

declare global {
  interface Window {
    __blendHands?: (fromId: string, toId: string, t: number, sides?: BlendSide[]) => void;
  }
}

// Installs window.__blendHands(fromId, toId, t, sides?) in an IWER page: a
// writable "blend" pose per hand (both by default), interpolated between
// IWER's captured poses (translation lerp, rotation slerp per joint). Pass it
// to page.evaluate.
export function installHandBlend() {
  const quatFromMatrix = (m: Matrix): Quat => {
    const [m00, m10, m20, , m01, m11, m21, , m02, m12, m22] = m as unknown as Mat16;
    const trace = m00 + m11 + m22;
    let x: number; let y: number; let z: number; let w: number;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1);
      w = 0.25 / s; x = (m21 - m12) * s; y = (m02 - m20) * s; z = (m10 - m01) * s;
    } else if (m00 > m11 && m00 > m22) {
      const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
      w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
    } else if (m11 > m22) {
      const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
      w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
    } else {
      const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
      w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
    }
    return [x, y, z, w];
  };
  const slerp = (a: Quat, b: Quat, t: number): Quat => {
    let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    const sign = cos < 0 ? -1 : 1;
    cos *= sign;
    if (cos > 0.9995) {
      const out = a.map((value, i) => value + (sign * b[i]! - value) * t);
      const n = Math.hypot(...out);
      return out.map((value) => value / n) as Quat;
    }
    const theta = Math.acos(cos);
    const wa = Math.sin((1 - t) * theta) / Math.sin(theta);
    const wb = (sign * Math.sin(t * theta)) / Math.sin(theta);
    return a.map((value, i) => wa * value + wb * b[i]!) as Quat;
  };
  const compose = ([x, y, z, w]: Quat, [tx, ty, tz]: Vec3) => [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    tx, ty, tz, 1
  ];
  // Hierarchical blend: each joint's rotation and offset relative to its
  // parent joint is interpolated, then the hand is rebuilt from the wrist
  // out, so fingers rotate about their joints instead of cutting chords.
  const fingers = ['thumb', 'index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'];
  const parentOf: Record<string, string | null> = { wrist: null };
  for (const finger of fingers) {
    const chain = finger === 'thumb'
      ? ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip']
      : ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'].map((part) => `${finger}-${part}`);
    chain.forEach((joint, i) => { parentOf[joint] = i === 0 ? 'wrist' : chain[i - 1]!; });
  }
  const order = Object.keys(parentOf);
  const conj = ([x, y, z, w]: Quat): Quat => [-x, -y, -z, w];
  const qmul = ([ax, ay, az, aw]: Quat, [bx, by, bz, bw]: Quat): Quat => [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz
  ];
  const rotate = (q: Quat, [x, y, z]: Vec3): Vec3 => qmul(qmul(q, [x, y, z, 0]), conj(q)).slice(0, 3) as Vec3;
  const rigid = (m: Matrix): Rigid => ({ q: quatFromMatrix(m), t: [m[12]!, m[13]!, m[14]!] });
  const locals = (pose: HandPose): Record<string, Rigid> => Object.fromEntries(order.map((joint): [string, Rigid] => {
    const self = rigid(pose.jointTransforms[joint]!.offsetMatrix);
    const parent = parentOf[joint];
    if (!parent) return [joint, self];
    const base = rigid(pose.jointTransforms[parent]!.offsetMatrix);
    const inv = conj(base.q);
    return [joint, { q: qmul(inv, self.q), t: rotate(inv, self.t.map((v, i) => v - base.t[i]!) as Vec3) }];
  }));
  window.__blendHands = (fromId, toId, t, sides = ['left', 'right']) => {
    for (const hand of sides.map((side) => window.IWER_DEVICE!.hands[side]!)) {
      // IWER keeps the poses under a private symbol key; XRHandInput's types hide it.
      const internals = hand as unknown as Record<symbol, { poses: Record<string, HandPose> } | undefined>;
      const key = Object.getOwnPropertySymbols(hand).find((symbol) => internals[symbol]?.poses)!;
      const { poses } = internals[key]!;
      const from = poses[fromId]!;
      const to = poses[toId]!;
      const a = locals(from);
      const b = locals(to);
      const world: Record<string, Rigid> = {};
      const blend: HandPose = { jointTransforms: {} };
      if (from.gripOffsetMatrix && to.gripOffsetMatrix) {
        const gripFrom = rigid(from.gripOffsetMatrix);
        const gripTo = rigid(to.gripOffsetMatrix);
        blend.gripOffsetMatrix = new Float32Array(compose(
          slerp(gripFrom.q, gripTo.q, t),
          gripFrom.t.map((v, i) => v + (gripTo.t[i]! - v) * t) as Vec3
        ));
      }
      for (const joint of order) {
        const q = slerp(a[joint]!.q, b[joint]!.q, t);
        const local = a[joint]!.t.map((v, i) => v + (b[joint]!.t[i]! - v) * t) as Vec3;
        const parentJoint = parentOf[joint];
        const parent = parentJoint ? world[parentJoint] : undefined;
        world[joint] = parent
          ? { q: qmul(parent.q, q), t: rotate(parent.q, local).map((v, i) => v + parent.t[i]!) as Vec3 }
          : { q, t: local };
        const fromRadius = from.jointTransforms[joint]!.radius;
        blend.jointTransforms[joint] = {
          offsetMatrix: new Float32Array(compose(world[joint]!.q, world[joint]!.t)),
          radius: fromRadius + (to.jointTransforms[joint]!.radius - fromRadius) * t
        };
      }
      poses.blend = blend;
      hand.poseId = 'blend';
      hand.updatePinchValue(0);
      hand.updateHandPose();
    }
  };
}
