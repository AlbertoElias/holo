/**
 * A take as data: performers on a stage and beats of direction. Every
 * direction has timing (anticipation, attack, hold, settle) and is a closed
 * form of time, so changing one beat changes only its own span (a `whole`
 * turn and a step are persistent: they also move everything after them).
 */
import { FACE_CHANNELS, type FaceChannel } from '@holoim/avatar-face';
import { FINISHES, parseLook, type Finish, type LookCard } from '@holoim/avatar-look';

import type { HandShapeName } from './hands.ts';
import { HAND_SHAPES } from './hands.ts';
import { measureProblem, placeProblem } from './stage.ts';
import { objectCreditSchema } from '@holoim/objects';

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
  | { readonly kind: 'expression'; readonly shape: FaceMixName | Partial<Record<FaceChannel, number>>; readonly strength?: number }
  | { readonly kind: 'reach'; readonly side: Side; readonly at: Point; /** Metres the palm stops short of `at`. */ readonly stopShort: number; readonly palm?: 'up' | 'down' | 'in' | 'toward' }
  | { readonly kind: 'hand'; readonly side: Side | 'both'; readonly shape: HandShapeName; readonly strength?: number }
  | { readonly kind: 'weight'; readonly toward: 'left' | 'right' | 'forward' | 'back'; /** 0..1, default 1 (about 6 cm). */ readonly amount?: number }
  /** Bend forward from the waist, hips back and knees soft, as over a plant or a low table; the arms and the look are solved on the bent body. */
  | { readonly kind: 'bend'; /** 0..1 of the deepest bend (`BEND` in `direct.ts`: 45° at the waist), default 0.7. */ readonly amount?: number }
  /** Lower the body: the knees bend and the hips sink and go back over planted feet, the chest leans a little forward, as to pick something up from the floor or to talk to a child. */
  | { readonly kind: 'crouch'; /** 0..1 of the deepest crouch (`CROUCH` in `direct.ts`), default 0.7. */ readonly amount?: number }
  | { readonly kind: 'turn'; readonly degrees?: number; readonly toward?: Point; /** `upper` twists and comes back; `whole` turns the performer and stays. */ readonly body?: 'upper' | 'whole' }
  | { readonly kind: 'step'; readonly foot: Side; /** Metres in the performer's frame: [left, forward]. */ readonly by: readonly [number, number]; /** Bring the other foot alongside. */ readonly follow?: boolean }
  | { readonly kind: 'take'; readonly side: Side; readonly object: string; readonly palm?: 'up' | 'down' | 'in' | 'toward' }
  | { readonly kind: 'put'; readonly side: Side; readonly object: string; readonly at?: Point; readonly on?: string }
  | { readonly kind: 'aim'; readonly side: Side; readonly at: Point }
  | {
      readonly kind: 'gesture'; readonly name: GestureName;
      /** The hand of a hand gesture (default right). */ readonly side?: Side;
      /** Repeats of a repeated gesture (a nod's nods, a wave's sweeps). */ readonly count?: number;
      /** 0..1 and a little past; default 1. */ readonly strength?: number;
      /** A wave's palm faces this point (default straight ahead). */ readonly at?: Point;
    }
  | { readonly kind: 'state'; readonly name: StateName; readonly strength?: number; /** What the state is about: the head turns to it. */ readonly at?: Point }
);
export type DirectionKind = Direction['kind'];

/** Fields each direction kind takes (the type above, at run time), so a sheet with a wrong field name fails with the name. */
const TIMING_FIELDS: readonly string[] = ['anticipation', 'attack', 'hold', 'settle', 'delay'];
const DIRECTION_FIELDS = {
  look: { required: ['at'], optional: ['head'] },
  expression: { required: ['shape'], optional: ['strength'] },
  reach: { required: ['side', 'at', 'stopShort'], optional: ['palm'] },
  hand: { required: ['side', 'shape'], optional: ['strength'] },
  weight: { required: ['toward'], optional: ['amount'] },
  bend: { required: [], optional: ['amount'] },
  crouch: { required: [], optional: ['amount'] },
  turn: { required: [], optional: ['degrees', 'toward', 'body'] },
  step: { required: ['foot', 'by'], optional: ['follow'] },
  take: { required: ['side', 'object'], optional: ['palm'] },
  put: { required: ['side', 'object'], optional: ['at', 'on'] },
  aim: { required: ['side', 'at'], optional: [] },
  gesture: { required: ['name'], optional: ['side', 'count', 'strength', 'at'] },
  state: { required: ['name'], optional: ['strength', 'at'] },
} as const satisfies Record<Direction['kind'], { required: readonly string[]; optional: readonly string[] }>;

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
  /** A spoken line, its first voiced sound at the beat's `at` (plus `delay`, ≥ 0), heard from the performer's head, with the lips following it (sound brief slice 1a). */
  readonly say?: Say;
}

/** A spoken line. `voice` is `local:<kokoro voice>` (made on this machine) or `file:<path>` (relative to the sheet). */
export interface Say {
  readonly text: string;
  readonly voice: string;
  readonly delay?: number;
  readonly gain?: number;
  /** A supplied file's credit: `own` or a free licence. */
  readonly credit?: CreditSpec;
}

/** An effect tied to a beat or to the moment a beat's put lands, heard from an object or a performer's head. */
export interface SoundSpec {
  readonly id: string;
  /** `synth:<name>` (the project's own, CC0) or a path relative to the sheet. */
  readonly file: string;
  readonly at: { readonly beat: string; readonly event?: 'put'; readonly delay?: number };
  /** An object id, or `<performer>.head`. */
  readonly on: string;
  readonly gain?: number;
  /** Required on a file. */
  readonly credit?: CreditSpec;
}

/** The house base as a performer's avatar, in its default finish, clay; `house:<finish>` wears another (`FINISHES` in `@holoim/avatar-look`). */
export const HOUSE_AVATAR = 'house:clay';

/** The finish a `house:<finish>` avatar names, or null when the avatar is not the house base. */
export function houseFinish(avatar: string): Finish | null {
  const m = /^house:(.+)$/.exec(avatar);
  return m && (FINISHES as readonly string[]).includes(m[1]!) ? (m[1] as Finish) : null;
}

export interface PerformerSpec {
  readonly id: string;
  /** Path to the avatar GLB, relative to the beat sheet; or `stock`, `fixture:<name>`, `house:<finish>` (the house base in `clay`, `ink` or `light`). */
  readonly avatar: string;
  /** For `house:<finish>` only: the look card the house base is dressed in (`@holoim/avatar-look`); default its default look. */
  readonly look?: LookCard;
  /** Stage position `[x, z]` in metres. */
  readonly at: readonly [number, number];
  /** Degrees about +Y; 0 faces +Z. */
  readonly facing: number;
  /** Seeds blinks, saccades and breath; default from the performer's index. */
  readonly seed?: number;
  /** Objects in hand from the first frame. */
  readonly hold?: Partial<Record<Side, string>>;
  /** false: no attending life (the nods and arm changes of a performer facing another). Default true. */
  readonly attend?: boolean;
}

/** When a world change happens: seconds, a beat id (its start) or `<beat>.end`. */
export type Cue = number | string;

/** An object's shape as a change leaves it: turned about its origin (degrees, XYZ), scaled, lifted (metres), in one colour. */
export interface ChangeState {
  readonly turn?: readonly [number, number, number];
  readonly scale?: number | readonly [number, number, number];
  readonly lift?: number;
  readonly color?: Color;
}

/**
 * Visible change in the set, computed after the solve from the objects'
 * tracks and written as plain node animation (slice 1f).
 */
export type WorldChange =
  | {
      readonly kind: 'pour'; readonly object: string;
      /** Where the drops land; default the target of the aim that points the object. */ readonly onto?: Point;
      /** Degrees below the horizontal the tool axis must point before water leaves; default 0. */ readonly tilt?: number;
      /** Drops a second at full flow; default 60. */ readonly rate?: number;
      /** Metres a second the water leaves the tip along the axis; default 0.8. */ readonly speed?: number;
      readonly color?: Color;
      /** A drop's width in metres; default 0.012. */ readonly size?: number;
      /** The wet patch where it lands: its radius in metres, or false; default 0.06. */ readonly wet?: boolean | number;
    }
  | { readonly kind: 'burst'; readonly at: Point; readonly when: Cue; readonly count?: number; readonly spread?: number; readonly life?: number; readonly color?: Color; readonly size?: number }
  | { readonly kind: 'drift'; readonly at: Point; readonly when: Cue; readonly until: Cue; readonly count?: number; readonly rise?: number; readonly spread?: number; readonly life?: number; readonly color?: Color; readonly size?: number }
  | (ChangeState & {
      readonly kind: 'change'; readonly object: string; readonly when: Cue;
      /** Seconds the change takes; default 1.5. */ readonly over?: number;
      /** How it starts; default how the change before left it (or as the sheet made it). */ readonly from?: ChangeState;
      /** A colour change's steps; default 4. */ readonly steps?: number;
      /** Disappear (false) or appear (true, absent before) at the cue; nothing else then. */ readonly show?: boolean;
    });
export type WorldChangeKind = WorldChange['kind'];

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
  /** Effects (sound brief slice 1a). */
  readonly sounds?: readonly SoundSpec[];
  /** Visible change in the set: water, particles, an object responding. */
  readonly world?: readonly WorldChange[];
}

export const EXPRESSIONS = {
  // Each mix follows Astra's round 2 clay expression sheet (docs/features/directed-performance.md, slice 2b), the drawing that read 7 of 7 at 40 px.
  // Holding something back: lips rolled in and pressed, inner brows knit and a little raised (worry, not anger), lids a little lowered.
  held: { browInnerUp: 0.4, eyeBlinkLeft: 0.2, eyeBlinkRight: 0.2, mouthPressLeft: 0.5, mouthPressRight: 0.5, mouthRollLower: 0.65, mouthRollUpper: 0.5, mouthShrugLower: 0.3 },
  // Hopeful: inner and outer brows high, eyes wide, the mouth a little open; no smile.
  hope: { browInnerUp: 0.75, browOuterUpLeft: 0.6, browOuterUpRight: 0.6, eyeWideLeft: 0.6, eyeWideRight: 0.6, jawOpen: 0.14, mouthFunnel: 0.15 },
  sad: { browInnerUp: 0.85, mouthFrownLeft: 0.55, mouthFrownRight: 0.55, eyeSquintLeft: 0.15, eyeSquintRight: 0.15, mouthLowerDownLeft: 0.1, mouthLowerDownRight: 0.1 },
  smile: { mouthSmileLeft: 0.7, mouthSmileRight: 0.7, cheekSquintLeft: 0.7, cheekSquintRight: 0.7, eyeSquintLeft: 0.2, eyeSquintRight: 0.2 },
  // A laugh: the mouth open and wide with the upper teeth and the tongue showing, the corners out more than up, the cheeks lifting the
  // lower lids, the brows up. No eye squint: a lowered upper lid over a wide grin reads as menace.
  laugh: { mouthSmileLeft: 0.6, mouthSmileRight: 0.6, mouthStretchLeft: 0.3, mouthStretchRight: 0.3, jawOpen: 0.6, cheekSquintLeft: 1, cheekSquintRight: 1, browInnerUp: 0.4, browOuterUpLeft: 0.5, browOuterUpRight: 0.5 },
  // Delighted: the laugh's open mouth with the eyes wide and the brows high; enthusiasm, not laughter.
  delighted: { mouthSmileLeft: 0.6, mouthSmileRight: 0.6, mouthStretchLeft: 0.3, mouthStretchRight: 0.3, jawOpen: 0.6, cheekSquintLeft: 1, cheekSquintRight: 1, browInnerUp: 0.5, browOuterUpLeft: 0.6, browOuterUpRight: 0.6, eyeWideLeft: 0.25, eyeWideRight: 0.25 },
  'small-smile': { mouthSmileLeft: 0.3, mouthSmileRight: 0.25, mouthPressLeft: 0.15, mouthPressRight: 0.15 },
  breath: { jawOpen: 0.12, mouthFunnel: 0.08, browInnerUp: 0.3 },
  // Determined: brows hard down toward the nose, eyes narrowed, mouth pressed straight.
  resolve: { browDownLeft: 1, browDownRight: 1, eyeSquintLeft: 0.6, eyeSquintRight: 0.6, mouthPressLeft: 0.5, mouthPressRight: 0.5, noseSneerLeft: 0.2, noseSneerRight: 0.2, jawForward: 0.1 },
  // Looking down: lids lowered, irises low, brows at rest, head upright.
  'eyes-down': { eyeBlinkLeft: 0.55, eyeBlinkRight: 0.55, eyeLookDownLeft: 0.8, eyeLookDownRight: 0.8 }
} as const satisfies Record<string, Partial<Record<FaceChannel, number>>>;
export type ExpressionName = keyof typeof EXPRESSIONS;

/**
 * Reads a beat sheet's text: JSON, with `//` and `/* *\/` comments and
 * trailing commas allowed (the starter sheet lists every choice in comments
 * beside the field it is for). A syntax error names the line and column.
 */
export function parseSheetText(text: string, file = 'sheet'): BeatSheet {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const skipped = text.slice(i, end === -1 ? text.length : end + 2);
      out += skipped.replace(/[^\n]/g, ' ');
      i += skipped.length - 1;
    } else out += ch;
  }
  // A trailing comma (only space before the closing bracket); strings are matched first and kept as they are.
  out = out.replace(/("(?:[^"\\]|\\.)*")|,(\s*[\]}])/g, (_m, str: string | undefined, close: string | undefined) => str ?? close!);
  try {
    return JSON.parse(out) as BeatSheet;
  } catch (e) {
    const at = /position (\d+)/.exec(String((e as Error).message));
    if (!at) throw new Error(`${file}: not valid JSON: ${(e as Error).message}`);
    const pos = Number(at[1]);
    const before = out.slice(0, pos).split('\n');
    const line = before.length;
    const col = before[before.length - 1]!.length + 1;
    const shown = text.split('\n')[line - 1] ?? '';
    throw new Error(`${file}:${line}:${col}: not valid JSON (${(e as Error).message.replace(/ in JSON at position \d+.*$/, '')}):\n    ${shown.trim()}\n  check for a missing comma or quote at the end of this line or the one before it`);
  }
}

export const DEFAULT_TIMING: Readonly<Record<DirectionKind, Required<Omit<Timing, 'delay' | 'hold'>>>> = {
  look: { anticipation: 0.08, attack: 0.35, settle: 0.5 },
  expression: { anticipation: 0, attack: 0.35, settle: 0.6 },
  reach: { anticipation: 0.25, attack: 0.75, settle: 0.8 },
  hand: { anticipation: 0, attack: 0.3, settle: 0.5 },
  weight: { anticipation: 0.2, attack: 0.6, settle: 0.7 },
  bend: { anticipation: 0.2, attack: 0.8, settle: 0.8 },
  crouch: { anticipation: 0.15, attack: 0.9, settle: 0.9 },
  turn: { anticipation: 0.2, attack: 0.8, settle: 0.5 },
  step: { anticipation: 0.15, attack: 0.6, settle: 0.3 },
  take: { anticipation: 0.2, attack: 0.8, settle: 0.8 },
  put: { anticipation: 0.15, attack: 0.8, settle: 0.8 },
  aim: { anticipation: 0.1, attack: 0.6, settle: 0.6 },
  // Per name in `GESTURES` and `STATES`; these are the fallbacks.
  gesture: { anticipation: 0.1, attack: 0.3, settle: 0.5 },
  state: { anticipation: 0, attack: 0.4, settle: 0.7 }
};

/**
 * Gestures a beat directs by name (brief slice 1e). `cycle` and `count` make a
 * repeated one: its hold is the repeats (`count × cycle`, less the attack when
 * the repeats start with the move, `from: 'at'`), unless the direction gives a
 * hold. `hand` gestures take a side and keep that hand from its fidgets.
 */
export const GESTURES = {
  nod: { anticipation: 0.06, attack: 0.15, settle: 0.3, cycle: 0.8, count: 3, from: 'at', hand: false },
  'head-shake': { anticipation: 0.05, attack: 0.15, settle: 0.35, cycle: 0.8, count: 3, from: 'at', hand: false },
  shrug: { anticipation: 0.1, attack: 0.35, settle: 0.5, hold: 0.5, hand: false },
  wave: { anticipation: 0.15, attack: 0.5, settle: 0.6, cycle: 0.42, count: 3, from: 'arrive', hand: true },
  rub: { anticipation: 0.15, attack: 0.6, settle: 0.6, cycle: 0.4, count: 5, from: 'arrive', hand: true },
  'hand-to-chest': { anticipation: 0.15, attack: 0.6, settle: 0.7, hold: 1.0, hand: true }
} as const satisfies Record<string, { anticipation: number; attack: number; settle: number; cycle?: number; count?: number; from?: 'at' | 'arrive'; hold?: number; hand: boolean }>;
export type GestureName = keyof typeof GESTURES;

/** States a beat directs by name, held for the beat's hold: a body and head attitude and a face mix (`STATE_FACES`). */
export const STATES = {
  noticing: { anticipation: 0, attack: 0.22, settle: 0.6 },
  concerned: { anticipation: 0, attack: 0.7, settle: 0.8 }
} as const satisfies Record<string, Required<Omit<Timing, 'delay' | 'hold'>>>;
export type StateName = keyof typeof STATES;

/** The states' faces, also named expressions: new names only (the mixes above are unchanged). */
export const STATE_FACES = {
  // Eyes wide, brows up, lips just parted: something has caught the eye.
  noticing: { eyeWideLeft: 0.55, eyeWideRight: 0.55, browOuterUpLeft: 0.45, browOuterUpRight: 0.45, browInnerUp: 0.35, jawOpen: 0.08, mouthLowerDownLeft: 0.1, mouthLowerDownRight: 0.1 },
  // Brows drawn together and up, lips pressed, the corners a little down.
  concerned: { browInnerUp: 0.6, browDownLeft: 0.3, browDownRight: 0.3, mouthPressLeft: 0.4, mouthPressRight: 0.4, mouthFrownLeft: 0.25, mouthFrownRight: 0.25, eyeSquintLeft: 0.15, eyeSquintRight: 0.15 }
} as const satisfies Record<StateName, Partial<Record<FaceChannel, number>>>;

/** Every named face mix an `expression` can ask for. */
export const FACE_MIXES: Readonly<Record<FaceMixName, Readonly<Partial<Record<FaceChannel, number>>>>> = { ...EXPRESSIONS, ...STATE_FACES };
export type FaceMixName = ExpressionName | StateName;

/** A direction's default timing: per gesture or state name, else per kind. */
export function defaultTiming(d: Direction): Required<Omit<Timing, 'delay' | 'hold'>> {
  if (d.kind === 'gesture' && Object.hasOwn(GESTURES, d.name)) { const g = GESTURES[d.name]; return { anticipation: g.anticipation, attack: g.attack, settle: g.settle }; }
  if (d.kind === 'state' && Object.hasOwn(STATES, d.name)) return STATES[d.name];
  return DEFAULT_TIMING[d.kind];
}

/** A gesture's repeats, and when they start (seconds after the direction's `at`). */
export function gestureCycle(d: Extract<Direction, { kind: 'gesture' }>, attack: number): { cycle: number; count: number; from: number } | undefined {
  const g = GESTURES[d.name] as { cycle?: number; count?: number; from?: 'at' | 'arrive' };
  if (g.cycle === undefined) return undefined;
  return { cycle: g.cycle, count: Math.max(1, Math.round(d.count ?? g.count ?? 1)), from: g.from === 'arrive' ? attack : 0 };
}

/** Directions whose result stays: the performer's place and facing. */
export const PERSISTENT = (d: Direction): boolean => d.kind === 'step' || (d.kind === 'turn' && d.body === 'whole');
/** Directions that change the world for the rest of the take: also where an object is (`take` and `put` reach and come back, but the object stays moved). */

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
  const def = defaultTiming(d);
  const at = beat.at + (d.delay ?? 0);
  const anticipation = d.anticipation ?? def.anticipation;
  const attack = Math.max(1e-3, d.attack ?? def.attack);
  const held = d.kind === 'gesture' && Object.hasOwn(GESTURES, d.name) ? (GESTURES[d.name] as { hold?: number }).hold : undefined;
  const hold = Math.max(0, d.hold ?? gestureHold(d, attack) ?? beat.hold ?? held ?? 0.6);
  const settle = Math.max(1e-3, d.settle ?? def.settle);
  return { beat, direction: d, start: at - anticipation, at, anticipation, attack, hold, settle, persistent: PERSISTENT(d), end: at + attack + hold + settle };
}

/** A repeated gesture holds for its repeats (a held one takes the beat's hold, else its own default). */
function gestureHold(d: Direction, attack: number): number | undefined {
  if (d.kind !== 'gesture' || !Object.hasOwn(GESTURES, d.name)) return undefined;
  const c = gestureCycle(d, attack);
  if (c) return Math.max(0, c.from + c.count * c.cycle - attack);
  return undefined;
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
export function beatSpan(beat: Beat): { from: number; to: number } {
  const rs = beat.directions.map((d) => resolveTiming(beat, d));
  if (!rs.length) return { from: beat.at, to: beat.at };
  return { from: Math.max(0, Math.min(...rs.map((r) => r.start))), to: Math.max(...rs.map((r) => r.persistent ? r.at + r.attack + r.settle : r.end)) };
}

/** A cue's time in seconds, or undefined when it names no beat. */
export function cueTime(sheet: BeatSheet, cue: Cue): number | undefined {
  if (typeof cue === 'number') return cue;
  const end = cue.endsWith('.end');
  const beat = sheet.beats.find((b) => b.id === (end ? cue.slice(0, -4) : cue));
  if (!beat) return undefined;
  const span = beatSpan(beat);
  return end ? span.to : beat.at;
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
export function pointObjects(p: Point | undefined, objects: ReadonlySet<string>, marks: Readonly<Record<string, Point>> = {}, seen: ReadonlySet<string> = new Set()): string[] {
  if (p === undefined) return [];
  if (typeof p === 'string') {
    // A mark stands for its own point, so it depends on what that point is measured from.
    if (!p.includes('.')) return Object.hasOwn(marks, p) && !seen.has(p) ? pointObjects(marks[p], objects, marks, new Set([...seen, p])) : [];
    const head = p.split('.')[0]!;
    return objects.has(head) ? [head] : [];
  }
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
    if (when >= duration) { problems.push(`${where}: the hand arrives at ${Math.round(when * 100) / 100} s, not before the take ends (${duration} s)`); continue; }
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
  for (const p of sheet.performers) {
    if ((p.avatar === 'house' || p.avatar.startsWith('house:')) && !houseFinish(p.avatar)) problems.push(`${p.id}: avatar "${p.avatar}": the house base is ${FINISHES.map((f) => `"house:${f}"`).join(', ')}`);
    if (p.look === undefined) continue;
    if (!houseFinish(p.avatar)) { problems.push(`${p.id}: a look needs a house avatar ("${HOUSE_AVATAR}" or another finish)`); continue; }
    try { parseLook(p.look, `${p.id} look`); } catch (e) { problems.push((e as Error).message); }
  }
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
    if (o.credit !== undefined && o.credit !== 'own') {
      const credit = objectCreditSchema.safeParse(o.credit);
      if (!credit.success) problems.push(`${where} credit: ${credit.error.issues.map((i) => `${i.path.join('.') || 'credit'} ${i.message}`).join('; ')}`);
    }
    if (o.source !== undefined && (typeof o.grip === 'string' || typeof o.tool === 'string')) problems.push(`${where}: a source has no parts; give a grip or tool as a point and an axis`);
    const vec = (label: string, v: Vec3Measure | undefined): void => {
      if (v === undefined) return;
      if (!Array.isArray(v) || v.length !== 3) { problems.push(`${where} ${label}: three measures`); return; }
      for (const x of v) { const problem = measureProblem(x, performers); if (problem) problems.push(`${where} ${label}: ${problem}`); }
      if (label.endsWith('size') && v.some((x) => typeof x === 'number' && !(x > 0))) problems.push(`${where} ${label}: each size is above 0`);
    };
    vec('size', o.size);
    if (typeof o.height === 'number' && !(o.height > 0)) problems.push(`${where} height: above 0`);
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
    return [...(o.on !== undefined ? [o.on] : []), ...pointObjects(o.at, objects, sheet.marks), ...(typeof o.facing === 'number' ? [] : pointObjects(o.facing, objects, sheet.marks))];
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
  // The set and the marks are fixed on the first frame, before a hand has seated what it holds.
  for (const id of objects) for (const d of deps(id)) if (held.has(d)) problems.push(`object ${id}: placed from ${d}, which is in a hand from the first frame`);
  for (const [name, m] of Object.entries(sheet.marks ?? {})) for (const d of pointObjects(m, objects, sheet.marks)) if (held.has(d)) problems.push(`mark ${name}: measured from ${d}, which is in a hand from the first frame`);
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
      const fields: { readonly required: readonly string[]; readonly optional: readonly string[] } = DIRECTION_FIELDS[d.kind];
      const loose = d as unknown as Record<string, unknown>;
      for (const k of Object.keys(loose)) {
        if (k !== 'kind' && !TIMING_FIELDS.includes(k) && !fields.required.includes(k) && !fields.optional.includes(k)) problems.push(`${where}: no field ${k} (it takes ${[...fields.required, ...fields.optional].join(', ')})`);
      }
      for (const k of fields.required) if (loose[k] === undefined) problems.push(`${where}: needs ${k}`);
      const side = d.kind === 'step' ? d.foot : 'side' in d ? d.side : undefined;
      if (side !== undefined && side !== 'left' && side !== 'right' && !(d.kind === 'hand' && side === 'both')) problems.push(`${where}: side ${side} is left or right${d.kind === 'hand' ? ' or both' : ''}`);
      if (d.kind === 'expression' && typeof d.shape === 'object') {
        for (const k of Object.keys(d.shape)) if (!FACE_CHANNELS.includes(k as FaceChannel)) problems.push(`${where}: no face channel ${k}`);
      }
      if (d.kind === 'hand' && !(d.shape in HAND_SHAPES)) problems.push(`${where}: no hand shape ${d.shape} (${Object.keys(HAND_SHAPES).join(', ')})`);
      if (d.kind === 'expression' && typeof d.shape === 'string' && !Object.hasOwn(FACE_MIXES, d.shape)) problems.push(`${where}: no expression ${d.shape} (${Object.keys(FACE_MIXES).join(', ')})`);
      if (d.kind === 'gesture') {
        if (!Object.hasOwn(GESTURES, d.name)) problems.push(`${where}: no gesture ${String(d.name)} (${Object.keys(GESTURES).join(', ')})`);
        else {
          if (d.side !== undefined && !GESTURES[d.name].hand) problems.push(`${where} ${d.name}: takes no side (it is not a hand gesture)`);
          if (d.count !== undefined && (!(d.count >= 1) || !gestureCycle({ ...d, count: 1 }, 0))) problems.push(`${where} ${d.name}: ${gestureCycle({ ...d, count: 1 }, 0) ? 'count is 1 or more' : 'takes no count (it is not repeated)'}`);
          if (d.at !== undefined && d.name !== 'wave') problems.push(`${where} ${d.name}: only a wave takes at`);
        }
      }
      if (d.kind === 'state' && !Object.hasOwn(STATES, d.name)) problems.push(`${where}: no state ${String(d.name)} (${Object.keys(STATES).join(', ')})`);
      if ((d.kind === 'gesture' || d.kind === 'state') && d.strength !== undefined && !(d.strength >= 0)) problems.push(`${where}: strength is 0 or more`);
      if (d.kind === 'crouch' && d.amount !== undefined && !(d.amount >= 0 && d.amount <= 1)) problems.push(`${where}: amount is 0 to 1 (1 is the deepest crouch)`);
      if (d.kind === 'bend' && d.amount !== undefined && !(d.amount >= 0 && d.amount <= 1)) problems.push(`${where}: amount is 0 to 1 (1 is the deepest bend)`);
      if (d.kind === 'reach' && !(d.stopShort >= 0)) problems.push(`${where}: stopShort must be ≥ 0`);
      if (d.kind === 'turn' && d.degrees === undefined && d.toward === undefined) problems.push(`${where}: needs degrees or toward`);
      if ((d.kind === 'take' || d.kind === 'put') && !objects.has(d.object)) problems.push(`${where}: no object ${d.object}`);
      if (d.kind === 'take' && sheet.objects?.[d.object] && !sheet.objects[d.object]!.grip) problems.push(`${where}: ${d.object} has no grip`);
      if (d.kind === 'put' && (d.at === undefined) === (d.on === undefined)) problems.push(`${where}: give at or on`);
      if (d.kind === 'put' && d.on !== undefined && (!objects.has(d.on) || d.on === d.object)) problems.push(`${where}: on ${d.on}: no other object`);
      if (d.kind === 'put' && pointObjects(d.at, objects, sheet.marks).includes(d.object)) problems.push(`${where}: an object cannot be put down at a point on itself`);
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
          if (pointObjects(d.at, objects, sheet.marks).includes(h.object)) problems.push(`${where}: a hand cannot aim the object it holds at itself`);
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
        if (h && pointObjects(d.at, objects, sheet.marks).includes(h.object)) problems.push(`${where}: a hand cannot reach for the object it holds`);
      }
      if (d.kind === 'hand' || (d.kind === 'gesture' && GESTURES[d.name].hand)) {
        const sides = d.kind === 'hand' ? (d.side === 'both' ? (['left', 'right'] as const) : [d.side]) : [d.side ?? 'right'];
        for (const side of sides) {
          const h = holdings.find((x) => x.performer === b.performer && x.side === side && x.from < r.end && r.start < x.to);
          if (h) problems.push(`${where}: the ${side} hand holds ${h.object} then; a holding hand keeps its grip`);
        }
      }
    }
  }
  problems.push(...soundProblems(sheet));
  problems.push(...worldProblems(sheet, holdings));
  return problems;
}

const WORLD_KINDS: readonly WorldChangeKind[] = ['pour', 'burst', 'drift', 'change'];

function worldProblems(sheet: BeatSheet, holdings: readonly Holding[]): string[] {
  const problems: string[] = [];
  const objects = sheet.objects ?? {};
  const ids = new Set(Object.keys(objects));
  // A world point is read from the objects' tracks after the solve: an object point, a numeric mark or [x, y, z].
  const point = (p: Point | undefined, where: string): void => {
    if (p === undefined) return;
    if (Array.isArray(p)) { if (p.length !== 3 || p.some((x) => typeof x !== 'number' || !Number.isFinite(x))) problems.push(`${where}: [x, y, z] in metres`); return; }
    if (typeof p !== 'string') { problems.push(`${where}: a place is not allowed here; name an object point, a numeric mark or [x, y, z]`); return; }
    const dot = p.indexOf('.');
    if (dot < 0) {
      const m = sheet.marks?.[p];
      if (!m) problems.push(`${where}: no mark ${p}`);
      else if (!Array.isArray(m)) problems.push(`${where}: mark ${p} is a place; name an object point, a numeric mark or [x, y, z]`);
      return;
    }
    const head = p.slice(0, dot);
    if (!ids.has(head)) { problems.push(`${where}: ${head} is not an object (a performer point moves with the solve)`); return; }
    if (!anchorNames(objects[head]!).includes(p.slice(dot + 1))) problems.push(`${where}: ${head} has no point ${p.slice(dot + 1)}`);
  };
  const cue = (c: Cue | undefined, where: string): number | undefined => {
    if (c === undefined) { problems.push(`${where}: needs a cue (seconds, a beat id or <beat>.end)`); return undefined; }
    const t = cueTime(sheet, c);
    if (t === undefined) problems.push(`${where}: no beat ${String(c).replace(/\.end$/, '')}`);
    else if (!(t >= 0 && t <= sheet.duration)) problems.push(`${where}: ${t.toFixed(2)} s is outside the take (0 to ${sheet.duration} s)`);
    return t;
  };
  const positive = (v: number | undefined, where: string): void => { if (v !== undefined && !(typeof v === 'number' && v > 0)) problems.push(`${where}: above 0`); };
  const color = (c: Color | undefined, where: string): void => {
    if (c === undefined) return;
    if (typeof c === 'string') { if (!/^#[0-9a-fA-F]{6}$/.test(c)) problems.push(`${where}: a colour is #rrggbb or [r, g, b]`); }
    else if (!Array.isArray(c) || c.length !== 3 || c.some((x) => !(x >= 0 && x <= 1))) problems.push(`${where}: [r, g, b] in 0..1`);
  };
  const state = (s: ChangeState | undefined, where: string, sourced: boolean, keys: readonly string[] = ['turn', 'scale', 'lift', 'color']): void => {
    if (!s) return;
    for (const k of Object.keys(s)) if (!keys.includes(k)) problems.push(`${where}: no ${k} (${keys.join(', ')})`);
    if (s.turn !== undefined && (!Array.isArray(s.turn) || s.turn.length !== 3 || s.turn.some((x) => !Number.isFinite(x)))) problems.push(`${where} turn: three degrees`);
    if (s.scale !== undefined) {
      const v = typeof s.scale === 'number' ? [s.scale] : s.scale;
      if (!Array.isArray(v) || (v.length !== 1 && v.length !== 3) || v.some((x) => !(x > 0))) problems.push(`${where} scale: a number or three, each above 0`);
    }
    if (s.lift !== undefined && !Number.isFinite(s.lift)) problems.push(`${where} lift: metres`);
    color(s.color, `${where} color`);
    if (s.color !== undefined && sourced) problems.push(`${where}: a sourced model keeps its own materials; a colour change needs parts`);
  };
  const shows = new Map<string, { t: number; show: boolean }[]>();
  const moves = new Map<string, { t: number; end: number }[]>();
  for (const [i, w] of (sheet.world ?? []).entries()) {
    const where = `world ${i + 1} (${w.kind})`;
    if (!WORLD_KINDS.includes(w.kind)) { problems.push(`${where}: no kind ${w.kind} (${WORLD_KINDS.join(', ')})`); continue; }
    if (w.kind === 'pour') {
      const spec = objects[w.object];
      if (!spec) { problems.push(`${where}: no object ${w.object}`); continue; }
      if (!spec.tool) problems.push(`${where}: ${w.object} has no tool axis to pour from`);
      point(w.onto, `${where} onto`);
      if (w.onto === undefined) {
        const aimed = aimTargetOf(sheet, holdings, w.object);
        // The water lands on its aim's target, which must stay put like any world point.
        if (!aimed) problems.push(`${where}: nothing aims ${w.object}; give onto`);
        else point(aimed, `${where} (its aim's target; give onto)`);
      }
      positive(w.rate, `${where} rate`); positive(w.speed, `${where} speed`); positive(w.size, `${where} size`);
      if (typeof w.wet === 'number') positive(w.wet, `${where} wet`);
      if (w.tilt !== undefined && !(w.tilt > -90 && w.tilt < 90)) problems.push(`${where} tilt: degrees between -90 and 90`);
      color(w.color, `${where} color`);
    } else if (w.kind === 'burst' || w.kind === 'drift') {
      if (w.at === undefined) problems.push(`${where}: needs at`);
      point(w.at, `${where} at`);
      const from = cue(w.when, `${where} when`);
      if (w.kind === 'drift') {
        const to = cue(w.until, `${where} until`);
        if (from !== undefined && to !== undefined && !(to > from)) problems.push(`${where}: until comes after when`);
        positive(w.rise, `${where} rise`);
      }
      if (w.count !== undefined && !(Number.isInteger(w.count) && w.count > 0 && w.count <= 400)) problems.push(`${where} count: a whole number from 1 to 400`);
      positive(w.spread, `${where} spread`); positive(w.life, `${where} life`); positive(w.size, `${where} size`);
      color(w.color, `${where} color`);
    } else {
      const spec = objects[w.object];
      if (!spec) { problems.push(`${where}: no object ${w.object}`); continue; }
      const t = cue(w.when, `${where} when`);
      const sourced = spec.source !== undefined;
      if (w.show !== undefined) {
        if (typeof w.show !== 'boolean') problems.push(`${where} show: true or false`);
        if (w.turn !== undefined || w.scale !== undefined || w.lift !== undefined || w.color !== undefined || w.from !== undefined || w.over !== undefined || w.steps !== undefined) problems.push(`${where}: a show cue changes nothing else; give the change its own line`);
        if (t !== undefined) shows.set(w.object, [...(shows.get(w.object) ?? []), { t, show: w.show }]);
        continue;
      }
      state(w, where, sourced, ['kind', 'object', 'when', 'over', 'from', 'steps', 'turn', 'scale', 'lift', 'color']);
      state(w.from, `${where} from`, sourced);
      if (w.over !== undefined && !(w.over >= 0)) problems.push(`${where} over: seconds, 0 or more`);
      if (w.steps !== undefined && !(Number.isInteger(w.steps) && w.steps >= 2 && w.steps <= 12)) problems.push(`${where} steps: a whole number from 2 to 12`);
      if (t !== undefined) moves.set(w.object, [...(moves.get(w.object) ?? []), { t, end: t + (w.over ?? 1.5) }]);
      if (t !== undefined && t + (w.over ?? 1.5) > sheet.duration + 1e-6) problems.push(`${where}: ends at ${(t + (w.over ?? 1.5)).toFixed(2)} s, after the take (${sheet.duration} s)`);
    }
  }
  for (const [object, spans] of moves) {
    const sorted = [...spans].sort((a, b) => a.t - b.t);
    for (let k = 1; k < sorted.length; k += 1) if (sorted[k]!.t < sorted[k - 1]!.end - 1e-6) problems.push(`world: ${object} changes again at ${sorted[k]!.t.toFixed(2)} s, before the change before it ends (${sorted[k - 1]!.end.toFixed(2)} s)`);
  }
  for (const [object, cues] of shows) {
    const sorted = [...cues].sort((a, b) => a.t - b.t);
    for (let k = 1; k < sorted.length; k += 1) {
      if (sorted[k]!.t === sorted[k - 1]!.t) problems.push(`world: ${object} is shown and hidden at the same time (${sorted[k]!.t.toFixed(2)} s)`);
      else if (sorted[k]!.show === sorted[k - 1]!.show) problems.push(`world: ${object} is shown (or hidden) twice in a row at ${sorted[k]!.t.toFixed(2)} s`);
    }
    if (holdings.some((h) => h.object === object)) problems.push(`world: ${object} is held; a held object does not appear or disappear`);
  }
  return problems;
}

/** The point the first aim of an object points at (who holds it then, by the holdings), if any. */
export function aimTargetOf(sheet: BeatSheet, holdings: readonly Holding[], object: string): Point | undefined {
  for (const b of sheet.beats) for (const d of b.directions) {
    if (d.kind !== 'aim') continue;
    const r = resolveTiming(b, d);
    const h = holdings.find((x) => x.performer === b.performer && x.side === d.side && x.from <= r.start && r.start <= x.to);
    if (h?.object === object) return d.at;
  }
  return undefined;
}

const SHAPES: readonly Shape[] = ['box', 'cylinder', 'cone', 'sphere'];

const SYNTH_SOUNDS = ['cup-clink'];

/** A sheet's spoken lines and effects: voices and files named, beats and puts that exist, one sound per place. */
export function soundProblems(sheet: BeatSheet): string[] {
  const problems: string[] = [];
  const performers = new Set(sheet.performers.map((p) => p.id));
  const objects = new Set(Object.keys(sheet.objects ?? {}));
  const places = new Map<string, string>();
  const place = (where: string, what: string): void => {
    if (places.has(where)) problems.push(`${what}: ${where} already carries ${places.get(where)} (one sound per place)`);
    else places.set(where, what);
  };
  for (const b of sheet.beats) {
    if (!b.say) continue;
    const what = `beat ${b.id} say`;
    if (!b.say.text?.trim()) problems.push(`${what}: no text`);
    if (!/^(local:[a-z]{2}_[a-z]+|file:.+)$/.test(b.say.voice ?? '')) problems.push(`${what}: voice is local:<voice> (e.g. local:af_heart) or file:<path>`);
    if ((b.say.delay ?? 0) < 0) problems.push(`${what}: delay is seconds after the beat, not before`);
    if (b.say.voice?.startsWith('file:') && b.say.credit === undefined) problems.push(`${what}: a file voice needs a credit ("own" or a free licence)`);
    place(`${b.performer}.head`, what);
  }
  const ids = new Set<string>();
  for (const s of sheet.sounds ?? []) {
    const what = `sound ${s.id}`;
    if (ids.has(s.id)) problems.push(`${what}: the id is used twice`);
    ids.add(s.id);
    const beat = sheet.beats.find((b) => b.id === s.at?.beat);
    if (!beat) problems.push(`${what}: no beat ${s.at?.beat}`);
    else if (s.at.event === 'put' && !beat.directions.some((d) => d.kind === 'put')) problems.push(`${what}: beat ${beat.id} has no put`);
    if (s.file.startsWith('synth:')) { if (!SYNTH_SOUNDS.includes(s.file.slice(6))) problems.push(`${what}: unknown ${s.file} (${SYNTH_SOUNDS.map((n) => `synth:${n}`).join(', ')})`); }
    else if (s.credit === undefined) problems.push(`${what}: a file needs a credit ("own" or a free licence)`);
    const [head, tail] = s.on.split('.');
    if (!(objects.has(s.on) || (head !== undefined && performers.has(head) && tail === 'head'))) problems.push(`${what}: on is an object or <performer>.head`);
    place(s.on, what);
  }
  return problems;
}
