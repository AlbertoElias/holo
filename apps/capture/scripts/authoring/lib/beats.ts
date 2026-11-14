/**
 * A take as data: performers on a stage and beats of direction. Every
 * direction has timing (anticipation, attack, hold, settle) and is a closed
 * form of time, so changing one beat changes only its own span (a `whole`
 * turn and a step are persistent: they also move everything after them).
 */
import { FACE_CHANNELS, type FaceChannel } from '@holoim/avatar-face';

import type { HandShapeName } from './hands.ts';
import { HAND_SHAPES } from './hands.ts';
import { measureProblem, placeProblem } from './stage.ts';

export type Side = 'left' | 'right';
/**
 * Metres, or a performer measure with a factor: `"step"`, `"0.5 arm"`,
 * `"q:hand-length"` (another performer's). A height can also be a landmark
 * at rest: `"waist"`, `"q:hanging-hand"`. See `lib/stage.ts`.
 */
export type Measure = number | string;
/** A place measured from a performer as they stand (or an object as it rests): +Z forward, −X right, `height` above the floor or `up` from the origin. */
export interface Place {
  readonly of?: string;
  readonly forward?: Measure;
  readonly right?: Measure;
  readonly up?: Measure;
  readonly height?: Measure;
}
/** Stage point in metres, `[x, y, z]`; `"<performer>.<humanoid bone>"`; `"<object>.<anchor>"`; a mark's name; or a place. */
export type Point = readonly [number, number, number] | string | Place;
export type Shape = 'box' | 'cylinder' | 'cone' | 'sphere';
/** `#rrggbb` or linear `[r, g, b]` in 0..1. */
export type Color = string | readonly [number, number, number];
export type Vec3Measure = readonly [Measure, Measure, Measure];

export interface PartSpec {
  readonly name?: string;
  readonly shape: Shape;
  /** `[width, height, depth]`; a cylinder's or cone's width and depth are its diameters. */
  readonly size: Vec3Measure;
  /** Where the part's bottom centre sits in the object's frame (default the origin). */
  readonly at?: Vec3Measure;
  /** Degrees about x, y, z (in that order), about the part's bottom centre. */
  readonly rotate?: readonly [number, number, number];
  readonly color?: Color;
}

/** Credit for a model someone else made (as `@holoim/objects` carries it), or `"own"`. */
export type CreditSpec = 'own' | { readonly source: string; readonly sourceUrl: string; readonly title: string; readonly author: string; readonly licence: 'CC0-1.0' | 'CC-BY-4.0' };

export interface ObjectSpec {
  /** Display name in `HOLOIM_objects` (default the id). */
  readonly name?: string;
  readonly shape?: Shape;
  readonly size?: Vec3Measure;
  readonly color?: Color;
  readonly parts?: readonly PartSpec[];
  /** A GLB path relative to the sheet, or `polyhaven:<id>`. */
  readonly source?: string;
  /** Scale a source to this height. */
  readonly height?: Measure;
  /** Required on a local source. */
  readonly credit?: CreditSpec;
  readonly at?: Point;
  /** Sits on top of another object (at its centre, unless `at` gives the spot). */
  readonly on?: string;
  /** Degrees about +Y (0 faces +Z), or toward a point. Default the facing of the performer it is placed from, else 0. */
  readonly facing?: number | Point;
  readonly anchors?: Readonly<Record<string, Vec3Measure>>;
  /** A part (its centre and long axis) or a point and an axis, where a hand closes. */
  readonly grip?: string | { readonly at: Vec3Measure; readonly axis: readonly [number, number, number]; readonly radius?: number };
  /** A part (its tip and +Y axis) or a tip and an axis, what an `aim` points. */
  readonly tool?: string | { readonly tip: Vec3Measure; readonly axis: readonly [number, number, number] };
}

/** Built-in anchors of every object; no part or named anchor may use these names. */
export const OBJECT_ANCHORS = ['top', 'center', 'bottom', 'front'] as const;

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
  | { readonly kind: 'take'; readonly side: Side; readonly object: string; readonly palm?: 'up' | 'down' | 'in' | 'toward' }
  | { readonly kind: 'put'; readonly side: Side; readonly object: string; readonly at?: Point; readonly on?: string }
  | { readonly kind: 'aim'; readonly side: Side; readonly at: Point }
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
  /** Objects in hand from the first frame. */
  readonly hold?: Partial<Record<Side, string>>;
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
  readonly marks?: Readonly<Record<string, readonly [number, number, number] | Place>>;
  readonly objects?: Readonly<Record<string, ObjectSpec>>;
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
  step: { anticipation: 0.15, attack: 0.6, settle: 0.3 },
  take: { anticipation: 0.2, attack: 0.8, settle: 0.8 },
  put: { anticipation: 0.15, attack: 0.8, settle: 0.8 },
  aim: { anticipation: 0.1, attack: 0.6, settle: 0.6 }
};

/** Directions whose result stays: the performer's place and facing. */
export const PERSISTENT = (d: Direction): boolean => d.kind === 'step' || (d.kind === 'turn' && d.body === 'whole');
/** Directions that change the world for the rest of the take: also where an object is (`take` and `put` reach and come back, but the object stays moved). */
export const CHANGES_AFTER = (d: Direction): boolean => PERSISTENT(d) || d.kind === 'take' || d.kind === 'put';

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

/** A beat's span: from its earliest anticipation to the end of its last settle (a persistent direction's ends after its attack plus its settle time). */
export function beatSpan(beat: Beat): { from: number; to: number; changesAfter?: boolean } {
  const rs = beat.directions.map((d) => resolveTiming(beat, d));
  if (!rs.length) return { from: beat.at, to: beat.at };
  return { from: Math.max(0, Math.min(...rs.map((r) => r.start))), to: Math.max(...rs.map((r) => r.persistent ? r.at + r.attack + r.settle : r.end)), changesAfter: rs.some((r) => CHANGES_AFTER(r.direction)) };
}

/** Names an object answers to after a dot: the built-in anchors, its named parts, its named anchors. */
export function anchorNames(spec: ObjectSpec): string[] {
  return [...OBJECT_ANCHORS, ...(spec.parts ?? []).flatMap((p) => (p.name ? [p.name] : [])), ...Object.keys(spec.anchors ?? {})];
}

/** An object in one performer's hand, from when the hand closes (a hold: frame 0) until it lets go (a put) or the take ends. */
export interface Holding {
  readonly object: string;
  readonly performer: string;
  readonly side: Side;
  readonly from: number;
  readonly to: number;
  readonly take?: Resolved;
  readonly put?: Resolved;
}

/** The objects of a point: `"obj.anchor"` and a place `of` an object. */
export function pointObjects(p: Point | undefined, objects: ReadonlySet<string>): string[] {
  if (p === undefined) return [];
  if (typeof p === 'string') { const head = p.split('.')[0]!; return p.includes('.') && objects.has(head) ? [head] : []; }
  if (Array.isArray(p)) return [];
  const place = p as Place;
  return place.of !== undefined && objects.has(place.of) ? [place.of] : [];
}

/** Who holds what, when, from the sheet's `hold`s, `take`s and `put`s; with the problems in their order. */
export function holdingsOf(sheet: BeatSheet, duration = sheet.duration): { holdings: Holding[]; problems: string[] } {
  const problems: string[] = [];
  const open = new Map<string, { performer: string; side: Side; from: number; take?: Resolved }>();
  const holdings: Holding[] = [];
  for (const p of sheet.performers) {
    for (const side of ['left', 'right'] as const) {
      const o = p.hold?.[side];
      if (o === undefined) continue;
      if (open.has(o)) problems.push(`${p.id} holds ${o} in two hands`);
      else open.set(o, { performer: p.id, side, from: 0 });
    }
  }
  const events = sheet.beats.flatMap((b) => b.directions.flatMap((d) => (d.kind === 'take' || d.kind === 'put' ? [resolveTiming(b, d)] : [])))
    .sort((a, b) => a.at + a.attack - (b.at + b.attack));
  for (const r of events) {
    const d = r.direction as Extract<Direction, { kind: 'take' | 'put' }>;
    const when = r.at + r.attack;
    const where = `beat ${r.beat.id} ${d.kind} ${d.object}`;
    const held = open.get(d.object);
    const inHand = [...open.entries()].find(([, h]) => h.performer === r.beat.performer && h.side === d.side);
    if (d.kind === 'take') {
      if (held) problems.push(`${where}: ${held.performer}'s ${held.side} hand already holds it`);
      else if (inHand) problems.push(`${where}: the ${d.side} hand already holds ${inHand[0]}`);
      else open.set(d.object, { performer: r.beat.performer, side: d.side, from: when, take: r });
    } else if (!held || held.performer !== r.beat.performer || held.side !== d.side) {
      problems.push(`${where}: ${r.beat.performer}'s ${d.side} hand does not hold it then`);
    } else {
      holdings.push({ object: d.object, ...held, to: when, put: r });
      open.delete(d.object);
    }
  }
  for (const [object, h] of open) holdings.push({ object, ...h, to: duration });
  return { holdings: holdings.sort((a, b) => a.from - b.from), problems };
}

export function validateSheet(sheet: BeatSheet): string[] {
  const problems: string[] = [];
  const performers = new Set(sheet.performers.map((p) => p.id));
  const objects = new Set(Object.keys(sheet.objects ?? {}));
  const marks = new Set(Object.keys(sheet.marks ?? {}));
  if (!sheet.performers.length) problems.push('no performers');
  if (!(sheet.duration > 0)) problems.push('duration must be > 0');
  // One table of names: a point's first word means one thing.
  const seen = new Map<string, string>();
  for (const [kind, names] of [['performer', [...sheet.performers.map((p) => p.id)]], ['object', [...objects]], ['mark', [...marks]]] as const) {
    for (const n of names) {
      if (seen.has(n)) problems.push(`${kind} ${n}: the name is already a ${seen.get(n)}`);
      else seen.set(n, kind);
      if (n.includes('.') || n.includes(':')) problems.push(`${kind} ${n}: a name has no "." or ":"`);
    }
  }
  const ids = { performers, objects };
  const pointProblem = (p: Point | undefined): string | undefined => {
    if (p === undefined) return undefined;
    if (Array.isArray(p)) return p.length === 3 && p.every((v) => Number.isFinite(v)) ? undefined : `[${String(p)}] is not [x, y, z] metres`;
    if (typeof p === 'string') {
      const dot = p.indexOf('.');
      if (dot < 0) {
        if (marks.has(p)) return undefined;
        if (objects.has(p)) return `"${p}" is an object: name a point on it ("${p}.${OBJECT_ANCHORS.join(`", "${p}.`)}", a part or an anchor)`;
        if (performers.has(p)) return `"${p}" is a performer: name a bone ("${p}.head")`;
        return `cannot resolve point "${p}"`;
      }
      const head = p.slice(0, dot);
      const tail = p.slice(dot + 1);
      if (performers.has(head)) return undefined;
      if (objects.has(head)) {
        const names = anchorNames(sheet.objects![head]!);
        return names.includes(tail) ? undefined : `"${p}": ${head} has no anchor ${tail} (${names.join(', ')})`;
      }
      return `cannot resolve point "${p}"`;
    }
    return placeProblem(p as Place, ids);
  };
  for (const [name, m] of Object.entries(sheet.marks ?? {})) {
    const problem = pointProblem(m);
    if (problem) problems.push(`mark ${name}: ${problem}`);
  }

  const held = new Set(sheet.performers.flatMap((p) => Object.values(p.hold ?? {})));
  for (const [id, o] of Object.entries(sheet.objects ?? {})) {
    const where = `object ${id}`;
    const forms = [o.shape !== undefined, o.parts !== undefined, o.source !== undefined].filter(Boolean).length;
    if (forms !== 1) problems.push(`${where}: give exactly one of shape (with size), parts, or source`);
    if (o.shape !== undefined && !SHAPES.includes(o.shape)) problems.push(`${where}: no shape ${o.shape} (${SHAPES.join(', ')})`);
    if (o.shape !== undefined && o.size === undefined) problems.push(`${where}: a shape needs a size [width, height, depth]`);
    if (o.height !== undefined && o.source === undefined) problems.push(`${where}: height scales a source; a shape takes its size`);
    if (o.source !== undefined && !o.source.startsWith('polyhaven:') && o.credit === undefined) problems.push(`${where}: a local model needs a credit (or "own" for your own work)`);
    if (o.source !== undefined && (typeof o.grip === 'string' || typeof o.tool === 'string')) problems.push(`${where}: a source has no parts; give a grip or tool as a point and an axis`);
    const vec = (label: string, v: Vec3Measure | undefined): void => {
      if (v === undefined) return;
      if (!Array.isArray(v) || v.length !== 3) { problems.push(`${where} ${label}: three measures`); return; }
      for (const x of v) { const problem = measureProblem(x, performers); if (problem) problems.push(`${where} ${label}: ${problem}`); }
    };
    vec('size', o.size);
    const measureOf = measureProblem(o.height, performers);
    if (measureOf) problems.push(`${where} height: ${measureOf}`);
    const partNames = new Set<string>();
    for (const [i, part] of (o.parts ?? []).entries()) {
      const label = `part ${part.name ?? i}`;
      if (!SHAPES.includes(part.shape)) problems.push(`${where} ${label}: no shape ${part.shape}`);
      vec(`${label} size`, part.size);
      vec(`${label} at`, part.at);
      if (part.name !== undefined) {
        if (partNames.has(part.name)) problems.push(`${where}: two parts are named ${part.name}`);
        if ((OBJECT_ANCHORS as readonly string[]).includes(part.name)) problems.push(`${where}: ${part.name} is a built-in anchor, not a part name`);
        partNames.add(part.name);
      }
    }
    for (const [k, v] of Object.entries(o.anchors ?? {})) {
      if ((OBJECT_ANCHORS as readonly string[]).includes(k) || partNames.has(k)) problems.push(`${where}: anchor ${k} is already a built-in anchor or part`);
      vec(`anchor ${k}`, v);
    }
    for (const [label, f] of [['grip', o.grip], ['tool', o.tool]] as const) {
      if (typeof f === 'string' && !partNames.has(f)) problems.push(`${where} ${label}: no part ${f}`);
      if (typeof f === 'object') vec(`${label} point`, 'at' in f ? f.at : f.tip);
    }
    if (o.on !== undefined && (!objects.has(o.on) || o.on === id)) problems.push(`${where}: on ${o.on}: no other object`);
    if (held.has(id) && (o.at !== undefined || o.on !== undefined)) problems.push(`${where}: it is in a hand from the first frame, so it takes no at or on`);
    if (!held.has(id) && o.at === undefined && o.on === undefined) problems.push(`${where}: needs at or on (or a performer's hold)`);
    for (const p of [o.at, typeof o.facing === 'number' ? undefined : o.facing]) {
      const problem = pointProblem(p);
      if (problem) problems.push(`${where}: ${problem}`);
    }
  }
  // An object placed from another may not, through any chain, be placed from itself.
  const deps = (id: string): string[] => {
    const o = sheet.objects![id]!;
    return [...(o.on !== undefined ? [o.on] : []), ...pointObjects(o.at, objects), ...(typeof o.facing === 'number' ? [] : pointObjects(o.facing, objects))];
  };
  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') { problems.push(`objects are placed from each other in a circle: ${[...path.slice(path.indexOf(id)), id].join(' → ')}`); return; }
    state.set(id, 'open');
    for (const d of deps(id)) if (objects.has(d)) visit(d, [...path, id]);
    state.set(id, 'done');
  };
  for (const id of objects) visit(id, []);
  for (const p of sheet.performers) {
    for (const [side, o] of Object.entries(p.hold ?? {})) {
      if (side !== 'left' && side !== 'right') problems.push(`performer ${p.id} hold: side ${side} is left or right`);
      if (!objects.has(o!)) problems.push(`performer ${p.id} hold: no object ${o}`);
      else if (!sheet.objects![o!]!.grip) problems.push(`performer ${p.id} hold: ${o} has no grip`);
    }
  }

  const beatIds = new Set<string>();
  for (const b of sheet.beats) {
    if (beatIds.has(b.id)) problems.push(`beat id ${b.id} repeats`);
    beatIds.add(b.id);
    if (!performers.has(b.performer)) problems.push(`beat ${b.id}: no performer ${b.performer}`);
    if (!(b.at >= 0)) problems.push(`beat ${b.id}: at must be ≥ 0`);
    if (b.at >= sheet.duration) problems.push(`beat ${b.id}: at ${b.at} s is not before the take ends (${sheet.duration} s)`);
    for (const d of b.directions) {
      const where = `beat ${b.id} ${d.kind}`;
      if (!Object.hasOwn(DEFAULT_TIMING, d.kind)) { problems.push(`${where}: no direction kind ${d.kind} (${Object.keys(DEFAULT_TIMING).join(', ')})`); continue; }
      const side = d.kind === 'step' ? d.foot : 'side' in d ? d.side : undefined;
      if (side !== undefined && side !== 'left' && side !== 'right' && !(d.kind === 'hand' && side === 'both')) problems.push(`${where}: side ${side} is left or right${d.kind === 'hand' ? ' or both' : ''}`);
      if (d.kind === 'expression' && typeof d.shape === 'object') {
        for (const k of Object.keys(d.shape)) if (!FACE_CHANNELS.includes(k as FaceChannel)) problems.push(`${where}: no face channel ${k}`);
      }
      if (d.kind === 'hand' && !(d.shape in HAND_SHAPES)) problems.push(`${where}: no hand shape ${d.shape} (${Object.keys(HAND_SHAPES).join(', ')})`);
      if (d.kind === 'expression' && typeof d.shape === 'string' && !(d.shape in EXPRESSIONS)) problems.push(`${where}: no expression ${d.shape} (${Object.keys(EXPRESSIONS).join(', ')})`);
      if (d.kind === 'reach' && !(d.stopShort >= 0)) problems.push(`${where}: stopShort must be ≥ 0`);
      if (d.kind === 'turn' && d.degrees === undefined && d.toward === undefined) problems.push(`${where}: needs degrees or toward`);
      if ((d.kind === 'take' || d.kind === 'put') && !objects.has(d.object)) problems.push(`${where}: no object ${d.object}`);
      if (d.kind === 'take' && sheet.objects?.[d.object] && !sheet.objects[d.object]!.grip) problems.push(`${where}: ${d.object} has no grip`);
      if (d.kind === 'put' && (d.at === undefined) === (d.on === undefined)) problems.push(`${where}: give at or on`);
      if (d.kind === 'put' && d.on !== undefined && (!objects.has(d.on) || d.on === d.object)) problems.push(`${where}: on ${d.on}: no other object`);
      for (const p of [('at' in d ? d.at : undefined), (d.kind === 'turn' ? d.toward : undefined)]) {
        const problem = pointProblem(p);
        if (problem) problems.push(`${where}: ${problem}`);
      }
    }
  }
  if (problems.length) return problems;

  // Hands and objects over time.
  const { holdings, problems: order } = holdingsOf(sheet);
  problems.push(...order);
  const holdingAt = (performer: string, side: Side, t: number): Holding | undefined => holdings.find((h) => h.performer === performer && h.side === side && h.from <= t && t <= h.to);
  for (const b of sheet.beats) {
    for (const d of b.directions) {
      const r = resolveTiming(b, d);
      const where = `beat ${b.id} ${d.kind}`;
      if (d.kind === 'aim') {
        const h = holdingAt(b.performer, d.side, r.start);
        const h2 = holdingAt(b.performer, d.side, r.end);
        if (!h || h !== h2) problems.push(`${where}: the ${d.side} hand holds nothing from ${r.start.toFixed(2)} to ${r.end.toFixed(2)} s`);
        else {
          const spec = sheet.objects![h.object]!;
          if (!spec.tool) problems.push(`${where}: ${h.object} has no tool axis to aim`);
          if (pointObjects(d.at, objects).includes(h.object)) problems.push(`${where}: a hand cannot aim the object it holds at itself`);
          const covered = sheet.beats.filter((x) => x.performer === b.performer).some((x) => x.directions.some((y) => {
            if (y.kind !== 'reach' || y.side !== d.side) return false;
            const q = resolveTiming(x, y);
            return q.start <= r.at && r.at + r.attack + r.hold <= q.end;
          }));
          if (!covered) problems.push(`${where}: an aim needs a reach of the ${d.side} hand around it (from before ${r.at.toFixed(2)} s to after ${(r.at + r.attack + r.hold).toFixed(2)} s)`);
        }
      }
      if (d.kind === 'reach') {
        const h = holdingAt(b.performer, d.side, r.at);
        if (h && pointObjects(d.at, objects).includes(h.object)) problems.push(`${where}: a hand cannot reach for the object it holds`);
      }
      if (d.kind === 'hand') {
        for (const side of d.side === 'both' ? (['left', 'right'] as const) : [d.side]) {
          const h = holdings.find((x) => x.performer === b.performer && x.side === side && x.from < r.end && r.start < x.to);
          if (h) problems.push(`${where}: the ${side} hand holds ${h.object} then; a holding hand keeps its grip`);
        }
      }
    }
  }
  return problems;
}

const SHAPES: readonly Shape[] = ['box', 'cylinder', 'cone', 'sphere'];
