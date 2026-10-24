import { PHONE_EDGES, TOUCH_HOLD_SLOP_APX } from '@holoim/xr-ui-core';
import { tokens } from '@holoim/design-tokens';

/** A touch walk stick: where it went down and where the finger is now, CSS px. */
export interface TouchStick {
  origin: { x: number; y: number };
  current: { x: number; y: number };
}

export interface TouchInputOptions {
  domElement: HTMLElement;
  isXrPresenting: () => boolean;
  /** −1..1 each way; x right, y forward. Zero on release. */
  onMove: (x: number, y: number) => void;
  /** A look drag, CSS px since the last event. */
  onLook: (dx: number, dy: number) => void;
  /** The stick appeared, moved or left (null). */
  onStick: (stick: TouchStick | null) => void;
}

// The share of the screen's width, from the left, where a touch walks; a
// touch anywhere else on the scene looks. Help text says "the left of the
// screen", so this is a rule of the copy, not of the styleguide.
const WALK_SHARE = 0.4;
// Full travel of the stick: one touch target from where the finger went down.
export const STICK_TRAVEL_APX = tokens.hit.touch;

/**
 * Phone capture by touch (docs/features/ui-redesign.md, slice 4): drag on
 * the left of the scene to walk with a stick that appears under the finger,
 * drag anywhere else to look. Touches that start in the back-swipe edges are
 * left to the system (styleguide 6.1, "Phone edges"); the dock's controls
 * sit above the scene and never reach it.
 */
export class TouchInput {
  private stickId: number | null = null;
  private stick: TouchStick | null = null;
  private readonly lookPointers = new Map<number, { x: number; y: number }>();

  constructor(private readonly options: TouchInputOptions) {}

  init(): void {
    const element = this.options.domElement;
    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerup', this.onPointerEnd);
    element.addEventListener('pointercancel', this.onPointerEnd);
  }

  /** Blur, hidden page or XR entry: every touch ends. */
  reset(): void {
    if (this.stickId !== null) this.options.onMove(0, 0);
    this.stickId = null;
    this.stick = null;
    this.lookPointers.clear();
    this.options.onStick(null);
  }

  snapshot(): { stick: TouchStick | null; looking: number } {
    return { stick: this.stick, looking: this.lookPointers.size };
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch' || this.options.isXrPresenting()) return;
    const width = window.innerWidth;
    // The back-swipe edges and the home bar are the system's.
    if (event.clientX < PHONE_EDGES.side || event.clientX > width - PHONE_EDGES.side || event.clientY > window.innerHeight - PHONE_EDGES.bottom) return;
    event.preventDefault();
    this.options.domElement.setPointerCapture?.(event.pointerId);
    const point = { x: event.clientX, y: event.clientY };
    if (this.stickId === null && event.clientX < width * WALK_SHARE) {
      this.stickId = event.pointerId;
      this.stick = { origin: point, current: point };
      this.options.onStick(this.stick);
      return;
    }
    this.lookPointers.set(event.pointerId, point);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return;
    const point = { x: event.clientX, y: event.clientY };
    if (event.pointerId === this.stickId && this.stick) {
      this.stick = { origin: this.stick.origin, current: point };
      const dx = point.x - this.stick.origin.x;
      const dy = point.y - this.stick.origin.y;
      const length = Math.hypot(dx, dy);
      // Inside the hold slop the finger is resting, not walking.
      if (length < TOUCH_HOLD_SLOP_APX / 2) this.options.onMove(0, 0);
      else {
        const scale = Math.min(1, length / STICK_TRAVEL_APX) / length;
        this.options.onMove(dx * scale, -dy * scale);
      }
      this.options.onStick(this.stick);
      return;
    }
    const last = this.lookPointers.get(event.pointerId);
    if (!last) return;
    this.lookPointers.set(event.pointerId, point);
    this.options.onLook(point.x - last.x, point.y - last.y);
  };

  private readonly onPointerEnd = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return;
    if (event.pointerId === this.stickId) {
      this.stickId = null;
      this.stick = null;
      this.options.onMove(0, 0);
      this.options.onStick(null);
    }
    this.lookPointers.delete(event.pointerId);
  };
}
