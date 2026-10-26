// Contract tests for the glyph control, from the failure cases of
// docs/features/ui-redesign.md slice 2: styleguide 6 (states), 6.1 (hit areas), 1.2 (idle dim).
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { tokens } from "@holoim/design-tokens";
import type { GlyphId, HitInput } from "@holoim/xr-ui-core";

import { GlyphControl } from "./GlyphControl.js";
import { cssRgb } from "./testHelpers.js";

function press(glyph: GlyphId | null, props: Partial<Parameters<typeof GlyphControl>[0]> = {}) {
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

  it("takes touch wherever a coarse pointer exists when none is given, and mouse when matchMedia is missing", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} }));
    expect(press("free").button.style.minWidth).toBe("44px");
    // A touch laptop: the primary pointer is fine, but a finger can still press.
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(any-pointer: coarse)", addEventListener() {}, removeEventListener() {} }));
    document.body.innerHTML = "";
    expect(press("free").button.style.minWidth, "a touch screen beside a mouse gets the touch minimum").toBe("44px");
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: fine)" || query === "(any-pointer: fine)", addEventListener() {}, removeEventListener() {} }));
    document.body.innerHTML = "";
    expect(press("free").button.style.minWidth, "a mouse alone keeps the mouse minimum").toBe("24px");
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
    // Only Play, Free and Return are always there (1.2); View in your room comes and goes.
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

describe("a control with no drawing yet (brief, slice 3: Pause, Exit, Recenter, Upload, true size)", () => {
  it("draws its word in the control-label role, with no drawing, and keeps its accessible name", () => {
    const { button, visual, onPress } = press(null);
    expect(button.querySelector("svg")).toBeNull();
    expect(visual.textContent).toBe("A glyph");
    expect(visual.style.fontWeight).toBe("500");
    expect(visual.style.fontFamily).toContain("Figtree");
    expect(visual.style.color).toBe(cssRgb(tokens.glyph.color));
    fireEvent.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  const cases: Array<[HitInput, number]> = [["mouse", 24], ["touch", 44], ["ray", 56], ["gazePinch", 72]];
  it.each(cases)("keeps the hit area at the %s minimum, %i apx", (input, expected) => {
    const { button } = press(null, { input });
    expect(button.style.minWidth).toBe(`${expected}px`);
    expect(button.style.minHeight).toBe(`${expected}px`);
  });

  it("shows a word that differs from its accessible name", () => {
    render(<GlyphControl glyph={null} label="Exit AR" word="Exit" onPress={() => undefined} />);
    const button = screen.getByRole("button", { name: "Exit AR" });
    expect(button.querySelector("[data-glyph-visual]")!.textContent).toBe("Exit");
  });
});

describe("word (6): the visible word can differ from the accessible name", () => {
  it("names Return in full and shows only its short word beside the arc", () => {
    render(<GlyphControl glyph="return" label="Return to the author's view" word="Return" showLabel onPress={() => undefined} />);
    const button = screen.getByRole("button", { name: "Return to the author's view" });
    expect(button.textContent).toBe("Return");
    expect(button.querySelector("svg")).not.toBeNull();
  });
});

// Brief, slice 4: capture's controls need native state and semantics on the
// button (Refit disabled while fitting, handedness as a radio pair, Settings
// expanded, an id the XR helpers click). Failure modes: an attribute never
// reaches the button; a caller's aria-label replaces the accessible name; a
// cast slips a class, a style or a handler past the tokens; disabled still
// presses, lifts to cream on hover or shows pressed; the disabled look is not
// the 40% idle dim; a radio is not focusable or does not show its state; the
// hit area shrinks below the input's minimum.
describe("native attributes (brief, slice 4)", () => {
  // By label, not role: some of these buttons are radios.
  function control(props: Partial<Parameters<typeof GlyphControl>[0]> = {}) {
    const onPress = vi.fn();
    render(<GlyphControl glyph={null} label="A glyph" onPress={onPress} {...props} />);
    return { button: screen.getByLabelText("A glyph") as HTMLButtonElement, onPress };
  }

  it("passes disabled, id, role, every aria-* and every data-* to the button", () => {
    const { button } = control({ id: "VRButton", role: "radio", "aria-checked": true, "aria-expanded": false, "aria-haspopup": "dialog", "data-capture-dock-item": "vr", disabled: false });
    expect(button.id).toBe("VRButton");
    expect(button.getAttribute("role")).toBe("radio");
    expect(button.getAttribute("aria-checked")).toBe("true");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("data-capture-dock-item")).toBe("vr");
  });

  it("keeps its label as the accessible name over a passed aria-label", () => {
    render(<GlyphControl glyph="free" label="Free view" aria-label="Something else" onPress={() => undefined} />);
    expect(screen.getByRole("button", { name: "Free view" })).toBeTruthy();
  });

  it("drops a class, a style or a handler slipped in by a cast: tokens own the look", () => {
    const onClick = vi.fn();
    const sneaky = { className: "custom", style: { color: "red" }, onClick } as unknown as Record<string, never>;
    const { button, onPress } = press("free", sneaky);
    expect(button.className).toBe("");
    expect(button.style.color).toBe(cssRgb(tokens.glyph.color));
    fireEvent.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("disabled: blocks the press, draws the 40% idle dim, and never lifts to cream or shows pressed", () => {
    const { button, onPress } = control({ glyph: "free", disabled: true });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onPress).not.toHaveBeenCalled();
    expect(button.style.opacity).toBe(String(tokens.glyph.idleOpacity));
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    expect(button.style.color).toBe(cssRgb(tokens.glyph.color));
    fireEvent.pointerDown(button);
    expect(button.style.opacity).toBe(String(tokens.glyph.idleOpacity));
    expect(button.style.cursor).toBe("default");
  });

  it("disabled while hovered drops the hover state at once", () => {
    const onPress = vi.fn();
    const { rerender } = render(<GlyphControl glyph={null} label="Refit height" onPress={onPress} input="mouse" />);
    const button = screen.getByRole("button", { name: "Refit height" });
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    expect(button.style.color).toBe(cssRgb(tokens.glyph.states.hoverColor));
    rerender(<GlyphControl glyph={null} label="Refit height" onPress={onPress} input="mouse" disabled />);
    expect(button.style.color).toBe(cssRgb(tokens.glyph.color));
    expect(button.style.opacity).toBe(String(tokens.glyph.idleOpacity));
  });

  it("works as a radio pair: focusable native buttons whose press moves aria-checked", () => {
    function Pair() {
      const [hand, setHand] = useState<"right" | "left">("right");
      return (
        <div role="radiogroup" aria-label="Hand">
          <GlyphControl glyph={null} label="Right-handed" role="radio" aria-checked={hand === "right"} onPress={() => setHand("right")} />
          <GlyphControl glyph={null} label="Left-handed" role="radio" aria-checked={hand === "left"} onPress={() => setHand("left")} />
        </div>
      );
    }
    render(<Pair />);
    const right = screen.getByRole("radio", { name: "Right-handed" });
    const left = screen.getByRole("radio", { name: "Left-handed" });
    expect(right.getAttribute("aria-checked")).toBe("true");
    // jsdom does not turn Enter or Space into the click a browser fires on a
    // button; capture's UI check presses Space in Chromium. Here: the radio is
    // a native button in the tab order, its key shows pressed, its click commits.
    expect(left.tagName).toBe("BUTTON");
    expect(left.tabIndex).toBe(0);
    left.focus();
    expect(document.activeElement).toBe(left);
    fireEvent.keyDown(left, { key: " " });
    expect(left.style.opacity).toBe(String(tokens.glyph.states.pressedOpacity));
    fireEvent.keyUp(left, { key: " " });
    fireEvent.click(left);
    expect(left.getAttribute("aria-checked")).toBe("true");
    expect(right.getAttribute("aria-checked")).toBe("false");
  });

  it.each<[HitInput, number]>([["mouse", 24], ["touch", 44], ["ray", 56]])("keeps the %s minimum (%i apx) with attributes, disabled included", (input, expected) => {
    const { button } = control({ input, disabled: true, role: "radio", "aria-checked": false });
    expect(button.style.minWidth).toBe(`${expected}px`);
    expect(button.style.minHeight).toBe(`${expected}px`);
  });
});
