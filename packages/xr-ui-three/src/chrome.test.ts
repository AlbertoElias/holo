// The two failure cases that cut across every component: gold converted to
// linear twice or tone-mapped (read back from the material), and chrome that
// is not flagged as chrome (so a recording or export would include it).
import { tokens } from "@holoim/design-tokens";
import { CAPTURE_HALO_ACTIONS, VIEW_TARGETS, type GlyphId } from "@holoim/xr-ui-core";
import type { Material, Object3D } from "three";
import { beforeAll, describe, expect, it } from "vitest";

import { createChromeMaterial } from "./chrome.js";
import { ThreeChip } from "./ThreeChip.js";
import { ThreeEdge } from "./ThreeEdge.js";
import { ThreeGlyph } from "./ThreeGlyph.js";
import { ThreeHalo } from "./ThreeHalo.js";
import { ThreeMsdfLabel } from "./ThreeMsdfLabel.js";
import { ThreeStatusLine } from "./ThreeStatusLine.js";
import { ThreeWorldPanel } from "./ThreeWorldPanel.js";
import { ThreeWristGlyphs } from "./ThreeWristGlyphs.js";
import { everyDescendantIsChrome, figtree400, hexOf, materialsOf } from "./testing.js";

const TOKEN_HEXES: string[] = [
  tokens.color.gold,
  tokens.color.glow,
  tokens.color.highlight,
  tokens.color.deepSea,
  tokens.color.record,
  tokens.color.text,
  tokens.color.textMuted
];

const ALL_GLYPHS: GlyphId[] = ["play", "free", "return", "viewInAr", "record"];

let font: Awaited<ReturnType<typeof figtree400>>;
beforeAll(async () => {
  font = await figtree400();
});

function components(): Record<string, Object3D> {
  const panel = new ThreeWorldPanel();
  panel.addRow(new ThreeMsdfLabel({ text: "Settings", role: "controlLabel", headset: true, distanceM: panel.distanceM, font, texture: null }));
  const halo = new ThreeHalo({ actions: CAPTURE_HALO_ACTIONS, distanceM: 1 });
  halo.handle({ type: "press", atMs: 0 });
  halo.handle({ type: "tick", atMs: 400 });
  const glyphs = new ThreeWristGlyphs({ handedness: "right", glyphs: ALL_GLYPHS, input: "poke" });
  glyphs.setRecording(true);
  return {
    edge: new ThreeEdge({ seed: "holo-1", width: 0.62, height: 0.74 }).group,
    glyphs: glyphs.group,
    hoveredGlyphs: (() => {
      const row = new ThreeWristGlyphs({ handedness: "left", glyphs: ALL_GLYPHS, input: "ray" });
      for (const glyph of row.glyphs) glyph.setState({ hovered: true, focusVisible: true });
      return row.group;
    })(),
    emptyGlyph: new ThreeGlyph({ id: null, input: "ray", distanceM: 1, headset: true }).group,
    label: new ThreeMsdfLabel({ text: "Recording 0:12", role: "timecode", headset: true, distanceM: 1.5, font, texture: null }).group,
    chip: new ThreeChip({ target: VIEW_TARGETS.questPassthrough, distanceM: 1.5, contentWidthM: 0.3, contentHeightM: 0.05 }).group,
    statusLine: new ThreeStatusLine({ text: "Recording 0:12", font, texture: null, chip: true }).group,
    worldPanel: panel.group,
    halo: halo.group
  };
}

describe("every chrome material reads back as a token, untone-mapped", () => {
  it("has a token colour (converted to linear once) and toneMapped false, on every component", () => {
    for (const [name, root] of Object.entries(components())) {
      const materials = materialsOf(root);
      expect(materials.length, name).toBeGreaterThan(0);
      for (const material of materials as Material[]) {
        expect(TOKEN_HEXES, `${name}: ${material.type}`).toContain(hexOf(material));
        expect(material.toneMapped, name).toBe(false);
      }
    }
  });

  it("reads gold back as gold: a second sRGB to linear conversion would darken it", () => {
    const material = createChromeMaterial({ color: tokens.color.gold });
    expect(`#${material.color.getHexString()}`).toBe(tokens.color.gold);
    // The working colour is linear: its raw channels differ from the sRGB bytes.
    expect(material.color.r).toBeCloseTo(1, 6);
    expect(material.color.g).toBeLessThan(200 / 255);
    expect(material.toneMapped).toBe(false);
  });

  it("blends only when translucent or carrying vertex alpha, and then writes no depth", () => {
    expect(createChromeMaterial({ color: tokens.color.gold }).transparent).toBe(false);
    const translucent = createChromeMaterial({ color: tokens.color.gold, opacity: 0.5 });
    expect(translucent.transparent).toBe(true);
    expect(translucent.depthWrite).toBe(false);
    expect(createChromeMaterial({ color: tokens.color.gold, vertexColors: true }).transparent).toBe(true);
  });
});

describe("the chrome flag (recording, export and point resolution skip it)", () => {
  it("is on every descendant of every component's root", () => {
    for (const [name, root] of Object.entries(components())) {
      expect(everyDescendantIsChrome(root), name).toBe(true);
    }
  });
});
