import { tokens } from "@holoim/design-tokens";
import { describe, expect, it } from "vitest";

import golden from "./fixtures/edge-golden.json" with { type: "json" };
import {
  ambientLuminance,
  bubbleSilhouette,
  edgeFrame,
  edgeOutline,
  edgePathData,
  edgePointsYUp,
  edgeStrokes,
  flatGroundColorAt,
  haloLayers,
  haloMaterialOpacity,
  hashSeed,
  nextArSootOn,
  relativeLuminance,
  sootBlend,
  VIEW_TARGETS,
  type EdgeFrameOptions
} from "./index.js";

// Failure cases (docs/features/ui-redesign.md): the edge differs between SVG,
// canvas, 3D and the USDZ for one hologram; the edge is clipped square at
// small sizes; AR soot flickers as the lighting estimate wavers; AR with no
// estimate keeps the glow against a bright wall; the AR ring slides off the
// bubble's outline as the viewer walks round it, or changes its tears.

describe("edgeOutline (styleguide 3.1)", () => {
  it("draws the same points from the same seed, and different tears from another", () => {
    const a = edgeOutline({ seed: "hologram-a", width: 300, height: 240 });
    expect(edgeOutline({ seed: "hologram-a", width: 300, height: 240 })).toEqual(a);
    expect(edgeOutline({ seed: "hologram-b", width: 300, height: 240 }).points).not.toEqual(a.points);
  });

  it("matches the golden outline the USDZ builder's port must reproduce", () => {
    const outline = edgeOutline({ seed: golden.seed, width: golden.width, height: golden.height });
    expect(hashSeed(golden.seed)).toBe(golden.hash);
    expect(outline.waves).toBe(golden.waves);
    expect(outline.tears).toHaveLength(golden.tears);
    outline.points.forEach((point, i) => {
      expect(point.x).toBeCloseTo(golden.points[i]![0]!, 3);
      expect(point.y).toBeCloseTo(golden.points[i]![1]!, 3);
    });
  });

  it("samples 280 points with waves and tears inside their ranges", () => {
    for (const seed of ["a", "b", "c", "d", "e", "f"]) {
      const outline = edgeOutline({ seed, width: 300, height: 240 });
      expect(outline.points).toHaveLength(tokens.edge.samples);
      expect(outline.waves).toBeGreaterThanOrEqual(3);
      expect(outline.waves).toBeLessThanOrEqual(9);
      expect(outline.tears.length).toBeGreaterThanOrEqual(16);
      expect(outline.tears.length).toBeLessThanOrEqual(38);
    }
  });

  it("is the same shape at every size: points scale with the card", () => {
    const small = edgeOutline({ seed: "same", width: 80, height: 64 });
    const large = edgeOutline({ seed: "same", width: 800, height: 640 });
    large.points.forEach((point, i) => {
      expect(point.x / 10).toBeCloseTo(small.points[i]!.x, 6);
      expect(point.y / 10).toBeCloseTo(small.points[i]!.y, 6);
    });
  });

  // 3.3: the phone card's tears are 2.2 apx deep, the deepest 3.1.
  it("tears the phone card about 2.2 apx deep, never past 3.1", () => {
    const shortSide = 240;
    for (const seed of ["a", "b", "c", "d"]) {
      const depths = edgeOutline({ seed, width: 300, height: shortSide }).tears.map((tear) => tear.depth * shortSide);
      expect(Math.max(...depths)).toBeLessThanOrEqual(3.1);
      expect(depths.reduce((sum, depth) => sum + depth, 0) / depths.length).toBeCloseTo(2.2, 0);
    }
  });

  // 3.1: inset is the larger of 6% and the halo width, so the glow is never clipped square.
  it("keeps the halo inside an 80 × 64 thumbnail", () => {
    for (const seed of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      const outline = edgeOutline({ seed, width: 80, height: 64 });
      const half = edgeStrokes(outline.shortSide).halo.width / 2;
      expect(outline.inset).toBeCloseTo(Math.max(tokens.edge.insetMin, tokens.edge.halo.width) * 64, 10);
      for (const point of outline.points) {
        expect(point.x - half).toBeGreaterThanOrEqual(0);
        expect(point.y - half).toBeGreaterThanOrEqual(0);
        expect(point.x + half).toBeLessThanOrEqual(80);
        expect(point.y + half).toBeLessThanOrEqual(64);
      }
    }
  });

  it("gives SVG and three.js the same points (y down, and centred y up)", () => {
    const outline = edgeOutline({ seed: "x", width: 300, height: 240 });
    const d = edgePathData(outline.points);
    expect(d.startsWith(`M${Number(outline.points[0]!.x.toFixed(2))} `)).toBe(true);
    expect(d.match(/L/g)).toHaveLength(tokens.edge.samples - 1);
    const yUp = edgePointsYUp(outline, 300, 240);
    expect(yUp[10]).toEqual({ x: outline.points[10]!.x - 150, y: 120 - outline.points[10]!.y });
  });
});

describe("the circle around the AR bubble (styleguide 9.2)", () => {
  const circle = (seed: string, diameter: number) => edgeOutline({ seed, width: diameter, height: diameter, shape: "circle" });

  it("draws the same points from the same seed, and other tears from another", () => {
    expect(circle("hologram-a", 1)).toEqual(circle("hologram-a", 1));
    expect(circle("hologram-b", 1).points).not.toEqual(circle("hologram-a", 1).points);
  });

  it("keeps a hologram's waves and tears from its card, and leaves the card's outline as it was", () => {
    const card = edgeOutline({ seed: "same", width: 300, height: 240 });
    expect(edgeOutline({ seed: "same", width: 300, height: 240, shape: "roundedRect" })).toEqual(card);
    const ring = edgeOutline({ seed: "same", width: 240, height: 240, shape: "circle" });
    expect(ring.waves).toBe(card.waves);
    expect(ring.tears).toEqual(card.tears);
  });

  it("follows the circle: every point within the waves, tears and jitter of the radius, clockwise from the top", () => {
    const { edge } = tokens;
    const most = edge.waveAmplitude + edge.tearAmplitude * 1.4 + edge.jitter;
    for (const seed of ["a", "b", "c", "d"]) {
      const outline = circle(seed, 2);
      expect(outline.inset).toBe(0);
      expect(outline.shortSide).toBe(2);
      for (const point of outline.points) expect(Math.abs(Math.hypot(point.x - 1, point.y - 1) - 1)).toBeLessThanOrEqual(most * 2 + 1e-9);
      const [first, second] = outline.points;
      expect(first!.y).toBeLessThan(1);
      expect(second!.x).toBeGreaterThan(first!.x);
    }
  });

  it("scales with the bubble: points and strokes are shares of the diameter", () => {
    const small = circle("same", 0.4);
    const large = circle("same", 4);
    large.points.forEach((point, i) => {
      expect(point.x / 10).toBeCloseTo(small.points[i]!.x, 9);
      expect(point.y / 10).toBeCloseTo(small.points[i]!.y, 9);
    });
    expect(edgeStrokes(large.shortSide).halo.width / 10).toBeCloseTo(edgeStrokes(small.shortSide).halo.width, 12);
    expect(edgeStrokes(large.shortSide).core.width / 10).toBeCloseTo(edgeStrokes(small.shortSide).core.width, 12);
  });
});

describe("bubbleSilhouette (styleguide 9.2)", () => {
  const centre = { x: 0.2, y: 1.1, z: -1.5 };
  const radius = 0.6;

  it("stays on the sphere's outline as the viewer walks round it", () => {
    for (let step = 0; step < 12; step += 1) {
      const angle = (step / 12) * Math.PI * 2;
      const distance = 1 + step * 0.4;
      const eye = { x: centre.x + distance * Math.sin(angle), y: 1.6, z: centre.z + distance * Math.cos(angle) };
      const ring = bubbleSilhouette(centre, radius, eye)!;
      const toEye = { x: eye.x - centre.x, y: eye.y - centre.y, z: eye.z - centre.z };
      const length = Math.hypot(toEye.x, toEye.y, toEye.z);
      expect(ring.normal.x * length).toBeCloseTo(toEye.x, 9);
      expect(ring.normal.z * length).toBeCloseTo(toEye.z, 9);
      // Points round the circle: on the sphere, and the line from the eye only touches it there.
      const helper = Math.abs(ring.normal.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
      const u = normalize(cross(ring.normal, helper));
      const v = cross(ring.normal, u);
      for (let k = 0; k < 8; k += 1) {
        const a = (k / 8) * Math.PI * 2;
        const point = {
          x: ring.center.x + ring.radius * (Math.cos(a) * u.x + Math.sin(a) * v.x),
          y: ring.center.y + ring.radius * (Math.cos(a) * u.y + Math.sin(a) * v.y),
          z: ring.center.z + ring.radius * (Math.cos(a) * u.z + Math.sin(a) * v.z)
        };
        const fromCentre = sub(point, centre);
        expect(Math.hypot(fromCentre.x, fromCentre.y, fromCentre.z)).toBeCloseTo(radius, 9);
        expect(dot(fromCentre, sub(point, eye))).toBeCloseTo(0, 9);
      }
    }
  });

  it("nears the sphere's own size from far away, and has no outline from inside", () => {
    expect(bubbleSilhouette(centre, radius, { x: centre.x, y: centre.y, z: centre.z + 100 })!.radius).toBeCloseTo(radius, 4);
    expect(bubbleSilhouette(centre, radius, { x: centre.x, y: centre.y, z: centre.z + 0.3 })).toBeNull();
    expect(bubbleSilhouette(centre, 0, { x: 0, y: 0, z: 5 })).toBeNull();
  });
});

type V = { x: number; y: number; z: number };
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: V, b: V) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V, b: V): V => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const normalize = (a: V): V => {
  const length = Math.hypot(a.x, a.y, a.z);
  return { x: a.x / length, y: a.y / length, z: a.z / length };
};

describe("edgeStrokes (styleguide 3.2, 3.3)", () => {
  it("matches the reference sizes for an 80 px thumbnail and a phone card", () => {
    const thumbnail = edgeStrokes(64);
    expect(thumbnail.core.width).toBeCloseTo(0.9, 1);
    expect(thumbnail.halo.width).toBeCloseTo(3.8, 1);
    expect(thumbnail.highlight.width).toBeCloseTo(0.3, 1);
    const card = edgeStrokes(240);
    expect(card.core.width).toBeCloseTo(3.4, 1);
    expect(card.halo.width).toBeCloseTo(14.4, 1);
    expect(card.highlight.width).toBeCloseTo(1.0, 1);
  });

  it("blurs the halo and soot by half the halo width, in the token colours", () => {
    const strokes = edgeStrokes(240);
    expect(strokes.halo.blur).toBeCloseTo(7.2, 6);
    expect(strokes.soot).toEqual({ ...strokes.halo, color: tokens.color.deepSea });
    expect([strokes.halo.color, strokes.core.color, strokes.highlight.color]).toEqual([tokens.color.glow, tokens.color.gold, tokens.color.highlight]);
  });

  it("rests the 3D halo material at 0.9 and caps it at 1", () => {
    expect(haloMaterialOpacity(0.5)).toBeCloseTo(0.9, 10);
    expect(haloMaterialOpacity(0.58)).toBe(1);
    expect(haloMaterialOpacity(0.08)).toBeCloseTo(0.144, 10);
  });
});

describe("soot (styleguide 3.2)", () => {
  it("is all glow about 75% down the flat ground and all soot about 88% down", () => {
    expect(sootBlend(relativeLuminance(flatGroundColorAt(0.74)))).toBe(0);
    expect(sootBlend(relativeLuminance(flatGroundColorAt(0.885)))).toBe(1);
    expect(flatGroundColorAt(0.8)).toBe(tokens.color.ground.grey);
  });

  it("splits a level into glow and soot at 0.6 on flat screens and in VR", () => {
    for (const target of [VIEW_TARGETS.desktop, VIEW_TARGETS.vr]) {
      const layers = haloLayers(target, 0.5, { groundLuminance: 1 });
      expect(layers).toEqual({ glowLevel: 0, sootOpacity: 0.6, t: 1 });
      expect(haloLayers(target, 0.5, { groundLuminance: 0 })).toEqual({ glowLevel: 0.5, sootOpacity: 0, t: 0 });
    }
  });

  it("keeps soot on at full strength in AR without a lighting estimate", () => {
    expect(haloLayers(VIEW_TARGETS.questPassthrough, 0.5, { arSootOn: null })).toEqual({ glowLevel: 0, sootOpacity: 1, t: 1 });
  });

  it("does not flicker as a noisy estimate wavers between the thresholds", () => {
    let on = false;
    const states: boolean[] = [];
    for (let i = 0; i < 200; i += 1) {
      const y = 0.125 + 0.03 * Math.sin(i * 1.7) + 0.004 * Math.sin(i * 13.1);
      on = nextArSootOn(on, y);
      states.push(on);
    }
    expect(new Set(states)).toEqual(new Set([false]));
    on = nextArSootOn(on, 0.16);
    expect(on).toBe(true);
    for (let i = 0; i < 200; i += 1) {
      on = nextArSootOn(on, 0.1 + 0.05 * Math.abs(Math.sin(i)));
      expect(on).toBe(true);
    }
    expect(nextArSootOn(true, 0.094)).toBe(false);
  });

  it("reads brightness from the first spherical-harmonic coefficient", () => {
    const sh = new Float32Array(27);
    sh.set([0.2, 0.2, 0.2]);
    expect(ambientLuminance(sh)).toBeCloseTo(0.2, 6);
  });
});

describe("edgeFrame (styleguide 8.5)", () => {
  const base: EdgeFrameOptions = { timeMs: 0, recording: false, inFocus: true, reducedMotion: false, soot: { groundLuminance: 0 } };

  it("quiets the flat edge while recording: halo 0.08, core and highlight 0.55, no sparks", () => {
    expect(edgeFrame(VIEW_TARGETS.phone, { ...base, recording: true })).toEqual({
      drawn: true, glowLevel: 0.08, sootOpacity: 0, coreOpacity: 0.55, highlightOpacity: 0.55, sparks: 0
    });
  });

  it("draws no edge in a headset or AR while recording", () => {
    for (const target of [VIEW_TARGETS.vr, VIEW_TARGETS.questPassthrough, VIEW_TARGETS.androidChrome]) {
      expect(edgeFrame(target, { ...base, recording: true, soot: { arSootOn: null } }).drawn).toBe(false);
    }
  });

  it("sparks only the hologram in focus", () => {
    expect(edgeFrame(VIEW_TARGETS.phone, base).sparks).toBe(120);
    expect(edgeFrame(VIEW_TARGETS.phone, { ...base, inFocus: false }).sparks).toBe(0);
  });

  it("holds a hologram out of focus at a steady 0.50 on every target, flickering or reduced (8.2)", () => {
    for (const target of [VIEW_TARGETS.phone, VIEW_TARGETS.desktop, VIEW_TARGETS.vr, VIEW_TARGETS.questPassthrough]) {
      for (const reducedMotion of [false, true]) {
        // 0%, 40%, 55% and 70% of the flat loop, and the reduced fade's trough.
        const levels = [0, 1040, 1430, 1820, 4000].map((timeMs) =>
          edgeFrame(target, { ...base, timeMs, inFocus: false, reducedMotion, soot: { groundLuminance: 0, arSootOn: false } }).glowLevel
        );
        expect(new Set(levels), `${target.kind} reduced=${reducedMotion}`).toEqual(new Set([0.5]));
      }
    }
    // The control: in focus, the same instants do flicker.
    expect(edgeFrame(VIEW_TARGETS.desktop, { ...base, timeMs: 1040 }).glowLevel).toBeCloseTo(0.32, 5);
  });
});
