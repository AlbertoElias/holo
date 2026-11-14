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
}

export type GaitLeg = 'left' | 'right';
/** The walk clip's footfalls, measured by forward kinematics when the clip is attached. */
export interface WalkGait {
  /** Clip phase (0..1) at which each foot lands and lifts; the stance may wrap past 1. */
  readonly stance: Readonly<Record<GaitLeg, { readonly land: number; readonly lift: number }>>;
  /** Mean backward speed of a planted foot at time scale 1, in the avatar's own (unscaled) units per second. */
  readonly stanceSpeed: number;
}
/** What the leg solver needs from the walk this frame. */
export interface GaitState {
  readonly gait: WalkGait;
  /** Walking on the walk clip (not idle, airborne or fading out). */
  readonly walking: boolean;
  /** Current clip phase, 0..1. */
  readonly phase: number;
  /** How much longer than the clip's own each stride is laid down (the leg solver scales the feet's fore-aft offset). */
  readonly stride: number;
}

/**
 * The shipped walk's stride is short for a brisk 1.8 m/s walk, so its cadence would be a scurry and its swing foot
 * would whip. Laying each stride down longer, and playing the clip slower to match, keeps the planted foot still.
 */
const WALK_STRIDE_SCALE = 1.2;

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
const LOWER_BODY_TARGETS = ['hips', 'leftupleg', 'leftleg', 'leftfoot', 'lefttoebase', 'rightupleg', 'rightleg', 'rightfoot', 'righttoebase'];
const LOWER_BODY_BONES: readonly VrmHumanoidBone[] = [
  'hips', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes'
];
// Without a measured gait (no humanoid), the old clip-agnostic rate.
const WALK_TIME_SCALE_BASE = 1.4;
const WALK_TIME_SCALE_MIN = 0.15;
const WALK_TIME_SCALE_MAX = 3;
const GAIT_SAMPLES = 96;
const WALK_LOOP_QUAT_MATCH_DOT = 0.99995;
const WALK_STATE_SPEED_THRESHOLD = 0.12;
const WALK_FADE_SEC = 0.08;
/** The desktop body is all clip: its walk eases in over most of a step, or the hips drop and the knees jump at the first frame. */
const DESKTOP_WALK_IN_SEC = 0.25;
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
  private rootMotionNames: ReadonlySet<string> | undefined;
  private readonly actionsByProfile: Record<LocomotionProfile, Partial<Record<LocomotionState, THREE.AnimationAction>>> = {
    'desktop-full': {},
    'vr-lower-body': {}
  };
  private state: LocomotionState = 'idle';
  private activeProfile: LocomotionProfile = 'desktop-full';
  private activeAction: THREE.AnimationAction | null = null;
  private currentTimeScale = 1;
  private clipSources: Record<LocomotionState, LocomotionClipSource> = { idle: 'none', walk: 'none', jump: 'none', fall: 'none' };
  private root: THREE.Object3D | undefined;
  private gait: WalkGait | undefined;

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
    return clips.find((clip) => CLIP_MATCHERS[state].test(clip.name) && LocomotionAnimator.turnsBones(clip, humanoid));
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
    this.rootMotionNames = undefined;
    if (humanoid) {
      this.lowerBodyNames = LocomotionAnimator.boneKeys(humanoid, LOWER_BODY_BONES);
      this.rootMotionNames = new Set([...LocomotionAnimator.boneKeys(humanoid, ['hips']), 'armature', 'root']);
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
    if (humanoid && walkClip && CLIP_MATCHERS.walk.test(walkClip.name)) {
      // A walk without its hips' rise and fall (root motion stripped, or retargeted as rotations) keeps the
      // hips at standing height, where a straight leg cannot reach a planted foot: put the bob back from the feet.
      const bobbed = LocomotionAnimator.withHipsBob(root, walkClip, humanoid);
      if (bobbed) desktopClips.splice(desktopClips.indexOf(walkClip), 1, bobbed);
      this.gait = LocomotionAnimator.measureGait(root, bobbed ?? walkClip, humanoid)?.gait;
    }
    this.bindProfileActions('desktop-full', desktopClips);
    this.bindProfileActions('vr-lower-body', vrClips);
    for (const state of LOCOMOTION_STATES) {
      this.clipSources[state] = this.resolveClip(clips, state) ? (own ? 'own' : 'retargeted') : 'none';
    }
    this.playState(this.state, this.activeProfile, 0);
  }

  update(input: LocomotionUpdateInput): void {
    const nextProfile: LocomotionProfile = input.vrMode ? 'vr-lower-body' : 'desktop-full';
    const nextState = this.resolveState(input.grounded, input.velocityY, input.horizontalSpeed);
    const fadeSec =
      nextState === 'jump' || nextState === 'fall'
          ? 0.1
          : nextState === 'walk'
            ? nextProfile === 'desktop-full' ? DESKTOP_WALK_IN_SEC : WALK_FADE_SEC
            : 0.18;
    this.playState(nextState, nextProfile, fadeSec);
    this.applyPlaybackSpeedCalibration(input);

    if (this.mixer) {
      this.mixer.update(input.deltaSec);
    }
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

  getGait(): WalkGait | undefined {
    return this.gait;
  }

  /** The walk's footfall phase this frame, for the leg solver's planted feet; undefined without a measured gait. */
  getGaitState(): GaitState | undefined {
    if (!this.gait) return undefined;
    const walk = this.actionsByProfile[this.activeProfile].walk;
    const walking = this.state === 'walk' && walk !== undefined && this.activeAction === walk;
    const duration = walk?.getClip().duration ?? 0;
    const phase = walk && duration > 0 ? (((walk.time / duration) % 1) + 1) % 1 : 0;
    return { gait: this.gait, walking, phase, stride: WALK_STRIDE_SCALE };
  }

  /** The planted foot's speed at time scale 1, in world metres per second (the avatar's scale applied). */
  stanceSpeedWorld(): number | undefined {
    if (!this.gait || !this.root) return undefined;
    const scale = this.root.getWorldScale(new THREE.Vector3()).z;
    return this.gait.stanceSpeed * WALK_STRIDE_SCALE * Math.abs(scale);
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
    // Lightly smoothed (circular, ±2 samples) so a foot's roll from heel to toe does not shake the body.
    const drop = soles.map((_, i) => {
      let sum = 0;
      for (let k = -2; k <= 2; k++) sum += soles[(i + k + n) % n]! - restSole;
      return sum / 5;
    });
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
  private static measureGait(root: THREE.Object3D, clip: THREE.AnimationClip, humanoid: HumanoidSkeleton): { gait: WalkGait | undefined; soles: number[]; restSole: number } | undefined {
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
    const mixer = new THREE.AnimationMixer(root);
    const action = mixer.clipAction(clip);
    action.play();
    const local = new THREE.Vector3();
    const track: Record<GaitLeg, Array<{ x: number; z: number; sole: number }>> = { left: [], right: [] };
    let hipsHeight = 0;
    try {
      for (let i = 0; i < GAIT_SAMPLES; i++) {
        action.time = (i / GAIT_SAMPLES) * clip.duration;
        mixer.update(0);
        root.updateWorldMatrix(true, true);
        // World space relative to the hips: the rig's own axes need not be the avatar's.
        const hip = hips.getWorldPosition(local);
        hipsHeight += (hip.y - root.getWorldPosition(new THREE.Vector3()).y) / GAIT_SAMPLES;
        for (const side of ['left', 'right'] as const) {
          const ankle = feet[side]!.getWorldPosition(new THREE.Vector3());
          const toe = toes[side] ? toes[side]!.getWorldPosition(new THREE.Vector3()) : ankle;
          track[side].push({ x: ankle.x - hip.x, z: ankle.z - hip.z, sole: Math.min(ankle.y, toe.y) - rootY });
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
    // The stride runs along the feet's main horizontal axis (principal component of their swing).
    let xx = 0, xz = 0, zz = 0, mx = 0, mz = 0;
    const all = [...track.left, ...track.right];
    for (const p of all) { mx += p.x / all.length; mz += p.z / all.length; }
    for (const p of all) { xx += (p.x - mx) ** 2; xz += (p.x - mx) * (p.z - mz); zz += (p.z - mz) ** 2; }
    const angle = 0.5 * Math.atan2(2 * xz, xx - zz);
    const axis = { x: Math.cos(angle), z: Math.sin(angle) };
    // Oriented forward, the way the toes point at rest: a planted foot slides back along it under an in-place walk.
    const along = (side: GaitLeg) => track[side].map((p) => p.x * axis.x + p.z * axis.z);
    const sign = restForward.x * axis.x + restForward.z * axis.z < 0 ? -1 : 1;
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
    return result(stanceSpeed > 1e-4 ? { stance, stanceSpeed: stanceSpeed / scale } : undefined);
  }

  private resolveState(grounded: boolean, velocityY: number, horizontalSpeed: number): LocomotionState {
    if (!grounded) {
      return velocityY > 0.25 ? 'jump' : 'fall';
    }
    if (horizontalSpeed >= WALK_STATE_SPEED_THRESHOLD) {
      return 'walk';
    }
    return 'idle';
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
      // Without an idle clip the desktop body stands in its rest pose; ease out of it rather than snapping to the walk.
      if (fadeSec > 0 && profile === 'desktop-full') nextAction.fadeIn(fadeSec);
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
      action.setLoop(airborne ? THREE.LoopOnce : THREE.LoopRepeat, airborne ? 1 : Infinity);
      action.clampWhenFinished = airborne;
      action.setEffectiveTimeScale(1);
      actions[state] = action;
    }
    this.actionsByProfile[profile] = actions;
  }

  private applyPlaybackSpeedCalibration(input: LocomotionUpdateInput): void {
    let nextTimeScale = 1;
    const walkAction = this.actionsByProfile[this.activeProfile].walk;
    const usingWalkAction = walkAction !== undefined && this.activeAction === walkAction && this.state === 'walk';
    if (usingWalkAction) {
      // The planted foot moves backwards at the speed the root moves forwards, so it stays put.
      const stanceSpeed = this.stanceSpeedWorld();
      const rate = stanceSpeed
        ? input.horizontalSpeed / stanceSpeed
        : WALK_TIME_SCALE_BASE * input.horizontalSpeed / Math.max(input.referenceSpeed ?? input.targetHorizontalSpeed, 0.01);
      nextTimeScale = THREE.MathUtils.clamp(rate, WALK_TIME_SCALE_MIN, WALK_TIME_SCALE_MAX);
    }

    // Smooth cadence changes without restarting the walking phase.
    nextTimeScale = THREE.MathUtils.lerp(this.currentTimeScale, nextTimeScale, 1 - Math.exp(-12 * Math.max(0, input.deltaSec)));
    this.currentTimeScale = nextTimeScale;
    this.activeAction?.setEffectiveTimeScale(nextTimeScale);
  }

  private resolveAction(profile: LocomotionProfile, state: LocomotionState): THREE.AnimationAction | undefined {
    const actions = this.actionsByProfile[profile];
    for (const fallbackState of CLIP_FALLBACK_ORDER[state]) {
      const action = actions[fallbackState];
      if (action) return action;
    }
    return undefined;
  }

  private resolveClip(clips: readonly THREE.AnimationClip[], state: LocomotionState): THREE.AnimationClip | undefined {
    for (const fallbackState of CLIP_FALLBACK_ORDER[state]) {
      const matcher = CLIP_MATCHERS[fallbackState];
      const match = clips.find((clip) => matcher.test(clip.name));
      if (match) return match;
    }
    return undefined;
  }

  private preprocessClip(clip: THREE.AnimationClip, profile: LocomotionProfile): THREE.AnimationClip | undefined {
    const isIdleClip = CLIP_MATCHERS.idle.test(clip.name);
    const isWalkClip = CLIP_MATCHERS.walk.test(clip.name);
    const tracks = clip.tracks
      .filter((track) => this.shouldKeepTrack(track.name, profile, isIdleClip))
      .map((track) => track.clone())
      .map((track) => this.trimWalkLoopTail(track, isWalkClip))
      // A walk keyed at a few poses with straight-line blends jerks the feet at every key; play it as a smooth loop.
      .map((track) => (isWalkClip && profile === 'desktop-full' ? LocomotionAnimator.smoothLoop(track, clip.duration) : track));
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
      if (isIdleClip && parts.property === 'quaternion' && this.isLowerBodyTarget(parts.nodeName)) {
        return false;
      }
      return true;
    }
    return parts.property === 'quaternion' && this.isLowerBodyTarget(parts.nodeName);
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

  private isLowerBodyTarget(nodeName: string): boolean {
    if (this.lowerBodyNames) return this.lowerBodyNames.has(nodeName);
    return LOWER_BODY_TARGETS.some((target) => nodeName === target || nodeName.endsWith(target));
  }
}
