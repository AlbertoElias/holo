// The side sheet (styleguide 1.2, 8.4): lists and long text on flat screens,
// on the chip, unfolding in from the right (240 ms) and leaving (400 ms), or
// crossfading in place under reduced motion.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { VIEW_TARGETS, chromeTransition, glyphMetrics, type ViewTarget } from "@holoim/xr-ui-core";

import { chipSurfaceStyle } from "./Chip.js";
import { GlyphButton } from "./GlyphButton.js";
import { useReducedMotion } from "./internal.js";
import { Type, typeRoleStyle } from "./typeRoles.js";

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
        width: "min(100%, 24rem)",
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
        <GlyphButton label={closeLabel} onPress={onClose} drawnApx={metrics.iconApx}>
          {/* The styleguide has no Close drawing yet (brief, slice 2), so the control is its word. */}
          {(appearance) => <span style={{ ...typeRoleStyle("controlLabel"), color: appearance.color }}>{closeLabel}</span>}
        </GlyphButton>
      </div>
      {children}
    </div>
  );
}
