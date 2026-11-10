import type { HaloDirection } from '@holoim/xr-ui-core';

import type {} from '../../src/runtime/automationHooks';

declare global {
  interface Window {
    /** Puts one IWER hand in a pose by id (`middlePinch`, IWER's `pinch`, the blend's `blend`), pinch value 0. */
    __setHandPoseId?: (side: 'left' | 'right', poseId: string) => void;
  }
}

// The headset hands Halo in IWER scripts (docs/features/ui-redesign.md, slice
// 5): the dominant hand's thumb–middle pinch summons it where the pinch is,
// a drag in the head's frame picks a direction, and letting go commits it.
// Shared by the held-mark check and the hand-trace takes.

/** How far a summon drags, metres in the head's frame (past the ring's dead zone, inside its reach). */
export const HALO_DRAG_M = 0.12;

/** The drag, in the head's frame (x right, y up), that picks `direction`. */
export function haloDrag(direction: HaloDirection, distance = HALO_DRAG_M): { dx: number; dy: number } {
  const index = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'].indexOf(direction);
  const fromNorthClockwise = (index * Math.PI) / 4;
  const round = (value: number) => (Math.abs(value) < 1e-9 ? 0 : value);
  return { dx: round(distance * Math.sin(fromNorthClockwise)), dy: round(distance * Math.cos(fromNorthClockwise)) };
}

/**
 * A summon's stages after the pinch closes: held still, dragged out, held at
 * the slot; the release after the last stage commits. `drag(t)` is the
 * share of the drag done at `t` (0–1) through the stage.
 */
export const HALO_PINCH_STAGES: ReadonlyArray<{ sec: number; drag: (t: number) => number }> = [
  { sec: 0.5, drag: () => 0 },
  { sec: 0.4, drag: (t) => t },
  { sec: 0.2, drag: () => 1 }
];

/** Seconds from the pinch closing (the Halo's press) to its release (the commit). */
export const HALO_PINCH_SEC = HALO_PINCH_STAGES.reduce((sum, stage) => sum + stage.sec, 0);

/**
 * Installs a thumb–middle pinch pose (`middlePinch`) on both IWER hands —
 * IWER's default pose with the middle fingertip moved onto the thumb tip, the
 * index clear of the thumb — and `window.__setHandPoseId`. Pass it to
 * `page.evaluate`; it returns each hand's thumb–index gap in the new pose.
 */
export function installMiddlePinchPose(): Record<'left' | 'right', { middle: number; index: number }> {
  type Pose = { jointTransforms: Record<string, { offsetMatrix: Float32Array; radius: number }>; gripOffsetMatrix?: Float32Array };
  const gaps = {} as Record<'left' | 'right', { middle: number; index: number }>;
  for (const side of ['left', 'right'] as const) {
    const hand = window.IWER_DEVICE!.hands[side]!;
    // IWER keeps the poses under a private symbol key; XRHandInput's types hide it.
    const internals = hand as unknown as Record<symbol, { poses: Record<string, Pose> } | undefined>;
    const key = Object.getOwnPropertySymbols(hand).find((symbol) => internals[symbol]?.poses)!;
    const { poses } = internals[key]!;
    const base = poses.default!;
    const jointTransforms = Object.fromEntries(Object.entries(base.jointTransforms).map(([joint, value]) => [joint, { offsetMatrix: new Float32Array(value.offsetMatrix), radius: value.radius }]));
    const thumb = jointTransforms['thumb-tip']!.offsetMatrix;
    const middle = jointTransforms['middle-finger-tip']!.offsetMatrix;
    const index = jointTransforms['index-finger-tip']!.offsetMatrix;
    for (const i of [12, 13, 14]) middle[i] = thumb[i]!;
    poses.middlePinch = base.gripOffsetMatrix ? { jointTransforms, gripOffsetMatrix: base.gripOffsetMatrix } : { jointTransforms };
    gaps[side] = { middle: 0, index: Math.hypot(index[12]! - thumb[12]!, index[13]! - thumb[13]!, index[14]! - thumb[14]!) };
  }
  // The hands share IWER's pose table, so its one "blend" pose cannot hold
  // two shapes; a pinching hand takes its pose by id instead.
  window.__setHandPoseId = (side, poseId) => {
    const hand = window.IWER_DEVICE!.hands[side]!;
    hand.poseId = poseId;
    hand.updatePinchValue(0);
    hand.updateHandPose();
  };
  return gaps;
}
