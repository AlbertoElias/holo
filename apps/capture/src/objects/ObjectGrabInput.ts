import * as THREE from 'three';

import type { VrHandSide } from '../types/contracts';
import type { XrTracking } from '../xr/XrTracking';

// Hysteresis, so a value at the threshold cannot flicker a grab on and off.
const SQUEEZE_ON = 0.6;
const SQUEEZE_OFF = 0.3;
const PINCH_ON_M = 0.02;
const PINCH_OFF_M = 0.04;
// xr-standard gamepad mapping: buttons[1] is squeeze (grip). buttons[0] is
// the trigger, which the VR HUD already uses to toggle recording.
const SQUEEZE_BUTTON = 1;

export type GrabInputSource = 'squeeze' | 'pinch' | 'none';

export interface GrabIntent {
  pressed: boolean;
  source: GrabInputSource;
  /** Squeeze value (0..1) or pinch distance (m) behind `pressed`. */
  value: number | null;
  /** The source changed between controller and hand this update: a release now is not a deliberate let-go. */
  switched: boolean;
}

interface InputSourceLike {
  handedness: string;
  hand?: unknown;
  gamepad?: { buttons?: ReadonlyArray<{ value?: number; pressed?: boolean }> };
}

/**
 * Per-hand grab intent in XR: a controller's squeeze button, or a tracked
 * hand's thumb–index pinch. Reads the session's input sources directly; the
 * pinch reads the joints `XrTracking` captured this frame.
 */
export class ObjectGrabInput {
  private readonly state: Record<VrHandSide, GrabIntent> = {
    left: { pressed: false, source: 'none', value: null, switched: false },
    right: { pressed: false, source: 'none', value: null, switched: false }
  };
  private readonly thumb = new THREE.Vector3();
  private readonly index = new THREE.Vector3();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly tracking: XrTracking
  ) {}

  update(): void {
    const session = this.renderer.xr.isPresenting ? this.renderer.xr.getSession() : null;
    for (const side of ['left', 'right'] as const) {
      const state = this.state[side];
      const source = session ? [...session.inputSources].find((s) => s.handedness === side) as InputSourceLike | undefined : undefined;
      // A switch between controller and hand mid-hold releases: the two
      // thresholds mean different things.
      const kind: GrabInputSource = source?.hand ? 'pinch' : source?.gamepad?.buttons?.[SQUEEZE_BUTTON] ? 'squeeze' : 'none';
      state.switched = kind !== 'none' && state.source !== 'none' && kind !== state.source;
      if (state.switched) state.pressed = false;
      if (source?.hand) {
        const tracked = this.tracking.getTrackedHandJointPosition(side, 'thumb-tip', this.thumb)
          && this.tracking.getTrackedHandJointPosition(side, 'index-finger-tip', this.index);
        const distance = tracked ? this.thumb.distanceTo(this.index) : null;
        state.source = 'pinch';
        state.value = distance;
        state.pressed = distance === null ? state.pressed : state.pressed ? distance < PINCH_OFF_M : distance < PINCH_ON_M;
        continue;
      }
      const button = source?.gamepad?.buttons?.[SQUEEZE_BUTTON];
      if (button) {
        const value = button.value ?? (button.pressed ? 1 : 0);
        state.source = 'squeeze';
        state.value = value;
        state.pressed = state.pressed ? value > SQUEEZE_OFF : value >= SQUEEZE_ON;
        continue;
      }
      // The input went away (a controller lost or asleep): keep the last
      // intent, so a held object freezes and the loss rule releases it.
      if (!session) state.pressed = false;
      state.source = 'none';
      state.value = null;
    }
  }

  get(side: VrHandSide): Readonly<GrabIntent> {
    return this.state[side];
  }

  reset(): void {
    for (const side of ['left', 'right'] as const) this.state[side] = { pressed: false, source: 'none', value: null, switched: false };
  }
}
