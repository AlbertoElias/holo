// Styleguide 7.3: MSDF text from the real figtree-400 atlas, sized from the
// type role, drawn once in linear light, hidden within arm's reach.
import { apxToMeters, tokens } from "@holoim/design-tokens";
import { VIEW_TARGETS } from "@holoim/xr-ui-core";
import { beforeAll, describe, expect, it } from "vitest";

import { ThreeMsdfLabel } from "./ThreeMsdfLabel.js";
import { everyDescendantIsChrome, figtree400, hexOf } from "./testing.js";

let font: Awaited<ReturnType<typeof figtree400>>;
beforeAll(async () => {
  font = await figtree400();
});

function label(text: string, extra: Partial<ConstructorParameters<typeof ThreeMsdfLabel>[0]> = {}): ThreeMsdfLabel {
  return new ThreeMsdfLabel({ text, role: "timecode", headset: false, distanceM: 1, font, texture: null, ...extra });
}

describe("ThreeMsdfLabel layout", () => {
  it("lays out \"Recording 0:12\" with one quad per non-space character", () => {
    const l = label("Recording 0:12");
    expect(l.getText()).toBe("Recording 0:12");
    expect(l.quadCount).toBe("Recording 0:12".replace(/ /g, "").length);
    const geometry = l.mesh.geometry;
    expect(geometry.getAttribute("position").count).toBe(l.quadCount * 4);
    expect(geometry.getAttribute("uv").count).toBe(l.quadCount * 4);
    expect(geometry.getIndex()!.count).toBe(l.quadCount * 6);
    expect(l.missingGlyphs).toEqual([]);
  });

  it("advances by the atlas's xadvance, scaled from the atlas's em to the role's size at the distance", () => {
    const scale = apxToMeters(tokens.type.timecode.fontSize, 1, { headset: false }) / font.info.size;
    const space = label(" ");
    expect(space.quadCount).toBe(0);
    expect(space.widthM).toBeCloseTo(font.chars.find((c) => c.char === " ")!.xadvance * scale, 9);
    // One glyph has no neighbour to kern against: its width is its own advance.
    const letter = font.chars.find((c) => c.char === "R")!;
    expect(label("R").widthM).toBeCloseTo(letter.xadvance * scale, 9);
  });

  it("takes the role's line height, not the font's (styleguide 7.1)", () => {
    const fontSizeM = apxToMeters(tokens.type.timecode.fontSize, 1, { headset: false });
    expect(label("Recording 0:12").heightM).toBeCloseTo(1.35 * fontSizeM, 9);
    expect(font.common.lineHeight / font.info.size).not.toBeCloseTo(1.35, 2);
  });

  it("keeps the timecode's figures tabular, so the running time never shifts (styleguide 7.2)", () => {
    const widths = ["Recording 0:11", "Recording 0:12", "Recording 1:08", "Recording 4:44"].map((text) => label(text).widthM);
    for (const width of widths) expect(width).toBeCloseTo(widths[0]!, 9);
    const digits = font.chars.filter((c) => /[0-9]/.test(c.char)).map((c) => c.xadvance);
    expect(new Set(digits).size).toBeGreaterThan(1);
  });

  it("leaves figures proportional in roles without tabular numbers", () => {
    const body = (text: string) => label(text, { role: "controlLabel" }).widthM;
    expect(body("11")).not.toBeCloseTo(body("44"), 6);
  });

  it("is 2.5x in a headset, and scales with distance", () => {
    const flat = label("Recording 0:12");
    const headset = label("Recording 0:12", { headset: true });
    expect(headset.widthM / flat.widthM).toBeCloseTo(2.5, 9);
    expect(label("Recording 0:12", { distanceM: 2 }).widthM / flat.widthM).toBeCloseTo(2, 9);
  });

  it("keeps every glyph's uv inside the atlas, on its own rectangle", () => {
    const uv = label("Recording 0:12").mesh.geometry.getAttribute("uv");
    for (let i = 0; i < uv.count; i += 1) {
      expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getX(i)).toBeLessThanOrEqual(1);
      expect(uv.getY(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getY(i)).toBeLessThanOrEqual(1);
    }
    const r = font.chars.find((c) => c.char === "R")!;
    expect(uv.getX(0)).toBeCloseTo(r.x / font.common.scaleW, 9);
    expect(uv.getY(3)).toBeCloseTo(1 - r.y / font.common.scaleH, 9);
  });

  it("lists characters the atlas lacks, and draws and advances nothing for them", () => {
    const l = label("Hi \u{1F600}\u{1F600}");
    expect(l.missingGlyphs).toEqual(["\u{1F600}"]);
    expect(l.quadCount).toBe(2);
    expect(l.widthM).toBeCloseTo(label("Hi ").widthM, 9);
  });

  it("anchors the line at its left, centre or right", () => {
    const left = label("Recording 0:12", { anchor: "left" });
    const centre = label("Recording 0:12", { anchor: "center" });
    const right = label("Recording 0:12", { anchor: "right" });
    const minX = (l: ThreeMsdfLabel) => {
      l.mesh.geometry.computeBoundingBox();
      return l.mesh.geometry.boundingBox!.min.x;
    };
    expect(minX(left) - minX(centre)).toBeCloseTo(left.widthM / 2, 9);
    expect(minX(left) - minX(right)).toBeCloseTo(left.widthM, 9);
  });

  it("re-lays out on setText and stays chrome", () => {
    const l = label("Recording 0:12");
    l.setText("Recording 0:13 \u{1F600}");
    expect(l.missingGlyphs).toEqual(["\u{1F600}"]);
    expect(l.quadCount).toBe("Recording0:13".length);
    expect(everyDescendantIsChrome(l.group)).toBe(true);
  });
});

describe("ThreeMsdfLabel material", () => {
  it("is a shader material in the role's colour, never tone-mapped, converting to the output once", () => {
    const l = label("Recording 0:12");
    expect(l.material.isShaderMaterial).toBe(true);
    expect(l.material.toneMapped).toBe(false);
    expect(l.material.transparent).toBe(true);
    expect(l.material.depthWrite).toBe(false);
    expect(hexOf(l.material)).toBe(tokens.color.textMuted);
    expect(hexOf(label("Hi", { role: "captionOnHologram" }).material)).toBe(tokens.color.text);
    expect(hexOf(label("Hi", { role: "controlLabel" }).material)).toBe(tokens.color.gold);
    expect(l.material.fragmentShader).toContain("colorspace_fragment");
    expect(l.material.fragmentShader).toContain("fwidth");
    expect(l.material.uniforms.distanceRange!.value).toBe(font.distanceField.distanceRange);
    expect(Object.keys(l.material.uniforms).sort()).toEqual(["color", "distanceRange", "map", "opacity"]);
  });

  it("sets opacity through the uniform", () => {
    const l = label("Hi");
    l.setOpacity(0.4);
    expect(l.material.uniforms.opacity!.value).toBe(0.4);
  });
});

describe("headset text (7.3)", () => {
  it("hides within 1 m of the head and shows beyond, in a headset", () => {
    const l = label("Recording 0:12", { headset: true, distanceM: 1.5 });
    expect(l.updateVisibility(VIEW_TARGETS.vr, "label", { fromHeadM: 0.45 })).toBe(false);
    expect(l.group.visible).toBe(false);
    expect(l.updateVisibility(VIEW_TARGETS.vr, "label", { fromHeadM: 0.99 })).toBe(false);
    expect(l.updateVisibility(VIEW_TARGETS.vr, "label", { fromHeadM: 1.5 })).toBe(true);
    expect(l.group.visible).toBe(true);
  });

  it("hides a hologram's label within 1 m of the hologram, and shows a status anywhere beyond arm's reach", () => {
    const l = label("0:12", { headset: true, distanceM: 1.5 });
    expect(l.updateVisibility(VIEW_TARGETS.questPassthrough, "timecode", { fromHeadM: 1.5, toHologramM: 0.6 })).toBe(false);
    expect(l.updateVisibility(VIEW_TARGETS.questPassthrough, "timecode", { fromHeadM: 1.5, toHologramM: 1.4 })).toBe(true);
    expect(l.updateVisibility(VIEW_TARGETS.vr, "status", { fromHeadM: 1.5, toHologramM: 0.2 })).toBe(true);
  });

  it("always shows on a flat screen", () => {
    expect(label("x").updateVisibility(VIEW_TARGETS.phone, "label", { fromHeadM: 0.3 })).toBe(true);
  });
});
