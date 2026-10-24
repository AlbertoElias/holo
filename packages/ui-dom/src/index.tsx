import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, InputHTMLAttributes, PropsWithChildren, ReactNode } from "react";

export const uiDomTokens = {
  colorBackground: "rgb(6 13 22 / 88%)",
  colorBackgroundStrong: "rgb(8 18 28 / 94%)",
  colorBorder: "rgb(147 205 255 / 24%)",
  colorText: "#ebf6ff",
  colorTextMuted: "#b7d6f5",
  colorDanger: "#ff9ea6",
  colorPrimaryStart: "rgb(29 105 160)",
  colorPrimaryEnd: "rgb(12 68 107)",
  colorSuccess: "#76f0c3",
  radiusPanel: 16,
  radiusControl: 10,
  radiusPill: 999,
  shadow: "0 18px 44px rgb(0 0 0 / 26%)",
  blur: "blur(14px)"
} as const;

const panelBaseStyle: CSSProperties = {
  background: uiDomTokens.colorBackground,
  border: `1px solid ${uiDomTokens.colorBorder}`,
  borderRadius: uiDomTokens.radiusPanel,
  boxShadow: uiDomTokens.shadow,
  color: uiDomTokens.colorText,
  backdropFilter: uiDomTokens.blur
};

const buttonBaseStyle: CSSProperties = {
  borderRadius: uiDomTokens.radiusPill,
  padding: "0.6rem 0.95rem",
  fontSize: "0.92rem",
  fontWeight: 700,
  cursor: "pointer",
  border: `1px solid ${uiDomTokens.colorBorder}`,
  transition: "opacity 140ms ease, transform 140ms ease, border-color 140ms ease"
};

const fieldInputStyle: CSSProperties = {
  width: "100%",
  border: `1px solid ${uiDomTokens.colorBorder}`,
  borderRadius: uiDomTokens.radiusControl,
  background: "rgb(2 12 20 / 76%)",
  color: uiDomTokens.colorText,
  padding: "0.55rem 0.65rem"
};

/** @deprecated Replaced by the redesign components; removed when slices 3 and 4 move the apps over. */
export function UiPanel({
  children,
  style,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <div {...props} style={{ ...panelBaseStyle, ...style }}>
      {children}
    </div>
  );
}

/** @deprecated Replaced by the redesign components; removed when slices 3 and 4 move the apps over. */
export function UiButton({
  children,
  style,
  tone = "primary",
  ...props
}: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "ghost" | "danger" }>) {
  const toneStyle: Record<NonNullable<typeof tone>, CSSProperties> = {
    primary: {
      background: `linear-gradient(180deg, ${uiDomTokens.colorPrimaryStart}, ${uiDomTokens.colorPrimaryEnd})`,
      color: "#f4fbff"
    },
    ghost: {
      background: "rgb(4 16 26 / 68%)",
      color: uiDomTokens.colorText
    },
    danger: {
      background: "linear-gradient(180deg, rgb(145 44 54), rgb(104 28 37))",
      color: "#fff5f6"
    }
  };

  return (
    <button
      {...props}
      style={{
        ...buttonBaseStyle,
        ...toneStyle[tone],
        opacity: props.disabled ? 0.6 : 1,
        ...style
      }}
    >
      {children}
    </button>
  );
}

/** @deprecated Replaced by the redesign components; removed when slices 3 and 4 move the apps over. */
export function UiField({
  children,
  label,
  description,
  style
}: PropsWithChildren<{ label: string; description?: ReactNode; style?: CSSProperties }>) {
  return (
    <label style={{ display: "grid", gap: "0.35rem", fontSize: "0.8rem", color: uiDomTokens.colorTextMuted, ...style }}>
      <span>{label}</span>
      {children}
      {description ? <span style={{ fontSize: "0.75rem", color: uiDomTokens.colorTextMuted }}>{description}</span> : null}
    </label>
  );
}

/** @deprecated Replaced by the redesign components; removed when slices 3 and 4 move the apps over. */
export function UiInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} style={{ ...fieldInputStyle, ...props.style }} />;
}

/** @deprecated Replaced by the redesign components; removed when slices 3 and 4 move the apps over. */
export function UiNotice({
  title,
  children,
  tone = "neutral",
  style
}: PropsWithChildren<{ title?: ReactNode; tone?: "neutral" | "warning" | "danger" | "success"; style?: CSSProperties }>) {
  const accentByTone: Record<NonNullable<typeof tone>, string> = {
    neutral: uiDomTokens.colorBorder,
    warning: "#ffd07a",
    danger: uiDomTokens.colorDanger,
    success: uiDomTokens.colorSuccess
  };

  return (
    <div
      style={{
        ...panelBaseStyle,
        padding: "0.8rem 0.95rem",
        borderLeft: `3px solid ${accentByTone[tone]}`,
        background: uiDomTokens.colorBackgroundStrong,
        ...style
      }}
    >
      {title ? <div style={{ marginBottom: "0.35rem", fontSize: "0.8rem", fontWeight: 700, letterSpacing: "0.04em" }}>{title}</div> : null}
      <div style={{ fontSize: "0.88rem", color: uiDomTokens.colorText }}>{children}</div>
    </div>
  );
}

/** @deprecated Replaced by the redesign components; removed when slices 3 and 4 move the apps over. */
export function UiPill({
  children,
  style
}: PropsWithChildren<{ style?: CSSProperties }>) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0.24rem 0.55rem",
        borderRadius: uiDomTokens.radiusPill,
        border: `1px solid ${uiDomTokens.colorBorder}`,
        background: "rgb(10 25 40 / 72%)",
        color: uiDomTokens.colorTextMuted,
        fontSize: "0.72rem",
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        ...style
      }}
    >
      {children}
    </span>
  );
}

/** @deprecated Replaced by the redesign components; removed when slices 3 and 4 move the apps over. */
export function UiStack({
  children,
  gap = "0.75rem",
  style,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement> & { gap?: CSSProperties["gap"] }>) {
  return (
    <div {...props} style={{ display: "grid", gap, ...style }}>
      {children}
    </div>
  );
}

/** @deprecated Replaced by the redesign components; removed when slices 3 and 4 move the apps over. */
export function UiFixedSurface({
  children,
  style,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <div {...props} style={{ position: "fixed", zIndex: 10, ...style }}>
      {children}
    </div>
  );
}

/** @deprecated Replaced by the redesign components; removed when slices 3 and 4 move the apps over. */
export function UiActionRow({
  children,
  gap = "0.75rem",
  style,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement> & { gap?: CSSProperties["gap"] }>) {
  return (
    <div
      {...props}
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap,
        ...style
      }}
    >
      {children}
    </div>
  );
}

// The redesigned components (docs/features/ui-redesign.md, slice 2): each
// renders a contract of @holoim/xr-ui-core.
export { Chip, chipSurfaceStyle, type ChipProps } from "./Chip.js";
export { Dock, type DockProps } from "./Dock.js";
export { EdgeSvg, RESTING_EDGE_FRAME, type EdgeSvgProps } from "./EdgeSvg.js";
export { GlyphControl, type GlyphControlProps } from "./GlyphControl.js";
export { Halo, type HaloProps, type HaloViewState } from "./Halo.js";
export { defaultHitInput, useReducedMotion } from "./internal.js";
export { Shade, shadeGradient, type ShadeProps } from "./Shade.js";
export { SideSheet, type SideSheetProps } from "./SideSheet.js";
export { Type, fontStack, typeRoleStyle, type TypeElement, type TypeProps, type TypeRole } from "./typeRoles.js";
