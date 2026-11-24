import * as THREE from 'three';
import { VRM_HUMANOID_BONES, type VrmHumanoidBone } from '@holoim/meaning';

import type { HumanoidSkeleton } from '../avatar/HumanoidSkeleton';

export type LocomotionState = 'idle' | 'walk' | 'jump' | 'fall';
export type LocomotionProfile = 'desktop-full' | 'vr-lower-body';
/** Where each state's clip came from: the avatar's own, the retargeted library, or neither. */
export type LocomotionClipSource = 'own' | 'retargeted' | 'none';

export interface LocomotionUpdateInput {
  deltaSec: number;
  grounded: boolean;
  velocityY: number;
  horizontalSpeed: number;
  targetHorizontalSpeed: number;
  moveIntent: boolean;
  vrMode: boolean;
  /** Uncrouched travel speed: cadence slows with crouch as well as collision. */
  referenceSpeed?: number;
  /** The body's world position on the ground plane: the walk is chosen on its net travel, since a body pushed
   * against a rock rattles back and forth each step and reports speed without going anywhere. */
  position?: { x: number; z: number };
  /** The desktop body's travel in its own frame (rad: 0 forward, +π/2 to its left), from the eased velocity; null
   * plays the forward walk alone (VR, the stick, or no directional clips). */
  travelLocalYaw?: number | null;
  /** A point, aim, carry, reach or plant holds the upper body: the idle's sway eases out (IDLE_SWAY_HOLD_SEC). */
  holdStill?: boolean;
  /** With holdStill, a point whose ray starts at the eye is held: the sway leaves within IDLE_SWAY_AIM_SEC. */
  aimHeld?: boolean;
  /** The crouch pose's amount (0..1): the desktop walk blends toward the crouch walk clips by it. */
  crouch?: number;
}

export type GaitLeg = 'left' | 'right';
/** The walk clip's footfalls, measured by forward kinematics when the clip is attached. */
export interface WalkGait {
  /** Clip phase (0..1) at which each foot lands and lifts; the stance may wrap past 1. */
  readonly stance: Readonly<Record<GaitLeg, { readonly land: number; readonly lift: number }>>;
  /** Mean backward speed of a planted foot at time scale 1, in the avatar's own (unscaled) units per second. */
  readonly stanceSpeed: number;
}
/**
 * The walk clip's step shape per phase, measured by forward kinematics with its feet (the VR body solver lays its
 * walking steps on it). Lengths are in rest hips heights (hips above the rest sole), so they hold at any avatar scale
 * and the solver multiplies them by its own. Each array holds WALK_TRAJECTORY_SAMPLES values over one clip cycle.
 */
export interface WalkTrajectory {
  readonly gait: WalkGait;
  /** Seconds per cycle at time scale 1. */
  readonly duration: number;
  /** Mean backward speed of a planted foot relative to the ground-projected root, in hips heights per second. */
  readonly stanceSpeed: number;
  readonly legs: Readonly<Record<GaitLeg, {
    /** In the swing (lift to land): share of the step's ground travel done, 0 at lift, 1 at landing. */
    readonly progress: Float32Array;
    /** Sole height above that foot's planted sole. */
    readonly clearance: Float32Array;
    /** Foot pitch from rest (radians): positive lifts the heel, negative the toes. */
    readonly roll: Float32Array;
  }>>;
  /** Hips height below its highest point over the cycle (zero or less). */
  readonly bob: Float32Array;
}

export const WALK_TRAJECTORY_SAMPLES = 96;

// The clip's hips dip sharply at each heel strike (the impact in the mocap). Laid under a VR body, that dip and the
// pelvis reach drop meet at the landing and read as a one-frame drop (B-087: 13–16 m/s² against a 2–4 m/s² stick
// walk). A Gaussian over this many samples (σ, about 6% of the cycle) rounds its bottom; the stick walk's bob stays
// about 3 cm deep, and its peak falls under 10 m/s².
// The desktop walk plays the clip's own hips, unchanged.
const WALK_BOB_SMOOTH_SAMPLES = 6;

/** Circular Gaussian smoothing of a per-phase array (`sigma` in samples). */
function smoothCircular(values: Float32Array, sigma: number): Float32Array {
  const n = values.length;
  const reach = Math.ceil(3 * sigma);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let weight = 0;
    for (let k = -reach; k <= reach; k++) {
      const w = Math.exp(-(k * k) / (2 * sigma * sigma));
      sum += values[(((i + k) % n) + n) % n]! * w;
      weight += w;
    }
    out[i] = sum / weight;
  }
  return out;
}

/** Linear interpolation of a per-phase trajectory array, circular in phase (0..1). */
export function sampleWalkTrajectory(values: Float32Array, phase: number): number {
  const n = values.length;
  const at = ((((phase % 1) + 1) % 1) * n);
  const i = Math.floor(at) % n;
  const f = at - Math.floor(at);
  return values[i]! + (values[(i + 1) % n]! - values[i]!) * f;
}

/** What the leg solver needs from the walk this frame. */
export interface GaitState {
  readonly gait: WalkGait;
  /** Walking on the walk clip (not idle, airborne or fading out). */
  readonly walking: boolean;
  /** Current clip phase, 0..1. */
  readonly phase: number;
  /** How much longer than the clip's own each stride is laid down (the leg solver scales the feet's offset along the clip's travel). */
  readonly stride: number;
  /** The blended clips' own travel in the body frame (unit): the leg solver turns the feet's offsets from it to the body's travel. */
  readonly clipForward: number;
  readonly clipLeft: number;
}

/**
 * The desktop walk's directional and crouch clips, by exact name (the walk matcher skips them). Each plays on the
 * walk's shared phase, weighted by the body-frame travel and the crouch (docs/features/realistic-avatar-motion.md, slice 2).
 */
type Direction = 'walk' | 'back' | 'left' | 'right' | 'crouch' | 'crouchBack';
const DIRECTIONAL_CLIPS: Readonly<Record<Exclude<Direction, 'walk'>, { name: string; travel: GaitTravel }>> = {
  back: { name: 'walkbackward', travel: 'back' },
  left: { name: 'strafeleft', travel: 'left' },
  right: { name: 'straferight', travel: 'right' },
  crouch: { name: 'crouchwalk', travel: 'forward' },
  crouchBack: { name: 'crouchwalkbackward', travel: 'back' }
};
const DIRECTIONAL_NAMES = new Set(Object.values(DIRECTIONAL_CLIPS).map((d) => d.name));
const isDirectionalClip = (name: string) => DIRECTIONAL_NAMES.has(name.toLowerCase());
type GaitTravel = 'forward' | 'back' | 'left' | 'right';
const TRAVEL_VECTORS: Readonly<Record<GaitTravel, { forward: number; left: number }>> = {
  forward: { forward: 1, left: 0 }, back: { forward: -1, left: 0 }, left: { forward: 0, left: 1 }, right: { forward: 0, left: -1 }
};
/** Time constant of the directional weights (s). */
const DIRECTION_EASE_SEC = 0.1;
/** Another clip leads the leg solver's footfalls once its weight passes the leading one's by this much. */
const LEAD_HYSTERESIS = 0.1;
interface DirectionalPlay {
  readonly direction: Direction;
  readonly action: THREE.AnimationAction;
  readonly gait: WalkGait;
  readonly duration: number;
  readonly forward: number;
  readonly left: number;
  /** Only the forward clips take the avatar's longer stride (fitStrideScale): a side step laid longer overreaches. */
  readonly strideScaled: boolean;
  /** Added to the shared phase, so every clip's left footfall falls on the walk's. */
  readonly offset: number;
  weight: number;
}
type MutableGaitState = { -readonly [K in keyof GaitState]: GaitState[K] };

/**
 * The shipped walk (CMU 07_12) plays on its own stride: at 1.8 m/s that is ~130 steps/min of 0.84 m steps. A longer
 * stride (1.1×) locked the trailing leg straight far behind, which read as stretched legs side-on
 * (docs/features/realistic-avatar-motion.md, 16).
 */
const WALK_STRIDE_SCALE = 1.0;
/**
 * An avatar with short legs for its height takes short steps, so at the walk speed (a share of its height) its own
 * stride gives a hurried cadence (the house base: 150 steps/min). Its stride is laid longer, up to this cadence at
 * the walk speed and no more than the limit. An avatar at or under the cadence keeps its own stride.
 */
const WALK_CADENCE_MAX_STEPS_PER_MIN = 130;
const WALK_STRIDE_SCALE_MAX = 1.2;

export function inStance(gait: WalkGait, leg: GaitLeg, phase: number): boolean {
  const { land, lift } = gait.stance[leg];
  return land <= lift ? phase >= land && phase < lift : phase >= land || phase < lift;
}

export const LOCOMOTION_STATES: readonly LocomotionState[] = ['idle', 'walk', 'jump', 'fall'];
const CLIP_MATCHERS: Readonly<Record<LocomotionState, RegExp>> = {
  idle: /idle|breath|stand/i,
  walk: /walk|locomotion/i,
  jump: /jump|takeoff/i,
  fall: /fall|air/i
};
const CLIP_FALLBACK_ORDER: Readonly<Record<LocomotionState, readonly LocomotionState[]>> = {
  jump: ['jump', 'fall', 'walk', 'idle'],
  fall: ['fall', 'jump', 'walk', 'idle'],
  walk: ['walk', 'idle'],
  idle: ['idle']
};
const ROOT_MOTION_TARGETS = ['hips', 'armature', 'root'];
/** The desktop idle's sway bones; IDLE_SWAY_HOLD_SEC: how long the sway takes to ease out (and back in) around a reach. */
const SWAY_BONES = ['spine', 'chest', 'upperChest', 'neck', 'head'] as const;
const IDLE_SWAY_HOLD_SEC = 0.25;
// A point's ray starts at the eye, and the stored link end is the mean of its hits: the sway must not move it.
const IDLE_SWAY_AIM_SEC = 0.05;
const smoothShare = (t: number) => t * t * (3 - 2 * t);
const LOWER_BODY_TARGETS = ['hips', 'leftupleg', 'leftleg', 'leftfoot', 'lefttoebase', 'rightupleg', 'rightleg', 'rightfoot', 'righttoebase'];
const LOWER_BODY_BONES: readonly VrmHumanoidBone[] = [
  'hips', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes'
];
// Without a measured gait (no humanoid), the old clip-agnostic rate.
const WALK_TIME_SCALE_BASE = 1.4;
const WALK_TIME_SCALE_MIN = 0.15;
const WALK_TIME_SCALE_MAX = 3;
/**
 * The slowest the desktop walk plays while the body is held back (shuffling along a rock, or pushing uphill). People held back keep
 * most of their cadence and shorten their steps; slowing the clip alone would hang each leg mid-swing for seconds.
 * Below this rate the stride shortens instead, so the planted foot still stays put. A free walk speeds up and
 * slows down on the clip's own rate, as before: a floor there quickens the first and last steps into pops.
 */
const WALK_CADENCE_FLOOR = 0.55;
/** A walk is held back once it has run this long (s) below HELD_BACK_SHARE of its intended speed. */
const HELD_BACK_SEC = 0.25;
const HELD_BACK_SHARE = 0.6;
/** The shortest stride, as a share of the full one, laid down at the cadence floor. */
const WALK_STRIDE_SHARE_MIN = 0.2;
const GAIT_SAMPLES = WALK_TRAJECTORY_SAMPLES;
const HIPS_BOB_SIGMA_SEC = 0.04;
const WALK_LOOP_QUAT_MATCH_DOT = 0.99995;
/** A walk starts at this speed and ends below WALK_STATE_SPEED_THRESHOLD: a walk pushed against a rock creeps
 * around 0.1 m/s, and must settle into the idle (a person stands against a wall) rather than flicker between the two. */
const WALK_STATE_ENTER_SPEED = 0.2;
const WALK_STATE_SPEED_THRESHOLD = 0.12;
/** Time constant of the net travel velocity a rattling body's walk is chosen on (s). */
const NET_VELOCITY_SEC = 0.08;
/** A body whose step reversed within this long (s) is rattling against something: its walk follows the net travel. */
const RATTLE_SEC = 0.3;
const WALK_FADE_SEC = 0.08;
/** The desktop body is all clip: its walk eases in over most of a step, or the hips drop and the knees jump at the first frame. */
const DESKTOP_WALK_IN_SEC = 0.25;
/** A walk that starts from the rest pose (no idle clip) eases in this long, or the feet jump at the first frame. */
const WALK_IN_FROM_REST_SEC = DESKTOP_WALK_IN_SEC;
const WALK_ENTRY_TIME_OFFSET_SEC = 0.12;

/** Node key (leaf name, namespace and path trimmed, lowercased) and property of a track. */
function parseTrackName(trackName: string): { nodeName: string; property: 'position' | 'quaternion' | 'scale' } | undefined {
  const match = /^(.+)\.(position|quaternion|scale)$/.exec(trackName);
  if (!match) return undefined;
  const rawNodeName = match[1]!;
  const rawProperty = match[2]!;

  const pathLeaf = rawNodeName.split('/').pop() ?? rawNodeName;
  const bracketMatch = /\[([^[\]]+)\]/.exec(pathLeaf);
  const nodeLeaf = bracketMatch?.[1] ?? pathLeaf;
  const namespaceTrimmed = nodeLeaf.includes(':') ? nodeLeaf.slice(nodeLeaf.lastIndexOf(':') + 1) : nodeLeaf;
  const nodeName = namespaceTrimmed.toLowerCase();
  const property = rawProperty as 'position' | 'quaternion' | 'scale';
  return { nodeName, property };
}

export class LocomotionAnimator {
  private mixer: THREE.AnimationMixer | null = null;
  private lowerBodyNames: ReadonlySet<string> | undefined;
  private armNames: ReadonlySet<string> | undefined;
  private swayNames: ReadonlySet<string> | undefined;
  /** The desktop idle's upper-body sway (spine to head), layered on the idle while it plays; none without an idle clip. */
  private sway: THREE.AnimationAction | undefined;
  /** 1 while the body may sway, easing to 0 while it is held still. */
  private swayShare = 1;
  private rootMotionNames: ReadonlySet<string> | undefined;
  private readonly actionsByProfile: Record<LocomotionProfile, Partial<Record<LocomotionState, THREE.AnimationAction>>> = {
    'desktop-full': {},
    'vr-lower-body': {}
  };
  private state: LocomotionState = 'idle';
  private lastPosition: { x: number; z: number } | undefined;
  private readonly netVelocity = { x: 0, z: 0 };
  private readonly lastStep = { x: 0, z: 0 };
  private rattleSec = Infinity;
  /** How long the walk has run well below its intended speed (s). */
  private heldBackSec = 0;
  private activeProfile: LocomotionProfile = 'desktop-full';
  private activeAction: THREE.AnimationAction | null = null;
  private currentTimeScale = 1;
  private strideShare = 1;
  /** How much longer than the clip's own the walk's stride is laid for this avatar (see WALK_CADENCE_MAX_STEPS_PER_MIN). */
  private strideScale = WALK_STRIDE_SCALE;
  private readonly tmpScale = new THREE.Vector3();
  private clipSources: Record<LocomotionState, LocomotionClipSource> = { idle: 'none', walk: 'none', jump: 'none', fall: 'none' };
  private root: THREE.Object3D | undefined;
  private gait: WalkGait | undefined;
  private walkTrajectory: WalkTrajectory | undefined;
  /** The one-shot Leap (a recorded jump) bound to this avatar, whose arms the desktop jump follows (JumpArms). */
  private leap: THREE.AnimationClip | undefined;
  /** The desktop walk's directional plays (the walk first); empty without directional clips. */
  private directions: DirectionalPlay[] = [];
  /** The play whose footfalls the leg solver follows (the heaviest, with hysteresis). */
  private lead: DirectionalPlay | undefined;
  /** The shared walk phase (0..1) of the directional plays, the walk's own clip phase. */
  private phase = 0;
  private walkRate = 1;
  private walkFade = 0;
  private walkWasActive = false;
  private blendStrideScale = 1;
  private blendCycleSec = 1;
  private blendStanceSpeed = 0;
  private readonly clipTravel = { forward: 1, left: 0 };
  private readonly gaitState: MutableGaitState = { gait: { stance: { left: { land: 0, lift: 0 }, right: { land: 0, lift: 0 } }, stanceSpeed: 0 }, walking: false, phase: 0, stride: 1, clipForward: 1, clipLeft: 0 };

  /**
   * The avatar plays its own clips when it has a usable Idle and Walk (a clip
   * of that name with a rotation track on one of this rig's canonical bones);
   * otherwise it plays the library's for every state. Never a mix: the
   * library's clips carry the T-pose correction, so mixing would make the
   * arms pop between states.
   */
  static usesOwnClips(clips: readonly THREE.AnimationClip[], humanoid?: HumanoidSkeleton): boolean {
    return LocomotionAnimator.ownClip(clips, 'idle', humanoid) !== undefined && LocomotionAnimator.ownClip(clips, 'walk', humanoid) !== undefined;
  }

  private static ownClip(clips: readonly THREE.AnimationClip[], state: LocomotionState, humanoid?: HumanoidSkeleton): THREE.AnimationClip | undefined {
    return clips.find((clip) => CLIP_MATCHERS[state].test(clip.name) && !isDirectionalClip(clip.name) && LocomotionAnimator.turnsBones(clip, humanoid));
  }

  /** Whether a clip rotates one of this rig's canonical bones (any clip, without a humanoid). */
  private static turnsBones(clip: THREE.AnimationClip, humanoid?: HumanoidSkeleton): boolean {
    if (!humanoid) return true;
    const canonical = LocomotionAnimator.boneKeys(humanoid, VRM_HUMANOID_BONES);
    return clip.tracks.some((track) => {
      const parts = parseTrackName(track.name);
      return parts?.property === 'quaternion' && canonical.has(parts.nodeName);
    });
  }

  /** Track node keys of these bones: the rig's own (lowercased) names, and the uuids retargeted tracks bind by. */
  private static boneKeys(humanoid: HumanoidSkeleton, bones: readonly VrmHumanoidBone[]): Set<string> {
    return new Set(bones.flatMap((b) => { const bone = humanoid.bone(b); return bone ? [bone.name.toLowerCase(), bone.uuid.toLowerCase()] : []; }));
  }

  /** Rebinds tracks named for a canonical bone to its uuid, so a prop with the same name cannot take them. */
  private static bindToBones(clip: THREE.AnimationClip, humanoid: HumanoidSkeleton): THREE.AnimationClip {
    const byName = new Map(VRM_HUMANOID_BONES.flatMap((b) => { const bone = humanoid.bone(b); return bone ? [[bone.name.toLowerCase(), bone.uuid] as const] : []; }));
    const tracks = clip.tracks.map((track) => {
      const parts = parseTrackName(track.name);
      const uuid = parts && byName.get(parts.nodeName);
      if (!parts || !uuid) return track;
      const rebound = track.clone();
      rebound.name = `${uuid}.${parts.property}`;
      return rebound;
    });
    const out = new THREE.AnimationClip(clip.name, clip.duration, tracks);
    out.blendMode = clip.blendMode;
    return out;
  }

  /**
   * With the avatar's humanoid skeleton, tracks are kept by canonical bone
   * (the rig's own hips and leg bones); without it, by the shipped rig's name
   * suffixes. `retargeted` (the library's clips on this rig) play when the
   * avatar's own do not qualify (`usesOwnClips`).
   */
  attachClips(root: THREE.Object3D, ownClips: THREE.AnimationClip[], humanoid?: HumanoidSkeleton, retargeted: readonly THREE.AnimationClip[] = []): void {
    this.lowerBodyNames = undefined;
    this.armNames = undefined;
    this.swayNames = undefined;
    this.sway = undefined;
    this.swayShare = 1;
    this.rootMotionNames = undefined;
    if (humanoid) {
      this.lowerBodyNames = LocomotionAnimator.boneKeys(humanoid, LOWER_BODY_BONES);
      this.armNames = LocomotionAnimator.boneKeys(humanoid, VRM_HUMANOID_BONES.filter((b) => /Shoulder|Arm|Hand|Thumb|Index|Middle|Ring|Little/.test(b)));
      this.rootMotionNames = new Set([...LocomotionAnimator.boneKeys(humanoid, ['hips']), 'armature', 'root']);
      this.swayNames = LocomotionAnimator.boneKeys(humanoid, SWAY_BONES);
    }
    const own = !humanoid || LocomotionAnimator.usesOwnClips(ownClips, humanoid);
    // A clip that moves only a prop must not win a state from the body clip that qualified.
    const clips = own
      ? (humanoid ? ownClips.filter((clip) => LocomotionAnimator.turnsBones(clip, humanoid)).map((clip) => LocomotionAnimator.bindToBones(clip, humanoid)) : ownClips)
      : [...retargeted];
    this.mixer?.stopAllAction();
    this.mixer = new THREE.AnimationMixer(root);
    this.activeAction = null;
    this.actionsByProfile['desktop-full'] = {};
    this.actionsByProfile['vr-lower-body'] = {};

    const desktopClips = clips
      .map((clip) => this.preprocessClip(clip, 'desktop-full'))
      .filter((clip): clip is THREE.AnimationClip => Boolean(clip));
    const vrClips = clips
      .map((clip) => this.preprocessClip(clip, 'vr-lower-body'))
      .filter((clip): clip is THREE.AnimationClip => Boolean(clip));

    this.root = root;
    const walkClip = this.resolveClip(desktopClips, 'walk');
    this.gait = undefined;
    this.walkTrajectory = undefined;
    if (humanoid && walkClip && CLIP_MATCHERS.walk.test(walkClip.name)) {
      // A walk without its hips' rise and fall (root motion stripped, or retargeted as rotations) keeps the
      // hips at standing height, where a straight leg cannot reach a planted foot: put the bob back from the feet.
      const bobbed = LocomotionAnimator.withHipsBob(root, walkClip, humanoid);
      if (bobbed) desktopClips.splice(desktopClips.indexOf(walkClip), 1, bobbed);
      const measured = LocomotionAnimator.measureGait(root, bobbed ?? walkClip, humanoid);
      this.gait = measured?.gait;
      this.walkTrajectory = measured?.trajectory;
    }
    this.bindProfileActions('desktop-full', desktopClips);
    this.bindProfileActions('vr-lower-body', vrClips);
    this.bindDirections(root, desktopClips, humanoid);
    // An avatar's own idle sways as its author made it; the house avatar's own idle is the library's scaled take.
    this.bindSway(clips);
    // Leap plays in no state; an avatar with its own clips still gets the library's (retargeted) one.
    this.leap = clips.find((clip) => /^leap$/i.test(clip.name)) ?? retargeted.find((clip) => /^leap$/i.test(clip.name));
    for (const state of LOCOMOTION_STATES) {
      this.clipSources[state] = this.resolveClip(clips, state) ? (own ? 'own' : 'retargeted') : 'none';
    }
    this.playState(this.state, this.activeProfile, 0);
  }

  update(input: LocomotionUpdateInput): void {
    this.fitStrideScale(input.referenceSpeed);
    const nextProfile: LocomotionProfile = input.vrMode ? 'vr-lower-body' : 'desktop-full';
    const travel = Math.min(input.horizontalSpeed, this.netSpeed(input.position, input.deltaSec) ?? input.horizontalSpeed);
    const nextState = this.resolveState(input.grounded, input.velocityY, travel);
    const fadeSec =
      nextState === 'jump' || nextState === 'fall'
          ? 0.1
          : nextState === 'walk'
            ? nextProfile === 'desktop-full' ? DESKTOP_WALK_IN_SEC : WALK_FADE_SEC
            : 0.18;
    this.playState(nextState, nextProfile, fadeSec);
    const directional = this.directions.length > 0;
    if (directional) this.playDirections(input);
    this.applyPlaybackSpeedCalibration(input);
    if (directional) this.stepDirections(input.deltaSec);
    this.playSway(input);

    if (this.mixer) {
      this.mixer.update(input.deltaSec);
    }
    if (directional) this.readWalkFade();
  }

  /**
   * The desktop idle's sway: its spine, chest, neck and head keys, played as their own action. Not its hips or legs
   * (they stand on the terrain IK) and not its arms (held at the first key). The builder already scales the take's
   * sway (`sway` in scripts/build-mocap-clips.ts), so it plays at full weight here.
   */
  private bindSway(clips: readonly THREE.AnimationClip[]): void {
    const idle = this.resolveClip(clips, 'idle');
    if (!this.mixer || !idle || !CLIP_MATCHERS.idle.test(idle.name)) return;
    const tracks = idle.tracks
      .filter((track) => {
        const parts = parseTrackName(track.name);
        return parts?.property === 'quaternion' && this.isSwayTarget(parts.nodeName);
      })
      .map((track) => track.clone());
    if (tracks.length === 0) return;
    const clip = new THREE.AnimationClip(`${idle.name}Sway`, -1, tracks);
    clip.resetDuration();
    if (!(clip.duration > 0)) return;
    this.sway = this.mixer.clipAction(clip);
    this.sway.setLoop(THREE.LoopRepeat, Infinity);
    this.sway.enabled = true;
    this.sway.weight = 0;
    this.sway.play();
  }

  /** The sway follows the desktop idle's weight, eased out while a point, aim, carry or reach holds the body still. */
  private playSway(input: LocomotionUpdateInput): void {
    const sway = this.sway;
    if (!sway) return;
    const dt = Math.max(0, input.deltaSec);
    const change = input.holdStill ? -dt / (input.aimHeld ? IDLE_SWAY_AIM_SEC : IDLE_SWAY_HOLD_SEC) : dt / IDLE_SWAY_HOLD_SEC;
    this.swayShare = THREE.MathUtils.clamp(this.swayShare + change, 0, 1);
    const idle = this.actionsByProfile['desktop-full'].idle;
    const idleWeight = this.activeProfile === 'desktop-full' && idle?.isScheduled() ? idle.getEffectiveWeight() : 0;
    sway.weight = idleWeight * smoothShare(this.swayShare);
  }

  /** How much of the idle's sway plays (0..1), for the motion checks. */
  getSwayWeight(): number { return this.sway?.weight ?? 0; }

  /**
   * The desktop walk's directional and crouch clips, each with its hips bob and its own gait measured along its travel,
   * phased so their left footfalls fall on the walk's. None without a measured walk gait.
   */
  private bindDirections(root: THREE.Object3D, desktopClips: readonly THREE.AnimationClip[], humanoid: HumanoidSkeleton | undefined): void {
    this.directions = [];
    this.lead = undefined;
    const walk = this.actionsByProfile['desktop-full'].walk;
    if (!this.mixer || !humanoid || !this.gait || !walk) return;
    const walkDuration = walk.getClip().duration;
    const walkPlay: DirectionalPlay = { direction: 'walk', action: walk, gait: this.gait, duration: walkDuration, forward: 1, left: 0, strideScaled: true, offset: 0, weight: 1 };
    const plays: DirectionalPlay[] = [walkPlay];
    for (const [direction, spec] of Object.entries(DIRECTIONAL_CLIPS) as Array<[Exclude<Direction, 'walk'>, { name: string; travel: GaitTravel }]>) {
      const clip = desktopClips.find((c) => c.name.toLowerCase() === spec.name);
      if (!clip || !(clip.duration > 0)) continue;
      const bobbed = LocomotionAnimator.withHipsBob(root, clip, humanoid) ?? clip;
      const gait = LocomotionAnimator.measureGait(root, bobbed, humanoid, spec.travel)?.gait;
      if (!gait) continue;
      const action = this.mixer.clipAction(bobbed);
      action.enabled = true;
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.setEffectiveTimeScale(0);
      action.weight = 0;
      const vector = TRAVEL_VECTORS[spec.travel];
      const offset = (((gait.stance.left.land - this.gait.stance.left.land) % 1) + 1) % 1;
      plays.push({ direction, action, gait, duration: clip.duration, forward: vector.forward, left: vector.left, strideScaled: spec.travel === 'forward', offset, weight: 0 });
    }
    if (plays.length > 1) {
      this.directions = plays;
      this.lead = walkPlay;
    }
  }

  /** This frame's target weight of each directional clip, from the body-frame travel and the crouch; a missing clip's goes to the walk. */
  private directionTarget(direction: Direction, travelLocalYaw: number | null, crouch: number): number {
    const yaw = travelLocalYaw ?? 0;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const sum = Math.abs(cos) + Math.abs(sin) || 1;
    const f = Math.max(0, cos) / sum, b = Math.max(0, -cos) / sum, l = Math.max(0, sin) / sum, r = Math.max(0, -sin) / sum;
    const c = THREE.MathUtils.clamp(crouch, 0, 1);
    switch (direction) {
      case 'walk': return f * (1 - c);
      case 'crouch': return f * c;
      case 'back': return b * (1 - c);
      case 'crouchBack': return b * c;
      case 'left': return l;
      case 'right': return r;
    }
  }

  /**
   * Weights and plays the directional clips on one shared phase: the phase advances by the travel over the blended
   * cycle's ground length (each clip's stance speed times its length), so a blend of clips of different lengths keeps
   * the planted foot still. The walk action keeps its fades; the others follow its fade.
   */
  private playDirections(input: LocomotionUpdateInput): void {
    const walk = this.directions[0]!;
    const desktop = this.activeProfile === 'desktop-full';
    const walking = desktop && this.state === 'walk' && this.activeAction === walk.action;
    // Entering the walk starts the phase where the walk's entry put its clip.
    if (walking && !this.walkWasActive) this.phase = walk.action.time / walk.duration;
    this.walkWasActive = walking;
    const yaw = input.travelLocalYaw ?? null;
    const k = 1 - Math.exp(-Math.max(0, input.deltaSec) / DIRECTION_EASE_SEC);
    let total = 0;
    for (const play of this.directions) {
      let target = this.directionTarget(play.direction, yaw, input.crouch ?? 0);
      if (play.direction === 'walk') {
        // A missing clip's share plays on the walk (its stride turned toward travel, as before).
        for (const d of ['back', 'left', 'right', 'crouch', 'crouchBack'] as const) {
          if (!this.directions.some((p) => p.direction === d)) target += this.directionTarget(d, yaw, input.crouch ?? 0);
        }
      }
      // The first walking frame takes the weights at once: no forward stride before a backward walk. A walk that is
      // coming to a stop (no key held, or fading out to the idle) keeps its blend: the travel it still has can read
      // another way (the view changed as the keys let go), and a new blend there turns the arms in a frame or two.
      if (this.walkFade > 0.01) {
        if (walking && input.moveIntent) play.weight += (target - play.weight) * k;
      } else play.weight = target;
      total += play.weight;
    }
    // All weights are normalised before the lead is picked: a lead still at its raw weight would compare unfairly.
    for (const play of this.directions) play.weight /= total || 1;
    let lead = this.lead ?? walk;
    let forward = 0, left = 0, scale = 0, cycle = 0, ground = 0;
    for (const play of this.directions) {
      if (play.weight > lead.weight + LEAD_HYSTERESIS) lead = play;
      forward += play.weight * play.forward;
      left += play.weight * play.left;
      const strideScale = play.strideScaled ? this.strideScale : 1;
      scale += play.weight * strideScale;
      cycle += play.weight * play.duration;
      ground += play.weight * play.gait.stanceSpeed * strideScale * play.duration;
    }
    this.lead = lead;
    const length = Math.hypot(forward, left);
    this.clipTravel.forward = length > 0.2 ? forward / length : lead.forward;
    this.clipTravel.left = length > 0.2 ? left / length : lead.left;
    this.blendStrideScale = scale;
    this.blendCycleSec = cycle;
    this.blendStanceSpeed = cycle > 0 ? ground / cycle : walk.gait.stanceSpeed;
    // The walk action's own fade (crossfades from and to the idle) carries the whole blend.
    walk.action.weight = Math.max(1e-3, walk.weight);
    for (const play of this.directions) {
      if (play !== walk) {
        if (!play.action.isScheduled()) play.action.play();
        play.action.weight = desktop ? play.weight * this.walkFade : 0;
      }
    }
  }

  /** After the mixer's fades: how far the walk is faded in, for the other directional clips to follow next frame. */
  private readWalkFade(): void {
    const walk = this.directions[0]?.action;
    this.walkFade = walk && walk.enabled && walk.isScheduled() && this.activeProfile === 'desktop-full' ? THREE.MathUtils.clamp(walk.getEffectiveWeight() / Math.max(1e-3, walk.weight), 0, 1) : 0;
  }

  /** Sets every directional clip to its time on the shared phase (they play at time scale 0). */
  private stepDirections(deltaSec: number): void {
    if (this.walkFade > 0 || this.walkWasActive) this.phase = (this.phase + (this.walkRate * Math.max(0, deltaSec)) / Math.max(1e-3, this.blendCycleSec)) % 1;
    for (const play of this.directions) {
      play.action.setEffectiveTimeScale(0);
      play.action.time = (((this.phase + play.offset) % 1) * play.duration);
    }
  }

  /** How much of the body the crouch walk clips crouch this frame (0..1): the crouch pose leaves that much to them. */
  getClipCrouch(): number {
    let crouch = 0;
    for (const play of this.directions) if (play.direction === 'crouch' || play.direction === 'crouchBack') crouch += play.weight;
    return crouch * this.walkFade;
  }

  /** The directional clips' weights this frame (automation). */
  getDirectionWeights(): Partial<Record<Direction, number>> {
    return Object.fromEntries(this.directions.map((p) => [p.direction, Math.round(p.weight * this.walkFade * 1000) / 1000]));
  }

  getState(): LocomotionState {
    return this.state;
  }

  getActiveProfile(): LocomotionProfile {
    return this.activeProfile;
  }

  getClipSnapshot(): { name: string; time: number; duration: number } | null {
    if (!this.activeAction) return null;
    const clip = this.activeAction.getClip();
    return { name: clip.name, time: this.activeAction.time, duration: clip.duration };
  }

  /**
   * Automation: shows one state's clip at a clip time, on one profile, with
   * nothing blended in (rest where the profile has no clip for the state).
   * Read the pose before the next simulation step overwrites it.
   */
  poseForCheck(state: LocomotionState, profile: LocomotionProfile, timeSec: number): string | null {
    if (!this.mixer) return null;
    this.mixer.stopAllAction();
    const action = this.actionsByProfile[profile][state] ?? null;
    this.state = state;
    this.activeProfile = profile;
    this.activeAction = action;
    if (!action) return null;
    action.reset().setEffectiveWeight(1).setEffectiveTimeScale(1).play();
    action.time = timeSec;
    this.mixer.update(0);
    return action.getClip().name;
  }

  getClipSources(): Readonly<Record<LocomotionState, LocomotionClipSource>> {
    return this.clipSources;
  }

  getCurrentTimeScale(): number {
    return this.currentTimeScale;
  }

  getLeap(): THREE.AnimationClip | undefined {
    return this.leap;
  }

  getGait(): WalkGait | undefined {
    return this.gait;
  }

  /** The walk clip's measured step shape, for any profile (the VR body solver's steps); undefined without a measured gait. */
  getWalkTrajectory(): WalkTrajectory | undefined {
    return this.walkTrajectory;
  }

  /** Lays this avatar's stride longer when its own stride would step faster than the cadence limit at the walk speed. */
  private fitStrideScale(referenceSpeed: number | undefined): void {
    const duration = this.actionsByProfile['desktop-full'].walk?.getClip().duration ?? 0;
    if (!this.gait || !this.root || !referenceSpeed || !(duration > 0)) return;
    const ownStanceSpeed = this.gait.stanceSpeed * Math.abs(this.root.getWorldScale(this.tmpScale).z);
    if (!(ownStanceSpeed > 1e-4)) return;
    const ownCadence = (120 / duration) * (referenceSpeed / ownStanceSpeed);
    this.strideScale = THREE.MathUtils.clamp((WALK_STRIDE_SCALE * ownCadence) / WALK_CADENCE_MAX_STEPS_PER_MIN, WALK_STRIDE_SCALE, WALK_STRIDE_SCALE_MAX);
  }

  /** The walk's footfall phase this frame, for the leg solver's planted feet; undefined without a measured gait. */
  getGaitState(): GaitState | undefined {
    // The gait is measured on the desktop clip; the VR clips keep their own speed-scaled cadence (gap 3).
    if (!this.gait || this.activeProfile !== 'desktop-full') return undefined;
    const walk = this.actionsByProfile[this.activeProfile].walk;
    const out = this.gaitState;
    out.walking = this.state === 'walk' && walk !== undefined && this.activeAction === walk;
    const lead = this.lead;
    if (lead) {
      // The heaviest clip's footfalls on its own phase; the feet turn from the blend's travel.
      out.gait = lead.gait;
      out.phase = (this.phase + lead.offset) % 1;
      out.stride = this.blendStrideScale * this.strideShare;
      out.clipForward = this.clipTravel.forward;
      out.clipLeft = this.clipTravel.left;
      return out;
    }
    const duration = walk?.getClip().duration ?? 0;
    out.gait = this.gait;
    out.phase = walk && duration > 0 ? (((walk.time / duration) % 1) + 1) % 1 : 0;
    out.stride = this.strideScale * this.strideShare;
    out.clipForward = 1;
    out.clipLeft = 0;
    return out;
  }

  /** The planted foot's speed at time scale 1, in world metres per second (the avatar's scale applied). */
  stanceSpeedWorld(): number | undefined {
    if (!this.gait || !this.root || this.activeProfile !== 'desktop-full') return undefined;
    const scale = Math.abs(this.root.getWorldScale(this.tmpScale).z);
    // With directional clips, the blend's stance speed (each clip's own, by its weight and cycle) sets the cadence.
    return (this.directions.length > 0 ? this.blendStanceSpeed : this.gait.stanceSpeed * this.strideScale) * scale;
  }

  /**
   * The walk with a hips height track rebuilt from its feet: at each moment the
   * lower foot stands on the ground, so the hips drop by as much as that foot
   * would float above it. Undefined when the clip already moves the hips or
   * the rig cannot be measured.
   */
  private static withHipsBob(root: THREE.Object3D, clip: THREE.AnimationClip, humanoid: HumanoidSkeleton): THREE.AnimationClip | undefined {
    const hips = humanoid.bone('hips');
    if (!hips?.parent) return undefined;
    if (clip.tracks.some((track) => track.name.endsWith('.position') && root.getObjectByName(track.name.slice(0, track.name.lastIndexOf('.'))) === hips)) return undefined;
    const measured = LocomotionAnimator.measureGait(root, clip, humanoid);
    if (!measured) return undefined;
    const { soles, restSole } = measured;
    const n = soles.length;
    // Smoothed (circular Gaussian, σ HIPS_BOB_SIGMA_SEC): the lower sole switches feet at each
    // footfall, a corner a person's pelvis rounds off, and a foot's roll from heel to toe must not shake the body.
    const sigma = Math.max(1, (HIPS_BOB_SIGMA_SEC / clip.duration) * n);
    const reach = Math.ceil(sigma * 3);
    const weights = Array.from({ length: 2 * reach + 1 }, (_, k) => Math.exp(-(((k - reach) / sigma) ** 2) / 2));
    const total = weights.reduce((a, b) => a + b, 0);
    const drop = soles.map((_, i) => weights.reduce((sum, w, k) => sum + w * (soles[(((i + k - reach) % n) + n) % n]! - restSole), 0) / total);
    root.updateWorldMatrix(true, true);
    const parentQuat = hips.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    const parentScale = Math.abs(hips.parent.getWorldScale(new THREE.Vector3()).y) || 1;
    const upInParent = new THREE.Vector3(0, 1, 0).applyQuaternion(parentQuat).divideScalar(parentScale);
    const times: number[] = [];
    const values: number[] = [];
    for (let i = 0; i <= n; i++) {
      times.push((i / n) * clip.duration);
      const at = hips.position.clone().addScaledVector(upInParent, -drop[i % n]!);
      values.push(at.x, at.y, at.z);
    }
    const bobbed = clip.clone();
    bobbed.tracks.push(new THREE.VectorKeyframeTrack(`${hips.uuid}.position`, times, values));
    return bobbed;
  }

  /**
   * Plays the walk clip on the avatar and reads its feet by forward
   * kinematics: when each foot is planted (lowest, moving backwards) and how
   * fast it moves then. The pose is restored afterwards.
   */
  private static measureGait(root: THREE.Object3D, clip: THREE.AnimationClip, humanoid: HumanoidSkeleton, travel: GaitTravel = 'forward'): { gait: WalkGait | undefined; soles: number[]; restSole: number; trajectory?: WalkTrajectory | undefined } | undefined {
    const feet = { left: humanoid.bone('leftFoot'), right: humanoid.bone('rightFoot') };
    const toes = { left: humanoid.bone('leftToes'), right: humanoid.bone('rightToes') };
    const hips = humanoid.bone('hips');
    if (!feet.left || !feet.right || !hips || !(clip.duration > 0)) return undefined;
    const saved: Array<[THREE.Object3D, THREE.Vector3, THREE.Quaternion, THREE.Vector3]> = [];
    root.traverse((node) => saved.push([node, node.position.clone(), node.quaternion.clone(), node.scale.clone()]));
    root.updateWorldMatrix(true, true);
    const rootY = root.getWorldPosition(new THREE.Vector3()).y;
    const soleOf = (side: GaitLeg) => Math.min(feet[side]!.getWorldPosition(new THREE.Vector3()).y, toes[side]?.getWorldPosition(new THREE.Vector3()).y ?? Infinity) - rootY;
    const restSole = Math.min(soleOf('left'), soleOf('right'));
    const restForward = new THREE.Vector3();
    for (const side of ['left', 'right'] as const) {
      if (toes[side]) restForward.add(toes[side]!.getWorldPosition(new THREE.Vector3()).sub(feet[side]!.getWorldPosition(new THREE.Vector3())));
    }
    if (restForward.x ** 2 + restForward.z ** 2 < 1e-10) return undefined;
    // The way the clip travels at rest: a planted foot slides opposite to it under the in-place clip.
    const upperLegs = { left: humanoid.bone('leftUpperLeg'), right: humanoid.bone('rightUpperLeg') };
    const restLeft = upperLegs.left && upperLegs.right
      ? upperLegs.left.getWorldPosition(new THREE.Vector3()).sub(upperLegs.right.getWorldPosition(new THREE.Vector3()))
      : new THREE.Vector3(restForward.z, 0, -restForward.x);
    const travelDirection = travel === 'forward' ? restForward.clone() : travel === 'back' ? restForward.clone().negate() : travel === 'left' ? restLeft : restLeft.clone().negate();
    const pitchOf = (side: GaitLeg) => {
      const toe = toes[side];
      if (!toe) return 0;
      const d = toe.getWorldPosition(new THREE.Vector3()).sub(feet[side]!.getWorldPosition(new THREE.Vector3()));
      return Math.atan2(d.y, Math.hypot(d.x, d.z));
    };
    const restPitch = { left: pitchOf('left'), right: pitchOf('right') };
    const restHips = hips.getWorldPosition(new THREE.Vector3()).y - rootY - restSole;
    const rootAt = root.getWorldPosition(new THREE.Vector3());
    const mixer = new THREE.AnimationMixer(root);
    const action = mixer.clipAction(clip);
    action.play();
    const local = new THREE.Vector3();
    const track: Record<GaitLeg, Array<{ x: number; z: number; sole: number; rx: number; rz: number; pitch: number }>> = { left: [], right: [] };
    const hipsYs: number[] = [];
    let hipsHeight = 0;
    try {
      for (let i = 0; i < GAIT_SAMPLES; i++) {
        action.time = (i / GAIT_SAMPLES) * clip.duration;
        mixer.update(0);
        root.updateWorldMatrix(true, true);
        // World space relative to the hips: the rig's own axes need not be the avatar's.
        const hip = hips.getWorldPosition(local);
        hipsHeight += (hip.y - root.getWorldPosition(new THREE.Vector3()).y) / GAIT_SAMPLES;
        hipsYs.push(hip.y - rootY);
        for (const side of ['left', 'right'] as const) {
          const ankle = feet[side]!.getWorldPosition(new THREE.Vector3());
          const toe = toes[side] ? toes[side]!.getWorldPosition(new THREE.Vector3()) : ankle;
          track[side].push({
            x: ankle.x - hip.x, z: ankle.z - hip.z, sole: Math.min(ankle.y, toe.y) - rootY,
            rx: ankle.x - rootAt.x, rz: ankle.z - rootAt.z, pitch: restPitch[side] - pitchOf(side)
          });
        }
      }
    } finally {
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
      for (const [node, position, quaternion, scale] of saved) {
        node.position.copy(position);
        node.quaternion.copy(quaternion);
        node.scale.copy(scale);
      }
      root.updateWorldMatrix(true, true);
    }
    const soles = track.left.map((p, i) => Math.min(p.sole, track.right[i]!.sole));
    const result = (gait: WalkGait | undefined) => ({ gait, soles, restSole });
    const dt = clip.duration / GAIT_SAMPLES;
    const tolerance = Math.abs(hipsHeight) * 0.03;
    // The stride runs along the feet's main horizontal axis (principal component of their swing). Each foot is
    // centred on its own mean: pooled, the gap between the feet outweighs a short stride (the back walk's) and the
    // axis turns sideways.
    let xx = 0, xz = 0, zz = 0;
    for (const side of ['left', 'right'] as const) {
      const points = track[side];
      let mx = 0, mz = 0;
      for (const p of points) { mx += p.x / points.length; mz += p.z / points.length; }
      for (const p of points) { xx += (p.x - mx) ** 2; xz += (p.x - mx) * (p.z - mz); zz += (p.z - mz) ** 2; }
    }
    const angle = 0.5 * Math.atan2(2 * xz, xx - zz);
    const axis = { x: Math.cos(angle), z: Math.sin(angle) };
    // Oriented along the clip's travel (for the walk, the way the toes point at rest): a planted foot slides back along it under an in-place clip.
    const along = (side: GaitLeg) => track[side].map((p) => p.x * axis.x + p.z * axis.z);
    const sign = travelDirection.x * axis.x + travelDirection.z * axis.z < 0 ? -1 : 1;
    const stance = {} as Record<GaitLeg, { land: number; lift: number }>;
    const speeds: number[] = [];
    for (const side of ['left', 'right'] as const) {
      const samples = track[side];
      const forward = along(side).map((value) => value * sign);
      const n = samples.length;
      const lowest = Math.min(...samples.map((s) => s.sole));
      // Forward speed over a centred difference; planted = near the lowest and moving backwards.
      const velocity = forward.map((_, i) => (forward[(i + 1) % n]! - forward[(i - 1 + n) % n]!) / (2 * dt));
      const planted = samples.map((s, i) => s.sole <= lowest + tolerance && velocity[i]! < 0);
      // The longest circular run of planted samples is the stance.
      let best = { start: -1, length: 0 };
      for (let start = 0; start < n; start++) {
        if (!planted[start] || planted[(start - 1 + n) % n]) continue;
        let length = 0;
        while (length < n && planted[(start + length) % n]) length++;
        if (length > best.length) best = { start, length };
      }
      if (best.start < 0 || best.length >= n || best.length < 3) return result(undefined);
      stance[side] = { land: best.start / n, lift: ((best.start + best.length) / n) % 1 };
      for (let k = 0; k < best.length; k++) speeds.push(-velocity[(best.start + k) % n]!);
    }
    // The mean over the stance: how far a planted foot travels back, over how long it is down.
    const stanceSpeed = speeds.reduce((sum, v) => sum + v, 0) / Math.max(1, speeds.length);
    // Kept in the root's own units, so a later rescale of the avatar still reads true.
    const scale = Math.abs(root.getWorldScale(new THREE.Vector3()).z) || 1;
    if (!(stanceSpeed > 1e-4)) return result(undefined);
    const gait: WalkGait = { stance, stanceSpeed: stanceSpeed / scale };
    const trajectory = restHips > 1e-4 && travel === 'forward' ? LocomotionAnimator.buildTrajectory(gait, clip.duration, track, hipsYs, axis, sign, restHips) : undefined;
    return { ...result(gait), trajectory };
  }

  /**
   * The step shape relative to the ground-projected root (not the swaying hips), in rest hips heights. A swing's
   * progress is the foot's ground travel as the body would carry it at the clip's stance speed: its offset along the
   * stride plus the travel since lift-off, normalised from lift-off to landing.
   */
  private static buildTrajectory(
    gait: WalkGait, duration: number,
    track: Record<GaitLeg, Array<{ sole: number; rx: number; rz: number; pitch: number }>>,
    hipsYs: number[], axis: { x: number; z: number }, sign: number, restHips: number
  ): WalkTrajectory | undefined {
    const n = hipsYs.length;
    const dt = duration / n;
    const legs = {} as Record<GaitLeg, { progress: Float32Array; clearance: Float32Array; roll: Float32Array }>;
    const forwardOf = (side: GaitLeg) => track[side].map((p) => (p.rx * axis.x + p.rz * axis.z) * sign);
    // Stance speed from the root: a planted foot slides back past it at this speed in the in-place clip.
    let speedSum = 0;
    let speedCount = 0;
    for (const side of ['left', 'right'] as const) {
      const forward = forwardOf(side);
      for (let i = 0; i < n; i++) {
        if (!inStance(gait, side, i / n)) continue;
        speedSum += -(forward[(i + 1) % n]! - forward[(i - 1 + n) % n]!) / (2 * dt);
        speedCount++;
      }
    }
    const stanceSpeed = speedSum / Math.max(1, speedCount);
    if (!(stanceSpeed > 1e-4)) return undefined;
    for (const side of ['left', 'right'] as const) {
      const samples = track[side];
      const forward = forwardOf(side);
      const { land, lift } = gait.stance[side];
      const swingLength = (land - lift + 1) % 1 || 1;
      const planted = Math.min(...samples.map((p) => p.sole));
      const progress = new Float32Array(n);
      const liftIndex = Math.round(lift * n) % n;
      const swingSamples = Math.max(1, Math.round(swingLength * n));
      const worldAt = (k: number) => forward[(liftIndex + k) % n]! + stanceSpeed * k * dt;
      const span = worldAt(swingSamples) - worldAt(0);
      // Stance samples: 1 in the first half (just landed), 0 in the second (about to lift), so interpolation at either
      // end of the swing reads its own end.
      for (let i = 0; i < n; i++) {
        const since = (((i / n) - land + 1) % 1);
        progress[i] = since < (1 - swingLength) / 2 ? 1 : 0;
      }
      let best = 0;
      for (let k = 0; k <= swingSamples; k++) {
        const p = Math.abs(span) > 1e-6 ? (worldAt(k) - worldAt(0)) / span : k / swingSamples;
        best = Math.min(1, Math.max(best, p));
        progress[(liftIndex + k) % n] = k === swingSamples ? 1 : best;
      }
      legs[side] = {
        progress,
        clearance: Float32Array.from(samples, (p) => Math.max(0, p.sole - planted) / restHips),
        roll: Float32Array.from(samples, (p) => p.pitch)
      };
    }
    const top = Math.max(...hipsYs);
    return {
      gait, duration,
      stanceSpeed: stanceSpeed / restHips,
      legs,
      bob: smoothCircular(Float32Array.from(hipsYs, (y) => (y - top) / restHips), WALK_BOB_SMOOTH_SAMPLES)
    };
  }

  private resolveState(grounded: boolean, velocityY: number, horizontalSpeed: number): LocomotionState {
    if (!grounded) {
      return velocityY > 0.25 ? 'jump' : 'fall';
    }
    if (horizontalSpeed >= (this.state === 'walk' ? WALK_STATE_SPEED_THRESHOLD : WALK_STATE_ENTER_SPEED)) {
      return 'walk';
    }
    return 'idle';
  }

  /**
   * While the body rattles (a step reversed lately, as against a rock), the speed of its eased net travel;
   * otherwise, or without a position or across a teleport, undefined, so a walk starts and stops without lag.
   */
  private netSpeed(position: { x: number; z: number } | undefined, deltaSec: number): number | undefined {
    if (!position || deltaSec <= 0) return undefined;
    const last = this.lastPosition;
    this.lastPosition = { x: position.x, z: position.z };
    if (!last) return undefined;
    const vx = (position.x - last.x) / deltaSec;
    const vz = (position.z - last.z) / deltaSec;
    if (Math.hypot(vx, vz) * deltaSec > 1) {
      this.netVelocity.x = 0;
      this.netVelocity.z = 0;
      return undefined;
    }
    const k = 1 - Math.exp(-deltaSec / NET_VELOCITY_SEC);
    this.netVelocity.x += (vx - this.netVelocity.x) * k;
    this.netVelocity.z += (vz - this.netVelocity.z) * k;
    this.rattleSec = vx * this.lastStep.x + vz * this.lastStep.z < 0 ? 0 : this.rattleSec + deltaSec;
    this.lastStep.x = vx;
    this.lastStep.z = vz;
    return this.rattleSec < RATTLE_SEC ? Math.hypot(this.netVelocity.x, this.netVelocity.z) : undefined;
  }

  private playState(state: LocomotionState, profile: LocomotionProfile, fadeSec: number): void {
    const previousState = this.state;
    this.state = state;
    this.activeProfile = profile;
    const nextAction = this.resolveAction(profile, state);
    if (!nextAction) {
      if (this.activeAction) {
        if (fadeSec > 0) {
          this.activeAction.fadeOut(fadeSec);
        } else {
          this.activeAction.stop();
        }
      }
      this.activeAction = null;
      return;
    }

    if (this.activeAction === nextAction) {
      return;
    }

    if (!this.activeAction) {
      nextAction.reset().setEffectiveWeight(1).play();
      this.applyEntryOffsets(state, previousState, nextAction);
      // Without an idle clip the body stands in its rest pose (the VR legs never have one); ease out of it over most
      // of a step rather than snapping to the walk, on either profile.
      if (fadeSec > 0) nextAction.fadeIn(state === 'walk' ? Math.max(fadeSec, WALK_IN_FROM_REST_SEC) : fadeSec);
    } else if (fadeSec <= 0) {
      this.activeAction.stop();
      nextAction.reset().setEffectiveWeight(1).play();
      this.applyEntryOffsets(state, previousState, nextAction);
    } else {
      nextAction.reset().setEffectiveWeight(1).play();
      this.applyEntryOffsets(state, previousState, nextAction);
      nextAction.crossFadeFrom(this.activeAction, fadeSec, true);
    }
    this.activeAction = nextAction;
  }

  private applyEntryOffsets(state: LocomotionState, previousState: LocomotionState, action: THREE.AnimationAction): void {
    if (state !== 'walk' || previousState === 'walk') return;
    const duration = action.getClip().duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    action.time = Math.min(WALK_ENTRY_TIME_OFFSET_SEC, Math.max(0, duration - 1e-3));
  }

  private bindProfileActions(profile: LocomotionProfile, clips: THREE.AnimationClip[]): void {
    if (!this.mixer) return;
    const actions: Partial<Record<LocomotionState, THREE.AnimationAction>> = {};
    for (const state of LOCOMOTION_STATES) {
      if (profile === 'vr-lower-body' && state === 'idle') {
        // VR keeps lower-body idle static to avoid artificial leg motion while standing.
        continue;
      }
      const clip = this.resolveClip(clips, state);
      if (!clip) continue;
      const action = this.mixer.clipAction(clip);
      action.enabled = true;
      const airborne = /jump|takeoff|fall|air/i.test(clip.name);
      // A legs-only airborne clip leaves the desktop body's arms in their rest pose (straight out) for the whole jump;
      // it stays on the idle instead, and the crouch pose draws the wind-up, tuck and landing (BodyPoseSystem).
      if (profile === 'desktop-full' && (state === 'jump' || state === 'fall') && !animatesArms(clip)) continue;
      action.setLoop(airborne ? THREE.LoopOnce : THREE.LoopRepeat, airborne ? 1 : Infinity);
      action.clampWhenFinished = airborne;
      action.setEffectiveTimeScale(1);
      actions[state] = action;
    }
    this.actionsByProfile[profile] = actions;
  }

  private applyPlaybackSpeedCalibration(input: LocomotionUpdateInput): void {
    let nextTimeScale = 1;
    let nextShare = 1;
    const walkAction = this.actionsByProfile[this.activeProfile].walk;
    const usingWalkAction = walkAction !== undefined && this.activeAction === walkAction && this.state === 'walk';
    if (usingWalkAction) {
      // The planted foot moves backwards at the speed the root moves forwards, so it stays put.
      const stanceSpeed = this.stanceSpeedWorld();
      const rate = stanceSpeed
        ? input.horizontalSpeed / stanceSpeed
        : WALK_TIME_SCALE_BASE * input.horizontalSpeed / Math.max(input.referenceSpeed ?? input.targetHorizontalSpeed, 0.01);
      const heldBack = input.horizontalSpeed < input.targetHorizontalSpeed * HELD_BACK_SHARE;
      this.heldBackSec = heldBack ? this.heldBackSec + Math.max(0, input.deltaSec) : 0;
      nextTimeScale = THREE.MathUtils.clamp(rate, stanceSpeed && this.heldBackSec >= HELD_BACK_SEC ? WALK_CADENCE_FLOOR : WALK_TIME_SCALE_MIN, WALK_TIME_SCALE_MAX);
      if (stanceSpeed) nextShare = THREE.MathUtils.clamp(rate / nextTimeScale, WALK_STRIDE_SHARE_MIN, 1);
    } else {
      this.heldBackSec = 0;
    }

    // Smooth cadence changes without restarting the walking phase.
    const ease = 1 - Math.exp(-12 * Math.max(0, input.deltaSec));
    nextTimeScale = THREE.MathUtils.lerp(this.currentTimeScale, nextTimeScale, ease);
    this.currentTimeScale = nextTimeScale;
    this.strideShare = THREE.MathUtils.lerp(this.strideShare, nextShare, ease);
    if (usingWalkAction) this.walkRate = nextTimeScale;
    this.activeAction?.setEffectiveTimeScale(nextTimeScale);
  }

  private resolveAction(profile: LocomotionProfile, state: LocomotionState): THREE.AnimationAction | undefined {
    const actions = this.actionsByProfile[profile];
    if (profile === 'desktop-full' && (state === 'jump' || state === 'fall') && !actions.jump && !actions.fall && actions.idle) return actions.idle;
    for (const fallbackState of CLIP_FALLBACK_ORDER[state]) {
      const action = actions[fallbackState];
      if (action) return action;
    }
    return undefined;
  }

  private resolveClip(clips: readonly THREE.AnimationClip[], state: LocomotionState): THREE.AnimationClip | undefined {
    for (const fallbackState of CLIP_FALLBACK_ORDER[state]) {
      const matcher = CLIP_MATCHERS[fallbackState];
      const match = clips.find((clip) => matcher.test(clip.name) && !isDirectionalClip(clip.name));
      if (match) return match;
    }
    return undefined;
  }

  private preprocessClip(clip: THREE.AnimationClip, profile: LocomotionProfile): THREE.AnimationClip | undefined {
    // "Standing Jump" or "Stand To Fall" is not an idle.
    const isIdleClip = CLIP_MATCHERS.idle.test(clip.name) && !LOCOMOTION_STATES.some((state) => state !== 'idle' && CLIP_MATCHERS[state].test(clip.name));
    const isWalkClip = CLIP_MATCHERS.walk.test(clip.name) || isDirectionalClip(clip.name);
    const tracks = clip.tracks
      .filter((track) => this.shouldKeepTrack(track.name, profile, isIdleClip))
      .map((track) => track.clone())
      .map((track) => this.trimWalkLoopTail(track, isWalkClip))
      // A walk keyed at a few poses with straight-line blends jerks the feet at every key; play it as a smooth loop.
      .map((track) => (isWalkClip && profile === 'desktop-full' ? LocomotionAnimator.smoothLoop(track, clip.duration) : track))
      .map((track) => (isIdleClip && profile === 'desktop-full' ? LocomotionAnimator.holdFirstKey(track, clip.duration) : track));
    if (tracks.length === 0) return undefined;
    const processed = new THREE.AnimationClip(clip.name, -1, tracks);
    processed.resetDuration();
    processed.blendMode = clip.blendMode;
    return processed;
  }

  private shouldKeepTrack(trackName: string, profile: LocomotionProfile, isIdleClip: boolean): boolean {
    const parts = parseTrackName(trackName);
    if (!parts) return false;

    if (parts.property === 'position' && this.isRootMotionTarget(parts.nodeName)) {
      return false;
    }
    if (profile === 'desktop-full') {
      // On desktop the idle only lowers the arms (holdFirstKey): its torso and head lean would move the shoulder and
      // eyes the desktop reach, carry and aim are tuned from, and the legs stand on the terrain IK. (VR plays no idle.)
      if (isIdleClip) return parts.property === 'quaternion' && this.isArmTarget(parts.nodeName);
      return true;
    }
    return parts.property === 'quaternion' && this.isLowerBodyTarget(parts.nodeName);
  }

  /**
   * The track held at its first key for the whole clip. The desktop arms stand in the idle's pose (down, on any rest
   * pose, so a T-pose avatar does not swing them down when it starts walking) but without its sway, which would move
   * the hand the desktop reach, carry and set-down are tuned from (docs/features/realistic-avatar-motion.md,
   * follow-ups). Two keys, so the clip keeps a nonzero duration to loop over.
   */
  private static holdFirstKey(track: THREE.KeyframeTrack, duration: number): THREE.KeyframeTrack {
    const size = track.getValueSize();
    const first = Array.from(track.values.slice(0, size));
    const TrackType = track.constructor as new (name: string, times: number[], values: number[]) => THREE.KeyframeTrack;
    return new TrackType(track.name, [0, Math.max(duration, 1 / 30)], [...first, ...first]);
  }

  /**
   * A looping track resampled at 60 Hz on a periodic cubic Hermite through its
   * keys (finite-difference tangents), so velocity is continuous across keys
   * and across the loop. Tracks already keyed densely are left as they are.
   */
  private static smoothLoop(track: THREE.KeyframeTrack, period: number): THREE.KeyframeTrack {
    const size = track.getValueSize();
    const isQuaternion = track instanceof THREE.QuaternionKeyframeTrack;
    const keys = track.times.length;
    if (!(period > 0) || keys < 3 || keys >= period * 20 || (size !== 3 && size !== 4)) return track;
    const times = Array.from(track.times);
    const points = Array.from({ length: keys }, (_, i) => Array.from(track.values.slice(i * size, (i + 1) * size)));
    // Close the loop at the period: the pose at the end is the pose at the start.
    if (times[0]! > 1e-4) return track;
    if (period - times[keys - 1]! > 1e-4) {
      times.push(period);
      points.push([...points[0]!]);
    } else points[keys - 1] = [...points[0]!];
    const m = times.length - 1;
    const dot = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i]!, 0);
    // One hemisphere for the whole loop, so a blend never takes the long way round.
    if (isQuaternion) for (let i = 1; i <= m; i++) if (dot(points[i]!, points[i - 1]!) < 0) points[i] = points[i]!.map((v) => -v);
    const wrapped = (i: number): [number, number[]] => {
      if (i < 0) {
        const q = points[m + i]!;
        return [times[m + i]! - period, isQuaternion && dot(q, points[0]!) < 0 ? q.map((v) => -v) : q];
      }
      if (i > m) {
        const q = points[i - m]!;
        return [times[i - m]! + period, isQuaternion && dot(q, points[m]!) < 0 ? q.map((v) => -v) : q];
      }
      return [times[i]!, points[i]!];
    };
    const tangent = (i: number) => {
      const [t0, p0] = wrapped(i - 1);
      const [t1, p1] = wrapped(i + 1);
      return p0.map((v, c) => (p1[c]! - v) / (t1 - t0));
    };
    const tangents = Array.from({ length: m + 1 }, (_, i) => tangent(i === m ? 0 : i));
    const count = Math.max(m * 4, Math.round(period * 60));
    const outTimes: number[] = [];
    const outValues: number[] = [];
    let segment = 0;
    for (let k = 0; k <= count; k++) {
      const t = (k / count) * period;
      while (segment < m - 1 && t > times[segment + 1]!) segment++;
      const t0 = times[segment]!, t1 = times[segment + 1]!, h = t1 - t0;
      const u = h > 0 ? (t - t0) / h : 0;
      const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u, h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
      const value = points[segment]!.map((v, c) => h00 * v + h10 * h * tangents[segment]![c]! + h01 * points[segment + 1]![c]! + h11 * h * tangents[segment + 1]![c]!);
      if (isQuaternion) {
        const length = Math.hypot(...value) || 1;
        for (let c = 0; c < 4; c++) value[c]! /= length;
      }
      outTimes.push(t);
      outValues.push(...value);
    }
    const smoothed = track.clone();
    smoothed.times = new Float32Array(outTimes);
    smoothed.values = new Float32Array(outValues);
    return smoothed;
  }

  private trimWalkLoopTail(track: THREE.KeyframeTrack, isWalkClip: boolean): THREE.KeyframeTrack {
    if (!isWalkClip) return track;
    if (!(track instanceof THREE.QuaternionKeyframeTrack)) return track;

    const parts = parseTrackName(track.name);
    if (!parts || parts.property !== 'quaternion' || !this.isLowerBodyTarget(parts.nodeName)) {
      return track;
    }

    const times = track.times;
    const values = track.values;
    const valueSize = track.getValueSize();
    if (times.length < 3 || valueSize !== 4) return track;

    let endIndex = times.length - 1;
    while (endIndex > 1) {
      const currentOffset = endIndex * valueSize;
      const previousOffset = (endIndex - 1) * valueSize;
      if (!this.quaternionSamplesMatch(values, previousOffset, currentOffset)) {
        break;
      }
      endIndex -= 1;
    }

    if (endIndex === times.length - 1) {
      return track;
    }

    const trimmed = track.clone();
    trimmed.times = times.slice(0, endIndex + 1);
    trimmed.values = values.slice(0, (endIndex + 1) * valueSize);
    return trimmed;
  }

  private quaternionSamplesMatch(values: THREE.TypedArray, aOffset: number, bOffset: number): boolean {
    const dot = Math.abs(
      values[aOffset]! * values[bOffset]! +
      values[aOffset + 1]! * values[bOffset + 1]! +
      values[aOffset + 2]! * values[bOffset + 2]! +
      values[aOffset + 3]! * values[bOffset + 3]!
    );
    return Number.isFinite(dot) && dot >= WALK_LOOP_QUAT_MATCH_DOT;
  }

  private isRootMotionTarget(nodeName: string): boolean {
    if (this.rootMotionNames) return this.rootMotionNames.has(nodeName);
    return ROOT_MOTION_TARGETS.some((target) => nodeName === target || nodeName.endsWith(target));
  }

  /** Shoulders, arms, hands and fingers: by canonical bone with a humanoid, else by the shipped rig's names. */
  private isArmTarget(nodeName: string): boolean {
    if (this.armNames) return this.armNames.has(nodeName);
    return /(shoulder|arm|hand)/i.test(nodeName) && !/armature/i.test(nodeName);
  }

  private isSwayTarget(nodeName: string): boolean {
    if (this.swayNames) return this.swayNames.has(nodeName);
    return /(spine|chest|neck|head)/i.test(nodeName) && !/headtop|end$/i.test(nodeName);
  }

  private isLowerBodyTarget(nodeName: string): boolean {
    if (this.lowerBodyNames) return this.lowerBodyNames.has(nodeName);
    return LOWER_BODY_TARGETS.some((target) => nodeName === target || nodeName.endsWith(target));
  }
}

/** The clip moves an arm: a whole-body clip, not one drawn for the legs alone. */
function animatesArms(clip: THREE.AnimationClip): boolean {
  return clip.tracks.some((track) => /arm|shoulder/i.test(track.name.split('.')[0] ?? ''));
}
