import { tokens } from '@holoim/design-tokens';
import { FLAT_CAPTURE_HALO_ACTIONS, HALO_CLOSED, haloLayout, stepHalo, type HaloCommit, type HaloDirection, type HaloEvent, type HaloLayout, type HaloState } from '@holoim/xr-ui-core';

/** What the overlay draws for a held key: where the ring opens and what it shows. */
export interface FlatHaloView {
  open: boolean;
  ringDrawn: boolean;
  highlighted: HaloDirection | null;
  /** CSS px: the screen's centre under pointer lock, else the mouse, kept far enough in that the ring fits. */
  at: { x: number; y: number };
}

const CLOSED_VIEW: FlatHaloView = { open: false, ringDrawn: false, highlighted: null, at: { x: 0, y: 0 } };

/**
 * The Halo summoned by a held key on a desktop (slice 5 build plan: B):
 * `stepHalo` on key press, mouse movement and key release, with the hold
 * delay on a timer as `@holoim/ui-dom`'s `Halo` keeps it. The dock's Halo
 * glyph is that component; this is the same machine for the keyboard.
 */
export class FlatHalo {
  readonly layout: HaloLayout = haloLayout(FLAT_CAPTURE_HALO_ACTIONS, { headset: false });
  private state: HaloState = HALO_CLOSED;
  private view: FlatHaloView = CLOSED_VIEW;
  private dx = 0;
  private dy = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly onCommit: (commit: HaloCommit) => void) {}

  isOpen(): boolean {
    return this.state.phase === 'held';
  }

  /** Opens at `at`, moved in just enough that the whole ring stays in the window. */
  press(at: { x: number; y: number }, window: { width: number; height: number } = { width: globalThis.innerWidth, height: globalThis.innerHeight }): void {
    if (this.isOpen()) return;
    this.dx = 0;
    this.dy = 0;
    const pressedAt = Date.now();
    const reach = this.layout.radiusApx + this.layout.slotApx / 2 + tokens.glyph.gap;
    const inside = (value: number, size: number) => (size > reach * 2 ? Math.min(Math.max(value, reach), size - reach) : size / 2);
    this.view = { ...CLOSED_VIEW, open: true, at: { x: inside(at.x, window.width), y: inside(at.y, window.height) } };
    this.feed({ type: 'press', atMs: pressedAt });
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.feed({ type: 'tick', atMs: Math.max(Date.now(), pressedAt + tokens.motion.hold.delay) });
    }, tokens.motion.hold.delay);
  }

  /** Mouse movement since the last call, CSS px with y down (as `movementY`). */
  move(dx: number, dy: number): void {
    if (!this.isOpen()) return;
    this.dx += dx;
    this.dy -= dy;
    this.feed({ type: 'move', atMs: Date.now(), dx: this.dx, dy: this.dy });
  }

  release(): void {
    if (!this.isOpen()) return;
    this.clearTimer();
    this.feed({ type: 'release', atMs: Date.now() });
  }

  /** Blur, hidden page, XR entry: commits nothing. */
  cancel(): void {
    if (!this.isOpen()) return;
    this.clearTimer();
    this.feed({ type: 'cancel' });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): FlatHaloView => this.view;

  private feed(event: HaloEvent): void {
    const step = stepHalo(this.state, event, this.layout);
    this.state = step.state;
    const open = step.state.phase === 'held';
    const next: FlatHaloView = open ? { open, ringDrawn: step.ringDrawn, highlighted: step.highlighted, at: this.view.at } : CLOSED_VIEW;
    if (next.open !== this.view.open || next.ringDrawn !== this.view.ringDrawn || next.highlighted !== this.view.highlighted) {
      this.view = next;
      for (const listener of this.listeners) listener();
    }
    if (step.commit?.action) this.onCommit(step.commit);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
