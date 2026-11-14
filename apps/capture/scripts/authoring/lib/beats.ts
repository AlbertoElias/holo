/**
 * A take as data: performers on a stage and beats of direction. Every
 * direction has timing (anticipation, attack, hold, settle) and is a closed
 * form of time, so changing one beat changes only its own span (a `whole`
 * turn and a step are persistent: they also move everything after them).
 */
import { FACE_CHANNELS, type FaceChannel } from '@holoim/avatar-face';

import type { HandShapeName } from './hands.ts';
import { HAND_SHAPES } from './hands.ts';

export type Side = 'left' | 'right';
/** Stage point in metres, `[x, y, z]`; or `"<performer>.<humanoid bone>"`; or a mark's name. */
export type Point = readonly [number, number, number] | string;

export interface Timing {
  /** Seconds after the beat's `at` (default 0). */
  readonly delay?: number;
  /** Before the move: a small movement the other way (seconds). */
  readonly anticipation?: number;
  /** The move itself (seconds). */
  readonly attack?: number;
  /** Time at the target (seconds; default the beat's `hold`). */
  readonly hold?: number;
  /** Back to rest (or, for persistent directions, settling into the new place). */
  readonly settle?: number;
}

export type Direction = Timing & (
  | { readonly kind: 'look'; readonly at: Point; /** Share of the look the head takes (0 eyes only, 1 all head); default 0.6. */ readonly head?: number }
  | { readonly kind: 'expression'; readonly shape: ExpressionName | Partial<Record<FaceChannel, number>>; readonly strength?: number }
  | { readonly kind: 'reach'; readonly side: Side; readonly at: Point; /** Metres the palm stops short of `at`. */ readonly stopShort: number; readonly palm?: 'up' | 'down' | 'in' | 'toward' }
  | { readonly kind: 'hand'; readonly side: Side | 'both'; readonly shape: HandShapeName; readonly strength?: number }
  | { readonly kind: 'weight'; readonly toward: 'left' | 'right' | 'forward' | 'back'; /** 0..1, default 1 (about 6 cm). */ readonly amount?: number }
  | { readonly kind: 'turn'; readonly degrees?: number; readonly toward?: Point; /** `upper` twists and comes back; `whole` turns the performer and stays. */ readonly body?: 'upper' | 'whole' }
  | { readonly kind: 'step'; readonly foot: Side; /** Metres in the performer's frame: [left, forward]. */ readonly by: readonly [number, number]; /** Bring the other foot alongside. */ readonly follow?: boolean }
);
export type DirectionKind = Direction['kind'];

export interface Beat {
  readonly id: string;
  readonly performer: string;
  readonly at: number;
  /** Default hold for its directions, seconds. */
  readonly hold?: number;
  /** The author's working note: what the performer does. */
  readonly note?: string;
  /** What a viewer should understand from this beat, in a viewer's words. The review compares a fresh reader's account against it. */
  readonly intent?: string;
  readonly directions: readonly Direction[];
}

export interface PerformerSpec {
  readonly id: string;
  /** Path to the avatar GLB, relative to the beat sheet. */
  readonly avatar: string;
  /** Stage position `[x, z]` in metres. */
  readonly at: readonly [number, number];
  /** Degrees about +Y; 0 faces +Z. */
  readonly facing: number;
  /** Seeds blinks, saccades and breath; default from the performer's index. */
  readonly seed?: number;
}

export interface BeatSheet {
  readonly title: string;
  /** What a viewer should come away with from the whole piece. The review compares a fresh reader's account against it. */
  readonly intent?: string;
  readonly duration: number;
  readonly fps?: number;
  /** false: no breath, blinks, eye movement or finger settle. Default true. */
  readonly life?: boolean;
  /** `flat`: the same blocking as straight lines with no life, face or fingers, for comparison. Default `directed`. */
  readonly style?: 'directed' | 'flat';
  readonly performers: readonly PerformerSpec[];
  readonly marks?: Readonly<Record<string, readonly [number, number, number]>>;
  readonly beats: readonly Beat[];
}

export const EXPRESSIONS = {
  // Lips held together, inner brows up: wanting and holding it in.
  held: { mouthPressLeft: 0.55, mouthPressRight: 0.55, browInnerUp: 0.6, mouthRollLower: 0.2, mouthShrugLower: 0.25 },
  hope: { browInnerUp: 0.45, eyeWideLeft: 0.25, eyeWideRight: 0.25, mouthSmileLeft: 0.2, mouthSmileRight: 0.2, jawOpen: 0.06 },
  sad: { browInnerUp: 0.7, mouthFrownLeft: 0.45, mouthFrownRight: 0.45, eyeSquintLeft: 0.15, eyeSquintRight: 0.15, mouthLowerDownLeft: 0.1, mouthLowerDownRight: 0.1 },
  smile: { mouthSmileLeft: 0.7, mouthSmileRight: 0.7, cheekSquintLeft: 0.35, cheekSquintRight: 0.35, eyeSquintLeft: 0.2, eyeSquintRight: 0.2 },
  'small-smile': { mouthSmileLeft: 0.3, mouthSmileRight: 0.25, mouthPressLeft: 0.15, mouthPressRight: 0.15 },
  breath: { jawOpen: 0.12, mouthFunnel: 0.08, browInnerUp: 0.3 },
  resolve: { mouthPressLeft: 0.4, mouthPressRight: 0.4, browDownLeft: 0.25, browDownRight: 0.25, jawForward: 0.05 },
  'eyes-down': { eyeBlinkLeft: 0.35, eyeBlinkRight: 0.35, browInnerUp: 0.35 }
} as const satisfies Record<string, Partial<Record<FaceChannel, number>>>;
export type ExpressionName = keyof typeof EXPRESSIONS;

export const DEFAULT_TIMING: Readonly<Record<DirectionKind, Required<Omit<Timing, 'delay' | 'hold'>>>> = {
  look: { anticipation: 0.08, attack: 0.35, settle: 0.5 },
  expression: { anticipation: 0, attack: 0.35, settle: 0.6 },
  reach: { anticipation: 0.25, attack: 0.75, settle: 0.8 },
  hand: { anticipation: 0, attack: 0.3, settle: 0.5 },
  weight: { anticipation: 0.2, attack: 0.6, settle: 0.7 },
  turn: { anticipation: 0.2, attack: 0.8, settle: 0.5 },
  step: { anticipation: 0.15, attack: 0.6, settle: 0.3 }
};

export const PERSISTENT = (d: Direction): boolean => d.kind === 'step' || (d.kind === 'turn' && d.body === 'whole');

export interface Resolved {
  readonly beat: Beat;
  readonly direction: Direction;
  readonly start: number;
  readonly at: number;
  readonly anticipation: number;
  readonly attack: number;
  readonly hold: number;
  readonly settle: number;
  readonly persistent: boolean;
  /** Last moment this direction moves anything (Infinity for persistent ones only in the sense that its result stays). */
  readonly end: number;
}

export function resolveTiming(beat: Beat, d: Direction): Resolved {
  const def = DEFAULT_TIMING[d.kind];
  const at = beat.at + (d.delay ?? 0);
  const anticipation = d.anticipation ?? def.anticipation;
  const attack = Math.max(1e-3, d.attack ?? def.attack);
  const hold = Math.max(0, d.hold ?? beat.hold ?? 0.6);
  const settle = Math.max(1e-3, d.settle ?? def.settle);
  return { beat, direction: d, start: at - anticipation, at, anticipation, attack, hold, settle, persistent: PERSISTENT(d), end: at + attack + hold + settle };
}

const smoother = (u: number): number => u * u * u * (u * (u * 6 - 15) + 10);

/**
 * How far a direction has its way at `t`: 0 before, a small dip the other way
 * during anticipation, up to 1 with a small arrival overshoot, held, then
 * back to 0 (transient) or settled at 1 (persistent).
 */
export function envelope(t: number, r: Resolved, depth = 0.08, overshoot = 0.05): number {
  if (t <= r.start) return 0;
  if (t < r.at) return r.anticipation > 0 ? -depth * Math.sin((Math.PI * (t - r.start)) / r.anticipation) : 0;
  const arrive = r.at + r.attack;
  if (t < arrive) return smoother((t - r.at) / r.attack);
  const holdEnd = arrive + r.hold;
  if (t < holdEnd) {
    const win = Math.min(0.35, r.hold);
    const u = win > 0 ? Math.min(1, (t - arrive) / win) : 1;
    return 1 + overshoot * Math.sin(Math.PI * u) * (1 - u);
  }
  const s = (t - holdEnd) / r.settle;
  if (r.persistent) return 1;
  return s >= 1 ? 0 : 1 - smoother(s);
}

/** A beat's span: from its earliest anticipation to the end of its last settle (persistent directions end when they arrive). */
export function beatSpan(beat: Beat): { from: number; to: number } {
  const rs = beat.directions.map((d) => resolveTiming(beat, d));
  if (!rs.length) return { from: beat.at, to: beat.at };
  return { from: Math.max(0, Math.min(...rs.map((r) => r.start))), to: Math.max(...rs.map((r) => r.persistent ? r.at + r.attack + r.settle : r.end)) };
}

export function validateSheet(sheet: BeatSheet): string[] {
  const problems: string[] = [];
  const ids = new Set(sheet.performers.map((p) => p.id));
  if (!sheet.performers.length) problems.push('no performers');
  if (!(sheet.duration > 0)) problems.push('duration must be > 0');
  const beatIds = new Set<string>();
  for (const b of sheet.beats) {
    if (beatIds.has(b.id)) problems.push(`beat id ${b.id} repeats`);
    beatIds.add(b.id);
    if (!ids.has(b.performer)) problems.push(`beat ${b.id}: no performer ${b.performer}`);
    if (!(b.at >= 0)) problems.push(`beat ${b.id}: at must be ≥ 0`);
    if (b.at >= sheet.duration) problems.push(`beat ${b.id}: at ${b.at} s is not before the take ends (${sheet.duration} s)`);
    for (const d of b.directions) {
      const where = `beat ${b.id} ${d.kind}`;
      if (!Object.hasOwn(DEFAULT_TIMING, d.kind)) { problems.push(`${where}: no direction kind ${d.kind} (${Object.keys(DEFAULT_TIMING).join(', ')})`); continue; }
      const side = d.kind === 'reach' || d.kind === 'hand' ? d.side : d.kind === 'step' ? d.foot : undefined;
      if (side !== undefined && side !== 'left' && side !== 'right' && !(d.kind === 'hand' && side === 'both')) problems.push(`${where}: side ${side} is left or right${d.kind === 'hand' ? ' or both' : ''}`);
      if (d.kind === 'expression' && typeof d.shape === 'object') {
        for (const k of Object.keys(d.shape)) if (!FACE_CHANNELS.includes(k as FaceChannel)) problems.push(`${where}: no face channel ${k}`);
      }
      if (d.kind === 'hand' && !(d.shape in HAND_SHAPES)) problems.push(`${where}: no hand shape ${d.shape} (${Object.keys(HAND_SHAPES).join(', ')})`);
      if (d.kind === 'expression' && typeof d.shape === 'string' && !(d.shape in EXPRESSIONS)) problems.push(`${where}: no expression ${d.shape} (${Object.keys(EXPRESSIONS).join(', ')})`);
      if (d.kind === 'reach' && !(d.stopShort >= 0)) problems.push(`${where}: stopShort must be ≥ 0`);
      if (d.kind === 'turn' && d.degrees === undefined && d.toward === undefined) problems.push(`${where}: needs degrees or toward`);
      for (const p of [('at' in d ? d.at : undefined), (d.kind === 'turn' ? d.toward : undefined)]) {
        if (typeof p !== 'string') continue;
        const [who, bone] = p.split('.');
        if (bone !== undefined ? !ids.has(who!) : !(sheet.marks && p in sheet.marks)) problems.push(`${where}: cannot resolve point "${p}"`);
      }
    }
  }
  return problems;
}
