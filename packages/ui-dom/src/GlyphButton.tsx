// The button around a glyph drawing: hit area (6.1), states (6) and label.
// GlyphControl and the side sheet's close mark share it.
import { useEffect, useState, type AriaAttributes, type ReactNode } from "react";

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

/**
 * Native button attributes a caller may set: state and semantics only. No
 * `className` or `style`: tokens own the look, and those would bypass them.
 */
export type GlyphButtonAttributes = AriaAttributes & {
  disabled?: boolean;
  id?: string;
  role?: string;
  [data: `data-${string}`]: string | undefined;
};

/** Keeps only the attributes above, so a cast cannot slip a class, a style or a handler through. */
export function passThroughAttributes(props: object): GlyphButtonAttributes {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key === "disabled" || key === "id" || key === "role" || key.startsWith("aria-") || key.startsWith("data-")) kept[key] = value;
  }
  return kept as GlyphButtonAttributes;
}

export interface GlyphButtonProps {
  label: string;
  onPress: () => void;
  input?: HitInput;
  dimmed?: boolean;
  /** The drawing's box in apx: the ring or the icon. */
  drawnApx: number;
  showLabel?: boolean;
  /** The visible word, when it differs from the accessible name (`label`). */
  word?: string;
  /** The drawing, given the state's appearance; without one the control is its word. */
  children?: (appearance: GlyphAppearance) => ReactNode;
  attributes?: GlyphButtonAttributes;
}

export function GlyphButton({ label, onPress, input, dimmed = false, drawnApx, showLabel = false, word = label, children, attributes = {} }: GlyphButtonProps) {
  const disabled = attributes.disabled === true;
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [focusVisible, setFocusVisible] = useState(false);
  const [assumedInput] = useState<HitInput>(defaultHitInput);
  const hitInput = input ?? assumedInput;

  useEffect(listenForModality, []);

  // A disabled control has no look in the styleguide yet (brief, slice 4,
  // placeholder): the idle dim, with no cream lift and no pressed state.
  const appearance = glyphAppearance(disabled ? { dimmed: true } : { hovered, focusVisible, pressed, dimmed }, { headset: false });
  const metrics = glyphMetrics({ headset: false });
  const hit = hitAreaApx(hitInput, drawnApx);
  const focusOutline = appearance.focusRing ? `${appearance.focusRing.width}px solid ${appearance.focusRing.color}` : "none";
  const outlineOffset = appearance.focusRing ? `${appearance.focusRing.offset}px` : undefined;

  return (
    <button
      {...passThroughAttributes(attributes)}
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
        cursor: disabled ? "default" : "pointer",
        color: appearance.color,
        opacity: appearance.opacity,
        WebkitTapHighlightColor: "transparent",
        touchAction: "manipulation"
      }}
    >
      {children ? (
        <span
          data-glyph-visual=""
          style={{
            display: "inline-flex",
            width: drawnApx,
            height: drawnApx,
            borderRadius: "50%",
            outline: focusOutline,
            outlineOffset
          }}
        >
          {children(appearance)}
        </span>
      ) : (
        // No drawing yet: the word stands in its place, at the drawing's height.
        <span
          data-glyph-visual=""
          data-glyph-word=""
          style={{
            ...typeRoleStyle("controlLabel"),
            display: "inline-flex",
            alignItems: "center",
            minHeight: drawnApx,
            paddingInline: metrics.gapApx / 2,
            borderRadius: drawnApx / 2,
            color: appearance.color,
            whiteSpace: "nowrap",
            outline: focusOutline,
            outlineOffset
          }}
        >
          {word}
        </span>
      )}
      {showLabel && children ? <span style={{ ...typeRoleStyle("controlLabel"), color: appearance.color }}>{word}</span> : null}
    </button>
  );
}
