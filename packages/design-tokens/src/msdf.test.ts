import { existsSync, readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Failure case: 3D text falls back to another face or loses glyphs. Every label
// the 3D UI draws is ASCII plus a few typographic marks; an atlas without one
// of them renders a hole (or tofu) in the portal.
const dir = new URL("./fonts/msdf/", import.meta.url);
const atlases = readdirSync(dir).filter((file) => file.endsWith(".json")).sort();

const required = [
  ...Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => 0x20 + i),
  ...[..."·½—"].map((char) => char.codePointAt(0)!)
];

describe("MSDF atlases", () => {
  it("covers the four faces the styleguide bakes", () => {
    expect(atlases).toEqual(["figtree-400.json", "figtree-500.json", "figtree-600.json", "fraunces-600.json"]);
  });

  describe.each(atlases)("%s", (file) => {
    const font = JSON.parse(readFileSync(new URL(file, dir), "utf8")) as {
      pages: string[];
      chars: { id: number }[];
      distanceField: { fieldType: string };
    };

    it("has every character a 3D label needs", () => {
      const ids = new Set(font.chars.map((char) => char.id));
      expect(required.filter((codePoint) => !ids.has(codePoint)).map((cp) => cp.toString(16))).toEqual([]);
    });

    it("is a multi-channel distance field", () => {
      expect(font.distanceField.fieldType).toBe("msdf");
    });

    it("names a PNG that exists next to it", () => {
      expect(font.pages.length).toBeGreaterThan(0);
      for (const page of font.pages) {
        expect(existsSync(new URL(page, dir)), page).toBe(true);
      }
    });
  });
});

describe("loadMsdfAtlas", () => {
  it("loads each face the type roles name, with an atlas image beside it", async () => {
    const { loadMsdfAtlas, MSDF_FACES } = await import("./msdf.js");
    for (const face of MSDF_FACES) {
      const { font, textureUrl } = await loadMsdfAtlas(face);
      expect(font.distanceField.fieldType).toBe("msdf");
      expect(existsSync(new URL(textureUrl))).toBe(true);
    }
  });
});
