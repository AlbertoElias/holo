// The Halo (styleguide 6.2): one radial menu with eight fixed directions. A
// hold draws it after 300 ms; a flick commits without ever drawing it. A
// press released in the centre (a click) leaves the ring open, and a click
// on a direction commits it. The state machine is the core's `stepHalo`;
// this maps pointer events to it and its result to elements.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { tokens } from "@holoim/design-tokens";
import {
  HALO_CLOSED,
  glyphAppearance,
  glyphDrawing,
  haloLayout,
  haloSlotGlyph,
  stepHalo,
  type HaloAction,
  type HaloCommit,
  type HaloDirection,
  type HaloEvent,
  type HaloLayout,
  type HaloState,
  type HaloStep
} from "@holoim/xr-ui-core";

import { GlyphSvg, RingSvg } from "./glyphSvg.js";

export interface HaloViewState {
  /** The ring and slots are drawn. */
  ringDrawn: boolean;
  /** The direction the movement points at. */
  highlighted: HaloDirection | null;
  /** Opened by a click: the ring stays until a direction is clicked or the press lands elsewhere. */
  pinned: boolean;
}

export interface HaloProps {
  /** The actions this Halo carries; every other direction stays empty. */
  actions: readonly HaloAction[];
  /** Called with a commit that has an action; empty directions and cancels never call it. */
  onCommit: (commit: HaloCommit) => void;
  /** What the press starts on. An element, or a function of the Halo's state. Defaults to an empty ring. */
  trigger?: ReactNode | ((state: HaloViewState) => ReactNode);
  /** Draws the ring this far above the trigger, apx, so a trigger by a screen edge keeps every place in view. Movement still counts from the press. */
  ringLiftApx?: number;
}

const CLOSED_VIEW: HaloViewState = { ringDrawn: false, highlighted: null, pinned: false };

const SLOT_LABELS: Partial<Record<HaloAction, string>> = { record: "Record", undo: "Undo mark", redo: "Redo mark" };

export function Halo({ actions, onCommit, trigger, ringLiftApx = 0 }: HaloProps) {
  const layout = useMemo(() => haloLayout(actions, { headset: false }), [actions]);
  const [view, setView] = useState<HaloViewState>(CLOSED_VIEW);
  const machine = useRef<HaloState>(HALO_CLOSED);
  const origin = useRef({ x: 0, y: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef({ layout, onCommit });
  latest.current = { layout, onCommit };

  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const feed = useCallback((event: HaloEvent) => {
    const step: HaloStep = stepHalo(machine.current, event, latest.current.layout);
    machine.current = step.state;
    // Released in the centre: the ring stays open for a click.
    const pinned = event.type === "release" && step.commit === null;
    setView((previous) =>
      previous.ringDrawn === (step.ringDrawn || pinned) && previous.highlighted === step.highlighted && previous.pinned === pinned
        ? previous
        : { ringDrawn: step.ringDrawn || pinned, highlighted: step.highlighted, pinned }
    );
    if (step.commit?.action) latest.current.onCommit(step.commit);
  }, []);

  const unpin = useCallback(() => setView((previous) => (previous.pinned ? CLOSED_VIEW : previous)), []);

  const pick = useCallback((direction: HaloDirection, action: HaloAction) => {
    setView(CLOSED_VIEW);
    latest.current.onCommit({ direction, action, flick: false });
  }, []);

  const cancel = useCallback(() => {
    clearTimer();
    feed({ type: "cancel" });
  }, [clearTimer, feed]);

  useEffect(() => {
    if (!view.pinned) return undefined;
    // A press anywhere but the ring, or Escape, closes a pinned ring.
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) unpin();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") unpin();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, [view.pinned, unpin]);

  useEffect(() => {
    // A held mode ends on blur (6.1).
    const blur = () => {
      cancel();
      unpin();
    };
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("blur", blur);
      clearTimer();
    };
  }, [cancel, clearTimer, unpin]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || machine.current.phase !== "closed") return;
    // The trigger pressed again closes a pinned ring.
    if (view.pinned) {
      unpin();
      return;
    }
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Capture is a refinement; the Halo still works without it.
    }
    origin.current = { x: event.clientX, y: event.clientY };
    const pressedAt = Date.now();
    feed({ type: "press", atMs: pressedAt });
    clearTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      // The timer is the proof that the hold delay passed, whatever the clock's rounding.
      feed({ type: "tick", atMs: Math.max(Date.now(), pressedAt + tokens.motion.hold.delay) });
    }, tokens.motion.hold.delay);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (machine.current.phase === "closed") return;
    // Apx with y up, as the core expects.
    feed({ type: "move", atMs: Date.now(), dx: event.clientX - origin.current.x, dy: -(event.clientY - origin.current.y) });
  };

  const onPointerUp = () => {
    if (machine.current.phase === "closed") return;
    clearTimer();
    feed({ type: "release", atMs: Date.now() });
  };

  const rest = glyphAppearance({}, { headset: false });
  const triggerNode = typeof trigger === "function"
    ? trigger(view)
    : (trigger ?? <RingSvg sizeApx={layout.slotApx} appearance={rest} />);

  return (
    <div
      ref={root}
      data-halo=""
      data-halo-pinned={view.pinned ? "" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={cancel}
      style={{ position: "relative", display: "inline-flex", touchAction: "none", userSelect: "none", WebkitUserSelect: "none" }}
    >
      {triggerNode}
      {view.ringDrawn ? <HaloRing layout={layout} highlighted={view.highlighted} liftApx={ringLiftApx} onPick={view.pinned ? pick : undefined} /> : null}
    </div>
  );
}

export interface HaloRingProps {
  /** From `haloLayout(actions, { headset: false })`. */
  layout: HaloLayout;
  highlighted: HaloDirection | null;
  /** Moves the drawing up from its parent's centre, apx. */
  liftApx?: number;
  /** Makes each direction with an action a button that commits it (a ring opened by a click). */
  onPick?: ((direction: HaloDirection, action: HaloAction) => void) | undefined;
}

/**
 * The drawn ring alone, centred on its parent's centre: eight reserved
 * places, a glyph ring where a direction has an action. `Halo` draws it for
 * a pointer; an app draws it for any other summon (a held key) from the
 * same `stepHalo` state.
 */
export function HaloRing({ layout, highlighted, liftApx = 0, onPick }: HaloRingProps) {
  const [hovered, setHovered] = useState<HaloDirection | null>(null);
  return (
    <div data-halo-ring="" style={{ position: "absolute", left: "50%", top: liftApx ? `calc(50% - ${liftApx}px)` : "50%", width: 0, height: 0, pointerEvents: "none" }}>
      {layout.slots.map((slot) => (
        <div
          key={slot.direction}
          data-halo-place={slot.direction}
          style={{
            position: "absolute",
            left: slot.x,
            top: -slot.y,
            width: layout.slotApx,
            height: layout.slotApx,
            transform: "translate(-50%, -50%)"
          }}
        >
          {slot.action === null ? null : onPick ? (
            <button
              type="button"
              data-halo-slot={slot.direction}
              data-action={slot.action}
              data-highlighted={hovered === slot.direction ? "" : undefined}
              aria-label={SLOT_LABELS[slot.action] ?? slot.action}
              // Kept from the trigger's press handler, which would close the ring first.
              onPointerDown={(event) => event.stopPropagation()}
              onPointerEnter={() => setHovered(slot.direction)}
              onPointerLeave={() => setHovered((current) => (current === slot.direction ? null : current))}
              onClick={() => onPick(slot.direction, slot.action!)}
              style={{ all: "unset", display: "block", cursor: "pointer", pointerEvents: "auto" }}
            >
              <HaloSlotDrawing action={slot.action} highlighted={hovered === slot.direction} slotApx={layout.slotApx} />
            </button>
          ) : (
            <div data-halo-slot={slot.direction} data-action={slot.action} data-highlighted={highlighted === slot.direction ? "" : undefined}>
              <HaloSlotDrawing action={slot.action} highlighted={highlighted === slot.direction} slotApx={layout.slotApx} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Record draws its own ring; undo and redo sit in a gold ring of the slot size; an action with no drawing is the ring alone. */
function HaloSlotDrawing({ action, highlighted, slotApx }: { action: HaloAction; highlighted: boolean; slotApx: number }) {
  const appearance = glyphAppearance({ hovered: highlighted }, { headset: false });
  if (action === "record") return <GlyphSvg drawing={glyphDrawing("record")} appearance={appearance} />;
  const drawn = haloSlotGlyph(action);
  return (
    <div style={{ position: "relative", width: slotApx, height: slotApx }}>
      <RingSvg sizeApx={slotApx} appearance={appearance} />
      {drawn ? (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
          <GlyphSvg drawing={glyphDrawing(drawn)} appearance={appearance} />
        </div>
      ) : null}
    </div>
  );
}
