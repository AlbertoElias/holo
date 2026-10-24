// Type roles (styleguide 7): two voices, Fraunces for titles and Figtree for
// the rest. Everything comes from the core's `typeStyle`.
import { createElement, type CSSProperties, type HTMLAttributes, type ReactElement, type ReactNode } from "react";

import { typeStyle, type TypeRole } from "@holoim/xr-ui-core";

export type { TypeRole };

const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded"]);

/** A CSS font stack: named families quoted, generic families bare. */
export function fontStack(families: readonly string[]): string {
  return families.map((family) => (GENERIC_FAMILIES.has(family) ? family : `"${family}"`)).join(", ");
}

/** The CSS of a type role on a flat screen (7, 7.2). */
export function typeRoleStyle(variant: TypeRole): CSSProperties {
  const style = typeStyle(variant, { headset: false });
  return {
    fontFamily: fontStack(style.fontFamily),
    fontWeight: style.fontWeight,
    fontSize: `${style.fontSizeApx}px`,
    lineHeight: style.lineHeight,
    letterSpacing: `${style.letterSpacingApx}px`,
    color: style.color,
    ...(style.tabularNumbers ? { fontVariantNumeric: "tabular-nums" } : {}),
    ...(style.opticalSizing ? { fontOpticalSizing: "auto" } : {})
  };
}

export type TypeElement = "span" | "p" | "div" | "h1" | "h2" | "h3" | "h4" | "label" | "time" | "small" | "strong" | "em";

export interface TypeProps extends HTMLAttributes<HTMLElement> {
  variant: TypeRole;
  as?: TypeElement;
  children?: ReactNode;
}

/** Text in one of the type roles: `<Type variant="byline" as="span">`. */
export function Type({ variant, as = "span", style, children, ...props }: TypeProps): ReactElement {
  return createElement(as, { ...props, style: { ...typeRoleStyle(variant), ...style } }, children);
}
