import * as THREE from 'three';
import {
  CAPTURE_HALO_ACTIONS,
  HELD_IDLE,
  dominantHand,
  haloDirectionOf,
  nonDominantHand,
  stepHeldMode,
  type HaloAction,
  type HaloEvent,
  type Handedness,
  type HeldModeEvent,
  type HeldModeState
} from '@holoim/xr-ui-core';
import { ThreeHalo } from '@holoim/xr-ui-three';

import type { AimInput } from '../recording/PointSampleStore';
import type { TrackedHandJointName, VrHandSide } from '../types/contracts';

// Held modes in a headset (docs/features/ui-redesign.md, slice 5 build plan):
// the mark "this" on the non-dominant hand (thumb–middle pinch, or the
// trigger), and the Halo summoned by the dominant thumb–middle pinch or by
// pressing the non-dominant thumbstick. Both go through the core's held-mode
// and Halo state machines; this reads the devices and places the ring.

/** Thumb–middle tips closer than this start the alternate pinch; farther than the exit end it. */
export const MIDDLE_PINCH_ON_M = 0.015;
export const MIDDLE_PINCH_OFF_M = 0.03;
/** The thumb–index gap must stay above grab's own release distance, so an ordinary pinch never holds. */
export const INDEX_CLEAR_M = 0.04;
/** The holding hand may drop out this long before the mode ends on tracking loss. */
const HOLD_LOST_GRACE_SEC = 0.25;
/** A select that arrives this soon after a mark's release still belongs to it (a misread pinch). */
const SELECT_SWALLOW_SEC = 0.3;
/** xr-standard: buttons[3] is the thumbstick press. */
const STICK_PRESS_BUTTON = 3;
const BUTTON_ON = 0.5;
/** The stick must rest inside this at the press: a click while walking never summons. */
const STICK_REST = 0.2;
/** A release this soon after the last pointed direction commits that direction (the stick recentres as the press lets go). */
const STICK_RELEASE_LATCH_SEC = 0.1;
/** The controller ring opens this far above the summoning controller. */
const CONTROLLER_RING_LIFT_M = 0.08;

/** The slice of `XrTracking` this reads. */
export interface HeadsetHoldTracking {
  getHandPoseSource(side: VrHandSide): string;
  getTrackedHandJointPosition(side: VrHandSide, jointName: TrackedHandJointName, out: THREE.Vector3): boolean;
  getChromeInput(side: VrHandSide): { hand: boolean; targetRay: THREE.Group | undefined; grip: THREE.Group | undefined; inputSource: XRInputSource | undefined };
  getThumbstickAxes(side: VrHandSide): { x: number; y: number } | undefined;
}

export interface HeadsetHoldsDeps {
  tracking: HeadsetHoldTracking;
  /** Where rings are placed (the headset chrome root). */
  root: THREE.Object3D;
  renderer: THREE.WebGLRenderer;
  getHandedness: () => Handedness;
  /** Whether the hand pinches or squeezes to grab, or holds the tray open: the mark and the Halo stay off that hand. */
  isHandBusy: (side: VrHandSide) => boolean;
  /** Runs a committed Halo action; `at` is where the summoning hand is, for feedback. */
  onHaloAction: (action: HaloAction, input: Extract<AimInput, 'hands' | 'controllers'>, side: VrHandSide, at: THREE.Vector3) => void;
}

export interface HeadsetHoldsStep {
  timeSec: number;
  /** Real XR presenting (not the mock pose hook). */
  presenting: boolean;
  /** The mark holds only during a take: nothing shows live in a headset. */
  recording: boolean;
  camera: THREE.Camera;
}

/** What the recorder takes from the mark this step. */
export type HeadsetMarkStep =
  | { state: 'held'; input: 'hands' | 'controllers'; side: VrHandSide; ray: { origin: THREE.Vector3; direction: THREE.Vector3 } | null; paused: boolean }
  | { state: 'ended' }
  | null;

interface PinchSide {
  on: boolean;
  /** Seconds since the joints were last read; 0 while tracked. */
  lostSec: number;
  seenSec: number;
}

type HaloSummon = { input: 'hands' | 'controllers'; side: VrHandSide; atMs: number; halo: ThreeHalo; origin: THREE.Vector3; handedness: Handedness };

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();

export class HeadsetHolds {
  private mark: HeldModeState = HELD_IDLE;
  private markHandedness: Handedness | null = null;
  private markEndedThisStep = false;
  private lastMarkReleaseSec = -Infinity;
  private lastMarkSide: VrHandSide | null = null;
  private readonly pinches: Record<VrHandSide, PinchSide> = { left: { on: false, lostSec: 0, seenSec: 0 }, right: { on: false, lostSec: 0, seenSec: 0 } };
  /** Controller selects from the mark's trigger, queued for the next step. */
  private readonly triggerEvents: HeldModeEvent[] = [];
  private unbind: (() => void) | null = null;

  private summon: HaloSummon | null = null;
  private readonly halos = new Map<number, ThreeHalo>();
  private stickWasPressed: Record<VrHandSide, boolean> = { left: false, right: false };
  /** A stick that summoned the Halo walks or turns again only once it has recentred. */
  private readonly stickLocked: Record<VrHandSide, boolean> = { left: false, right: false };
  private lastPointed: { atMs: number; dx: number; dy: number } | null = null;
  private haloDrawn = false;
  /** Committed Halo actions and marks, for checks. */
  readonly log: Array<{ kind: 'halo'; input: string; direction: string; action: string | null; flick: boolean } | { kind: 'mark'; input: string; phase: 'start' | 'end'; reason?: string }> = [];

  constructor(private readonly deps: HeadsetHoldsDeps) {}

  /** Listens for the trigger's selects; call once the renderer exists. */
  bind(): void {
    if (this.unbind) return;
    const xr = this.deps.renderer.xr;
    const controllers = [xr.getController(0), xr.getController(1)];
    const onStart = (event: { data?: XRInputSource }): void => this.onTrigger(event.data, true);
    const onEnd = (event: { data?: XRInputSource }): void => this.onTrigger(event.data, false);
    for (const controller of controllers) {
      controller.addEventListener('selectstart', onStart as never);
      controller.addEventListener('selectend', onEnd as never);
    }
    this.unbind = () => {
      for (const controller of controllers) {
        controller.removeEventListener('selectstart', onStart as never);
        controller.removeEventListener('selectend', onEnd as never);
      }
      this.unbind = null;
    };
  }

  private onTrigger(source: XRInputSource | undefined, pressed: boolean): void {
    if (!source || source.hand || (source.handedness !== 'left' && source.handedness !== 'right')) return;
    const side = source.handedness;
    const at = performance.now();
    this.triggerEvents.push(pressed ? { type: 'press', source: `${side}:trigger`, atMs: at, delayMs: 0 } : { type: 'release', source: `${side}:trigger`, atMs: at });
  }

  /**
   * Whether a select from this source belongs to the mark (its trigger, or a
   * pinch misread on the holding hand) and must not also press chrome.
   */
  ownsSelect(source: XRInputSource | undefined, timeSec: number): boolean {
    if (!source || (source.handedness !== 'left' && source.handedness !== 'right')) return false;
    const side = source.handedness;
    if (this.mark.phase === 'held' && this.mark.source.startsWith(`${side}:`)) return true;
    if (this.mark.swallow?.startsWith(`${side}:`)) return true;
    return this.lastMarkSide === side && timeSec - this.lastMarkReleaseSec <= SELECT_SWALLOW_SEC;
  }

  /** The stick on this side neither walks nor turns: it is pointing the Halo, or has not recentred since. */
  locomotionBlocked(side: VrHandSide): boolean {
    return this.stickLocked[side];
  }

  /** The side whose hand summons the Halo now; that hand gives no point evidence meanwhile. */
  haloHand(): VrHandSide | null {
    return this.summon?.input === 'hands' ? this.summon.side : null;
  }

  isHaloOpen(): boolean {
    return this.summon !== null;
  }

  /** Ends both modes (the session ended, or the window lost focus). */
  reset(timeSec: number): void {
    this.feedMark({ type: 'blur' }, timeSec);
    this.closeHalo({ type: 'cancel' });
    for (const side of ['left', 'right'] as const) {
      this.pinches[side] = { on: false, lostSec: 0, seenSec: timeSec };
      this.stickWasPressed[side] = false;
      this.stickLocked[side] = false;
    }
    this.triggerEvents.length = 0;
  }

  update(step: HeadsetHoldsStep): HeadsetMarkStep {
    this.markEndedThisStep = false;
    if (!step.presenting) {
      this.reset(step.timeSec);
      return this.markEndedThisStep ? { state: 'ended' } : null;
    }
    const handedness = this.deps.getHandedness();
    const holder = nonDominantHand(handedness);
    const pointer = dominantHand(handedness);
    const nowMs = step.timeSec * 1000;

    // A handedness change mid-hold ends the mark; the new holding hand needs a fresh press.
    if (this.mark.phase !== 'idle' && this.markHandedness !== handedness) this.feedMark({ type: 'blur' }, step.timeSec);

    for (const side of ['left', 'right'] as const) this.updatePinch(side, step.timeSec);
    this.updateMark(step, holder);
    this.updateHalo(step, handedness, pointer, holder, nowMs);

    if (this.markEndedThisStep) return { state: 'ended' };
    if (this.mark.phase !== 'held') return null;
    const input = this.mark.source.endsWith(':trigger') ? 'controllers' : 'hands';
    return { state: 'held', input, side: pointer, ray: input === 'controllers' ? this.controllerRay(pointer) : null, paused: this.summon !== null };
  }

  snapshot(): { mark: HeldModeState; pinches: Record<VrHandSide, boolean>; halo: { input: string; side: VrHandSide; drawn: boolean } | null; stickLocked: Record<VrHandSide, boolean>; log: HeadsetHolds['log'] } {
    return {
      mark: this.mark,
      pinches: { left: this.pinches.left.on, right: this.pinches.right.on },
      halo: this.summon ? { input: this.summon.input, side: this.summon.side, drawn: this.haloDrawn } : null,
      stickLocked: { ...this.stickLocked },
      log: this.log
    };
  }

  // --- The mark ---

  private updateMark(step: HeadsetHoldsStep, holder: VrHandSide): void {
    for (const event of this.triggerEvents.splice(0)) {
      if (event.type === 'press') {
        // Only the holding hand's trigger, only during a take, never on a busy hand.
        if (!step.recording || !event.source.startsWith(`${holder}:`) || this.deps.isHandBusy(holder)) continue;
      }
      this.feedMark(event, step.timeSec);
    }
    const pinchSource = `${holder}:thumbMiddle`;
    const pinch = this.pinches[holder];
    if (this.mark.phase === 'idle') {
      if (pinch.on && step.recording && !this.deps.isHandBusy(holder) && this.summon?.side !== holder) this.feedMark({ type: 'press', source: pinchSource, atMs: step.timeSec * 1000, delayMs: 0 }, step.timeSec);
    } else if (this.mark.phase === 'held' && this.mark.source === pinchSource) {
      if (pinch.lostSec > HOLD_LOST_GRACE_SEC) this.feedMark({ type: 'trackingLost', source: pinchSource }, step.timeSec);
      else if (pinch.lostSec === 0 && !pinch.on) this.feedMark({ type: 'release', source: pinchSource, atMs: step.timeSec * 1000 }, step.timeSec);
    } else if (this.mark.phase === 'held' && this.mark.source.endsWith(':trigger')) {
      const input = this.deps.tracking.getChromeInput(holder);
      if (!input.inputSource || input.hand) this.feedMark({ type: 'trackingLost', source: this.mark.source }, step.timeSec);
    }
    if (!step.recording && this.mark.phase === 'held') this.feedMark({ type: 'blur' }, step.timeSec);
  }

  private feedMark(event: HeldModeEvent, timeSec: number): void {
    const before = this.mark;
    const result = stepHeldMode(this.mark, event);
    this.mark = result.state;
    if (result.started && this.mark.phase === 'held') {
      this.markHandedness = this.deps.getHandedness();
      this.log.push({ kind: 'mark', input: this.mark.source, phase: 'start' });
    }
    if (result.ended && before.phase === 'held') {
      this.markEndedThisStep = true;
      this.lastMarkReleaseSec = timeSec;
      this.lastMarkSide = before.source.startsWith('left:') ? 'left' : 'right';
      this.log.push({ kind: 'mark', input: before.source, phase: 'end', reason: result.ended });
    }
  }

  /** The alternate pinch per hand, with hysteresis; off while the thumb also nears the index (an ordinary pinch). */
  private updatePinch(side: VrHandSide, timeSec: number): void {
    const pinch = this.pinches[side];
    const { tracking } = this.deps;
    const thumb = tmpA;
    const middle = tmpB;
    const index = tmpC;
    // This side's own hand only: with it gone, tracking lends the side the
    // other hand's joints, and the pointing hand would read as a release.
    const read = tracking.getHandPoseSource(side) === 'xr-hand'
      && tracking.getChromeInput(side).hand
      && tracking.getTrackedHandJointPosition(side, 'thumb-tip', thumb)
      && tracking.getTrackedHandJointPosition(side, 'middle-finger-tip', middle)
      && tracking.getTrackedHandJointPosition(side, 'index-finger-tip', index);
    if (!read) {
      pinch.lostSec = Math.max(1e-6, timeSec - pinch.seenSec);
      if (pinch.lostSec > HOLD_LOST_GRACE_SEC) pinch.on = false;
      return;
    }
    pinch.seenSec = timeSec;
    pinch.lostSec = 0;
    const middleGap = thumb.distanceTo(middle);
    const indexGap = thumb.distanceTo(index);
    pinch.on = pinch.on ? middleGap < MIDDLE_PINCH_OFF_M && indexGap > MIDDLE_PINCH_ON_M : middleGap < MIDDLE_PINCH_ON_M && indexGap > INDEX_CLEAR_M;
  }

  private controllerRay(side: VrHandSide): { origin: THREE.Vector3; direction: THREE.Vector3 } | null {
    const input = this.deps.tracking.getChromeInput(side);
    const object = input.targetRay;
    if (!object || input.hand || !input.inputSource) return null;
    object.updateWorldMatrix(true, false);
    const origin = object.getWorldPosition(new THREE.Vector3());
    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(object.getWorldQuaternion(tmpQuat)).normalize();
    return { origin, direction };
  }

  // --- The Halo ---

  private updateHalo(step: HeadsetHoldsStep, handedness: Handedness, pointer: VrHandSide, holder: VrHandSide, nowMs: number): void {
    const { tracking } = this.deps;
    const stick = tracking.getThumbstickAxes(holder);
    const stickPressed = this.stickPressed(holder);
    const pressEdge = stickPressed && !this.stickWasPressed[holder];
    this.stickWasPressed[holder] = stickPressed;
    for (const side of ['left', 'right'] as const) {
      const axes = tracking.getThumbstickAxes(side);
      if (this.stickLocked[side] && (this.summon?.side !== side || this.summon.input !== 'controllers') && (!axes || Math.hypot(axes.x, axes.y) < STICK_REST)) this.stickLocked[side] = false;
    }

    if (this.summon && this.summon.handedness !== handedness) this.closeHalo({ type: 'cancel' });

    if (!this.summon) {
      const handPinch = this.pinches[pointer].on && tracking.getHandPoseSource(pointer) === 'xr-hand' && !this.deps.isHandBusy(pointer);
      if (handPinch && this.handPinchPoint(pointer, tmpA)) {
        this.openHalo('hands', pointer, tmpA, step.camera, nowMs, handedness);
      } else if (pressEdge && stick && Math.hypot(stick.x, stick.y) < STICK_REST && !tracking.getChromeInput(holder).hand) {
        const grip = tracking.getChromeInput(holder).grip ?? tracking.getChromeInput(holder).targetRay;
        if (grip) {
          grip.updateWorldMatrix(true, false);
          grip.getWorldPosition(tmpA);
          tmpA.y += CONTROLLER_RING_LIFT_M;
          this.openHalo('controllers', holder, tmpA, step.camera, nowMs, handedness);
          this.stickLocked[holder] = true;
        }
      }
      return;
    }

    const summon = this.summon;
    if (summon.input === 'hands') {
      const pinch = this.pinches[summon.side];
      const tracked = pinch.lostSec === 0;
      if (pinch.lostSec > HOLD_LOST_GRACE_SEC) {
        this.closeHalo({ type: 'cancel' });
        return;
      }
      if (tracked && !pinch.on) {
        this.closeHalo({ type: 'release', atMs: nowMs });
        return;
      }
      if (tracked && this.handPinchPoint(summon.side, tmpA)) {
        // The drag in the head's yaw frame: walking or turning does not move the choice.
        const { dx, dy } = this.dragInHeadFrame(summon, tmpA, step.camera);
        this.stepHalo({ type: 'move', atMs: nowMs, dx, dy });
      } else {
        this.stepHalo({ type: 'tick', atMs: nowMs });
      }
      return;
    }

    // Controllers: the stick tilts the choice; letting go of the press commits.
    if (!tracking.getChromeInput(summon.side).inputSource) {
      this.closeHalo({ type: 'cancel' });
      return;
    }
    const axes = tracking.getThumbstickAxes(summon.side) ?? { x: 0, y: 0 };
    const radius = summon.halo.layout.radiusApx;
    const dx = axes.x * radius;
    const dy = axes.y * radius;
    if (haloDirectionOf(dx, dy, summon.halo.layout.deadZoneApx)) this.lastPointed = { atMs: nowMs, dx, dy };
    if (!this.stickPressed(summon.side)) {
      const latched = this.lastPointed && nowMs - this.lastPointed.atMs <= STICK_RELEASE_LATCH_SEC * 1000 ? this.lastPointed : { dx, dy };
      this.stepHalo({ type: 'move', atMs: nowMs, dx: latched.dx, dy: latched.dy });
      this.closeHalo({ type: 'release', atMs: nowMs });
      return;
    }
    this.stepHalo({ type: 'move', atMs: nowMs, dx, dy });
  }

  private stickPressed(side: VrHandSide): boolean {
    const input = this.deps.tracking.getChromeInput(side);
    if (!input.inputSource || input.hand) return false;
    const button = input.inputSource.gamepad?.buttons[STICK_PRESS_BUTTON];
    return Boolean(button && (button.pressed || button.value > BUTTON_ON));
  }

  private handPinchPoint(side: VrHandSide, out: THREE.Vector3): boolean {
    const { tracking } = this.deps;
    if (!tracking.getTrackedHandJointPosition(side, 'thumb-tip', out) || !tracking.getTrackedHandJointPosition(side, 'middle-finger-tip', tmpC)) return false;
    out.add(tmpC).multiplyScalar(0.5);
    return true;
  }

  private openHalo(input: HaloSummon['input'], side: VrHandSide, at: THREE.Vector3, camera: THREE.Camera, nowMs: number, handedness: Handedness): void {
    camera.updateWorldMatrix(true, false);
    const head = camera.getWorldPosition(new THREE.Vector3());
    // One ring per 5 cm of distance, so its sizes hold at the distance it opens at.
    const distanceM = Math.max(0.2, Math.round(head.distanceTo(at) * 20) / 20);
    const key = Math.round(distanceM * 100);
    let halo = this.halos.get(key);
    if (!halo) {
      halo = new ThreeHalo({ actions: CAPTURE_HALO_ACTIONS, distanceM, input: input === 'hands' ? 'poke' : 'ray' });
      this.halos.set(key, halo);
    }
    halo.group.position.copy(at);
    // Facing the head, upright.
    halo.group.lookAt(head.x, at.y, head.z);
    this.deps.root.add(halo.group);
    halo.group.visible = true;
    this.summon = { input, side, atMs: nowMs, halo, origin: this.headFrame(at, camera), handedness };
    this.lastPointed = null;
    this.stepHalo({ type: 'press', atMs: nowMs });
  }

  private stepHalo(event: HaloEvent): void {
    const summon = this.summon;
    if (!summon) return;
    const result = summon.halo.handle(event);
    this.haloDrawn = result.ringDrawn;
    if (result.commit) {
      this.log.push({ kind: 'halo', input: summon.input, direction: result.commit.direction, action: result.commit.action, flick: result.commit.flick });
      if (result.commit.action) this.deps.onHaloAction(result.commit.action, summon.input, summon.side, summon.halo.group.getWorldPosition(new THREE.Vector3()));
    }
  }

  private closeHalo(event: Extract<HaloEvent, { type: 'release' | 'cancel' }>): void {
    if (!this.summon) return;
    this.stepHalo(event);
    const { halo } = this.summon;
    halo.group.visible = false;
    halo.group.removeFromParent();
    this.summon = null;
    this.haloDrawn = false;
    this.lastPointed = null;
  }

  /** A point in the head's yaw frame: x right, y up, z back, metres from the head. */
  private headFrame(point: THREE.Vector3, camera: THREE.Camera): THREE.Vector3 {
    camera.updateWorldMatrix(true, false);
    const head = camera.getWorldPosition(tmpB);
    const forward = camera.getWorldDirection(tmpC);
    const yaw = Math.atan2(-forward.x, -forward.z);
    return point.clone().sub(head).applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
  }

  private dragInHeadFrame(summon: HaloSummon, point: THREE.Vector3, camera: THREE.Camera): { dx: number; dy: number } {
    const now = this.headFrame(point, camera);
    return { dx: summon.halo.apxFromMetres(now.x - summon.origin.x), dy: summon.halo.apxFromMetres(now.y - summon.origin.y) };
  }

  dispose(): void {
    this.unbind?.();
    for (const halo of this.halos.values()) halo.dispose();
    this.halos.clear();
  }
}
