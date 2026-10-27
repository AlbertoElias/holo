import { HELD_IDLE, HOLD_DELAY_MS, PHONE_EDGES, TOUCH_HOLD_SLOP_APX, stepHeldMode, type HeldModeEvent, type HeldModeState } from '@holoim/xr-ui-core';
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
  /** Touch and hold on the scene (slice 5): the mark "this" starts, its finger moves, or it ends. CSS px. */
  /** A look-side touch went down at this point (CSS px): true when it grabbed a prop, so it does not start a point hold. */
  onObjectPress?: (point: { x: number; y: number }) => boolean;
  /** The touch that grabbed a prop lifted or was cancelled. */
  onObjectRelease?: () => void;
  onHold?: (phase: 'start' | 'move' | 'end', point: { x: number; y: number }) => void;
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
 * sit above the scene and never reach it. A look touch that rests inside
 * the slop for the hold delay becomes the held mark "this" (styleguide 6.1,
 * "Holds"): from then on the finger aims and the view stays still, until it
 * lifts. The walk side never holds, so a resting thumb on the stick never marks.
 */
export class TouchInput {
  private stickId: number | null = null;
  private stick: TouchStick | null = null;
  private readonly lookPointers = new Map<number, { x: number; y: number }>();
  private held: HeldModeState = HELD_IDLE;
  private holdDown: { id: number; x: number; y: number } | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** The look touch that holds a prop: it still looks when dragged, never points. */
  private grabId: number | null = null;

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
    this.feedHold({ type: 'blur' });
    if (this.stickId !== null) this.options.onMove(0, 0);
    this.stickId = null;
    this.stick = null;
    this.endGrab();
    this.lookPointers.clear();
    this.options.onStick(null);
  }

  snapshot(): { stick: TouchStick | null; looking: number; hold: HeldModeState['phase'] } {
    return { stick: this.stick, looking: this.lookPointers.size, hold: this.held.phase };
  }

  private endGrab(): void {
    if (this.grabId === null) return;
    this.grabId = null;
    this.options.onObjectRelease?.();
  }

  private feedHold(event: HeldModeEvent, point?: { x: number; y: number }): void {
    const before = this.held;
    const step = stepHeldMode(this.held, event);
    this.held = step.state;
    if (this.held.phase !== 'pending' && this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    const at = point ?? (this.holdDown ? this.lookPointers.get(this.holdDown.id) ?? this.holdDown : { x: 0, y: 0 });
    if (step.started) {
      this.options.onHold?.('start', at);
      // A short buzz where the device has one: the hold began.
      try {
        navigator.vibrate?.(10);
      } catch {
        // Feedback only.
      }
    }
    if (step.ended && before.phase === 'held') this.options.onHold?.('end', at);
    if (this.held.phase === 'idle') this.holdDown = null;
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
    // A look touch that lands on a reachable prop picks it up; it never becomes a point hold.
    const grabbed = this.grabId === null && (this.options.onObjectPress?.(point) ?? false);
    if (grabbed) this.grabId = event.pointerId;
    this.lookPointers.set(event.pointerId, point);
    if (!grabbed && this.held.phase === 'idle' && this.lookPointers.size === 1) {
      this.holdDown = { id: event.pointerId, ...point };
      this.feedHold({ type: 'press', source: `touch:${event.pointerId}`, atMs: event.timeStamp, delayMs: HOLD_DELAY_MS });
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null;
        this.feedHold({ type: 'tick', atMs: Number.POSITIVE_INFINITY });
      }, HOLD_DELAY_MS);
    }
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
    const source = `touch:${event.pointerId}`;
    if (this.held.phase === 'held' && this.held.source === source) {
      this.options.onHold?.('move', point);
      return;
    }
    if (this.held.phase === 'pending' && this.held.source === source && this.holdDown) {
      this.feedHold({ type: 'move', source, distanceApx: Math.hypot(point.x - this.holdDown.x, point.y - this.holdDown.y) });
    }
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
    if (event.pointerId === this.grabId) this.endGrab();
    const point = this.lookPointers.get(event.pointerId);
    this.lookPointers.delete(event.pointerId);
    this.feedHold(event.type === 'pointercancel' ? { type: 'trackingLost', source: `touch:${event.pointerId}` } : { type: 'release', source: `touch:${event.pointerId}`, atMs: event.timeStamp }, point);
  };
}
