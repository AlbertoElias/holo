// The button around a glyph drawing: hit area (6.1), states (6) and label.
// GlyphControl and the side sheet's close mark share it.
import { useEffect, useState, type ReactNode } from "react";

import { glyphAppearance, glyphMetrics, hitAreaApx, type GlyphAppearance, type HitInput } from "@holoim/xr-ui-core";

import { defaultHitInput } from "./internal.js";
import { typeRoleStyle } from "./typeRoles.js";

// Keyboard focus shows the ring, pointer focus does not. `:focus-visible` is
// asked first; where it is missing, focus that follows a key is keyboard focus.
let keyboardModality = false;
let listening = false;

function listenForModality() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener("keydown", () => { keyboardModality = true; }, true);
  document.addEventListener("pointerdown", () => { keyboardModality = false; }, true);
}

function isFocusVisible(element: Element): boolean {
  try {
    if (element.matches(":focus-visible")) return true;
  } catch {
    // An engine without :focus-visible falls back to the last input modality.
  }
  return keyboardModality;
}

export interface GlyphButtonProps {
  label: string;
  onPress: () => void;
  input?: HitInput;
  dimmed?: boolean;
  /** The drawing's box in apx: the ring or the icon. */
  drawnApx: number;
  showLabel?: boolean;
  /** The drawing, given the state's appearance. */
  children: (appearance: GlyphAppearance) => ReactNode;
}

export function GlyphButton({ label, onPress, input, dimmed = false, drawnApx, showLabel = false, children }: GlyphButtonProps) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [focusVisible, setFocusVisible] = useState(false);
  const [assumedInput] = useState<HitInput>(defaultHitInput);
  const hitInput = input ?? assumedInput;

  useEffect(listenForModality, []);

  const appearance = glyphAppearance({ hovered, focusVisible, pressed, dimmed }, { headset: false });
  const metrics = glyphMetrics({ headset: false });
  const hit = hitAreaApx(hitInput, drawnApx);

  return (
    <button
      type="button"
      aria-label={label}
      onClick={onPress}
      onPointerEnter={(event) => { if (event.pointerType !== "touch") setHovered(true); }}
      onPointerLeave={() => { setHovered(false); setPressed(false); }}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setPressed(true); }}
      onKeyUp={() => setPressed(false)}
      onFocus={(event) => setFocusVisible(isFocusVisible(event.currentTarget))}
      onBlur={() => { setFocusVisible(false); setPressed(false); }}
      style={{
        boxSizing: "border-box",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: metrics.gapApx,
        minWidth: hit,
        minHeight: hit,
        padding: 0,
        margin: 0,
        border: "none",
        background: "transparent",
        // The ring is drawn on the glyph, not on the (larger) hit area.
        outline: "none",
        cursor: "pointer",
        color: appearance.color,
        opacity: appearance.opacity,
        WebkitTapHighlightColor: "transparent",
        touchAction: "manipulation"
      }}
    >
      <span
        data-glyph-visual=""
        style={{
          display: "inline-flex",
          width: drawnApx,
          height: drawnApx,
          borderRadius: "50%",
          outline: appearance.focusRing ? `${appearance.focusRing.width}px solid ${appearance.focusRing.color}` : "none",
          outlineOffset: appearance.focusRing ? `${appearance.focusRing.offset}px` : undefined
        }}
      >
        {children(appearance)}
      </span>
      {showLabel ? <span style={{ ...typeRoleStyle("controlLabel"), color: appearance.color }}>{label}</span> : null}
    </button>
  );
}
