// The hover hint: a control whose word does not show (a drawing alone, a
// lantern on the dock) names itself on the chip when a mouse rests on it or
// keyboard focus reaches it. Its word is the control's own, gold in the
// control label role, as a word beside a drawing would be (styleguide 2.3, 5.2,
// 6). It fades as chrome does (8). Touch never shows it: the accessible name
// already carries the word for assistive technology, so the hint is hidden
// from it.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { tokens } from "@holoim/design-tokens";
import { VIEW_TARGETS } from "@holoim/xr-ui-core";

import { chipSurfaceStyle } from "./Chip.js";
import { useReducedMotion } from "./internal.js";
import { typeRoleStyle } from "./typeRoles.js";

/** How long a mouse rests before the hint shows. */
const REST_MS = 450;
/** A hint shown within this long of the last one shows at once, so a row reads as the pointer runs along it. */
const WARM_MS = 600;
/** The gap between the control and its hint, and the hint's clearance from the window's edge. */
const GAP_PX = 8;
const EDGE_PX = 8;

let lastHiddenAt = -Infinity;

type Placement = { left: number; top: number };

export interface HintHandlers {
  onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave: () => void;
  onPointerDown: () => void;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
}

/**
 * Wires a hint to a control. Spread `handlers` onto the control (calling any
 * of its own first) and render `hint` anywhere: it is drawn in a portal, fixed
 * above the control, or below it where there is no room above.
 */
export function useHint(label: string | undefined): { handlers: HintHandlers; hint: ReactNode } {
  const anchorRef = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [shown, setShown] = useState(false);
  const [mounted, setMounted] = useState(false);
  const reduced = useReducedMotion();
  const gone = useCallback(() => setMounted(false), []);

  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  const show = useCallback((anchor: HTMLElement, delay: number) => {
    // The label is read at render, so a control that names itself in the same event (a halo slot) still shows.
    anchorRef.current = anchor;
    clear();
    const reveal = () => {
      setMounted(true);
      setShown(true);
    };
    if (delay <= 0) reveal();
    else timer.current = setTimeout(reveal, delay);
  }, []);

  const hide = useCallback(() => {
    clear();
    setShown((was) => {
      if (was) lastHiddenAt = performance.now();
      return false;
    });
  }, []);

  // Escape, a scroll or the window leaving focus takes the hint away.
  useEffect(() => {
    if (!shown) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, [shown, hide]);

  useEffect(() => clear, []);

  const handlers: HintHandlers = {
    onPointerEnter: (event) => {
      if (event.pointerType === "touch") return;
      const warm = performance.now() - lastHiddenAt < WARM_MS;
      show(event.currentTarget, warm ? 0 : REST_MS);
    },
    onPointerLeave: hide,
    onPointerDown: hide,
    onFocus: (event) => {
      let keyboard = false;
      try {
        keyboard = event.currentTarget.matches(":focus-visible");
      } catch {
        keyboard = false;
      }
      if (keyboard) show(event.currentTarget, 0);
    },
    onBlur: hide
  };

  const hint = mounted && label && typeof document !== "undefined"
    ? createPortal(
        <HintBubble
          label={label}
          anchor={anchorRef.current}
          shown={shown}
          reduced={reduced}
          onGone={gone}
        />,
        document.body
      )
    : null;

  return { handlers, hint };
}

function HintBubble({ label, anchor, shown, reduced, onGone }: { label: string; anchor: HTMLElement | null; shown: boolean; reduced: boolean; onGone: () => void }) {
  const bubble = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  const [visible, setVisible] = useState(false);

  // Measure, then place: centred over the control, kept inside the window.
  useLayoutEffect(() => {
    const own = bubble.current;
    if (!own || !anchor) return;
    const at = anchor.getBoundingClientRect();
    const size = own.getBoundingClientRect();
    const roomAbove = at.top - GAP_PX - size.height >= EDGE_PX;
    const top = roomAbove ? at.top - GAP_PX - size.height : at.bottom + GAP_PX;
    const centred = at.left + at.width / 2 - size.width / 2;
    const left = Math.min(Math.max(centred, EDGE_PX), window.innerWidth - EDGE_PX - size.width);
    setPlace({ left, top });
  }, [anchor, label]);

  // Fade in on the frame after placing, so the transition has a start.
  useEffect(() => {
    if (!shown) {
      setVisible(false);
      const done = setTimeout(onGone, reduced ? 0 : tokens.motion.chrome.out);
      return () => clearTimeout(done);
    }
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, [shown, reduced, onGone]);

  const [x1, y1, x2, y2] = tokens.motion.chrome.easing;
  const duration = reduced ? 0 : visible ? tokens.motion.chrome.in : tokens.motion.chrome.out;

  return (
    <div
      ref={bubble}
      role="presentation"
      aria-hidden="true"
      data-hint=""
      style={{
        ...chipSurfaceStyle(VIEW_TARGETS.desktop, { overPicture: true }),
        ...typeRoleStyle("controlLabel"),
        color: tokens.color.gold,
        position: "fixed",
        left: place?.left ?? 0,
        top: place?.top ?? 0,
        zIndex: 2147483000,
        whiteSpace: "nowrap",
        pointerEvents: "none",
        userSelect: "none",
        opacity: place && visible ? 1 : 0,
        // A short rise towards its place, with the fade; none where motion is reduced.
        transform: place && visible ? "translateY(0)" : reduced ? "none" : "translateY(3px)",
        transition: `opacity ${duration}ms cubic-bezier(${x1}, ${y1}, ${x2}, ${y2}), transform ${duration}ms cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`
      }}
    >
      {label}
    </div>
  );
}
