import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { tokens } from "./index.js";

// Failure case: fonts fail to load and text falls back to a different face.
// The page-level check (computed font family) comes with the pages that use them.
describe("fonts.css", () => {
  const css = readFileSync(new URL("./fonts/fonts.css", import.meta.url), "utf8");

  it("points every @font-face at a WOFF2 file in the package", () => {
    const urls = [...css.matchAll(/url\("\.\/([^"]+)"\)/g)].map((match) => match[1]!);
    expect(urls.length).toBe(4);
    for (const file of urls) {
      expect(readFileSync(new URL(`./fonts/${file}`, import.meta.url)).subarray(0, 4).toString("latin1")).toBe("wOF2");
    }
  });

  it("declares the faces the token font stacks name first", () => {
    const families = new Set([...css.matchAll(/font-family: "([^"]+)"/g)].map((match) => match[1]));
    expect(families).toEqual(new Set([tokens.font.title[0], tokens.font.ui[0]]));
  });
});
