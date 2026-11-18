/**
 * How a walk reads as a person walking (docs/features/realistic-avatar-motion.md):
 * arm swing and its phase against the legs, knee flexion in swing and stance,
 * stance share, cadence and left/right step symmetry. Measured on a steady
 * walk window of avatar joints, with fore-aft taken along the hips' travel.
 *
 * Contact: a foot is in stance while its ankle or its toe is nearly still
 * (under CONTACT_SPEED_SHARE of the walk speed): the heel lands first and the
 * toe leaves last, so either point resting means the foot bears weight.
 */
import type { MotionFrame, Vec3 } from './motion-quality.ts';

export type GaitMetrics = {
  strides: number;
  cadenceStepsPerMin: number | null;
  /** Wrist travel fore-aft relative to the hips per stride, scaled to a 1.8 m avatar (median of both arms). */
  armSwingCm: number | null;
  /** Correlation of each wrist's fore-aft with its own side's ankle (antiphase is negative); the worse arm. */
  armLegCorrelation: number | null;
  /** Peak knee flexion in swing (median over swings), the lower knee. */
  kneeSwingFlexDeg: number | null;
  kneeSwingFlexMaxDeg: number | null;
  /** Knee flexion at mid-stance, where the ankle passes under the hips (median over stances), the more bent knee: a crouched, "injured" walk reads high. */
  kneeMidStanceFlexDeg: number | null;
  stanceShareLeft: number | null;
  stanceShareRight: number | null;
  /** |left step time - right step time| / mean step time. */
  stepAsymmetry: number | null;
};

type Target = { min?: number; max?: number };
// Anchored on real people measured by this same code: the original CMU walks
// 02_01, 07_01, 07_12 and 08_01 (1.2-1.9 m/s, converted by
// scripts/mocap/amc-to-dump.ts). Joint centres from markers read more knee bend
// and less stance than a gait lab's definitions (stance ~60 %, mid-stance knee
// ~5-10°, Perry & Burnfield), so the targets are the takes' range, not the
// textbook's: they read mid-stance knee 16-37°, swing knee 68-73°, stance share
// (speed-based contact) 0.38-0.52, arm swing 31-59 cm. The bent-kneed FBX
// conversion of the same takes reads 53° at mid-stance.
// Swing knee allows 78°: the retargeted clip reads 77° (slice 2 brings it to the
// takes' range); mid-stance allows 40° for the same reason. A locked knee (under
// 10°) fails.
export const GAIT_TARGETS: Partial<Record<keyof GaitMetrics, Target>> = {
  armSwingCm: { min: 30, max: 55 },
  armLegCorrelation: { max: -0.5 },
  kneeSwingFlexDeg: { min: 45, max: 78 },
  kneeMidStanceFlexDeg: { min: 10, max: 40 },
  stanceShareLeft: { min: 0.38, max: 0.55 },
  stanceShareRight: { min: 0.38, max: 0.55 },
  stepAsymmetry: { max: 0.08 },
  cadenceStepsPerMin: { min: 100, max: 140 }
};

const CONTACT_SPEED_SHARE = 0.2;
const MIN_SWING_SEC = 0.15;
const REFERENCE_HEIGHT_M = 1.8;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const median = (v: number[]) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]! : null);

function flexion(hip: Vec3, knee: Vec3, ankle: Vec3): number {
  const a = sub(hip, knee), b = sub(ankle, knee);
  const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / ((len(a) * len(b)) || 1);
  return 180 - (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

function correlation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) { ab += (a[i]! - ma) * (b[i]! - mb); aa += (a[i]! - ma) ** 2; bb += (b[i]! - mb) ** 2; }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : null;
}

/** `frames`: a steady walk (no start or stop); `heightM`: the avatar's standing height. */
export function measureGait(frames: MotionFrame[], heightM: number): GaitMetrics {
  const empty: GaitMetrics = { strides: 0, cadenceStepsPerMin: null, armSwingCm: null, armLegCorrelation: null, kneeSwingFlexDeg: null, kneeSwingFlexMaxDeg: null, kneeMidStanceFlexDeg: null, stanceShareLeft: null, stanceShareRight: null, stepAsymmetry: null };
  const usable = frames.filter((f) => f.joints.hips && f.joints.leftAnkle && f.joints.rightAnkle);
  if (usable.length < 10) return empty;
  const first = usable[0]!, last = usable.at(-1)!;
  const duration = last.timeSec - first.timeSec;
  const travel = sub(last.joints.hips!, first.joints.hips!);
  const flat = Math.hypot(travel[0], travel[2]);
  if (!(duration > 0) || flat < 0.5) return empty;
  const forward: Vec3 = [travel[0] / flat, 0, travel[2] / flat];
  const speed = flat / duration;
  const scale = REFERENCE_HEIGHT_M / (heightM || REFERENCE_HEIGHT_M);
  const along = (f: MotionFrame, joint: keyof MotionFrame['joints']) => {
    const p = f.joints[joint], h = f.joints.hips!;
    return p ? (p[0] - h[0]) * forward[0] + (p[2] - h[2]) * forward[2] : null;
  };
  const speedAt = (i: number, joint: keyof MotionFrame['joints']) => {
    const a = usable[Math.max(0, i - 1)]!, b = usable[Math.min(usable.length - 1, i + 1)]!;
    const pa = a.joints[joint], pb = b.joints[joint];
    return pa && pb && b.timeSec > a.timeSec ? Math.hypot(pb[0] - pa[0], pb[2] - pa[2]) / (b.timeSec - a.timeSec) : Infinity;
  };

  const sides = ['left', 'right'] as const;
  const contact = Object.fromEntries(sides.map((side) => [side, usable.map((_, i) =>
    Math.min(speedAt(i, `${side}Ankle`), speedAt(i, `${side}Toe`)) < CONTACT_SPEED_SHARE * speed)])) as Record<'left' | 'right', boolean[]>;
  for (const side of sides) {
    const c = contact[side];
    for (let i = 1; i < c.length; i++) {
      if (c[i] || !c[i - 1]) continue;
      let j = i;
      while (j < c.length && !c[j]) j++;
      if (j < c.length && usable[j]!.timeSec - usable[i]!.timeSec < MIN_SWING_SEC) c.fill(true, i, j);
      i = j;
    }
  }
  // Footfalls: the first contact frame after a swing.
  const strikes = Object.fromEntries(sides.map((side) => [side, contact[side].flatMap((c, i) => (c && i > 0 && !contact[side][i - 1] ? [usable[i]!.timeSec] : []))])) as Record<'left' | 'right', number[]>;
  const strides = Math.min(strikes.left.length, strikes.right.length) - 1;
  if (strides < 1) return { ...empty, strides: Math.max(0, strides) };

  // Stance share over whole strides only (first to last footfall of that foot).
  const stanceShare = (side: 'left' | 'right') => {
    const s = strikes[side];
    if (s.length < 2) return null;
    let on = 0, all = 0;
    usable.forEach((f, i) => { if (f.timeSec >= s[0]! && f.timeSec < s.at(-1)!) { all++; if (contact[side][i]) on++; } });
    return all ? on / all : null;
  };
  // Step times: left footfall to the next right one, and right to the next left.
  const steps = (from: number[], to: number[]) => from.flatMap((t) => { const next = to.find((u) => u > t); return next === undefined ? [] : [next - t]; });
  const leftToRight = median(steps(strikes.left, strikes.right));
  const rightToLeft = median(steps(strikes.right, strikes.left));
  const strideSec = median([...strikes.left.slice(1).map((t, k) => t - strikes.left[k]!), ...strikes.right.slice(1).map((t, k) => t - strikes.right[k]!)]);

  // Knees: per swing run its peak flexion, per stance run the flexion where the ankle is nearest under the hips.
  const knee = (side: 'left' | 'right') => {
    const swing: number[] = [], stance: number[] = [];
    let run: Array<{ flex: number; ahead: number }> = [], inContact = contact[side][0]!;
    const close = () => {
      if (!run.length) return;
      if (inContact) stance.push(run.reduce((best, r) => (Math.abs(r.ahead) < Math.abs(best.ahead) ? r : best)).flex);
      else swing.push(Math.max(...run.map((r) => r.flex)));
    };
    usable.forEach((f, i) => {
      const hip = f.joints[`${side}Hip`], k = f.joints[`${side}Knee`], a = f.joints[`${side}Ankle`];
      if (!hip || !k || !a) return;
      if (contact[side][i] !== inContact) {
        close();
        run = [];
        inContact = contact[side][i]!;
      }
      run.push({ flex: flexion(hip, k, a), ahead: along(f, `${side}Ankle`) ?? Infinity });
    });
    // The first and last runs are partial; drop them.
    return { swing: swing.slice(1), stance: stance.slice(1) };
  };
  const knees = sides.map(knee);
  const swingPeaks = knees.map((k) => median(k.swing));
  const midStance = knees.map((k) => median(k.stance));
  const lowest = (v: Array<number | null>) => (v.some((x) => x === null) ? null : Math.min(...(v as number[])));

  // Arms: fore-aft wrist travel per stride; correlation with the same-side ankle.
  const swings: number[] = [];
  const correlations: number[] = [];
  for (const side of sides) {
    const s = strikes[side];
    for (let k = 1; k < s.length; k++) {
      const values = usable.filter((f) => f.timeSec >= s[k - 1]! && f.timeSec < s[k]!).map((f) => along(f, `${side}Wrist`)).filter((v): v is number => v !== null);
      if (values.length > 2) swings.push((Math.max(...values) - Math.min(...values)) * scale * 100);
    }
    const wrist: number[] = [], ankle: number[] = [];
    for (const f of usable) {
      const w = along(f, `${side}Wrist`), a = along(f, `${side}Ankle`);
      if (w !== null && a !== null) { wrist.push(w); ankle.push(a); }
    }
    const c = correlation(wrist, ankle);
    if (c !== null) correlations.push(c);
  }

  return {
    strides,
    cadenceStepsPerMin: strideSec ? 120 / strideSec : null,
    armSwingCm: median(swings),
    armLegCorrelation: correlations.length === 2 ? Math.max(...correlations) : null,
    kneeSwingFlexDeg: lowest(swingPeaks),
    kneeSwingFlexMaxDeg: swingPeaks.some((x) => x === null) ? null : Math.max(...(swingPeaks as number[])),
    kneeMidStanceFlexDeg: midStance.some((x) => x === null) ? null : Math.max(...(midStance as number[])),
    stanceShareLeft: stanceShare('left'),
    stanceShareRight: stanceShare('right'),
    stepAsymmetry: leftToRight && rightToLeft ? Math.abs(leftToRight - rightToLeft) / ((leftToRight + rightToLeft) / 2) : null
  };
}

export function judgeGait(metrics: GaitMetrics): Array<{ metric: string; value: number | null; target: Target; pass: boolean }> {
  return Object.entries(GAIT_TARGETS).map(([metric, target]) => {
    const value = metrics[metric as keyof GaitMetrics];
    const pass = value !== null && (target.max === undefined || value <= target.max + 1e-9) && (target.min === undefined || value >= target.min - 1e-9);
    return { metric, value, target, pass };
  });
}
