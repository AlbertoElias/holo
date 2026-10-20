import path from "node:path";
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ["json", { outputFile: path.resolve(import.meta.dirname, "../../output/test-results/playwright-knowledge.json") }],
  ],
  use: {
    baseURL: "http://127.0.0.1:4176",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://127.0.0.1:4176",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
