import { defineConfig } from "vitest/config";

// SVGLoader parses the glyph paths with DOMParser. r3f and its test renderer
// are inlined so they share the one ESM `three` with the code under test
// (their CJS builds would load a second copy).
export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/testSetup.ts"],
    server: { deps: { inline: [/@react-three\//] } }
  }
});
