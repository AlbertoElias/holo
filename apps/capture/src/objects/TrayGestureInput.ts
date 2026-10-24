import * as THREE from 'three';

import type { VrHandSide } from '../types/contracts';
import type { XrTracking } from '../xr/XrTracking';

// xr-standard mapping on Touch controllers: buttons[4] is X/A, buttons[5] Y/B.
// X is the design language's "Speak" hold, so the tray uses Y.
const TRAY_BUTTON = 5;
const BUTTON_ON = 0.5;
// Palm up: the palm normal against world up, with hysteresis and a dwell, so
// a palm turned while explaining does not open the tray.
const PALM_UP_ON = 0.7;
const PALM_UP_OFF = 0.4;
const PALM_DWELL_SEC = 0.25;
// The holding hand lost (the other reaching over it, say): keep the tray open this long.
const LOST_HOLD_SEC = 0.5;

export type TrayGestureSource = 'button' | 'palm' | 'key' | 'none';

interface InputSourceLike {
  handedness: string;
  hand?: unknown;
  gamepad?: { buttons?: ReadonlyArray<{ value?: number; pressed?: boolean }> };
}

/**
 * The held tray gesture (PRD-045): the holding controller's upper face button
 * (Y on the left, B on the right), that palm turned up, or T on desktop. The
 * holding hand is the non-dominant one (handedness). The tray is open only
 * while it is held.
 */
export class TrayGestureInput {
  private held = false;
  private source: TrayGestureSource = 'none';
  private palmUpSec = 0;
  private lostSec = 0;
  private palmDot: number | null = null;
  private readonly wrist = new THREE.Vector3();
  private readonly indexBase = new THREE.Vector3();
  private readonly pinkyBase = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly toPinky = new THREE.Vector3();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly tracking: XrTracking
  ) {}

  update(step: { vrActive: boolean; deltaSec: number; desktopHeld: boolean; hand: VrHandSide }): boolean {
    if (!step.vrActive) {
      this.palmUpSec = this.lostSec = 0;
      this.palmDot = null;
      this.held = step.desktopHeld;
      this.source = this.held ? 'key' : 'none';
      return this.held;
    }
    const session = this.renderer.xr.isPresenting ? this.renderer.xr.getSession() : null;
    const holder = session ? ([...session.inputSources].find((s) => s.handedness === step.hand) as InputSourceLike | undefined) : undefined;
    if (holder?.hand) {
      const dot = this.readPalmUp(step.hand);
      this.palmDot = dot;
      if (dot === null) {
        this.lostSec += step.deltaSec;
        if (this.lostSec >= LOST_HOLD_SEC) this.held = false;
      } else {
        this.lostSec = 0;
        if (this.held) {
          this.held = dot > PALM_UP_OFF;
        } else {
          this.palmUpSec = dot >= PALM_UP_ON ? this.palmUpSec + step.deltaSec : 0;
          this.held = this.palmUpSec >= PALM_DWELL_SEC;
        }
      }
      if (!this.held && (dot === null || dot < PALM_UP_ON)) this.palmUpSec = 0;
      this.source = 'palm';
      return this.held;
    }
    this.palmUpSec = 0;
    this.palmDot = null;
    const button = holder?.gamepad?.buttons?.[TRAY_BUTTON];
    if (button) {
      this.lostSec = 0;
      this.held = (button.value ?? (button.pressed ? 1 : 0)) >= BUTTON_ON;
      this.source = 'button';
      return this.held;
    }
    // No holding input this frame: hold briefly, then close.
    this.lostSec += step.deltaSec;
    if (this.lostSec >= LOST_HOLD_SEC || !session) this.held = false;
    this.source = 'none';
    return this.held;
  }

  isHeld(): boolean {
    return this.held;
  }

  snapshot(): { held: boolean; source: TrayGestureSource; palmUp: number | null } {
    return { held: this.held, source: this.source, palmUp: this.palmDot };
  }

  reset(): void {
    this.held = false;
    this.source = 'none';
    this.palmUpSec = this.lostSec = 0;
    this.palmDot = null;
  }

  /** The palm normal's dot with world up, or null without the joints. */
  private readPalmUp(side: VrHandSide): number | null {
    const t = this.tracking;
    if (!t.getTrackedHandJointPosition(side, 'wrist', this.wrist)
      || !t.getTrackedHandJointPosition(side, 'index-finger-metacarpal', this.indexBase)
      || !t.getTrackedHandJointPosition(side, 'pinky-finger-metacarpal', this.pinkyBase)) return null;
    // Left hand: (pinky − wrist) × (index − wrist) points out of the palm; the right hand mirrors it.
    this.toPinky.subVectors(this.pinkyBase, this.wrist);
    this.normal.subVectors(this.indexBase, this.wrist);
    if (side === 'left') this.normal.crossVectors(this.toPinky, this.normal);
    else this.normal.crossVectors(this.normal, this.toPinky);
    if (this.normal.lengthSq() < 1e-10) return null;
    return this.normal.normalize().y;
  }
}
