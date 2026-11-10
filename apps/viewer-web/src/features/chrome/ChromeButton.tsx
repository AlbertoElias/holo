// A toggle in the glyph language (styleguide 6, 6.1): the highlight, tilt
// and sound toggles, which carry a pressed state and drawings the styleguide
// has not given as tokens yet. Every other control is ui-dom's GlyphControl.
// Every size, colour and state comes from the core's glyph contract.
import { useState, type ReactNode } from "react";

import { tokens } from "@holoim/design-tokens";
import { typeRoleStyle, useHint } from "@holoim/ui-dom";
import { glyphAppearance, glyphMetrics, hitAreaApx, inputFromPointerType, type GlyphAppearance, type HitInput } from "@holoim/xr-ui-core";

export interface ChromeButtonProps {
  label: string;
  onPress: () => void;
  /** The drawing's box in apx: the 36 apx ring, or the 16 apx icon. */
  drawnApx?: number;
  /** The drawing, given the state's appearance. Without one, the control is its word. */
  children?: (appearance: GlyphAppearance) => ReactNode;
  /** The visible word beside a drawing, or the word itself when there is no drawing. */
  word?: string;
  pressed?: boolean;
  /** Tilt where the device has no motion, or access was declined. */
  disabled?: boolean;
  title?: string | undefined;
  className?: string;
  /** Defaults to the last pointer's input, touch on a coarse pointer before that. */
  input?: HitInput;
  /** Extra attributes for checks. */
  data?: Record<`data-${string}`, string>;
}

function assumedInput(): HitInput {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "mouse";
  return window.matchMedia("(pointer: coarse)").matches ? "touch" : "mouse";
}

export function ChromeButton({
  label,
  onPress,
  drawnApx,
  children,
  word,
  pressed,
  disabled = false,
  title,
  className,
  input,
  data
}: ChromeButtonProps) {
  const [hovered, setHovered] = useState(false);
  const [down, setDown] = useState(false);
  const [focusVisible, setFocusVisible] = useState(false);
  const [lastInput, setLastInput] = useState<HitInput>(assumedInput);
  const hitInput = input ?? lastInput;
  const appearance = glyphAppearance({ hovered, focusVisible, pressed: down, dimmed: false }, { headset: false });
  const metrics = glyphMetrics({ headset: false });
  // A drawing without its word names itself on hover; an explanation (`title`) takes the hint's place.
  const { handlers: hintOn, hint } = useHint(children && !word ? (title ?? label) : title);
  const hit = hitAreaApx(hitInput, drawnApx ?? 0);
  const drawing = children ? (
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
  ) : null;
  const wordFocus = !children && appearance.focusRing
    ? { outline: `${appearance.focusRing.width}px solid ${appearance.focusRing.color}`, outlineOffset: `${appearance.focusRing.offset}px`, borderRadius: metrics.ringApx }
    : {};

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      // A disabled button takes no pointer events, so its explanation stays the browser's own.
      title={disabled ? title : undefined}
      className={className}
      {...data}
      onClick={onPress}
      onPointerEnter={(event) => {
        setLastInput(inputFromPointerType(event.pointerType));
        if (event.pointerType !== "touch") setHovered(true);
        hintOn.onPointerEnter(event);
      }}
      onPointerLeave={() => {
        setHovered(false);
        setDown(false);
        hintOn.onPointerLeave();
      }}
      onPointerDown={(event) => {
        setLastInput(inputFromPointerType(event.pointerType));
        setDown(true);
        hintOn.onPointerDown();
      }}
      onPointerUp={() => setDown(false)}
      onPointerCancel={() => setDown(false)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") setDown(true);
      }}
      onKeyUp={() => setDown(false)}
      onFocus={(event) => {
        let visible = false;
        try {
          visible = event.currentTarget.matches(":focus-visible");
        } catch {
          visible = false;
        }
        setFocusVisible(visible);
        hintOn.onFocus(event);
      }}
      onBlur={() => {
        setFocusVisible(false);
        setDown(false);
        hintOn.onBlur();
      }}
      style={{
        boxSizing: "border-box",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: metrics.gapApx / 2,
        minWidth: hit,
        minHeight: hit,
        padding: children ? 0 : `0 ${metrics.gapApx / 2}px`,
        margin: 0,
        border: "none",
        background: "transparent",
        outline: "none",
        cursor: disabled ? "default" : "pointer",
        color: appearance.color,
        // A disabled control rests at the idle dim, the dimmest a glyph is drawn.
        opacity: disabled ? tokens.glyph.idleOpacity : appearance.opacity,
        WebkitTapHighlightColor: "transparent",
        touchAction: "manipulation",
        ...wordFocus
      }}
    >
      {drawing}
      {hint}
      {word ? <span style={{ ...typeRoleStyle("controlLabel"), color: appearance.color, whiteSpace: "nowrap" }}>{word}</span> : null}
    </button>
  );
}
