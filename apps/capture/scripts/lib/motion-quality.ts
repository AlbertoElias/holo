// One motion-quality report for the capture avatar, whatever drives it (VR
// body and hands, AR, camera, desktop keyboard or controller). It measures
// what mocap cleanup measures: feet (skate, float, penetration), joint
// limits, jitter, and hand/aim error and latency against the input when
// the input is known. Targets are per source (`MOTION_TARGETS`), because a
// camera is far noisier than a headset; see
// docs/features/archive/natural-avatar-motion.md for where each number comes from.
//
// Input is source-agnostic: per-frame world positions of named joints, the
// ground height under each foot, and optionally the input the avatar should
// follow (tracked wrists, head, or an aim ray). `framesFromBodySamples`
// adapts the body and hand replays' saved samples; the report CLI is
// scripts/motion-quality-report.ts.

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
  aimRay?: Vec3 | undefined;
  // Direction to a measured target from the fingertip (unit), when known.
  aimTarget?: Vec3 | undefined;
  // The input holds the avatar still (desktop keys released, settled): jitter is
  // judged on these frames instead of where each joint happens to be still, since
  // a living idle (breathing, weight shifts) is never still for long.
  held?: boolean;
};
export type MotionSource = 'vr-body' | 'vr-hands' | 'ar-quest' | 'ar-phone' | 'camera' | 'desktop' | 'authored';

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
  popP99MS2: number | null;
};

type Target = { max?: number; min?: number };
export type Targets = Partial<Record<keyof Omit<MotionMetrics, 'frames' | 'jointLimitWorst'>, Target>>;

// Aggressive, per source. Feet and pops are anchored to two CMU motion
// capture walks (subjects 02 and 07, trial 01; brief "Baselines"), which read
// skate max 2.6-3.9 cm, skate share 10-16%, pops p99 34-45 m/s^2; the targets
// sit at or below the better human walk. Penetration and float are mocap
// cleanup tolerances (the CMU floor drifts, so its own reads are not usable).
// Headset jitter is anchored to the real Quest hand recording's still-hand
// noise, camera jitter to the user's phone clip.
const HUMAN_FEET: Targets = {
  footSkateMaxCm: { max: 3 },
  footSkateShare: { max: 0.1 },
  footFloatP95Cm: { max: 1 },
  footPenetrationCm: { max: 0.5 },
  jointLimitShare: { max: 0 },
  popP99MS2: { max: 35 }
};
export const MOTION_TARGETS: Record<MotionSource, Targets> = {
  'vr-body': { ...HUMAN_FEET, jitterP95Mm: { max: 2 }, wristErrorP95Cm: { max: 1.5 }, latencyMs: { max: 0 }, jerkRatio: { max: 1.2 } },
  'vr-hands': { jointLimitShare: { max: 0 }, jitterP95Mm: { max: 2 }, wristErrorP95Cm: { max: 2 }, latencyMs: { max: 0 }, jerkRatio: { max: 1.2 } },
  'ar-quest': { ...HUMAN_FEET, jitterP95Mm: { max: 2 }, wristErrorP95Cm: { max: 1.5 }, latencyMs: { max: 0 }, jerkRatio: { max: 1.2 } },
  'ar-phone': { ...HUMAN_FEET, jitterP95Mm: { max: 2 } },
  camera: { ...HUMAN_FEET, jitterP95Mm: { max: 8 }, rayJitterP95Deg: { max: 3.5 }, aimErrorMedianDeg: { max: 3.5 }, latencyMs: { max: 100 } },
  // Desktop plays recorded human motion at a brisk 1.8 m/s, and pops grow with pace: the original
  // CMU walks (scripts/mocap/amc-to-dump.ts) read 34 at 1.3 m/s (02_01), 43 at 1.5 (07_01), 46 at
  // 1.9 (08_01) and 54 at 2.2 (07_12), so desktop pops sit at the human walk of its pace. Its held
  // jitter is the idle's life, not noise: CMU 113_21 standing still reads 4.1 mm; the target is under it.
  desktop: { ...HUMAN_FEET, popP99MS2: { max: 46 }, jitterP95Mm: { max: 3 } },
  // A take solved from a directed beat sheet (docs/features/directed-performance.md): no input to follow, so bodies only.
  authored: { ...HUMAN_FEET, jitterP95Mm: { max: 2 } }
};

// Human joint ranges (degrees between the two bones; 180 = straight).
// Knee flexion to ~155 deg (inner angle 25), elbow to ~150 (inner 30); neither
// bends backwards. Chest-over-hips twist ~45.
const KNEE_MIN_INNER_DEG = 25;
const ELBOW_MIN_INNER_DEG = 30;
const HYPEREXTENSION_M = 0.01;
const SPINE_TWIST_MAX_DEG = 45;

const PLANTED_SPEED_SHARE = 0.5;
const PLANTED_MIN_M_S = 0.3;
const CONTACT_M = 0.02;
const STILL_FOOT_M_S = 0.15;
const SPEED_HALF_WINDOW_SEC = 0.033;
const MIN_CONTACT_SEC = 0.1;
const REST_SEC = 0.5;
const POP_HALF_WINDOW_SEC = 0.05;
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

// Frames spanning `sec` at `rate`, at least 1. The epsilon keeps a 30 Hz take
// whose timestamps sum to 29.9999 Hz on the same stencil as an exact one.
function framesFor(rate: number, sec: number) {
  return Math.max(1, Math.round(rate * sec + 1e-6));
}

function feet(frames: MotionFrame[], options: MotionOptions) {
  const rate = fps(frames);
  // Speeds over a ±33 ms central difference, so tracker noise at high frame
  // rates does not read as sliding; contacts shorter than 100 ms are grazes.
  const k = framesFor(rate, SPEED_HALF_WINDOW_SEC);
  const minContact = framesFor(rate, MIN_CONTACT_SEC);
  const slides: number[] = [];
  const floats: number[] = [];
  let penetration = 0;
  let planted = 0;
  let skating = 0;
  const offsets = soleOffsets(frames, options);
  const speedOf = (i: number, joint: JointName) => {
    const a = frames[Math.max(0, i - k)]?.joints[joint];
    const b = frames[Math.min(frames.length - 1, i + k)]?.joints[joint];
    const span = Math.min(frames.length - 1, i + k) - Math.max(0, i - k);
    return a && b && span > 0 ? (len(flat(sub(b, a))) * rate) / span : 0;
  };
  for (const side of ['left', 'right'] as const) {
    const toeName = `${side}Toe` as const;
    const ankleName = `${side}Ankle` as const;
    let run: number[] = [];
    const closeRun = () => {
      if (run.length >= minContact) {
        const toe0 = frames[run[0]!]!.joints[toeName]!;
        const ankle0 = frames[run[0]!]!.joints[ankleName]!;
        let slide = 0;
        for (const i of run) {
          const f = frames[i]!;
          // A planted foot pivots on its heel (strike) or its ball (push-off),
          // so it slid as far as its stiller end did.
          slide = Math.max(slide, Math.min(len(flat(sub(f.joints[toeName]!, toe0))), len(flat(sub(f.joints[ankleName]!, ankle0)))));
          const speed = Math.min(speedOf(i, toeName), speedOf(i, ankleName));
          planted++;
          if (speed > STILL_FOOT_M_S) skating++;
          else floats.push(Math.max(0, soleAt(f, side) - offsets[side]));
        }
        slides.push(slide);
      }
      run = [];
    };
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]!;
      if (!f.joints[ankleName] || !f.joints[toeName]) {
        closeRun();
        continue;
      }
      const sole = soleAt(f, side);
      penetration = Math.min(penetration, sole - offsets[side]);
      // A foot near the floor that moves much slower than the body is planted;
      // a swing foot skims the floor (human toe clearance is 1-2 cm) but moves
      // several times faster than the hips.
      const speed = Math.min(speedOf(i, toeName), speedOf(i, ankleName));
      const bodySpeed = speedOf(i, 'hips');
      const inContact = sole <= CONTACT_M + offsets[side] && speed <= Math.max(PLANTED_SPEED_SHARE * bodySpeed, PLANTED_MIN_M_S);
      if (inContact) run.push(i);
      else closeRun();
    }
    closeRun();
  }
  return {
    footSkateMaxCm: slides.length ? Math.max(...slides) * 100 : null,
    footSkateShare: planted ? skating / planted : null,
    footFloatP95Cm: floats.length ? percentile(floats, 0.95)! * 100 : null,
    footPenetrationCm: planted ? Math.max(0, -penetration) * 100 : null
  };
}

function soleAt(f: MotionFrame, side: 'left' | 'right') {
  return Math.min(f.joints[`${side}Ankle`]![1], f.joints[`${side}Toe`]![1]) - (f.ground?.[side] ?? 0);
}

// The rig's resting sole height (lower foot joint above the floor). Taken from
// the first half second, where every in-app check stands still in its rest
// pose, so a foot that lifts or sinks after the rest reads as float or
// penetration. A take that floats from its first frame is offset away here;
// the body replay's absolute planted-sole guard (body-fidelity.ts) catches
// that one. A clip
// without a rest pose (mocap) passes `soleOffset: 'take'` (its 5th percentile).
function soleOffsets(frames: MotionFrame[], options: MotionOptions) {
  const out = { left: 0, right: 0 };
  const t0 = frames[0]?.timeSec ?? 0;
  for (const side of ['left', 'right'] as const) {
    const pool = frames.filter((f) => f.joints[`${side}Ankle`] && f.joints[`${side}Toe`] && (options.soleOffset === 'take' || f.timeSec - t0 <= REST_SEC));
    const soles = pool.map((f) => soleAt(f, side));
    out[side] = Math.max(0, (options.soleOffset === 'take' ? percentile(soles, 0.05) : soles.length ? Math.min(...soles) : 0) ?? 0);
  }
  return out;
}

// Pops: the p99 joint acceleration (m/s^2) over a ±50 ms stencil, every joint
// and frame. Pin/release snaps and solver flips show here even without input.
// The stencil reaches the nearest frames at least 50 ms either side by
// timestamp, so a take whose frames land unevenly (a replay stepping 32/48 ms)
// reads its real acceleration; on an even take it is the old fixed-k stencil.
function pops(frames: MotionFrame[]) {
  // Second difference over exactly ±50 ms, reading each side by linear
  // interpolation between the frames around it. Frames arrive 32–48 ms apart,
  // so a frame-count stencil reaches only ±34 ms on some takes (inflating
  // pops) and "the nearest frames ≥ 50 ms away" reaches ±64–80 ms (hiding them).
  const h = POP_HALF_WINDOW_SEC;
  const accels: number[] = [];
  if (frames.length < 3) return { popP99MS2: null };
  const first = frames[0]!.timeSec;
  const last = frames.at(-1)!.timeSec;
  // Frame index whose span [index, index + 1] holds the time.
  let before = 0;
  let after = 0;
  const sampleAt = (index: number, time: number, name: JointName): Vec3 | null => {
    const a = frames[index]!;
    const b = frames[index + 1]!;
    const pa = a.joints[name];
    const pb = b.joints[name];
    if (!pa || !pb) return null;
    const u = (time - a.timeSec) / (b.timeSec - a.timeSec || 1);
    return [pa[0] + (pb[0] - pa[0]) * u, pa[1] + (pb[1] - pa[1]) * u, pa[2] + (pb[2] - pa[2]) * u];
  };
  for (let i = 0; i < frames.length; i++) {
    const t = frames[i]!.timeSec;
    if (t - h < first || t + h > last) continue;
    while (before + 2 < frames.length && frames[before + 1]!.timeSec <= t - h) before += 1;
    if (after < before) after = before;
    while (after + 2 < frames.length && frames[after + 1]!.timeSec <= t + h) after += 1;
    const joints = frames[i]!.joints;
    for (const name of Object.keys(joints) as JointName[]) {
      const pb = joints[name];
      const pa = sampleAt(before, t - h, name);
      const pc = sampleAt(after, t + h, name);
      if (!pa || !pb || !pc) continue;
      accels.push(Math.hypot(pa[0] - 2 * pb[0] + pc[0], pa[1] - 2 * pb[1] + pc[1], pa[2] - 2 * pb[2] + pc[2]) / (h * h));
    }
  }
  return { popP99MS2: accels.length ? percentile(accels, 0.99) : null };
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
        // Backwards against both the hips' and the foot's own forward, so hips
        // yawed over planted feet in a turn do not read as backwards knees.
        const foot = j[`${side}Toe`] && j[`${side}Ankle`] ? flat(sub(j[`${side}Toe`]!, j[`${side}Ankle`]!)) : forward;
        if (len(knee.offset) > HYPEREXTENSION_M && dot(knee.offset, forward) < 0 && dot(knee.offset, len(foot) > 1e-3 ? foot : forward) < 0) issues.push(`${side} knee backwards`);
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

// Runs of flagged frames, [start, end). The smoother is fit inside each run
// only, so it never reaches into the motion before or after it.
function runs(flags: boolean[]) {
  const out: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    if (flags[i] && start < 0) start = i;
    if (!flags[i] && start >= 0) {
      if (i - start >= 3) out.push([start, i]);
      start = -1;
    }
  }
  return out;
}

// The joint's own smooth path at frame i: a least-squares quadratic over
// ±radius frames, centred on i (a Savitzky-Golay smoother) and fit against
// timestamps, so unevenly stepped frames do not bend it. Noise departs from
// it; a held joint that settles or drifts along a curve does not, where it
// would from a plain moving mean.
function smoothPath(series: Vec3[], times: number[], radius: number, i: number, bounds: [number, number] = [0, series.length]): Vec3 {
  const lo = Math.max(bounds[0], i - radius);
  const hi = Math.min(bounds[1] - 1, i + radius);
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  const t0 = [0, 0, 0], t1 = [0, 0, 0], t2 = [0, 0, 0];
  // In units of the mean frame step, which keeps the normal equations well scaled.
  const step = hi > lo ? (times[hi]! - times[lo]!) / (hi - lo) : 1;
  for (let q = lo; q <= hi; q++) {
    const x = (times[q]! - times[i]!) / (step || 1);
    s0++; s1 += x; s2 += x * x; s3 += x ** 3; s4 += x ** 4;
    for (let c = 0; c < 3; c++) {
      const y = series[q]![c]!;
      t0[c]! += y; t1[c]! += x * y; t2[c]! += x * x * y;
    }
  }
  // Value at x = 0 by Cramer's rule on the 3x3 normal equations.
  const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
  if (Math.abs(det) < 1e-9) return movingMean(series, radius, i);
  return [0, 1, 2].map((c) => (t0[c]! * (s2 * s4 - s3 * s3) - s1 * (t1[c]! * s4 - s3 * t2[c]!) + s2 * (t1[c]! * s3 - s2 * t2[c]!)) / det) as Vec3;
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
  const times = frames.map((f) => f.timeSec);
  const heldWindows = frames.some((f) => f.held !== undefined) ? runs(frames.map((f) => f.held === true)) : null;
  for (const name of JITTER_JOINTS) {
    const series = frames.map((f) => f.joints[name]);
    for (const [a, b] of heldWindows ?? stillWindows(frames, heldSpeed(series))) {
      if (series.slice(a, b).some((p) => !p)) continue;
      const full = series as Vec3[];
      for (let i = a; i < b; i++) deviations.push(len(sub(full[i]!, smoothPath(full, times, radius, i, heldWindows ? [a, b] : undefined))));
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

export type MotionOptions = { soleOffset?: 'rest' | 'take' };

export function measureMotion(frames: MotionFrame[], options: MotionOptions = {}): MotionMetrics {
  return { frames: frames.length, ...feet(frames, options), ...pops(frames), ...jointLimits(frames), ...jitter(frames), ...following(frames) };
}

export type MotionVerdict = { metric: string; value: number | null; target: Target; pass: boolean };

// A metric with no value fails: the take did not show it. The one exception
// is opt-in: `{ withoutInput: true }` says the take has no tracked input to
// follow (a body replay with no tracked hands), so its following metrics are
// not judged. `inputJitterP95Mm` is the tracked input's own jitter: jitter at
// or under it is the tracker's, so the bar is the target or that floor.
const FOLLOWING_METRICS = new Set(['wristErrorP95Cm', 'latencyMs', 'jerkRatio', 'aimErrorMedianDeg']);

export function judgeMotion(metrics: MotionMetrics, source: MotionSource, { withoutInput = false, inputJitterP95Mm = null }: { withoutInput?: boolean; inputJitterP95Mm?: number | null } = {}): MotionVerdict[] {
  return Object.entries(MOTION_TARGETS[source]).filter(([metric]) => !(withoutInput && FOLLOWING_METRICS.has(metric))).map(([metric, rowTarget]) => {
    const value = metrics[metric as keyof MotionMetrics] as number | null;
    const target: Target = metric === 'jitterP95Mm' && inputJitterP95Mm !== null && rowTarget.max !== undefined ? { max: Math.max(rowTarget.max, inputJitterP95Mm) } : rowTarget;
    const pass = value !== null && (target.max === undefined || value <= target.max + 1e-9) && (target.min === undefined || value >= target.min - 1e-9);
    return { metric, value, target, pass };
  });
}

// Body replay and hand replay samples share one shape: body bones (when the
// solver ran) plus per-hand tracked and avatar joints. `avatar` reads the
// avatar's joints; `tracked` the tracked input, whose jitter is the floor a
// solver cannot beat.
export const BODY_JOINTS: JointName[] = ['head', 'neck', 'chest', 'hips', 'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist', 'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle', 'leftToe', 'rightToe'];
export type BodyLikeSample = {
  timeMs: number;
  body?: { bones: Partial<Record<string, Vec3>>; ground?: Partial<Record<string, { y: number }>>; trackedHead?: { world: Vec3 } | null } | null;
  hands?: Partial<Record<string, { source?: string; tracked?: Partial<Record<string, Vec3>>; avatar?: Partial<Record<string, Vec3>> }>>;
};

const unitBetween = (a: Vec3, b: Vec3): Vec3 => {
  const d = sub(b, a);
  const l = len(d) || 1;
  return [d[0] / l, d[1] / l, d[2] / l];
};
const indexRay = (hand?: Partial<Record<string, Vec3>>) => {
  const base = hand?.['index-finger-phalanx-proximal'];
  const tip = hand?.['index-finger-tip'];
  return base && tip ? unitBetween(base, tip) : undefined;
};

export function framesFromBodySamples(samples: BodyLikeSample[], side: 'avatar' | 'tracked'): MotionFrame[] {
  return samples.map((s) => {
    const joints: MotionFrame['joints'] = {};
    for (const name of side === 'avatar' ? BODY_JOINTS : []) {
      const v = s.body?.bones?.[name];
      if (v) joints[name] = v;
    }
    const input: NonNullable<MotionFrame['input']> = {};
    for (const hand of ['left', 'right'] as const) {
      const h = s.hands?.[hand];
      if (!h || (h.source && h.source !== 'xr-hand' && h.source !== 'controller' && h.source !== 'camera-hand')) continue;
      const own = side === 'avatar' ? h.avatar : h.tracked;
      if (own?.wrist) joints[`${hand}Wrist`] = own.wrist;
      if (h.tracked?.wrist) input[`${hand}Wrist`] = h.tracked.wrist;
    }
    if (s.body?.trackedHead?.world) input.head = s.body.trackedHead.world;
    const g = s.body?.ground;
    const ray = indexRay(side === 'avatar' ? s.hands?.right?.avatar : s.hands?.right?.tracked);
    return {
      timeSec: s.timeMs / 1000,
      joints,
      input,
      ...(g ? { ground: { left: g.leftToe?.y ?? g.leftAnkle?.y ?? 0, right: g.rightToe?.y ?? g.rightAnkle?.y ?? 0 } } : {}),
      ...(ray ? { aimRay: ray } : {})
    };
  });
}
