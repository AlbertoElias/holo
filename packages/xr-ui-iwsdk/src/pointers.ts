import type { World } from "@iwsdk/core";
import type { Object3D } from "three";

// How both apps take IWSDK's pointers (styleguide §6.1): a poke commits on
// contact, and the aim ray is the gold line (`AimRays`), so IWSDK's own ray
// and cursor stay hidden. The distances were set for capture's slice 4
// (docs/features/ui-redesign.md) and are open to revisit.

export const POKE = {
  /** The fingertip shade shows this far in front of a glyph's face. */
  proximityM: 0.1,
  /** A fingertip this close to the face (or through it) commits. */
  contactM: 0.008,
  /** Below the face a fingertip still counts as near, so a fast poke is not missed. */
  throughM: 0.04,
  /** One poke per approach: the finger must be this far in front again before the next. */
  rearmM: 0.03
} as const;

export type XrHand = "left" | "right";

interface PointerLike {
  id: number;
  options: { downRadius?: number };
  getIntersection(): { distance: number; object: Object3D & { isVoidObject?: boolean } } | undefined;
  getEnabled(): boolean;
}

interface MultiPointerLike {
  ray: { pointer: PointerLike; visual: { rayDisplayMode: number } };
  grab: { pointer: PointerLike };
  touch: { pointer: PointerLike };
  cursorVisual: { setVisible(visible: boolean): void };
}

/** IWSDK's per-hand pointers (ray, grab, touch); not part of its typed API. */
export function multiPointer(world: World, hand: XrHand): MultiPointerLike {
  return (world.input.xr as unknown as { multiPointers: Record<XrHand, MultiPointerLike> }).multiPointers[hand];
}

/** Every IWSDK pointer id of one hand, for filters that keep a hand off its own dock. */
export function handPointerIds(world: World, hand: XrHand): number[] {
  const pointers = multiPointer(world, hand);
  return [pointers.ray.pointer.id, pointers.grab.pointer.id, pointers.touch.pointer.id];
}

/** The hand an IWSDK pointer id belongs to, or null for any other pointer (a phone tap). */
export function pointerHand(world: World, pointerId: number): XrHand | null {
  for (const hand of ["left", "right"] as const) if (handPointerIds(world, hand).includes(pointerId)) return hand;
  return null;
}

const RAY_INVISIBLE = 3; // RayDisplayMode.Invisible

/**
 * Configures IWSDK's pointers for HoloIM: the touch pointer presses at
 * `POKE.contactM` (IWSDK's default 2 cm presses before the finger arrives),
 * and IWSDK's ray and cursor never draw.
 */
export function configureXrPointers(world: World): void {
  for (const hand of ["left", "right"] as const) {
    const pointers = multiPointer(world, hand);
    pointers.touch.pointer.options.downRadius = POKE.contactM;
    pointers.ray.visual.rayDisplayMode = RAY_INVISIBLE;
    pointers.cursorVisual.setVisible(false);
    pointers.cursorVisual.setVisible = () => undefined;
  }
}
