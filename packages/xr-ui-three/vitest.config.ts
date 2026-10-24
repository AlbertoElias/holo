import { defineConfig } from "vitest/config";

// SVGLoader parses the glyph paths with DOMParser.
export default defineConfig({ test: { environment: "jsdom" } });
