// The side sheet (styleguide 1.2, 8.4): lists and long text on flat screens,
// on the chip, unfolding in from the right (240 ms) and leaving (400 ms), or
// crossfading in place under reduced motion.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { VIEW_TARGETS, chromeTransition, glyphMetrics, type ViewTarget } from "@holoim/xr-ui-core";

import { chipSurfaceStyle } from "./Chip.js";
import { GlyphControl } from "./GlyphControl.js";
import { useReducedMotion } from "./internal.js";
import { Type } from "./typeRoles.js";

export interface SideSheetProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  /** The close control's word and accessible name. */
  closeLabel?: string;
  /** Defaults to a desktop screen. */
  target?: ViewTarget;
  /** Overrides `prefers-reduced-motion`. */
  reducedMotion?: boolean;
  children?: ReactNode;
}

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** A modal sheet keeps Tab inside it: past the last control to the first, before the first to the last. */
function keepFocusIn(container: HTMLElement, event: KeyboardEvent): void {
  const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((node) => !node.hidden && node.getAttribute("aria-hidden") !== "true");
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  const inside = active instanceof Node && container.contains(active);
  let next: HTMLElement | undefined;
  if (!first || !last) next = container;
  else if (!inside || active === container) next = event.shiftKey ? last : first;
  else if (event.shiftKey && active === first) next = last;
  else if (!event.shiftKey && active === last) next = first;
  if (!next) return;
  event.preventDefault();
  next.focus({ preventScroll: true });
}

export function SideSheet({ open, title, onClose, closeLabel = "Close", target = VIEW_TARGETS.desktop, reducedMotion, children }: SideSheetProps) {
  const titleId = useId();
  const systemReducedMotion = useReducedMotion();
  const reduced = reducedMotion ?? systemReducedMotion;
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  const returnFocusTo = useRef<Element | null>(null);
  const outMs = chromeTransition("out", { reducedMotion: reduced }).durationMs;

  useEffect(() => {
    if (open) {
      setMounted(true);
      const node = sheet.current;
      if (!node) return undefined;
      // Flush the closed position first, so the change below is a transition.
      void node.getBoundingClientRect();
      returnFocusTo.current ??= document.activeElement;
      node.focus({ preventScroll: true });
      setShown(true);
      return undefined;
    }
    setShown(false);
    const timer = setTimeout(() => {
      setMounted(false);
      const previous = returnFocusTo.current;
      returnFocusTo.current = null;
      if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
    }, outMs);
    return () => clearTimeout(timer);
  }, [open, mounted, outMs]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab" && sheet.current) keepFocusIn(sheet.current, event);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const surface = chipSurfaceStyle(target);
  if (!mounted || !surface) return null;

  const motion = chromeTransition(shown ? "in" : "out", { reducedMotion: reduced });
  const easing = `cubic-bezier(${motion.easing.join(", ")})`;
  const moving = motion.style === "unfold";
  const metrics = glyphMetrics({ headset: false });

  return (
    <div
      ref={sheet}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      style={{
        ...surface,
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: "min(100%, 26rem)",
        boxSizing: "border-box",
        // A form needs room: two glyph gaps all round, never the chip's tight row padding.
        padding: `max(env(safe-area-inset-top), ${metrics.gapApx * 2}px) ${metrics.gapApx * 2}px ${metrics.gapApx * 2}px`,
        display: "flex",
        flexDirection: "column",
        gap: metrics.gapApx * 2,
        overflowY: "auto",
        outline: "none",
        zIndex: 10,
        ...(moving
          ? { transform: shown ? "translateX(0)" : "translateX(100%)", transition: `transform ${motion.durationMs}ms ${easing}` }
          : { opacity: shown ? 1 : 0, transition: `opacity ${motion.durationMs}ms ${easing}` })
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: metrics.gapApx }}>
        <Type variant="titlePhoneCard" as="h2" id={titleId} style={{ margin: 0 }}>
          {title}
        </Type>
        <GlyphControl glyph="close" label={closeLabel} onPress={onClose} />
      </div>
      {children}
    </div>
  );
}
