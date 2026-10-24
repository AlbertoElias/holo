// The Halo (styleguide 6.2): one radial menu with eight fixed directions. A
// hold draws it after 300 ms; a flick commits without ever drawing it. The
// state machine is the core's `stepHalo`; this maps pointer events to it and
// its result to elements.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { tokens } from "@holoim/design-tokens";
import {
  HALO_CLOSED,
  glyphAppearance,
  glyphDrawing,
  haloLayout,
  stepHalo,
  type HaloAction,
  type HaloCommit,
  type HaloDirection,
  type HaloEvent,
  type HaloState,
  type HaloStep
} from "@holoim/xr-ui-core";

import { GlyphSvg, RingSvg } from "./glyphSvg.js";

export interface HaloViewState {
  /** The ring and slots are drawn. */
  ringDrawn: boolean;
  /** The direction the movement points at. */
  highlighted: HaloDirection | null;
}

export interface HaloProps {
  /** The actions this Halo carries; every other direction stays empty. */
  actions: readonly HaloAction[];
  /** Called with a commit that has an action; empty directions and cancels never call it. */
  onCommit: (commit: HaloCommit) => void;
  /** What the press starts on. An element, or a function of the Halo's state. Defaults to an empty ring. */
  trigger?: ReactNode | ((state: HaloViewState) => ReactNode);
}

const CLOSED_VIEW: HaloViewState = { ringDrawn: false, highlighted: null };

export function Halo({ actions, onCommit, trigger }: HaloProps) {
  const layout = useMemo(() => haloLayout(actions, { headset: false }), [actions]);
  const [view, setView] = useState<HaloViewState>(CLOSED_VIEW);
  const machine = useRef<HaloState>(HALO_CLOSED);
  const origin = useRef({ x: 0, y: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ layout, onCommit });
  latest.current = { layout, onCommit };

  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const feed = useCallback((event: HaloEvent) => {
    const step: HaloStep = stepHalo(machine.current, event, latest.current.layout);
    machine.current = step.state;
    setView((previous) =>
      previous.ringDrawn === step.ringDrawn && previous.highlighted === step.highlighted
        ? previous
        : { ringDrawn: step.ringDrawn, highlighted: step.highlighted }
    );
    if (step.commit?.action) latest.current.onCommit(step.commit);
  }, []);

  const cancel = useCallback(() => {
    clearTimer();
    feed({ type: "cancel" });
  }, [clearTimer, feed]);

  useEffect(() => {
    // A held mode ends on blur (6.1).
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      clearTimer();
    };
  }, [cancel, clearTimer]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || machine.current.phase !== "closed") return;
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
      data-halo=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={cancel}
      style={{ position: "relative", display: "inline-flex", touchAction: "none", userSelect: "none", WebkitUserSelect: "none" }}
    >
      {triggerNode}
      {view.ringDrawn ? (
        <div data-halo-ring="" style={{ position: "absolute", left: "50%", top: "50%", width: 0, height: 0, pointerEvents: "none" }}>
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
              {slot.action === null ? null : (
                <div data-halo-slot={slot.direction} data-action={slot.action} data-highlighted={view.highlighted === slot.direction ? "" : undefined}>
                  <HaloSlotDrawing action={slot.action} highlighted={view.highlighted === slot.direction} slotApx={layout.slotApx} />
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Record has a decided drawing; every other action is an empty gold ring of the slot size until one is. */
function HaloSlotDrawing({ action, highlighted, slotApx }: { action: HaloAction; highlighted: boolean; slotApx: number }) {
  const appearance = glyphAppearance({ hovered: highlighted }, { headset: false });
  return action === "record"
    ? <GlyphSvg drawing={glyphDrawing("record")} appearance={appearance} />
    : <RingSvg sizeApx={slotApx} appearance={appearance} />;
}
