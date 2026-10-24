// The Halo's directions (styleguide 6.2; brief Q20): a flick commits without
// drawing, a hold draws eight places, an empty direction and a cancel commit nothing.
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tokens } from "@holoim/design-tokens";
import { CAPTURE_HALO_ACTIONS } from "@holoim/xr-ui-core";

import { Halo } from "./Halo.js";

const ORIGIN = { clientX: 200, clientY: 200, pointerId: 1 };

function setup() {
  const onCommit = vi.fn();
  const { container } = render(<Halo actions={CAPTURE_HALO_ACTIONS} onCommit={onCommit} />);
  const halo = container.querySelector<HTMLElement>("[data-halo]")!;
  const ring = () => container.querySelector("[data-halo-ring]");
  const elapse = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
  /** Moves from the press point by apx, y up (so north is positive). */
  const moveTo = (dx: number, dy: number) => fireEvent.pointerMove(halo, { ...ORIGIN, clientX: ORIGIN.clientX + dx, clientY: ORIGIN.clientY - dy });
  const press = () => fireEvent.pointerDown(halo, ORIGIN);
  return { onCommit, container, halo, ring, elapse, moveTo, press };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a flick (6.2)", () => {
  it("commits undo for a flick west released before 300 ms, and never draws the ring", () => {
    const { onCommit, halo, ring, elapse, moveTo, press } = setup();
    press();
    moveTo(-40, 0);
    elapse(100);
    expect(ring()).toBeNull();
    fireEvent.pointerUp(halo, ORIGIN);
    elapse(1000);
    expect(ring()).toBeNull();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ direction: "w", action: "undo", flick: true });
  });

  it("commits record south and redo east, with y up (moving down the screen is south)", () => {
    const south = setup();
    south.press();
    south.moveTo(0, -40);
    fireEvent.pointerUp(south.halo, ORIGIN);
    expect(south.onCommit).toHaveBeenCalledWith({ direction: "s", action: "record", flick: true });

    const east = setup();
    east.press();
    east.moveTo(40, 0);
    fireEvent.pointerUp(east.halo, ORIGIN);
    expect(east.onCommit).toHaveBeenCalledWith({ direction: "e", action: "redo", flick: true });
  });
});

describe("a hold (6.2)", () => {
  it("draws nothing until the hold delay, then the ring with 8 places of which only S, W and E are drawn", () => {
    const { ring, elapse, press, container } = setup();
    press();
    elapse(tokens.motion.hold.delay - 1);
    expect(ring()).toBeNull();
    elapse(1);
    expect(ring()).not.toBeNull();
    expect(container.querySelectorAll("[data-halo-place]")).toHaveLength(8);
    const drawn = Array.from(container.querySelectorAll("[data-halo-slot]")).map((slot) => slot.getAttribute("data-halo-slot"));
    expect(drawn.sort()).toEqual(["e", "s", "w"]);
  });

  it("draws Record's glyph at S and an empty gold ring of the slot size at the other decided places", () => {
    const { elapse, press, container } = setup();
    press();
    elapse(tokens.motion.hold.delay);
    const south = container.querySelector("[data-halo-slot=s]")!;
    expect(south.querySelector("[data-record-shape=idle]")).not.toBeNull();
    for (const direction of ["w", "e"]) {
      const svg = container.querySelector(`[data-halo-slot=${direction}] svg`)!;
      expect(svg.getAttribute("width")).toBe("36");
      expect(svg.querySelectorAll("circle")).toHaveLength(1);
      expect(svg.querySelector("path, rect, g")).toBeNull();
      expect(svg.querySelector("circle")!.getAttribute("stroke")).toBe(tokens.glyph.color);
    }
  });

  it("puts the places on the ring: N above the centre, E to its right, one glyph gap between neighbours", () => {
    const { elapse, press, container } = setup();
    press();
    elapse(tokens.motion.hold.delay);
    const place = (direction: string) => container.querySelector<HTMLElement>(`[data-halo-place=${direction}]`)!;
    expect(parseFloat(place("n").style.left)).toBeCloseTo(0);
    expect(parseFloat(place("n").style.top)).toBeLessThan(0);
    expect(parseFloat(place("e").style.left)).toBeGreaterThan(0);
    expect(parseFloat(place("e").style.top)).toBeCloseTo(0);
    // The ring's radius is about 63 apx (6.2).
    expect(Math.abs(parseFloat(place("e").style.left))).toBeGreaterThan(62);
    expect(Math.abs(parseFloat(place("e").style.left))).toBeLessThan(64);
  });

  it("lifts the highlighted direction to the hover state and commits it, not as a flick", () => {
    const { onCommit, halo, elapse, moveTo, press, container } = setup();
    press();
    elapse(tokens.motion.hold.delay);
    moveTo(-40, 0);
    const west = container.querySelector("[data-halo-slot=w]")!;
    expect(west.hasAttribute("data-highlighted")).toBe(true);
    expect(west.querySelector("circle")!.getAttribute("stroke")).toBe(tokens.glyph.states.hoverColor);
    expect(container.querySelector("[data-halo-slot=e] circle")!.getAttribute("stroke")).toBe(tokens.glyph.color);
    fireEvent.pointerUp(halo, ORIGIN);
    expect(onCommit).toHaveBeenCalledWith({ direction: "w", action: "undo", flick: false });
    expect(container.querySelector("[data-halo-ring]")).toBeNull();
  });
});

describe("commits nothing", () => {
  it("for an empty direction: north has no action in capture's Halo", () => {
    const { onCommit, halo, elapse, moveTo, press } = setup();
    press();
    elapse(tokens.motion.hold.delay);
    moveTo(0, 40);
    fireEvent.pointerUp(halo, ORIGIN);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("for a flick towards an empty direction", () => {
    const { onCommit, halo, moveTo, press } = setup();
    press();
    moveTo(40, 40);
    fireEvent.pointerUp(halo, ORIGIN);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("for a release inside the centre, half a glyph ring (18 apx)", () => {
    const { onCommit, halo, moveTo, press } = setup();
    press();
    moveTo(-10, 0);
    fireEvent.pointerUp(halo, ORIGIN);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("for a pointercancel, which also closes the ring", () => {
    const { onCommit, halo, ring, elapse, moveTo, press } = setup();
    press();
    elapse(tokens.motion.hold.delay);
    moveTo(-40, 0);
    expect(ring()).not.toBeNull();
    fireEvent.pointerCancel(halo, ORIGIN);
    expect(ring()).toBeNull();
    fireEvent.pointerUp(halo, ORIGIN);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("for the window losing focus mid-hold (a held mode ends on blur, 6.1)", () => {
    const { onCommit, halo, ring, elapse, moveTo, press } = setup();
    press();
    elapse(tokens.motion.hold.delay);
    moveTo(-40, 0);
    act(() => { window.dispatchEvent(new Event("blur")); });
    expect(ring()).toBeNull();
    fireEvent.pointerUp(halo, ORIGIN);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
