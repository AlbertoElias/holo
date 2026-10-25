import { LinearSRGBColorSpace, SRGBColorSpace } from "three";
import { describe, expect, it } from "vitest";

import { apxToMeters, hitAreaMeters, tokens } from "./index.js";
import { chromeMaterial, tokenColor } from "./three.js";

describe("tokenColor", () => {
  // Gold converted to linear twice, or not at all, would shift it visibly.
  it("converts sRGB hex to linear once and reads back the same hex", () => {
    const gold = tokenColor(tokens.color.gold);
    expect(gold.getHexString(SRGBColorSpace)).toBe("ffc872");
    const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const linear = gold.clone().getRGB({ r: 0, g: 0, b: 0 }, LinearSRGBColorSpace);
    expect(linear.g).toBeCloseTo(srgbToLinear(0xc8 / 255), 5);
  });

  it("keeps chrome out of tone mapping", () => {
    expect(chromeMaterial.toneMapped).toBe(false);
  });
});

describe("apxToMeters", () => {
  // Styleguide 6.1: a 56 apx ray target is about 37 mm at 1.75 m.
  it("follows size_m = apx × 0.000372 × distance", () => {
    expect(apxToMeters(56, 1.75, { headset: false }) * 1000).toBeCloseTo(36.5, 1);
  });

  // Styleguide 6 and 7.3: the 3.75 apx headset stroke and the 90 apx ring.
  it("applies the 2.5× headset factor to drawn sizes", () => {
    expect(apxToMeters(tokens.glyph.stroke, 1, { headset: true })).toBeCloseTo(apxToMeters(3.75, 1, { headset: false }), 10);
    expect(apxToMeters(tokens.glyph.ring, 1, { headset: true })).toBeCloseTo(apxToMeters(90, 1, { headset: false }), 10);
  });
});

describe("hitAreaMeters", () => {
  it("never scales an input's minimum in a headset", () => {
    const ray = hitAreaMeters("ray", tokens.glyph.icon, 1.75, { headset: true });
    expect(ray).toBeCloseTo(apxToMeters(56, 1.75, { headset: false }), 10);
  });

  it("uses the drawn size when it is larger than the minimum", () => {
    expect(hitAreaMeters("mouse", tokens.glyph.ring, 1, { headset: false })).toBeCloseTo(apxToMeters(36, 1, { headset: false }), 10);
  });

  // At 45 cm the 20 mm poke floor rules (styleguide 6.1).
  it("keeps a poke target at 20 mm or more", () => {
    expect(hitAreaMeters("poke", tokens.glyph.icon, 0.45, { headset: true })).toBeCloseTo(0.02, 6);
  });

  it("sizes gaze and pinch at 72 apx", () => {
    expect(tokens.hit.gazePinch).toBe(72);
  });
});
