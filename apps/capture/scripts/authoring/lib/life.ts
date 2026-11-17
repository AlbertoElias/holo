/**
 * The life a performer has under its directions, as events rather than
 * oscillation (brief slice 1d): a person standing still holds, then does
 * something small. They put their weight on the other leg, glance away and
 * back, take a deeper breath, fidget a hand. Each event is a change of shape
 * a viewer sees, with real stillness between.
 *
 * A performer's schedule is drawn from its seed alone, event by event from
 * t = 0, one random stream per kind, so it depends on neither the beats nor
 * the duration. Directions only mask it (`busy`), each within its own span
 * plus `MASK_PAD`, so revising a beat changes life only near that beat.
 */
import type { DirectionKind, Resolved, Side } from './beats.ts';

/** How far either side of a direction's span life eases out and back in, seconds. */
export const MASK_PAD = 0.4;
/** Into and out of a direction's hold, the mask eases between full and its hold level over this long. */
const HOLD_EASE = 0.3;

/** Event starts, one seeded sequence for weight, glance and sigh, so no stretch of a hold goes long without one. */
const SLOT_FIRST: Range = [0.4, 1.0];
const SLOT_EVERY: Range = [1.0, 2.0];
/** Which kind a slot prefers (cumulative): weight, glance, else sigh. A kind still under way gives the slot to another. */
const SLOT_SHARE = { weight: 0.3, glance: 0.75 } as const;

/** Weight on one leg: hips toward the standing foot (metres at amount 1), the pelvis rolled so the free hip drops (degrees). */
export const LIFE_WEIGHT = { shift: 0.05, rollDeg: 4, drop: 0.006, chestCounter: 0.7 } as const;
const WEIGHT_OVER: Range = [0.9, 1.3];
const WEIGHT_AMOUNT: Range = [0.7, 1.0];
/** The least time on one leg before the next shift. */
const WEIGHT_REST = 2.0;
/** Each change of legs also resettles the posture, which is what reads from the side: the spine leans
 *  forward (degrees, + forward) and the hips sit forward or back (metres, + forward). */
const POSTURE_LEAN: Range = [-1.5, 3.5];
const POSTURE_HIPS: Range = [-0.015, 0.015];

/** A glance: degrees off where the performer faces; the head takes `GLANCE_HEAD_SHARE`, the eyes the rest and lead. */
const GLANCE_YAW: Range = [20, 40];
const GLANCE_HOLD: Range = [0.5, 1.4];
export const GLANCE_HEAD_SHARE = 0.75;
/** Of the head's share, beyond `GLANCE_CHEST_FROM` degrees the upper chest turns this part with it (so the shoulders change from the side). */
export const GLANCE_CHEST_SHARE = 0.35;
const GLANCE_CHEST_FROM = 10;
const EYES_ATTACK = 0.12;
const EYES_LEAD = 0.06;
const HEAD_ATTACK = 0.3;
const HEAD_RETURN = 0.45;
const EYES_RETURN = 0.25;
/** A head turn this large brings a blink with it, degrees. */
export const GLANCE_BLINK_DEG = 12;

/** A sigh: at its peak the shoulders rise and the chest lifts; on the way out the body slumps below its rest and the head dips (degrees). */
export const LIFE_SIGH = { shoulderDeg: 6, chestDeg: 2, slump: 0.5, headDipDeg: 4 } as const;
const SIGH_IN = 0.9;
const SIGH_OUT = 1.5;
const SIGH_BACK = 1.5;
const SIGH_REST = 3;

/** A hanging hand's fidget at its peak: extra finger curl, the hand lifted (metres) and the forearm rolled (degrees). */
export const LIFE_FIDGET = { curl: 0.22, lift: 0.04, rollDeg: 25, stagger: 0.05 } as const;
const FIDGET_EVERY: Range = [3, 6];
const FIDGET_FIRST: Range = [1.2, 3.5];
const FIDGET_IN = 0.6;
const FIDGET_HOLD: Range = [0.3, 0.9];
const FIDGET_OUT = 0.9;

type Range = readonly [number, number];

interface WeightShift { readonly at: number; readonly over: number; readonly to: number; readonly lean: number; readonly hips: number }
interface Glance { readonly at: number; readonly yaw: number; readonly pitch: number; readonly hold: number }
interface Pulse { readonly at: number; readonly hold: number }

export interface LifeSchedule {
  /** Signed amount on the left leg (+) or the right (−) before the first shift. */
  readonly startWeight: number;
  /** The posture before the first shift: spine lean (degrees) and hips forward (metres). */
  readonly startPosture: { readonly lean: number; readonly hips: number };
  readonly weight: readonly WeightShift[];
  readonly glances: readonly Glance[];
  readonly sighs: readonly Pulse[];
  readonly fidgets: Readonly<Record<Side, readonly Pulse[]>>;
}

/** mulberry32 on a hashed seed: a small seeded stream, one per use. */
function stream(seed: number, salt: number): () => number {
  let s = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r: () => number, [lo, hi]: Range): number => lo + (hi - lo) * r();
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
/** Quintic ease (zero velocity and acceleration at both ends). */
const smoother = (u: number): number => { const x = clamp01(u); return x * x * x * (x * (x * 6 - 15) + 10); };

type Kind = 'weight' | 'glance' | 'sigh';

/**
 * The performer's events up to `until` seconds; a longer `until` only
 * appends. Slot times and kinds come from one stream, each kind's sizes from
 * its own, so resizing glances never moves a weight shift.
 */
export function lifeSchedule(seed: number, until: number): LifeSchedule {
  const slots = stream(seed, 0);
  const rw = stream(seed, 1);
  const rg = stream(seed, 2);
  const rp = stream(seed, 6);
  const posture = (): { lean: number; hips: number } => ({ lean: pick(rp, POSTURE_LEAN), hips: pick(rp, POSTURE_HIPS) });
  const startPosture = posture();
  let side = rw() < 0.5 ? 1 : -1;
  const startWeight = side * pick(rw, WEIGHT_AMOUNT);
  const weight: WeightShift[] = [];
  const glances: Glance[] = [];
  const sighs: Pulse[] = [];
  const freeAt: Record<Kind, number> = { weight: WEIGHT_REST * 0.5, glance: 0, sigh: SIGH_REST * 0.5 };
  for (let t = pick(slots, SLOT_FIRST); t < until; t += pick(slots, SLOT_EVERY)) {
    const roll = slots();
    const preferred: Kind = roll < SLOT_SHARE.weight ? 'weight' : roll < SLOT_SHARE.glance ? 'glance' : 'sigh';
    const kind = ([preferred, 'glance', 'weight', 'sigh'] as const).find((k) => freeAt[k] <= t);
    if (!kind) continue;
    if (kind === 'weight') {
      side = -side;
      const w = { at: t, over: pick(rw, WEIGHT_OVER), to: side * pick(rw, WEIGHT_AMOUNT), ...posture() };
      weight.push(w);
      freeAt.weight = t + w.over + WEIGHT_REST;
    } else if (kind === 'glance') {
      const yaw = (rg() < 0.5 ? -1 : 1) * pick(rg, GLANCE_YAW);
      // Mostly down (the floor, something nearby), now and then level.
      const pitch = rg() < 0.65 ? -pick(rg, [8, 15]) : pick(rg, [-3, 3]);
      const g = { at: t, yaw, pitch, hold: pick(rg, GLANCE_HOLD) };
      glances.push(g);
      freeAt.glance = t + EYES_LEAD + HEAD_ATTACK + g.hold + HEAD_RETURN + 0.2;
    } else {
      sighs.push({ at: t, hold: 0 });
      freeAt.sigh = t + SIGH_IN + SIGH_OUT + SIGH_BACK + SIGH_REST;
    }
  }
  const fidget = (salt: number): Pulse[] => {
    const rf = stream(seed, salt);
    const out: Pulse[] = [];
    for (let t = pick(rf, FIDGET_FIRST); t < until; t += pick(rf, FIDGET_EVERY)) out.push({ at: t, hold: pick(rf, FIDGET_HOLD) });
    return out;
  };
  return { startWeight, startPosture, weight, glances, sighs, fidgets: { left: fidget(4), right: fidget(5) } };
}

/** Signed weight at t: + on the left leg, − on the right, about 0.55 to 0.85 in magnitude. */
export function weightAt(s: LifeSchedule, t: number): number {
  let level = s.startWeight;
  for (const w of s.weight) {
    if (t <= w.at) break;
    level += (w.to - level) * smoother((t - w.at) / w.over);
  }
  return level;
}

/**
 * The posture at t, easing with each weight shift: spine lean (degrees, + forward) and hips
 * forward (metres). A shift whose span `still` says to keep still leaves the posture as it was
 * (the next shift catches up), so someone being reached for is not moving under the hand.
 */
export function postureAt(s: LifeSchedule, t: number, still?: (from: number, to: number) => boolean): { lean: number; hips: number } {
  let { lean, hips } = s.startPosture;
  for (const w of s.weight) {
    if (t <= w.at) break;
    if (still?.(w.at, w.at + w.over)) continue;
    const k = smoother((t - w.at) / w.over);
    lean += (w.lean - lean) * k;
    hips += (w.hips - hips) * k;
  }
  return { lean, hips };
}

/** How far a glance turns the upper chest, degrees, from the head's yaw. */
export function glanceChest(headYaw: number): number {
  const over = Math.max(0, Math.abs(headYaw) - GLANCE_CHEST_FROM);
  return Math.sign(headYaw) * over * GLANCE_CHEST_SHARE;
}

/** Up over `attack`, held, back over `release`. */
function pulse(t: number, at: number, attack: number, hold: number, release: number): number {
  if (t <= at) return 0;
  if (t < at + attack) return smoother((t - at) / attack);
  if (t < at + attack + hold) return 1;
  return 1 - smoother((t - at - attack - hold) / release);
}

/** Degrees off the facing, positive yaw toward the performer's left (+X) and pitch up: the head's share, and where the eyes look. */
/** Where a glance has the head and the eyes at t (degrees), and when the latest glance began and how far it turns the head. */
export function glanceAt(s: LifeSchedule, t: number): { head: { yaw: number; pitch: number }; eyes: { yaw: number; pitch: number }; onset?: number; size: number } {
  const head = { yaw: 0, pitch: 0 };
  const eyes = { yaw: 0, pitch: 0 };
  let onset: number | undefined;
  let size = 0;
  for (const g of s.glances) {
    if (t <= g.at) break;
    // The eyes arrive first and leave last-but-faster; the head follows a little later and returns slower.
    const e = pulse(t, g.at, EYES_ATTACK, EYES_LEAD + HEAD_ATTACK - EYES_ATTACK + g.hold + 0.05, EYES_RETURN);
    const h = pulse(t, g.at + EYES_LEAD, HEAD_ATTACK, g.hold, HEAD_RETURN);
    eyes.yaw += g.yaw * e; eyes.pitch += g.pitch * e;
    head.yaw += g.yaw * GLANCE_HEAD_SHARE * h; head.pitch += g.pitch * GLANCE_HEAD_SHARE * h;
    onset = g.at;
    size = Math.abs(g.yaw) * GLANCE_HEAD_SHARE;
  }
  return { head, eyes, size, ...(onset !== undefined ? { onset } : {}) };
}

/** A sigh: up to 1 at its peak, down to −`LIFE_SIGH.slump` as the breath goes out, then back to 0. */
export function sighAt(s: LifeSchedule, t: number): number {
  let v = 0;
  for (const p of s.sighs) {
    if (t <= p.at) break;
    const u = t - p.at;
    if (u < SIGH_IN) v += smoother(u / SIGH_IN);
    else if (u < SIGH_IN + SIGH_OUT) v += 1 - (1 + LIFE_SIGH.slump) * smoother((u - SIGH_IN) / SIGH_OUT);
    else v += -LIFE_SIGH.slump * (1 - smoother((u - SIGH_IN - SIGH_OUT) / SIGH_BACK));
  }
  return v;
}

/** A hand's fidget, 0 to 1, `delay` seconds behind (a finger arriving after another). */
export function fidgetAt(s: LifeSchedule, side: Side, t: number, delay = 0): number {
  let v = 0;
  for (const p of s.fidgets[side]) {
    if (t - delay <= p.at) break;
    v = Math.max(v, pulse(t - delay, p.at, FIDGET_IN, p.hold, FIDGET_OUT));
  }
  return v;
}

/**
 * What masks each life channel, by direction kind: 1 while the direction
 * moves, easing to its hold level while it holds (life goes on, smaller,
 * under a held look or reach), and to 0 over `MASK_PAD` either side. Weight
 * gives way only to directions that place the legs or aim a held thing: a
 * level easing in and out under every reach moved the hips in jerks.
 */
export const MASKED_BY = {
  weight: { weight: 1, step: 1, aim: 1 },
  glance: { look: 0.65, reach: 0.8, take: 0.8, put: 0.8, aim: 0.8 },
  hand: { hand: 1, reach: 1, take: 1, put: 1, aim: 1 }
} as const satisfies Record<string, Partial<Record<DirectionKind, number>>>;

/**
 * How busy a life channel is at t, 0 to 1, from the directions near t only
 * (so revising a beat changes life only within its span plus `MASK_PAD`).
 * A hand's channel counts that side's directions. A persistent direction
 * (a turn, a step) is busy while it moves, not after.
 */
export function busy(dirs: readonly Resolved[], t: number, kinds: Partial<Record<DirectionKind, number>>, side?: Side): number {
  let b = 0;
  for (const r of dirs) {
    const d = r.direction;
    const level = kinds[d.kind];
    if (level === undefined) continue;
    if (side && 'side' in d && d.side !== side && d.side !== 'both') continue;
    const end = r.persistent ? r.at + r.attack + r.settle : r.end;
    let v: number;
    if (t < r.start) v = 1 - smoother((r.start - t) / MASK_PAD);
    else if (t > end) v = 1 - smoother((t - end) / MASK_PAD);
    else {
      const arrive = r.at + r.attack;
      const holdEnd = arrive + r.hold;
      v = r.persistent || t < arrive || t > holdEnd ? 1 : level + (1 - level) * (1 - smoother(Math.min(t - arrive, holdEnd - t) / HOLD_EASE));
    }
    if (v > b) b = v;
    if (b >= 1) return 1;
  }
  return b;
}

/** The events in words, for the build's printout. */
export function describeLife(s: LifeSchedule, duration: number): string {
  const at = (xs: readonly { at: number }[]): string => xs.filter((x) => x.at < duration).map((x) => x.at.toFixed(1)).join(', ') || 'none';
  return `weight on the ${s.startWeight > 0 ? 'left' : 'right'} leg, shifts at ${at(s.weight)} s; glances at ${at(s.glances)} s; sighs at ${at(s.sighs)} s`;
}
