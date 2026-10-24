import { tokens } from "@holoim/design-tokens";
import { describe, expect, it } from "vitest";

import {
  boxInsideLabelRim,
  cardRedraws,
  chipOpacity,
  chipStyle,
  chromeTransition,
  controlRowPaddingApx,
  flatHaloLevel,
  haloLevel,
  nearestToForwardRay,
  nearestToMiddle,
  reducedHaloLevel,
  roomHaloLevel,
  rowBacking,
  shadeLayout,
  shadeStops,
  sparkCount,
  stageLight,
  stepVrChipFade,
  VIEW_TARGETS,
  VR_CHIP_HIDDEN,
  type VrChipFade,
  type ViewTarget
} from "./index.js";

// Failure cases: the chip is opaque in AR, hiding the room; the VR chip
// flickers on and off at a boundary; flicker exceeds three flashes a second;
// sparks on every card drop frames on a phone.

describe("chip (styleguide 2.3, 5.2)", () => {
  it("takes its opacity from the target", () => {
    expect(chipOpacity(VIEW_TARGETS.vr)).toBe(0.72);
    expect(chipOpacity(VIEW_TARGETS.questPassthrough)).toBe(0.97);
    expect(chipOpacity(VIEW_TARGETS.androidChrome)).toBe(0.88);
    expect(chipOpacity({ kind: "ar", compositor: "linear", headset: true })).toBe(0.92);
    expect(chipOpacity(VIEW_TARGETS.phone)).toBe(0.72);
    expect(chipOpacity(VIEW_TARGETS.desktop, { overPicture: true })).toBe(0.72);
    expect(chipOpacity(VIEW_TARGETS.quickLook)).toBeNull();
  });

  it("takes 92% on an AR target that is not listed (Q18)", () => {
    expect(chipOpacity({ kind: "ar", compositor: "unlisted", headset: false })).toBe(0.92);
  });

  it("is never opaque in AR", () => {
    for (const compositor of ["questPassthrough", "androidChrome", "linear", "unlisted"] as const) {
      expect(chipOpacity({ kind: "ar", compositor, headset: true })).toBeLessThan(1);
    }
  });

  it("is flat deep sea with no blur or rim, its shape 2.5× in a headset", () => {
    expect(chipStyle(VIEW_TARGETS.phone)).toEqual({
      color: tokens.color.deepSea, opacity: 0.72, blendMode: "normal", backdropBlur: false, rim: false,
      radiusApx: 18, paddingBlockApx: 5, paddingInlineApx: 14
    });
    expect(chipStyle(VIEW_TARGETS.vr)).toMatchObject({ radiusApx: 45, paddingBlockApx: 12.5, paddingInlineApx: 35 });
    expect(controlRowPaddingApx(VIEW_TARGETS.desktop)).toEqual({ top: 3, bottom: 3, start: 3, end: 14 });
  });

  it("is mandatory only where the ground fails", () => {
    expect(rowBacking(VIEW_TARGETS.vr, "hologramRow", "wall")).toBe("bare");
    expect(rowBacking(VIEW_TARGETS.vr, "hologramRow", "sky")).toBe("chip");
    expect(rowBacking(VIEW_TARGETS.vr, "hologramRow", "litSurface")).toBe("chip");
    expect(rowBacking(VIEW_TARGETS.androidChrome, "hologramRow", "ground")).toBe("chip");
    expect(rowBacking(VIEW_TARGETS.quickLook, "hologramRow", "ground")).toBe("none");
    expect(rowBacking(VIEW_TARGETS.phone, "hologramRow", "ground")).toBe("shade");
    expect(rowBacking(VIEW_TARGETS.phone, "feedNotice", "ground")).toBe("chip");
    expect(rowBacking(VIEW_TARGETS.desktop, "dock", "ground")).toBe("shade");
    expect(rowBacking(VIEW_TARGETS.desktop, "hologramRow", "picture")).toBe("chip");
  });
});

describe("VR chip fade (styleguide 5.2, 8.4)", () => {
  const run = (wantedAt: (ms: number) => boolean, durationMs: number, dtMs = 10) => {
    let state: VrChipFade = VR_CHIP_HIDDEN;
    const presence: number[] = [];
    for (let t = 0; t < durationMs; t += dtMs) {
      state = stepVrChipFade(state, wantedAt(t), dtMs);
      presence.push(state.presence);
    }
    return presence;
  };

  it("fades in over 0.3 s", () => {
    const presence = run(() => true, 400);
    expect(presence[28]).toBeLessThan(1);
    expect(presence[29]).toBe(1);
  });

  it("holds steady while the background steps back and forth across the boundary", () => {
    const presence = run((t) => Math.floor(t / 90) % 2 === 0, 10_000);
    expect(presence.slice(30).every((value) => value === 1)).toBe(true);
  });

  it("holds at least 2 s after the background last asked for it, then leaves", () => {
    const presence = run((t) => t < 500, 3500);
    const lastWanted = 490;
    const lastFull = presence.lastIndexOf(1) * 10;
    expect(lastFull).toBe(lastWanted + tokens.chip.vrMinHold - 10);
    expect(presence.at(-1)).toBe(0);
  });
});

describe("shade (styleguide 5.1)", () => {
  it("is deep sea at 70%, 50% at 60%, then clear", () => {
    expect(shadeStops()).toEqual([
      { color: tokens.color.deepSea, alpha: 0.7, position: 0 },
      { color: tokens.color.deepSea, alpha: 0.5, position: 0.6 },
      { color: tokens.color.deepSea, alpha: 0, position: 1 }
    ]);
  });

  it("is 120% of the hologram's width, 120 px on a desktop and 24% of a phone's height", () => {
    const card = { left: 100, top: 50, width: 300, height: 240 };
    expect(shadeLayout({ card, device: "desktop", screenHeight: 900 })).toEqual({ left: 70, top: 50 + 240 * 0.9, width: 360, height: 120 });
    expect(shadeLayout({ card, device: "phone", screenHeight: 844, start: 0.99 })).toMatchObject({ top: 50 + 240 * 0.95, height: 844 * 0.24 });
  });

  it("keeps labels inside 45% of its radius", () => {
    const shade = { left: 0, top: 0, width: 360, height: 120 };
    expect(boxInsideLabelRim(shade, { left: 150, top: 50, width: 60, height: 20 })).toBe(true);
    expect(boxInsideLabelRim(shade, { left: 20, top: 50, width: 60, height: 20 })).toBe(false);
  });
});

describe("flicker (styleguide 8.1, 8.3)", () => {
  const flashesPerSecond = (sample: (ms: number) => number) => {
    let peaks = 0;
    let before = sample(0);
    let now = sample(5);
    for (let t = 10; t <= 10_000; t += 5) {
      const after = sample(t);
      if (now > before && now > after) peaks += 1;
      before = now;
      now = after;
    }
    return peaks / 10;
  };

  it("runs the round 1 levels over a 2.6 s loop", () => {
    expect([0, 0.4, 0.55, 0.7, 1].map((at) => flatHaloLevel(at * 2600))).toEqual([0.5, 0.32, 0.58, 0.4, 0.5].map((level) => expect.closeTo(level, 10)));
  });

  it("swings 0.45 to 0.50 in a room", () => {
    expect(roomHaloLevel(0.4 * 2600)).toBeCloseTo(0.45, 10);
    expect(roomHaloLevel(0.55 * 2600)).toBeCloseTo(0.5, 10);
  });

  it("stays under three flashes a second on flat screens", () => {
    expect(flashesPerSecond(flatHaloLevel)).toBeLessThan(3);
    expect(flashesPerSecond((ms) => stageLight(VIEW_TARGETS.phone, ms, { reducedMotion: false })!)).toBeLessThan(3);
  });

  it("never flickers the stage light on real surfaces or under reduced motion", () => {
    for (const target of [VIEW_TARGETS.vr, VIEW_TARGETS.questPassthrough, VIEW_TARGETS.androidChrome] as ViewTarget[]) {
      expect(stageLight(target, 1234, { reducedMotion: false })).toBe(0.9);
    }
    expect(stageLight(VIEW_TARGETS.desktop, 1234, { reducedMotion: true })).toBe(0.9);
    expect(stageLight(VIEW_TARGETS.quickLook, 0, { reducedMotion: false })).toBeNull();
  });

  it("fades 0.50 to 0.489 and back over 8 s under reduced motion, on every target", () => {
    expect(reducedHaloLevel(0)).toBeCloseTo(0.5, 10);
    expect(reducedHaloLevel(4000)).toBeCloseTo(0.489, 10);
    expect(reducedHaloLevel(8000)).toBeCloseTo(0.5, 10);
    expect(haloLevel(VIEW_TARGETS.vr, 4000, { reducedMotion: true })).toBeCloseTo(0.489, 10);
  });
});

describe("sparks (styleguide 8.2, 8.3)", () => {
  it("only the card nearest the middle sparks, and only it redraws on a phone", () => {
    const cards = [{ id: "top", centerX: 195, centerY: 100 }, { id: "middle", centerX: 195, centerY: 430 }, { id: "bottom", centerX: 195, centerY: 800 }];
    expect(nearestToMiddle(cards, { width: 390, height: 844 })).toBe("middle");
    expect(cardRedraws(VIEW_TARGETS.phone, false)).toBe(false);
    expect(cardRedraws(VIEW_TARGETS.desktop, false)).toBe(true);
  });

  it("only the hologram nearest the forward ray sparks, none in peripheral vision", () => {
    expect(nearestToForwardRay([{ id: "a", angleDegrees: 12 }, { id: "b", angleDegrees: 4 }])).toBe("b");
    expect(nearestToForwardRay([{ id: "a", angleDegrees: 50 }])).toBeNull();
  });

  it("sheds 26 on a flat screen, up to 70 in a room, none under reduced motion or while recording", () => {
    const options = { inFocus: true, reducedMotion: false, recording: false };
    expect(sparkCount(VIEW_TARGETS.phone, options)).toBe(26);
    expect(sparkCount(VIEW_TARGETS.vr, options)).toBe(70);
    expect(sparkCount(VIEW_TARGETS.phone, { ...options, reducedMotion: true })).toBe(0);
    expect(sparkCount(VIEW_TARGETS.desktop, { ...options, recording: true })).toBe(0);
  });
});

describe("chrome transitions (styleguide 8.4)", () => {
  it("unfolds in 240 ms, leaves in 400 ms, ease-out; crossfades under reduced motion", () => {
    expect(chromeTransition("in", { reducedMotion: false })).toEqual({ durationMs: 240, easing: [0, 0, 0.58, 1], style: "unfold" });
    expect(chromeTransition("out", { reducedMotion: true })).toMatchObject({ durationMs: 400, style: "crossfade" });
  });
});
