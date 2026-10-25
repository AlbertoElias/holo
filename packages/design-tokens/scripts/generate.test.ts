import { describe, expect, it } from "vitest";

import { findDrift, generate, TokenError } from "./generate.js";

// Failure cases from docs/features/ui-redesign.md: stale output after a
// token edit, an unresolved or circular alias, and code reading a value for
// an undecided item.

const colour = (hex: string, components: number[]) => ({ $type: "color", $value: { colorSpace: "srgb", components, hex } });

describe("generate", () => {
  it("matches the committed outputs (the drift check)", async () => {
    expect(await findDrift()).toEqual([]);
  });

  it("fails on an alias to a token that does not exist", () => {
    expect(() => generate({ chip: { color: { $type: "color", $value: "{color.missing}" } } })).toThrow(TokenError);
    expect(() => generate({ chip: { color: { $type: "color", $value: "{color.missing}" } } })).toThrow(/unresolved alias \{color.missing\}/);
  });

  it("fails on a circular alias, including through a composite value", () => {
    expect(() => generate({ a: { $type: "color", $value: "{b}" }, b: { $type: "color", $value: "{a}" } })).toThrow(/circular alias: a -> b -> a/);
    expect(() => generate({
      font: { title: { $type: "fontFamily", $value: "{type.title}" } },
      type: { title: { $type: "typography", $value: { fontFamily: "{font.title}", fontWeight: 600, fontSize: { value: 1, unit: "rem" }, letterSpacing: { value: 0, unit: "px" }, lineHeight: 1 } } }
    })).toThrow(/circular alias/);
  });

  it("resolves aliases at any depth and inherits a group's $type", () => {
    const files = generate({
      color: { gold: colour("#ffc872", [1, 0.7843, 0.4471]) },
      glyph: { $type: "color", color: { $value: "{color.gold}" } },
      ground: { flat: { $type: "gradient", $value: [{ color: "{color.gold}", position: 0 }, { color: "{color.gold}", position: 1 }] } }
    });
    expect(files["tokens.json"]).toContain('"glyph.color": "#ffc872"');
    expect(files["tokens.css"]).toContain("--holoim-ground-flat-stops: #ffc872 0%, #ffc872 100%;");
  });

  it("exports only $value tokens, never $extensions or free text", () => {
    const files = generate({
      $extensions: { holoim: { headsetScale: { value: 2.5 } } },
      chip: { $description: "free text", opacity: { $type: "number", $value: 0.72, $extensions: { holoim: { note: "x" } } }, undecided: { $description: "open question" } }
    });
    expect(JSON.parse(files["tokens.json"])).toEqual({ "chip.opacity": 0.72 });
  });

  it("fails when a colour's hex disagrees with its components", () => {
    expect(() => generate({ color: { gold: colour("#ffc800", [1, 0.7843, 0.4471]) } })).toThrow(/disagrees/);
  });

  // A translucent colour (the shade's stops) must not lose its alpha.
  it("keeps a colour's alpha in code and CSS", () => {
    const files = generate({ shade: { inner: { $type: "color", $value: { colorSpace: "srgb", components: [0.0314, 0.102, 0.1176], hex: "#081a1e", alpha: 0.7 } } } });
    expect(JSON.parse(files["tokens.json"])).toEqual({ "shade.inner": { hex: "#081a1e", alpha: 0.7 } });
    expect(files["tokens.css"]).toContain("--holoim-shade-inner: rgb(8 26 30 / 0.7);");
    expect(() => generate({ c: { $type: "color", $value: { colorSpace: "srgb", components: [0, 0, 0], alpha: 2 } } })).toThrow(/alpha/);
  });

  it("exports a glyph drawing as an SVG path and refuses one without a moveto", () => {
    const files = generate({ glyph: { play: { $type: "svgPath", $value: { d: "M4 2.5v11l9-5.5z", fill: true } } } });
    expect(JSON.parse(files["tokens.json"])).toEqual({ "glyph.play": { d: "M4 2.5v11l9-5.5z", fill: true, linejoin: "miter" } });
    expect(() => generate({ glyph: { bad: { $type: "svgPath", $value: { d: "v11" } } } })).toThrow(/moveto/);
  });

  it("fails on a $type it does not know, rather than guessing", () => {
    expect(() => generate({ shadow: { $type: "shadow", $value: {} } })).toThrow(/unsupported \$type/);
  });
});
