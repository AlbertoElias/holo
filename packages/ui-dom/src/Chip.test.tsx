// The chip's opacity for the target and its shape: styleguide 2.3, 5.2.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { VIEW_TARGETS, type ViewTarget } from "@holoim/xr-ui-core";

import { Chip } from "./Chip.js";
import { alphaOf } from "./testHelpers.js";

function chip(target: ViewTarget, props: { overPicture?: boolean; controlRow?: boolean } = {}) {
  const { container } = render(<Chip target={target} {...props}>text</Chip>);
  return container.firstElementChild as HTMLElement | null;
}

describe("chip opacity per target (2.3)", () => {
  const cases: Array<[string, ViewTarget, number]> = [
    ["phone", VIEW_TARGETS.phone, 0.72],
    ["desktop", VIEW_TARGETS.desktop, 0.72],
    ["VR", VIEW_TARGETS.vr, 0.72],
    ["AR on Android Chrome", VIEW_TARGETS.androidChrome, 0.88],
    ["AR on Quest passthrough", VIEW_TARGETS.questPassthrough, 0.97],
    // An AR target nobody listed blends in linear light.
    ["AR on an unlisted target", { kind: "ar", compositor: "unlisted", headset: false }, 0.92]
  ];
  it.each(cases)("%s is %d", (_name, target, opacity) => {
    expect(alphaOf(chip(target)!.style.background)).toBe(opacity);
  });

  it("is never opaque in AR", () => {
    for (const compositor of ["questPassthrough", "androidChrome", "linear", "unlisted"] as const) {
      for (const headset of [true, false]) {
        expect(alphaOf(chip({ kind: "ar", compositor, headset })!.style.background)).toBeLessThan(1);
      }
    }
  });

  it("takes the chip at 72% over a hologram's own picture on a flat screen", () => {
    expect(alphaOf(chip(VIEW_TARGETS.desktop, { overPicture: true })!.style.background)).toBe(0.72);
  });

  it("hands its surface to what it holds, so a stacked reach line can be the same chip", () => {
    const over = chip(VIEW_TARGETS.phone, { overPicture: true })!;
    // The custom property keeps the authored `rgb(r g b / a)`; jsdom reports the background as rgba().
    expect(over.style.getPropertyValue("--chip-surface")).toMatch(/^rgb\(\d+ \d+ \d+ \/ 0\.72\)$/);
    expect(alphaOf(over.style.background)).toBe(0.72);
  });

  it("renders nothing in AR Quick Look, which shows only the USDZ", () => {
    expect(chip(VIEW_TARGETS.quickLook)).toBeNull();
  });
});

describe("chip shape (2.3)", () => {
  it("has an 18 apx radius, 5 × 14 apx padding, and no backdrop blur, rim or shadow", () => {
    const element = chip(VIEW_TARGETS.desktop)!;
    expect(element.style.borderRadius).toBe("18px");
    expect(element.style.paddingBlock).toBe("5px");
    expect(element.style.paddingInline).toBe("14px");
    expect(element.style.getPropertyValue("backdrop-filter")).toBe("");
    expect(element.style.boxShadow).toBe("");
    expect(element.style.filter).toBe("");
  });

  it("pads a control row 3 apx at the top, bottom and start and 14 at the end, so Play sits flush", () => {
    const element = chip(VIEW_TARGETS.desktop, { controlRow: true })!;
    expect(element.style.paddingTop).toBe("3px");
    expect(element.style.paddingBottom).toBe("3px");
    expect(element.style.paddingInlineStart).toBe("3px");
    expect(element.style.paddingInlineEnd).toBe("14px");
  });

  it("scales its shape 2.5× in a headset", () => {
    const element = chip(VIEW_TARGETS.vr)!;
    expect(element.style.borderRadius).toBe("45px");
    expect(element.style.paddingInline).toBe("35px");
  });
});
