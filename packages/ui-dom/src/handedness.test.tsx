// The handedness setting both apps share (brief Q8). Failure modes: storage
// that throws (a private window, blocked site data) breaks the page or the
// setter; a stored value that is not a hand is believed; the pair shows no
// choice to assistive tech; the sentence names the wrong wrist.
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HandednessPicker } from "./HandednessPicker.js";
import { loadHandedness, saveHandedness, useHandedness } from "./handedness.js";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("handedness, stored per device (Q8)", () => {
  it("is right-handed by default, and for anything stored that is not a hand", () => {
    expect(loadHandedness()).toBe("right");
    window.localStorage.setItem("holoim.handedness", "ambidextrous");
    expect(loadHandedness()).toBe("right");
  });

  it("remembers left across loads, under the key capture has always used", () => {
    saveHandedness("left");
    expect(window.localStorage.getItem("holoim.handedness")).toBe("left");
    expect(loadHandedness()).toBe("left");
  });

  it("falls back to right-handed, and still sets it for the page, when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(loadHandedness()).toBe("right");
    expect(() => saveHandedness("left")).not.toThrow();
    const { result } = renderHook(() => useHandedness());
    act(() => result.current[1]("left"));
    expect(result.current[0]).toBe("left");
  });

  it("saves through the hook", () => {
    const { result } = renderHook(() => useHandedness());
    act(() => result.current[1]("left"));
    expect(loadHandedness()).toBe("left");
  });
});

describe("the handedness pair", () => {
  it("is a radio group with the choice checked, and says which wrist holds the control", () => {
    const onChange = vi.fn();
    const { rerender } = render(<HandednessPicker value="right" onChange={onChange} wristControl="Exit AR" />);
    expect(screen.getByRole("radiogroup", { name: "Dominant hand" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Right-handed" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Left-handed" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Right-handed: in a headset, Exit AR sits on your left wrist.")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Left-handed" }));
    expect(onChange).toHaveBeenCalledWith("left");
    rerender(<HandednessPicker value="left" onChange={onChange} wristControl="Exit AR" />);
    expect(screen.getByRole("radio", { name: "Left-handed" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Left-handed: in a headset, Exit AR sits on your right wrist.")).toBeTruthy();
  });
});
