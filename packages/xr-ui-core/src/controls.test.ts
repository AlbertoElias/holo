import { apxToMeters, tokens } from "@holoim/design-tokens";
import { describe, expect, it } from "vitest";

import {
  ALWAYS_THERE,
  arCompositorFromUserAgent,
  chromeVisible,
  drawnSizeApx,
  glyphAppearance,
  glyphDrawing,
  glyphGapApx,
  glyphMetrics,
  headsetTextVisible,
  hitAreaApx,
  hitAreaMeters,
  inputFromPointerType,
  inputFromTargetRayMode,
  isIdleDimmed,
  lanternLook,
  noteFolded,
  pausedText,
  placeControl,
  recordingText,
  scaleLabel,
  scaleState,
  startLazyFollow,
  stepLazyFollow,
  typeStyle,
  VIEW_TARGETS,
  worldPanelDistanceM,
  type Control,
  type ViewTarget
} from "./index.js";

// Failure cases: a glyph's hit area shrinks to its drawing on touch, rays or
// gaze; the headset factor is applied to type only; the idle dim hides a
// control someone is reaching for; red alone carries the recording state; a
// control is head-locked in a headset; text appears within arm's reach;
// handedness is read in one place and not another; a hologram is shown at a
// scale nobody chose, unlabelled.

const ALL_TARGETS: ViewTarget[] = Object.values(VIEW_TARGETS);
const ALL_CONTROLS: Control[] = [
  "play", "free", "return", "timecode", "caption", "scale", "record", "ink", "undo", "exitAr", "placingHint",
  "upload", "signIn", "halo", "tray", "find", "settings", "library", "longText", "status", "markEditor", "menu"
];

describe("glyphs (styleguide 6)", () => {
  it("draws Play's filled triangle at 14 apx in the 36 apx ring and the line glyphs at 16 apx", () => {
    expect(glyphDrawing("play")).toEqual({ kind: "path", d: "M4 2.5v11l9-5.5z", fill: true, linejoin: "miter", ringed: true, drawnApx: 14 });
    expect(glyphDrawing("viewInAr")).toMatchObject({ fill: false, linejoin: "round", ringed: false, drawnApx: 16 });
  });

  it("carries recording by shape: a 14 apx circle idle, a 13 apx rounded square while recording", () => {
    expect(glyphDrawing("record")).toEqual({ kind: "recordIdle", diameterApx: 14, ringed: true });
    expect(glyphDrawing("record", { recording: true })).toEqual({ kind: "recordStop", sizeApx: 13, cornerRadiusApx: 3, ringed: true });
  });

  it("applies the 2.5× headset factor to strokes, icons, rings, gaps and focus rings, not to type alone", () => {
    expect(glyphMetrics({ headset: true })).toEqual({ strokeApx: 3.75, iconApx: 40, ringApx: 90, gapApx: 30, focusRingWidthApx: 3.75, focusRingOffsetApx: 7.5 });
    expect(drawnSizeApx(glyphDrawing("play"), { headset: true })).toBe(90);
    expect(typeStyle("controlLabel", { headset: true }).fontSizeApx).toBe(35);
  });

  it("brightens to cream on hover, rings gold on keyboard focus, dims to 55% when pressed, never glows", () => {
    const flat = { headset: false };
    expect(glyphAppearance({}, flat)).toMatchObject({ color: tokens.color.gold, opacity: 1, focusRing: null, glow: false });
    expect(glyphAppearance({ hovered: true }, flat).color).toBe(tokens.color.highlight);
    expect(glyphAppearance({ focusVisible: true }, flat).focusRing).toEqual({ width: 1.5, offset: 3, color: tokens.color.gold });
    expect(glyphAppearance({ pressed: true }, flat).opacity).toBe(0.55);
    expect(glyphAppearance({ hovered: true }, flat).recordColor).toBe(tokens.color.record);
  });

  // The feed's dock on the amber horizon (5.2). Failure modes: a lens or a
  // focus ring that vanishes on amber (a control's boundary needs 3:1), a
  // lens too light to carry gold, a ring that ignores the hover lift.
  it("keeps a lantern legible on the horizon: gold in a deep-sea lens, an ink focus ring", () => {
    const channel = (hex: string, i: number) => {
      const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (hex: string) => 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    const mix = (a: string, b: string, t: number) => `#${[0, 1, 2].map((i) => Math.round(parseInt(a.slice(1 + i * 2, 3 + i * 2), 16) * (1 - t) + parseInt(b.slice(1 + i * 2, 3 + i * 2), 16) * t).toString(16).padStart(2, "0")).join("")}`;
    const flat = { headset: false };
    const idle = lanternLook(glyphAppearance({}, flat), flat);
    // The dock's middle sits 56 apx up: 30% of the way from grey (80%) to
    // the horizon on a 440 px laptop window, further down on taller screens.
    for (const ground of [mix(tokens.color.ground.grey, tokens.color.ground.horizon, 0.3), tokens.color.ground.horizon]) {
      expect(contrast(idle.fill, ground), `the lens on ${ground}`).toBeGreaterThanOrEqual(3);
      expect(contrast(idle.ink, ground), `the focus ring on ${ground}`).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(tokens.color.gold, tokens.color.ground.horizon), "bare gold fails at the horizon, hence the lantern").toBeLessThan(3);
    expect(contrast(idle.ringColor, idle.fill), "the glyph on its lens").toBeGreaterThanOrEqual(4.5);
    expect(idle).toMatchObject({ ringApx: 36, ringWidthApx: 1.5, ringColor: tokens.color.gold, focusRing: null });
    expect(lanternLook(glyphAppearance({ hovered: true }, flat), flat).ringColor).toBe(tokens.color.highlight);
    expect(lanternLook(glyphAppearance({ focusVisible: true }, flat), flat).focusRing).toEqual({ width: 1.5, offset: 3, color: idle.ink });
  });

  it("dims the always-there set to 40% after 4 s unused, and restores it as a cursor nears", () => {
    expect(ALWAYS_THERE).toEqual(["play", "pause", "return"]);
    expect(isIdleDimmed("play", { msSinceUse: 3999, approached: false })).toBe(false);
    expect(isIdleDimmed("play", { msSinceUse: 4000, approached: false })).toBe(true);
    expect(isIdleDimmed("play", { msSinceUse: 60_000, approached: true })).toBe(false);
    expect(isIdleDimmed("record", { msSinceUse: 60_000, approached: false })).toBe(false);
    expect(glyphAppearance({ dimmed: true }, { headset: false }).opacity).toBe(0.4);
  });
});

describe("hit areas (styleguide 6.1)", () => {
  it("is the larger of the drawing and the input's minimum", () => {
    expect(hitAreaApx("mouse", 16)).toBe(24);
    expect(hitAreaApx("mouse", 36)).toBe(36);
    expect(hitAreaApx("touch", 36)).toBe(44);
    expect(hitAreaApx("ray", 16)).toBe(56);
    expect(hitAreaApx("gazePinch", 36)).toBe(72);
    expect(hitAreaApx("poke", 36)).toBe(72);
  });

  it("never scales an input's minimum by the headset factor, and a poke is 20 mm or more", () => {
    expect(hitAreaMeters("ray", 0, 1.75, { headset: true })).toBeCloseTo(apxToMeters(56, 1.75, { headset: false }), 10);
    expect(hitAreaMeters("poke", 16, tokens.placement.armReachM, { headset: true }) * 1000).toBeCloseTo(20, 6);
    expect(0.02 / (tokens.size.radiansPerApx * 0.45)).toBeCloseTo(120, -1);
  });

  it("maps every input to its minimum, gaze and pinch at 72", () => {
    expect(inputFromPointerType("mouse")).toBe("mouse");
    expect(inputFromPointerType("pen")).toBe("touch");
    expect(inputFromTargetRayMode("transient-pointer")).toBe("gazePinch");
    expect(inputFromTargetRayMode("tracked-pointer")).toBe("ray");
    expect(inputFromTargetRayMode("tracked-pointer", { poke: true })).toBe("poke");
    expect(inputFromTargetRayMode("screen")).toBe("touch");
  });

  it("keeps 30 apx between poke targets", () => {
    expect(glyphGapApx("poke", { headset: false })).toBe(30);
    expect(glyphGapApx("mouse", { headset: false })).toBe(12);
  });
});

describe("placement and handedness (styleguide 1.2; Q8, Q11)", () => {
  it("head-locks nothing but the periphery status line", () => {
    for (const target of ALL_TARGETS) {
      for (const control of ALL_CONTROLS) {
        expect(placeControl(control, target, "right").followsHead).toBe(target.kind !== "flat" && control === "status" && placeControl(control, target, "right").slot === "periphery");
      }
    }
  });

  it("puts actions on the non-dominant wrist in a headset, swapping with handedness", () => {
    expect(placeControl("record", VIEW_TARGETS.vr, "right")).toEqual({ slot: "wrist", hand: "left", followsHead: false });
    expect(placeControl("record", VIEW_TARGETS.vr, "left")).toEqual({ slot: "wrist", hand: "right", followsHead: false });
    expect(placeControl("menu", VIEW_TARGETS.vr, "left")).toMatchObject({ slot: "pointOfAction", hand: "left" });
  });

  it("keeps Exit and the placing hint reachable in AR before placement: wrist on Quest, dock on Android", () => {
    expect(placeControl("exitAr", VIEW_TARGETS.questPassthrough, "right").slot).toBe("wrist");
    expect(placeControl("placingHint", VIEW_TARGETS.questPassthrough, "right").slot).toBe("wrist");
    expect(placeControl("exitAr", VIEW_TARGETS.androidChrome, "right").slot).toBe("dock");
  });

  it("puts lists on a world panel 1 m or more away in a headset, a side sheet on flat screens", () => {
    expect(placeControl("settings", VIEW_TARGETS.vr, "right")).toEqual({ slot: "world", followsHead: false, minDistanceM: 1 });
    expect(placeControl("settings", VIEW_TARGETS.phone, "right").slot).toBe("sideSheet");
    expect(worldPanelDistanceM()).toBe(1.5);
    expect(worldPanelDistanceM(0.4)).toBe(1);
  });

  it("puts Play, Free and Return at the stage base in a room and in the shade on flat screens", () => {
    expect(placeControl("play", VIEW_TARGETS.questPassthrough, "right").slot).toBe("stageBase");
    expect(placeControl("play", VIEW_TARGETS.desktop, "right").slot).toBe("shade");
    expect(placeControl("play", VIEW_TARGETS.quickLook, "right").slot).toBe("none");
  });

  it("follows the head lazily: still within 20°, then back above the line of sight", () => {
    let line = startLazyFollow(0, 0);
    expect(line.pitch).toBe(20);
    line = stepLazyFollow(line, 15, 0, 16);
    expect(line).toMatchObject({ yaw: 0, following: false });
    for (let i = 0; i < 200; i += 1) line = stepLazyFollow(line, 40, 0, 16);
    expect(line.following).toBe(false);
    expect(line.yaw).toBeGreaterThan(39);
    expect(line.pitch).toBeCloseTo(20, 0);
  });
});

describe("headset text (styleguide 7.3)", () => {
  it("shows no text within arm's reach", () => {
    expect(headsetTextVisible(VIEW_TARGETS.vr, "label", { fromHeadM: 0.45 })).toBe(false);
    expect(headsetTextVisible(VIEW_TARGETS.questPassthrough, "status", { fromHeadM: 0.99 })).toBe(false);
    expect(headsetTextVisible(VIEW_TARGETS.vr, "status", { fromHeadM: 1.5 })).toBe(true);
    expect(headsetTextVisible(VIEW_TARGETS.phone, "label", { fromHeadM: 0.3 })).toBe(true);
  });

  it("hides a hologram's labels, timecode and caption within 1 m of it, and folds notes", () => {
    expect(headsetTextVisible(VIEW_TARGETS.vr, "caption", { fromHeadM: 1.2, toHologramM: 0.9 })).toBe(false);
    expect(headsetTextVisible(VIEW_TARGETS.vr, "caption", { fromHeadM: 1.2, toHologramM: 1.1 })).toBe(true);
    expect(noteFolded(VIEW_TARGETS.vr, 0.8)).toBe(true);
    expect(noteFolded(VIEW_TARGETS.desktop, 0.8)).toBe(false);
  });
});

describe("recording chrome (styleguide 8.5)", () => {
  it("hides everything but stop, the running time, the Halo, the tray and Find until the take ends", () => {
    const shown = ALL_CONTROLS.filter((control) => chromeVisible(control, true));
    expect(shown.sort()).toEqual(["find", "halo", "record", "status", "timecode", "tray"]);
    expect(ALL_CONTROLS.every((control) => chromeVisible(control, false))).toBe(true);
  });

  it("says the state in words, counting up", () => {
    expect(recordingText(12_400)).toBe("Recording 0:12");
    expect(recordingText(3_723_000)).toBe("Recording 1:02:03");
    expect(pausedText(8_000)).toBe("Paused · 0:08");
  });
});

describe("scale (styleguide 4; Q13)", () => {
  it("is unlabelled only at true scale, and labels every rescale", () => {
    expect(scaleState()).toEqual({ factor: 1, label: null, canReturn: false });
    expect(scaleLabel(0.25)).toBe("1:4");
    expect(scaleLabel(2.5)).toBe("2.5:1");
    expect(scaleLabel(0.98)).toBe("1:1.02");
    expect(scaleLabel(1.0004)).toBe("1.0004:1");
    expect(scaleState(0.5).canReturn).toBe(true);
    expect(() => scaleLabel(0)).toThrow(RangeError);
  });
});

describe("type roles (styleguide 7)", () => {
  it("sets titles in Fraunces with optical sizing and timecode with tabular figures, in muted text", () => {
    expect(typeStyle("titleDesktop", { headset: false })).toMatchObject({ fontWeight: 600, opticalSizing: true, msdfFace: "fraunces-600" });
    expect(typeStyle("timecode", { headset: false })).toMatchObject({ tabularNumbers: true, color: tokens.color.textMuted, msdfFace: "figtree-400" });
    expect(typeStyle("controlLabel", { headset: false })).toMatchObject({ color: tokens.color.gold, msdfFace: "figtree-500", fontSizeApx: 14 });
  });
});

describe("targets", () => {
  it("names Quest passthrough and Android Chrome, and leaves the rest unlisted", () => {
    expect(arCompositorFromUserAgent("Mozilla/5.0 (X11; Linux x86_64; Quest 3) OculusBrowser/37.0 Chrome/132")).toBe("questPassthrough");
    expect(arCompositorFromUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/132 Mobile")).toBe("androidChrome");
    expect(arCompositorFromUserAgent("Mozilla/5.0 (Macintosh) Safari/605")).toBe("unlisted");
  });
});
