/**
 * The smoothness bar: no joint stops and goes on (a stammer).
 *
 * A stall is a joint whose speed falls to a small share of the speeds just
 * before and just after it (within `STALL_WINDOW` each side) while it goes on
 * the same way. A turn-round, such as an anticipation that turns into the
 * move, also passes through rest, but its direction changes, so it is not a
 * stall. Slow motion (the idle's life) is under `STALL_FLOOR` and is not
 * judged. The feet are left out: a planted foot stops by design.
 */
import type { MotionFrame } from '../../lib/motion-quality.ts';

export const SMOOTH_LIMITS = {
  /** The smallest share of the speeds around it that a joint's speed may fall to while it goes on the same way. */
  stallShare: 0.25,
  /**
   * The most a hand's or an elbow's velocity may change between two frames, m/s (at 30 fps, 60 m/s²): a reach
   * target that changes inside one frame snaps the arm (crouch v42: 6.0 m/s at 2.17 s). Fast human hand moves
   * stay near 1 m/s (crouch before B-092: 1.5; pinch v9: 0.5).
   */
  jump: 2
} as const;

export interface Jump { t: number; joint: string; change: number }
/** `over`: frames where a hand or an elbow jumps over the limit. */
export interface JumpReport { worst: Jump | undefined; over: number; jumps: Jump[] }

/** Hand and elbow velocity changes between two frames over `SMOOTH_LIMITS.jump`, and the largest. */
export function measureJumps(frames: readonly MotionFrame[]): JumpReport {
  const jumps: Jump[] = [];
  let worst: Jump | undefined;
  for (const j of ['leftWrist', 'rightWrist', 'leftElbow', 'rightElbow'] as const) {
    for (let i = 2; i < frames.length; i += 1) {
      const [a, b, c] = [frames[i - 2]!, frames[i - 1]!, frames[i]!];
      const pa = a.joints[j]; const pb = b.joints[j]; const pc = c.joints[j];
      if (!pa || !pb || !pc) continue;
      const d1 = b.timeSec - a.timeSec; const d2 = c.timeSec - b.timeSec;
      if (d1 <= 0 || d2 <= 0) continue;
      const change = Math.hypot(...[0, 1, 2].map((k) => (pc[k]! - pb[k]!) / d2 - (pb[k]! - pa[k]!) / d1));
      const jump = { t: b.timeSec, joint: j, change };
      if (!worst || change > worst.change) worst = jump;
      if (change > SMOOTH_LIMITS.jump) jumps.push(jump);
    }
  }
  return { worst, over: new Set(jumps.map((x) => x.t)).size, jumps: jumps.sort((x, y) => y.change - x.change) };
}

/** Seconds each side of a slow frame in which the speeds around it are looked for. */
const STALL_WINDOW = 0.3;
/** m/s: the speeds around a slow frame must both be over this for it to be a stall. */
const STALL_FLOOR = 0.15;
/** The cosine between the velocities before and after over which the joint goes on the same way. */
const SAME_WAY = 0.5;

export interface Stall { t: number; joint: string; speed: number; around: number; share: number }
/** `over`: how many moments (frames) have a joint stalled under the limit; several joints often stall at one moment. */
export interface SmoothReport { stalls: Stall[]; worst: Stall | undefined; over: number }

export function measureSmoothness(frames: readonly MotionFrame[]): SmoothReport {
  const stalls: Stall[] = [];
  if (frames.length < 3) return { stalls, worst: undefined, over: 0 };
  const dt = (frames[frames.length - 1]!.timeSec - frames[0]!.timeSec) / (frames.length - 1);
  const w = Math.max(1, Math.round(STALL_WINDOW / dt));
  const names = Object.keys(frames[0]!.joints).filter((j) => !/Ankle|Toe/.test(j)) as (keyof MotionFrame['joints'])[];
  for (const j of names) {
    const vel: [number, number, number][] = [];
    for (let i = 1; i < frames.length; i += 1) {
      const a = frames[i - 1]!.joints[j];
      const b = frames[i]!.joints[j];
      if (!a || !b) { vel.length = 0; break; }
      vel.push([(b[0] - a[0]) / dt, (b[1] - a[1]) / dt, (b[2] - a[2]) / dt]);
    }
    const v = vel.map((x) => Math.hypot(...x));
    const peak = (from: number, to: number): number => {
      let k = -1;
      for (let i = Math.max(0, from); i < Math.min(v.length, to); i += 1) if (k < 0 || v[i]! > v[k]!) k = i;
      return k;
    };
    for (let i = 1; i < v.length - 1; i += 1) {
      if (v[i]! > v[i - 1]! || v[i]! > v[i + 1]!) continue;
      const l = peak(i - w, i);
      const r = peak(i + 1, i + 1 + w);
      if (l < 0 || r < 0) continue;
      const around = Math.min(v[l]!, v[r]!);
      if (around < STALL_FLOOR) continue;
      const cos = (vel[l]![0] * vel[r]![0] + vel[l]![1] * vel[r]![1] + vel[l]![2] * vel[r]![2]) / (v[l]! * v[r]!);
      if (cos < SAME_WAY) continue;
      stalls.push({ t: frames[i + 1]!.timeSec, joint: String(j), speed: v[i]!, around, share: v[i]! / around });
    }
  }
  stalls.sort((a, b) => a.share - b.share);
  return { stalls, worst: stalls[0], over: new Set(stalls.filter((s) => s.share < SMOOTH_LIMITS.stallShare).map((s) => s.t)).size };
}
