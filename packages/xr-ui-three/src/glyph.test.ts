// Styleguide 6 and 6.1: glyph drawings, states, and hit areas that follow the
// input and are never scaled by the headset factor.
import { apxToMeters, tokens } from "@holoim/design-tokens";
import type { GlyphId } from "@holoim/xr-ui-core";
import { Raycaster, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { ThreeGlyph } from "./ThreeGlyph.js";
import { ThreeWristGlyphs } from "./ThreeWristGlyphs.js";
import { everyDescendantIsChrome, hexOf, meshesOf } from "./testing.js";

const ARM = tokens.placement.armReachM;
const WRIST: GlyphId[] = ["play", "free", "return", "record"];

describe("ThreeGlyph drawing (6)", () => {
  it("draws Play's triangle inside the gold ring, and Free and Return as strokes", () => {
    const play = new ThreeGlyph({ id: "play", input: "ray", distanceM: 1.5, headset: true });
    expect(play.ring).not.toBeNull();
    expect(play.shape).not.toBeNull();
    expect(hexOf(play.shape!.material as never)).toBe(tokens.glyph.color);
    for (const id of ["free", "return", "viewInAr"] as const) {
      const glyph = new ThreeGlyph({ id, input: "ray", distanceM: 1.5, headset: true });
      expect(glyph.ring).toBeNull();
      expect(glyph.shape!.geometry.getAttribute("position").count).toBeGreaterThan(8);
      glyph.shape!.geometry.computeBoundingBox();
      const box = glyph.shape!.geometry.boundingBox!;
      // The drawing is the 16 apx icon (plus half a stroke at the extremes), centred.
      const icon = apxToMeters(tokens.glyph.icon, 1.5, { headset: true });
      const stroke = apxToMeters(tokens.glyph.stroke, 1.5, { headset: true });
      expect(box.max.x - box.min.x).toBeLessThanOrEqual(icon + stroke);
      expect(box.max.x - box.min.x).toBeGreaterThan(icon * 0.7);
      expect(Math.abs(box.max.x + box.min.x)).toBeLessThan(icon * 0.2);
    }
  });

  it("flips the drawing to y up: Return's arrowhead (top left in the 16 box) is above the centre", () => {
    const glyph = new ThreeGlyph({ id: "return", input: "ray", distanceM: 1, headset: false });
    const position = glyph.shape!.geometry.getAttribute("position");
    let top = -Infinity;
    for (let i = 0; i < position.count; i += 1) top = Math.max(top, position.getY(i));
    glyph.shape!.geometry.computeBoundingBox();
    // The arrowhead M3 2.5 v2.5 h2.5 sits at the top of the box; the arc ends below it.
    expect(top).toBeCloseTo(glyph.shape!.geometry.boundingBox!.max.y);
    expect(top).toBeGreaterThan(0);
  });

  it("draws Record as a rose circle, and as a rose rounded square when recording, in the same colour (6, 8.5)", () => {
    const record = new ThreeGlyph({ id: "record", input: "ray", distanceM: 1, headset: false });
    expect(record.shape!.geometry.type).toBe("CircleGeometry");
    expect(hexOf(record.shape!.material as never)).toBe(tokens.color.record);
    record.setRecording(true);
    expect(record.shape!.geometry.type).toBe("ShapeGeometry");
    expect(hexOf(record.shape!.material as never)).toBe(tokens.color.record);
    expect(record.group.children.filter((child) => child === record.shape)).toHaveLength(1);
    record.setRecording(false);
    expect(record.shape!.geometry.type).toBe("CircleGeometry");
  });

  it("sizes the rose circle and the ring in apx at the distance (2.5x only in a headset)", () => {
    const flat = new ThreeGlyph({ id: "record", input: "ray", distanceM: 1.5, headset: false });
    const headset = new ThreeGlyph({ id: "record", input: "ray", distanceM: 1.5, headset: true });
    const diameter = (glyph: ThreeGlyph) => {
      glyph.shape!.geometry.computeBoundingBox();
      return glyph.shape!.geometry.boundingBox!.max.x * 2;
    };
    expect(diameter(flat)).toBeCloseTo(apxToMeters(14, 1.5, { headset: false }), 6);
    expect(diameter(headset) / diameter(flat)).toBeCloseTo(2.5, 6);
    const outer = (glyph: ThreeGlyph) => (glyph.ring!.geometry as unknown as { parameters: { outerRadius: number } }).parameters.outerRadius * 2;
    expect(outer(flat)).toBeCloseTo(apxToMeters(36, 1.5, { headset: false }), 6);
    expect(outer(headset) / outer(flat)).toBeCloseTo(2.5, 6);
  });
});

describe("ThreeGlyph states (6)", () => {
  it("brightens ring and drawing on hover, adds a focus ring, dims to 55% pressed, never moves record's colour", () => {
    const play = new ThreeGlyph({ id: "play", input: "ray", distanceM: 1, headset: true });
    expect(play.focusRing.visible).toBe(false);
    play.setState({ hovered: true });
    expect(hexOf(play.ring!.material as never)).toBe(tokens.glyph.states.hoverColor);
    expect(hexOf(play.shape!.material as never)).toBe(tokens.glyph.states.hoverColor);
    play.setState({ focusVisible: true });
    expect(play.focusRing.visible).toBe(true);
    expect(hexOf(play.focusRing.material as never)).toBe(tokens.glyph.states.focusRingColor);
    play.setState({ pressed: true });
    expect((play.ring!.material as { opacity: number }).opacity).toBeCloseTo(0.55);
    play.setState({ dimmed: true });
    expect((play.ring!.material as { opacity: number }).opacity).toBeCloseTo(0.4);

    const record = new ThreeGlyph({ id: "record", input: "ray", distanceM: 1, headset: true });
    record.setState({ hovered: true });
    expect(hexOf(record.ring!.material as never)).toBe(tokens.glyph.states.hoverColor);
    expect(hexOf(record.shape!.material as never)).toBe(tokens.color.record);
  });

  it("puts the focus ring outside the glyph by the focus offset (headset-scaled)", () => {
    const play = new ThreeGlyph({ id: "play", input: "ray", distanceM: 1, headset: true });
    const parameters = (play.focusRing.geometry as unknown as { parameters: { innerRadius: number; outerRadius: number } }).parameters;
    const ringOuter = apxToMeters(tokens.glyph.ring, 1, { headset: true }) / 2;
    expect(parameters.innerRadius - ringOuter).toBeCloseTo(apxToMeters(tokens.glyph.states.focusRingOffset, 1, { headset: true }), 6);
    expect(parameters.outerRadius - parameters.innerRadius).toBeCloseTo(apxToMeters(tokens.glyph.states.focusRingWidth, 1, { headset: true }), 6);
  });
});

describe("hit areas (6.1)", () => {
  it("makes the wrist row's pokes at least 20 mm at arm's reach, however small the drawing", () => {
    const row = new ThreeWristGlyphs({ handedness: "right", glyphs: WRIST, input: "poke" });
    for (const glyph of row.glyphs) expect(glyph.hitSizeM).toBeGreaterThanOrEqual(0.02 - 1e-9);
  });

  it("makes ray hit areas at least 56 apx, flat-sized", () => {
    const row = new ThreeWristGlyphs({ handedness: "right", glyphs: WRIST, input: "ray" });
    const minimum = apxToMeters(56, ARM, { headset: false });
    for (const glyph of row.glyphs) expect(glyph.hitSizeM).toBeGreaterThanOrEqual(minimum - 1e-9);
  });

  it("draws the ring at 2.5x in a headset while the hit area does not take the factor", () => {
    const flat = new ThreeGlyph({ id: "play", input: "poke", distanceM: ARM, headset: false });
    const headset = new ThreeGlyph({ id: "play", input: "poke", distanceM: ARM, headset: true });
    expect(headset.drawnSizeM / flat.drawnSizeM).toBeCloseTo(2.5, 6);
    // At arm's reach the 20 mm poke floor rules for both: the factor changed the drawing, not the target.
    expect(headset.hitSizeM).toBeCloseTo(0.02, 9);
    expect(flat.hitSizeM).toBeCloseTo(0.02, 9);
    // And the minimum is the floor of a target, never a multiple of the headset factor.
    const ray = new ThreeGlyph({ id: "free", input: "ray", distanceM: 1.5, headset: true });
    expect(ray.hitSizeM).toBeCloseTo(Math.max(apxToMeters(56, 1.5, { headset: false }), apxToMeters(16, 1.5, { headset: true })), 9);
  });

  it("is raycastable although invisible, and as large as hitSizeM", () => {
    const glyph = new ThreeGlyph({ id: "free", input: "poke", distanceM: ARM, headset: true });
    expect(glyph.hitTarget.material).toMatchObject({ visible: false });
    glyph.group.updateMatrixWorld(true);
    const raycaster = new Raycaster(new Vector3(glyph.hitSizeM * 0.45, 0, 1), new Vector3(0, 0, -1));
    expect(raycaster.intersectObject(glyph.hitTarget)).toHaveLength(1);
    const outside = new Raycaster(new Vector3(glyph.hitSizeM * 0.55, 0, 1), new Vector3(0, 0, -1));
    expect(outside.intersectObject(glyph.hitTarget)).toHaveLength(0);
    const behind = new Raycaster(new Vector3(glyph.hitSizeM * 0.2, 0, -1), new Vector3(0, 0, 1));
    expect(behind.intersectObject(glyph.hitTarget)).toHaveLength(1);
  });

  it("spaces the wrist row so neighbouring hit areas never overlap and keep the poke gap (5.0 mm at 45 cm)", () => {
    for (const input of ["poke", "ray"] as const) {
      const row = new ThreeWristGlyphs({ handedness: "right", glyphs: WRIST, input });
      for (let i = 1; i < row.glyphs.length; i += 1) {
        const a = row.glyphs[i - 1]!;
        const b = row.glyphs[i]!;
        const between = b.group.position.x - a.group.position.x - (a.hitSizeM + b.hitSizeM) / 2;
        expect(between).toBeGreaterThanOrEqual(row.gapM - 1e-9);
        expect(between).toBeGreaterThan(0);
      }
      // Glyphs only: nothing in the row is text.
      expect(meshesOf(row.group).some((mesh) => (mesh.material as { isShaderMaterial?: boolean }).isShaderMaterial)).toBe(false);
    }
    const poke = new ThreeWristGlyphs({ handedness: "right", glyphs: WRIST, input: "poke" });
    expect(poke.gapM).toBeCloseTo(0.005, 3);
  });

  it("is chrome on every object, after a Record to Stop rebuild too", () => {
    const row = new ThreeWristGlyphs({ handedness: "right", glyphs: WRIST, input: "poke" });
    expect(everyDescendantIsChrome(row.group)).toBe(true);
    row.setRecording(true);
    expect(everyDescendantIsChrome(row.group)).toBe(true);
    const record = new ThreeGlyph({ id: "record", input: "ray", distanceM: 1, headset: false });
    record.setRecording(true);
    record.setState({ hovered: true, focusVisible: true });
    expect(everyDescendantIsChrome(record.group)).toBe(true);
  });
});

// Failure case found in xr-ui-r3f: a rebuilt Record shape drew at order 0 and
// sorted under the chip it sits on, so Stop vanished on a translucent chip.
describe("ThreeGlyph draw order", () => {
  it("keeps its render order when Record becomes Stop", () => {
    const record = new ThreeGlyph({ id: "record", input: "ray", distanceM: 1.5, headset: true });
    record.setRenderOrder(11);
    record.setRecording(true);
    expect(meshesOf(record.group).every((mesh) => mesh.renderOrder === 11)).toBe(true);
  });
});
