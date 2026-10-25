// The shade, the dock and the side sheet: styleguide 5.1, 5.2, 6.1 (phone edges), 8.4.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tokens } from "@holoim/design-tokens";
import { PHONE_EDGES, VIEW_TARGETS } from "@holoim/xr-ui-core";

import { Dock } from "./Dock.js";
import { GlyphControl } from "./GlyphControl.js";
import { Shade } from "./Shade.js";
import { SideSheet } from "./SideSheet.js";
import { alphaOf } from "./testHelpers.js";

describe("shade (5.1)", () => {
  it("is 120% of the hologram's width, centred, with deep sea at 0.7, 0.5 at 60% and clear at the edge", () => {
    const { container } = render(<Shade>Paused</Shade>);
    const shade = container.firstElementChild as HTMLElement;
    expect(shade.style.position).toBe("absolute");
    expect(shade.style.width).toBe("120%");
    expect(shade.style.left).toBe("-10%");
    const gradient = shade.style.background;
    expect(gradient).toMatch(/^radial-gradient\(closest-side,/);
    const stops = Array.from(gradient.matchAll(/rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\) ([\d.]+)%/g));
    expect(stops.map((stop) => [Number(stop[4]), Number(stop[5])])).toEqual([[0.7, 0], [0.5, 60], [0, 100]]);
    for (const stop of stops) expect(stop.slice(1, 4).map(Number)).toEqual([8, 26, 30]);
  });

  it("starts 90% of the way down the card, clamped to 90–95%, 120 px tall on a desktop and 24% of the screen on a phone", () => {
    const desktop = render(<Shade device="desktop" start={0.5}>x</Shade>).container.firstElementChild as HTMLElement;
    expect(desktop.style.top).toBe("90%");
    expect(desktop.style.height).toBe("120px");
    const phone = render(<Shade device="phone" start={0.99}>x</Shade>).container.lastElementChild as HTMLElement;
    expect(phone.style.top).toBe("95%");
    expect(phone.style.height).toBe("24vh");
  });

  it("lets pointer events through, except on its children", () => {
    const { container } = render(<Shade><button type="button">Play</button></Shade>);
    const shade = container.firstElementChild as HTMLElement;
    expect(shade.style.pointerEvents).toBe("none");
    expect((screen.getByRole("button").parentElement as HTMLElement).style.pointerEvents).toBe("auto");
  });
});

describe("dock (5.2, 6.1 phone edges)", () => {
  it("keeps targets out of the gesture zones: 34 px at the bottom and 20 px at each side, or the safe-area inset if larger", () => {
    expect(PHONE_EDGES).toEqual({ side: 20, bottom: 34 });
    const { container } = render(<Dock aria-label="Actions"><button type="button">A</button></Dock>);
    const dock = container.firstElementChild as HTMLElement;
    expect(dock.getAttribute("role")).toBe("toolbar");
    expect(dock.style.position).toBe("fixed");
    expect(dock.style.paddingBottom).toBe("max(env(safe-area-inset-bottom), 34px)");
    expect(dock.style.paddingLeft).toBe("max(env(safe-area-inset-left), 20px)");
    expect(dock.style.paddingRight).toBe("max(env(safe-area-inset-right), 20px)");
  });

  it("spaces its glyphs one glyph gap apart (30 apx for a poke)", () => {
    const { container } = render(<Dock input="mouse">x</Dock>);
    const dock = (container.firstElementChild as HTMLElement).firstElementChild as HTMLElement;
    expect(dock.style.gap).toBe("12px");
    const poke = (render(<Dock input="poke">x</Dock>).container.lastElementChild as HTMLElement).firstElementChild as HTMLElement;
    expect(poke.style.gap).toBe("30px");
  });
});

// The user saw two shadows: first the dock's oval shade, then its band along
// the bottom edge (2026-10-24, 2026-10-25). Only a hologram casts a shade.
// Over a picture the dock's row sits on the chip, sized to the row; on the
// feed's horizon the user found that chip a heavy dark toast (2026-10-25), so
// each control holds its own lens instead.
describe("dock surface (5.2)", () => {
  it("paints nothing across the screen: the bar is clear and lets pointer events through", () => {
    const dock = render(<Dock>x</Dock>).container.firstElementChild as HTMLElement;
    expect(dock.style.background).toBe("");
    expect(dock.style.pointerEvents).toBe("none");
  });

  it("puts its row on the flat chip, deep sea at 72%, which takes pointer events", () => {
    const dock = render(<Dock><button type="button">Upload</button></Dock>).container.firstElementChild as HTMLElement;
    const row = dock.querySelector("[data-dock-row]") as HTMLElement;
    expect(row.contains(screen.getByRole("button"))).toBe(true);
    expect(row.style.pointerEvents).toBe("auto");
    expect(row.style.background).toMatch(/^rgba\(8, 26, 30,/);
    expect(alphaOf(row.style.background)).toBe(0.72);
    expect(row.style.borderRadius).toBe(`${tokens.chip.radius}px`);
    expect(row.style.background).not.toMatch(/gradient/);
  });
});

describe("dock on the horizon (5.2)", () => {
  // Failure modes: the chip's slab coming back, a gold word on amber, a
  // drawing with no lens under it, a gold focus ring lost on amber, a hit
  // area shrunk to the icon.
  it("stands bare, each control a lantern: the glyph in a gold ring round a deep-sea lens, no word", () => {
    const dock = render(
      <Dock ground="horizon" input="touch"><GlyphControl glyph="upload" label="Upload a hologram" word="Upload" showLabel input="touch" onPress={() => {}} /></Dock>
    ).container.firstElementChild as HTMLElement;
    const row = dock.querySelector("[data-dock-row]") as HTMLElement;
    expect(row.style.background).toBe("");
    const button = screen.getByRole("button", { name: "Upload a hologram" });
    expect(button.textContent).toBe("");
    expect(Number.parseFloat(button.style.minWidth)).toBeGreaterThanOrEqual(44);
    const lantern = button.querySelector("[data-glyph-lantern]") as HTMLElement;
    expect(lantern.style.width).toBe(`${tokens.glyph.ring}px`);
    expect(lantern.style.background).toBe("rgb(8, 26, 30)");
    expect(lantern.style.boxShadow).toBe(`inset 0 0 0 ${tokens.glyph.stroke}px ${tokens.color.gold}`);
  });

  it("rings keyboard focus in ink, which holds on amber", () => {
    render(<Dock ground="horizon"><GlyphControl glyph="upload" label="Upload a hologram" onPress={() => {}} /></Dock>);
    const button = screen.getByRole("button", { name: "Upload a hologram" });
    fireEvent.keyDown(document, { key: "Tab" });
    act(() => button.focus());
    expect((button.querySelector("[data-glyph-lantern]") as HTMLElement).style.outline).toBe(`1.5px solid ${tokens.glyph.lantern.ink}`);
  });

  it("holds a control with no drawing yet as its gold word in a lantern capsule, never bare on amber", () => {
    render(<Dock ground="horizon" input="touch"><GlyphControl glyph={null} label="Settings" input="touch" onPress={() => {}} /></Dock>);
    const button = screen.getByRole("button", { name: "Settings" });
    expect(button.textContent).toBe("Settings");
    const capsule = button.querySelector("[data-glyph-lantern]") as HTMLElement;
    const lens = document.createElement("span");
    lens.style.background = tokens.glyph.lantern.fill;
    expect(capsule.style.background).toBe(lens.style.background);
    expect(capsule.style.boxShadow).toBe(`inset 0 0 0 ${tokens.glyph.stroke}px ${tokens.color.gold}`);
    expect(Number.parseFloat(capsule.style.minHeight)).toBe(tokens.glyph.ring);
    expect(Number.parseFloat(button.style.minHeight)).toBeGreaterThanOrEqual(44);
  });

  it("keeps the chip over a picture, where the word still shows", () => {
    const dock = render(<Dock><GlyphControl glyph="upload" label="Upload a hologram" word="Upload" showLabel onPress={() => {}} /></Dock>).container.firstElementChild as HTMLElement;
    expect((dock.querySelector("[data-dock-row]") as HTMLElement).style.background).toMatch(/^rgba\(8, 26, 30,/);
    expect(screen.getByRole("button", { name: "Upload a hologram" }).textContent).toBe("Upload");
    expect(dock.querySelector("[data-glyph-lantern]")).toBeNull();
  });
});

describe("side sheet (1.2, 8.4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const easing = `cubic-bezier(${tokens.motion.chrome.easing.join(", ")})`;

  it("is a modal dialog named by its title, on the 72% chip, with a Close control that closes it", () => {
    const onClose = vi.fn();
    render(<SideSheet open title="Library" onClose={onClose}>Holograms</SideSheet>);
    const dialog = screen.getByRole("dialog", { name: "Library" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(alphaOf(dialog.style.background)).toBe(0.72);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<SideSheet open title="Library" onClose={onClose}>x</SideSheet>);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab inside while open, as a modal dialog must, in both directions and from outside", () => {
    render(
      <>
        <button type="button">Behind</button>
        <SideSheet open title="Library" onClose={() => {}}>
          <input aria-label="File" />
          <button type="button">Send</button>
        </SideSheet>
      </>
    );
    const close = screen.getByRole("button", { name: "Close" });
    const send = screen.getByRole("button", { name: "Send" });
    const behind = screen.getByRole("button", { name: "Behind" });
    send.focus();
    expect(fireEvent.keyDown(document, { key: "Tab" }), "the browser's own Tab is stopped").toBe(false);
    expect(document.activeElement, "past the last control comes the first").toBe(close);
    expect(fireEvent.keyDown(document, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement, "before the first comes the last").toBe(send);
    behind.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement, "focus outside is brought back in").toBe(close);
    screen.getByLabelText("File").focus();
    expect(fireEvent.keyDown(document, { key: "Tab" }), "between controls the browser moves focus").toBe(true);
  });

  it("does not listen for Escape, or exist, while closed", () => {
    const onClose = vi.fn();
    render(<SideSheet open={false} title="Library" onClose={onClose}>x</SideSheet>);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("unfolds in from the right in 240 ms and leaves in 400 ms, ease-out, then goes", () => {
    const { rerender } = render(<SideSheet open title="Library" onClose={() => {}} reducedMotion={false}>x</SideSheet>);
    const dialog = screen.getByRole("dialog");
    expect(dialog.style.transform).toBe("translateX(0)");
    expect(dialog.style.transition).toBe(`transform 240ms ${easing}`);
    rerender(<SideSheet open={false} title="Library" onClose={() => {}} reducedMotion={false}>x</SideSheet>);
    expect(screen.getByRole("dialog").style.transform).toBe("translateX(100%)");
    expect(screen.getByRole("dialog").style.transition).toBe(`transform 400ms ${easing}`);
    act(() => { vi.advanceTimersByTime(399); });
    expect(screen.queryByRole("dialog")).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("crossfades in place under reduced motion: opacity only, no movement", () => {
    const { rerender } = render(<SideSheet open title="Library" onClose={() => {}} reducedMotion>x</SideSheet>);
    const dialog = screen.getByRole("dialog");
    expect(dialog.style.opacity).toBe("1");
    expect(dialog.style.transform).toBe("");
    expect(dialog.style.transition).toBe(`opacity 240ms ${easing}`);
    rerender(<SideSheet open={false} title="Library" onClose={() => {}} reducedMotion>x</SideSheet>);
    expect(screen.getByRole("dialog").style.opacity).toBe("0");
    expect(screen.getByRole("dialog").style.transform).toBe("");
  });

  it("follows prefers-reduced-motion when not told", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)", addEventListener() {}, removeEventListener() {} }));
    render(<SideSheet open title="Library" onClose={() => {}}>x</SideSheet>);
    expect(screen.getByRole("dialog").style.transform).toBe("");
  });

  it("is not drawn in AR Quick Look, which holds no controls", () => {
    render(<SideSheet open title="Library" onClose={() => {}} target={VIEW_TARGETS.quickLook}>x</SideSheet>);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
