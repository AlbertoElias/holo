// One motion-quality report for the capture avatar, whatever drives it (VR
// body and hands, AR, camera, desktop keyboard or controller). It measures
// what mocap cleanup measures: feet (skate, float, penetration), joint
// limits, jitter, and hand/aim error and latency against the input when
// the input is known. Targets are per source (`MOTION_TARGETS`), because a
// camera is far noisier than a headset; see
// docs/features/natural-avatar-motion.md for where each number comes from.
//
// Input is source-agnostic: per-frame world positions of named joints, the
// ground height under each foot, and optionally the input the avatar should
// follow (tracked wrists, head, or an aim ray). Adapters for each source's
// saved samples live in scripts/motion-quality-report.ts.

export type Vec3 = [number, number, number];
export type JointName =
  | 'head' | 'neck' | 'chest' | 'hips'
  | 'leftShoulder' | 'rightShoulder' | 'leftElbow' | 'rightElbow' | 'leftWrist' | 'rightWrist'
  | 'leftHip' | 'rightHip' | 'leftKnee' | 'rightKnee' | 'leftAnkle' | 'rightAnkle' | 'leftToe' | 'rightToe';
export type MotionFrame = {
  timeSec: number;
  joints: Partial<Record<JointName, Vec3>>;
  // Ground height under each foot; flat 0 when absent.
  ground?: Partial<Record<'left' | 'right', number>>;
  // What the avatar should follow this frame, when the source knows it.
  input?: { leftWrist?: Vec3; rightWrist?: Vec3; head?: Vec3; aimRay?: Vec3 };
  // The avatar's own aim ray (unit), for aim error and ray jitter.
  aimRay?: Vec3;
  // Direction to a measured target from the fingertip (unit), when known.
  aimTarget?: Vec3;
};
export type MotionSource = 'vr-body' | 'vr-hands' | 'ar-quest' | 'ar-phone' | 'camera' | 'desktop';

export type MotionMetrics = {
  frames: number;
  // Feet: worst horizontal slide of a planted foot over one contact, share of
  // planted foot-frames sliding faster than 5 cm/s, p95 height of a planted
  // sole above ground, and deepest sole below ground.
  footSkateMaxCm: number | null;
  footSkateShare: number | null;
  footFloatP95Cm: number | null;
  footPenetrationCm: number | null;
  // Joint limits: share of frames with any knee or elbow bent backwards or
  // beyond human flexion, or chest twisted on the hips beyond human range.
  // (Neck twist needs head orientation; the body replay checks it.)
  jointLimitShare: number | null;
  jointLimitWorst: string | null;
  // Jitter (camera spike definition): p95 deviation of a joint from its own
  // centred 1 s moving mean, inside still windows trimmed 0.3 s at each end.
  jitterP95Mm: number | null;
  rayJitterP95Deg: number | null;
  // Input following: wrist error p95, aim error median, latency.
  wristErrorP95Cm: number | null;
  aimErrorMedianDeg: number | null;
  latencyMs: number | null;
  // Smoothness against the input: avatar wrist/head jerk RMS over input's.
  jerkRatio: number | null;
};

type Target = { max?: number; min?: number };
export type Targets = Partial<Record<keyof Omit<MotionMetrics, 'frames' | 'jointLimitWorst'>, Target>>;

// Aggressive, per source. Anchors (brief, "Targets"): mocap cleanup
// tolerances for feet, the human joint ranges below, the real Quest hand
// recording's own still-hand noise for headset jitter, and the user's phone
// clip for camera jitter. A null target means the metric does not apply.
const HUMAN_FEET: Targets = {
  footSkateMaxCm: { max: 1 },
  footSkateShare: { max: 0.01 },
  footFloatP95Cm: { max: 1 },
  footPenetrationCm: { max: 0.5 },
  jointLimitShare: { max: 0 }
};
export const MOTION_TARGETS: Record<MotionSource, Targets> = {
  'vr-body': { ...HUMAN_FEET, jitterP95Mm: { max: 2 }, wristErrorP95Cm: { max: 1.5 }, latencyMs: { max: 0 }, jerkRatio: { max: 1.2 } },
  'vr-hands': { jointLimitShare: { max: 0 }, jitterP95Mm: { max: 2 }, wristErrorP95Cm: { max: 2 }, latencyMs: { max: 0 }, jerkRatio: { max: 1.2 } },
  'ar-quest': { ...HUMAN_FEET, jitterP95Mm: { max: 2 }, wristErrorP95Cm: { max: 1.5 }, latencyMs: { max: 0 }, jerkRatio: { max: 1.2 } },
  'ar-phone': { ...HUMAN_FEET, jitterP95Mm: { max: 2 } },
  camera: { ...HUMAN_FEET, jitterP95Mm: { max: 8 }, rayJitterP95Deg: { max: 3.5 }, aimErrorMedianDeg: { max: 3.5 }, latencyMs: { max: 100 } },
  desktop: { ...HUMAN_FEET, jitterP95Mm: { max: 2 } }
};

// Human joint ranges (degrees between the two bones; 180 = straight).
// Knee flexion to ~155 deg (inner angle 25), elbow to ~150 (inner 30); neither
// bends backwards. Chest-over-hips twist ~45.
const KNEE_MIN_INNER_DEG = 25;
const ELBOW_MIN_INNER_DEG = 30;
const HYPEREXTENSION_M = 0.01;
const SPINE_TWIST_MAX_DEG = 45;

const CONTACT_M = 0.02;
const STILL_FOOT_M_S = 0.05;
const STILL_INPUT_M_S = 0.03; // ~6 deg/s on a 0.3 m ray
const STILL_MIN_SEC = 1;
const TRIM_SEC = 0.3;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const DEG = 180 / Math.PI;
const angleDeg = (a: Vec3, b: Vec3) => Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (len(a) * len(b) || 1)))) * DEG;
const flat = (a: Vec3): Vec3 => [a[0], 0, a[2]];

export function percentile(values: number[], p: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]!;
}

function median(values: number[]) {
  return percentile(values, 0.5);
}

function fps(frames: MotionFrame[]) {
  if (frames.length < 2) return 30;
  return (frames.length - 1) / Math.max(1e-6, frames[frames.length - 1]!.timeSec - frames[0]!.timeSec);
}

function feet(frames: MotionFrame[]) {
  const rate = fps(frames);
  const slides: number[] = [];
  const floats: number[] = [];
  let penetration = 0;
  let planted = 0;
  let skating = 0;
  for (const side of ['left', 'right'] as const) {
    let contactStart: Vec3 | null = null;
    let contactMax = 0;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]!;
      const ankle = f.joints[`${side}Ankle`];
      const toe = f.joints[`${side}Toe`];
      if (!ankle || !toe) continue;
      const ground = f.ground?.[side] ?? 0;
      // The sole is the lower of toe and ankle, less the ankle's height above
      // the sole, which the toe joint approximates on standard rigs.
      const sole = Math.min(ankle[1], toe[1]) - ground;
      penetration = Math.min(penetration, sole);
      const prevToe = frames[i - 1]?.joints[`${side}Toe`];
      const speed = prevToe ? len(flat(sub(toe, prevToe))) * rate : 0;
      const inContact = sole <= CONTACT_M + firstSoleOffset(frames, side);
      if (inContact) {
        planted++;
        if (speed > STILL_FOOT_M_S) skating++;
        if (speed <= STILL_FOOT_M_S * 2) floats.push(Math.max(0, sole - firstSoleOffset(frames, side)));
        contactStart ??= toe;
        contactMax = Math.max(contactMax, len(flat(sub(toe, contactStart))));
      } else if (contactStart) {
        slides.push(contactMax);
        contactStart = null;
        contactMax = 0;
      }
    }
    if (contactStart) slides.push(contactMax);
  }
  return {
    footSkateMaxCm: slides.length ? Math.max(...slides) * 100 : null,
    footSkateShare: planted ? skating / planted : null,
    footFloatP95Cm: floats.length ? percentile(floats, 0.95)! * 100 : null,
    footPenetrationCm: planted ? Math.max(0, -penetration) * 100 : null
  };
}

// The rig's resting sole height (toe joint above the sole), from the first
// frame, so float is measured from the sole and not the joint.
const soleOffsets = new WeakMap<MotionFrame[], Record<string, number>>();
function firstSoleOffset(frames: MotionFrame[], side: 'left' | 'right') {
  let cached = soleOffsets.get(frames);
  if (!cached) {
    cached = {};
    for (const s of ['left', 'right'] as const) {
      const lows = frames.flatMap((f) => {
        const a = f.joints[`${s}Ankle`];
        const t = f.joints[`${s}Toe`];
        return a && t ? [Math.min(a[1], t[1]) - (f.ground?.[s] ?? 0)] : [];
      });
      cached[s] = Math.max(0, percentile(lows, 0.05) ?? 0);
    }
    soleOffsets.set(frames, cached);
  }
  return cached[side] ?? 0;
}

function bend(a: Vec3 | undefined, mid: Vec3 | undefined, c: Vec3 | undefined) {
  if (!a || !mid || !c) return null;
  const inner = angleDeg(sub(a, mid), sub(c, mid));
  // Offset of the middle joint from the straight line a→c.
  const ac = sub(c, a);
  const t = dot(sub(mid, a), ac) / (dot(ac, ac) || 1);
  const offset = sub(mid, [a[0] + ac[0] * t, a[1] + ac[1] * t, a[2] + ac[2] * t]);
  return { inner, offset };
}

function yawOf(v: Vec3) {
  return Math.atan2(v[0], v[2]) * DEG;
}

function wrapDeg(d: number) {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

function jointLimits(frames: MotionFrame[]) {
  let bad = 0;
  let counted = 0;
  const worst = new Map<string, number>();
  for (const f of frames) {
    const j = f.joints;
    if (!j.hips || !j.leftHip || !j.rightHip) continue;
    counted++;
    // Body forward from the hips: right-to-left across, up.
    const across = sub(j.leftHip, j.rightHip);
    const forward = cross(across, [0, 1, 0]);
    const issues: string[] = [];
    for (const side of ['left', 'right'] as const) {
      const knee = bend(j[`${side}Hip`], j[`${side}Knee`], j[`${side}Ankle`]);
      if (knee) {
        if (knee.inner < KNEE_MIN_INNER_DEG) issues.push(`${side} knee over-flexed`);
        // A knee bends forward: its offset from hip→ankle points forward.
        if (len(knee.offset) > HYPEREXTENSION_M && dot(knee.offset, forward) < 0) issues.push(`${side} knee backwards`);
      }
      const elbow = bend(j[`${side}Shoulder`], j[`${side}Elbow`], j[`${side}Wrist`]);
      if (elbow) {
        if (elbow.inner < ELBOW_MIN_INNER_DEG) issues.push(`${side} elbow over-flexed`);
        // An elbow bends with its point backwards/outwards, never forwards
        // past the shoulder→wrist line toward the body's front and inward.
        const inward = side === 'left' ? -1 : 1;
        if (len(elbow.offset) > HYPEREXTENSION_M && dot(elbow.offset, forward) > 0.7 * len(elbow.offset) && dot(elbow.offset, across) * inward > 0) issues.push(`${side} elbow inverted`);
      }
    }
    if (j.leftShoulder && j.rightShoulder) {
      const twist = Math.abs(wrapDeg(yawOf(cross(sub(j.leftShoulder, j.rightShoulder), [0, 1, 0])) - yawOf(forward)));
      if (twist > SPINE_TWIST_MAX_DEG) issues.push('spine twist');
    }
    if (issues.length) bad++;
    for (const issue of issues) worst.set(issue, (worst.get(issue) ?? 0) + 1);
  }
  const top = [...worst.entries()].sort((a, b) => b[1] - a[1])[0];
  return { jointLimitShare: counted ? bad / counted : null, jointLimitWorst: top ? `${top[0]} (${top[1]} frames)` : null };
}

// Still windows: runs of at least STILL_MIN_SEC where the reference moves
// slower than STILL_INPUT_M_S, trimmed TRIM_SEC at each end.
function stillWindows(frames: MotionFrame[], speedAt: (i: number) => number | null) {
  const rate = fps(frames);
  const windows: Array<[number, number]> = [];
  let start = -1;
  for (let i = 1; i <= frames.length; i++) {
    const s = i < frames.length ? speedAt(i) : null;
    const still = s !== null && s < STILL_INPUT_M_S;
    if (still && start < 0) start = i;
    if (!still && start >= 0) {
      const trim = Math.round(TRIM_SEC * rate);
      if ((i - start) / rate >= STILL_MIN_SEC) windows.push([start + trim, i - trim]);
      start = -1;
    }
  }
  return windows.filter(([a, b]) => b - a >= 3);
}

function movingMean(series: Vec3[], radius: number, i: number): Vec3 {
  const sum: Vec3 = [0, 0, 0];
  let n = 0;
  for (let k = Math.max(0, i - radius); k <= Math.min(series.length - 1, i + radius); k++) {
    sum[0] += series[k]![0];
    sum[1] += series[k]![1];
    sum[2] += series[k]![2];
    n++;
  }
  return [sum[0] / n, sum[1] / n, sum[2] / n];
}

const JITTER_JOINTS: JointName[] = ['head', 'chest', 'hips', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle'];

function jitter(frames: MotionFrame[]) {
  const rate = fps(frames);
  const radius = Math.round(rate / 2);
  // Each joint is judged where it is held: its displacement over ±0.25 s
  // (insensitive to millimetre noise) under STILL_INPUT_M_S, so a joint that
  // walks, swings or reaches is not counted as noise.
  const k = Math.max(1, Math.round(rate / 4));
  const heldSpeed = (series: Array<Vec3 | undefined>) => (i: number) => {
    const a = series[i - k];
    const b = series[i + k];
    return a && b ? (len(sub(b, a)) * rate) / (2 * k) : null;
  };
  const deviations: number[] = [];
  const rayDeviations: number[] = [];
  for (const name of JITTER_JOINTS) {
    const series = frames.map((f) => f.joints[name]);
    for (const [a, b] of stillWindows(frames, heldSpeed(series))) {
      if (series.slice(a, b).some((p) => !p)) continue;
      const full = series as Vec3[];
      for (let i = a; i < b; i++) deviations.push(len(sub(full[i]!, movingMean(full, radius, i))));
    }
  }
  // Rays: the same definition in degrees, where the ray is held (angular
  // speed over ±0.25 s under 6 deg/s, scored as 0.3 m of lever).
  const rays = frames.map((f) => f.aimRay);
  if (rays.some(Boolean)) {
    const rayWindows = stillWindows(frames, (i) => {
      const r = rays[i + k];
      const p = rays[i - k];
      return r && p ? ((angleDeg(r, p) / DEG) * rate * 0.3) / (2 * k) : null;
    });
    for (const [a, b] of rayWindows) {
      const full = rays as Vec3[];
      for (let i = a; i < b; i++) rayDeviations.push(angleDeg(full[i]!, movingMean(full, radius, i)));
    }
  }
  return {
    jitterP95Mm: deviations.length ? percentile(deviations, 0.95)! * 1000 : null,
    rayJitterP95Deg: rayDeviations.length ? percentile(rayDeviations, 0.95) : null
  };
}

function jerkRms(series: Vec3[], rate: number) {
  const values: number[] = [];
  for (let i = 3; i < series.length; i++) {
    const j: Vec3 = [0, 1, 2].map((k) => (series[i]![k]! - 3 * series[i - 1]![k]! + 3 * series[i - 2]![k]! - series[i - 3]![k]!) * rate ** 3) as Vec3;
    values.push(dot(j, j));
  }
  return values.length ? Math.sqrt(values.reduce((s, v) => s + v, 0) / values.length) : null;
}

function bestLagFrames(input: Vec3[], avatar: Vec3[], maxLag: number) {
  let best = 0;
  let bestErr = Infinity;
  for (let lag = 0; lag <= maxLag; lag++) {
    let err = 0;
    let n = 0;
    for (let i = 0; i + lag < avatar.length; i++) {
      err += len(sub(avatar[i + lag]!, input[i]!)) ** 2;
      n++;
    }
    if (n && err / n < bestErr - 1e-9) {
      bestErr = err / n;
      best = lag;
    }
  }
  return best;
}

function following(frames: MotionFrame[]) {
  const rate = fps(frames);
  const errors: number[] = [];
  let lagSum = 0;
  let lagCount = 0;
  const ratios: number[] = [];
  for (const side of ['left', 'right'] as const) {
    const pairs = frames.flatMap((f) => {
      const inp = f.input?.[`${side}Wrist`];
      const av = f.joints[`${side}Wrist`];
      return inp && av ? [[inp, av] as const] : [];
    });
    if (pairs.length < 10) continue;
    for (const [inp, av] of pairs) errors.push(len(sub(inp, av)));
    const input = pairs.map((p) => p[0]);
    const avatar = pairs.map((p) => p[1]);
    lagSum += bestLagFrames(input, avatar, Math.round(rate / 2));
    lagCount++;
    const ji = jerkRms(input, rate);
    const ja = jerkRms(avatar, rate);
    if (ji && ja) ratios.push(ja / ji);
  }
  const aimErrors = frames.flatMap((f) => (f.aimRay && f.aimTarget ? [angleDeg(f.aimRay, f.aimTarget)] : []));
  return {
    wristErrorP95Cm: errors.length ? percentile(errors, 0.95)! * 100 : null,
    aimErrorMedianDeg: aimErrors.length ? median(aimErrors) : null,
    latencyMs: lagCount ? ((lagSum / lagCount) * 1000) / rate : null,
    jerkRatio: ratios.length ? Math.max(...ratios) : null
  };
}

export function measureMotion(frames: MotionFrame[]): MotionMetrics {
  return { frames: frames.length, ...feet(frames), ...jointLimits(frames), ...jitter(frames), ...following(frames) };
}

export type MotionVerdict = { metric: string; value: number | null; target: Target; pass: boolean };

export function judgeMotion(metrics: MotionMetrics, source: MotionSource): MotionVerdict[] {
  return Object.entries(MOTION_TARGETS[source]).map(([metric, target]) => {
    const value = metrics[metric as keyof MotionMetrics] as number | null;
    const pass = value !== null && (target.max === undefined || value <= target.max + 1e-9) && (target.min === undefined || value >= target.min - 1e-9);
    return { metric, value, target: target as Target, pass };
  });
}
