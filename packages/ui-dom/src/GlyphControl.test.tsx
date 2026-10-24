// Contract tests for the glyph control, from the failure cases of
// docs/features/ui-redesign.md slice 2: styleguide 6 (states), 6.1 (hit areas), 1.2 (idle dim).
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { tokens } from "@holoim/design-tokens";
import type { GlyphId, HitInput } from "@holoim/xr-ui-core";

import { GlyphControl } from "./GlyphControl.js";
import { cssRgb } from "./testHelpers.js";

function press(glyph: GlyphId, props: Partial<Parameters<typeof GlyphControl>[0]> = {}) {
  const onPress = vi.fn();
  render(<GlyphControl glyph={glyph} label="A glyph" onPress={onPress} {...props} />);
  const button = screen.getByRole("button", { name: "A glyph" });
  const visual = button.querySelector<HTMLElement>("[data-glyph-visual]")!;
  return { button, visual, onPress };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hit area (6.1): a glyph's box is the larger of its drawing and the input's minimum", () => {
  const cases: Array<[GlyphId, HitInput, number]> = [
    ["free", "mouse", 24],
    ["return", "mouse", 24],
    // The 36 apx ring is bigger than the mouse minimum, so the ring is the box.
    ["play", "mouse", 36],
    ["record", "mouse", 36],
    ["free", "touch", 44],
    ["play", "touch", 44],
    ["record", "touch", 44],
    ["free", "ray", 56],
    ["free", "gazePinch", 72]
  ];
  it.each(cases)("%s on %s is %i apx", (glyph, input, expected) => {
    const { button } = press(glyph, { input });
    expect(button.style.minWidth).toBe(`${expected}px`);
    expect(button.style.minHeight).toBe(`${expected}px`);
  });

  it("takes the input from a coarse pointer when none is given, and mouse when matchMedia is missing", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} }));
    expect(press("free").button.style.minWidth).toBe("44px");
    vi.unstubAllGlobals();
    // jsdom has no matchMedia.
    expect(typeof window.matchMedia).toBe("undefined");
    document.body.innerHTML = "";
    expect(press("free").button.style.minWidth).toBe("24px");
  });
});

describe("states (6)", () => {
  it("rests in gold, and brightens to the cream highlight on hover, ring included", () => {
    const { button, visual } = press("play");
    const ring = () => visual.querySelector("circle")!;
    expect(ring().getAttribute("stroke")).toBe(tokens.glyph.color);
    expect(button.style.color).toBe(cssRgb(tokens.glyph.color));
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    expect(ring().getAttribute("stroke")).toBe(tokens.glyph.states.hoverColor);
    expect(visual.querySelector("path")!.getAttribute("fill")).toBe(tokens.glyph.states.hoverColor);
    fireEvent.pointerLeave(button);
    expect(ring().getAttribute("stroke")).toBe(tokens.glyph.color);
  });

  it("dims to 55% while pressed and comes back on release", () => {
    const { button } = press("free");
    expect(button.style.opacity).toBe("1");
    fireEvent.pointerDown(button);
    expect(button.style.opacity).toBe(String(tokens.glyph.states.pressedOpacity));
    expect(button.style.opacity).toBe("0.55");
    fireEvent.pointerUp(button);
    expect(button.style.opacity).toBe("1");
  });

  it("draws a 1.5 apx gold ring 3 apx outside the glyph for keyboard focus only", () => {
    const { button, visual } = press("free");
    // Pointer focus: no ring.
    fireEvent.pointerDown(button);
    fireEvent.focus(button);
    expect(visual.style.outline).toBe("none");
    fireEvent.blur(button);
    // Focus that follows a key: ring.
    fireEvent.keyDown(document.body, { key: "Tab" });
    fireEvent.focus(button);
    expect(visual.style.outline).toBe(`1.5px solid ${tokens.glyph.states.focusRingColor}`);
    expect(visual.style.outlineOffset).toBe("3px");
    fireEvent.blur(button);
    expect(visual.style.outline).toBe("none");
  });

  it("dims the always-there set to 40% after 4 s unused, and back as soon as a hand or cursor nears", () => {
    const idle = press("play", { msSinceUse: 4000 });
    expect(idle.button.style.opacity).toBe("0.4");
    document.body.innerHTML = "";
    expect(press("play", { msSinceUse: 3999 }).button.style.opacity).toBe("1");
    document.body.innerHTML = "";
    expect(press("play", { msSinceUse: 9000, approached: true }).button.style.opacity).toBe("1");
    document.body.innerHTML = "";
    // Only Play, Free and Return are always there (1.2); View in AR comes and goes.
    expect(press("viewInAr", { msSinceUse: 9000 }).button.style.opacity).toBe("1");
  });

  it("never glows: no box-shadow and no filter anywhere", () => {
    const { button, visual } = press("play");
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    fireEvent.pointerDown(button);
    for (const element of [button, visual, ...Array.from(button.querySelectorAll<SVGElement | HTMLElement>("*"))]) {
      expect(element.style.boxShadow ?? "").toBe("");
      expect(element.style.filter ?? "").toBe("");
      expect(element.getAttribute("filter")).toBeNull();
    }
  });

  it("is transparent with no border, and calls onPress when pressed", () => {
    const { button, onPress } = press("return");
    expect(button.style.background).toBe("transparent");
    expect(button.style.border).toBe("");
    fireEvent.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("drawings (6)", () => {
  it("draws Play as a filled triangle at 14 apx inside the 36 apx ring with a 1.5 apx stroke", () => {
    const { visual } = press("play");
    const ring = visual.querySelector("circle")!;
    expect(visual.querySelector("svg")!.getAttribute("width")).toBe("36");
    expect(ring.getAttribute("r")).toBe(String((36 - 1.5) / 2));
    expect(ring.getAttribute("stroke-width")).toBe("1.5");
    expect(visual.querySelector("path")!.getAttribute("d")).toBe(tokens.glyph.path.play.d);
    expect(visual.querySelector("g")!.getAttribute("transform")).toContain(`scale(${14 / 16})`);
  });

  it("draws a line glyph at 1.5 apx with round caps and the drawing's join, unringed", () => {
    const { visual } = press("viewInAr");
    const path = visual.querySelector("path")!;
    expect(visual.querySelector("circle")).toBeNull();
    expect(path.getAttribute("fill")).toBe("none");
    expect(path.getAttribute("stroke-width")).toBe("1.5");
    expect(path.getAttribute("stroke-linecap")).toBe("round");
    expect(path.getAttribute("stroke-linejoin")).toBe(tokens.glyph.path.viewInAr.linejoin);
  });

  it("draws Record as a rose circle idle and a rose rounded square while recording, never changing with hover", () => {
    const idle = press("record");
    const dot = idle.visual.querySelector("[data-record-shape=idle]")!;
    expect(dot.getAttribute("r")).toBe("7");
    expect(dot.getAttribute("fill")).toBe(tokens.color.record);
    fireEvent.pointerEnter(idle.button, { pointerType: "mouse" });
    expect(dot.getAttribute("fill")).toBe(tokens.color.record);
    expect(idle.visual.querySelector("circle")!.getAttribute("stroke")).toBe(tokens.glyph.states.hoverColor);
    document.body.innerHTML = "";

    const recording = press("record", { recording: true });
    const square = recording.visual.querySelector("[data-record-shape=recording]")!;
    expect(square.getAttribute("width")).toBe("13");
    expect(square.getAttribute("rx")).toBe("3");
    expect(square.getAttribute("fill")).toBe(tokens.color.record);
  });

  it("shows its label in the control-label role beside the glyph when asked", () => {
    const { button } = press("free", { showLabel: true });
    const label = Array.from(button.querySelectorAll("span")).find((span) => span.textContent === "A glyph")!;
    expect(label.style.fontWeight).toBe("500");
    expect(label.style.color).toBe(cssRgb(tokens.glyph.color));
    expect(label.style.fontFamily).toContain("Figtree");
  });
});
