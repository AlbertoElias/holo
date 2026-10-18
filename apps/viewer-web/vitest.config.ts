import { defineConfig } from "vitest/config";

export default defineConfig({
  // Match tsconfig "jsx": "react-jsx" so components without a React import render in tests.
  esbuild: {
    jsx: "automatic"
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    exclude: ["e2e/**", "**/node_modules/**", "**/dist/**"]
  }
});
