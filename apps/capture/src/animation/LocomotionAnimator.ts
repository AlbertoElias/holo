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
const WALK_TIME_SCALE_BASE = 1.4;
const WALK_TIME_SCALE_MIN = 0.15;
const WALK_TIME_SCALE_MAX = 2.4;
const WALK_LOOP_QUAT_MATCH_DOT = 0.99995;
const WALK_STATE_SPEED_THRESHOLD = 0.12;
const WALK_FADE_SEC = 0.08;
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
            ? WALK_FADE_SEC
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
      const speedRatio = input.horizontalSpeed / Math.max(input.referenceSpeed ?? input.targetHorizontalSpeed, 0.01);
      nextTimeScale = THREE.MathUtils.clamp(
        WALK_TIME_SCALE_BASE * speedRatio,
        WALK_TIME_SCALE_MIN,
        WALK_TIME_SCALE_MAX
      );
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
      .map((track) => this.trimWalkLoopTail(track, isWalkClip));
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
