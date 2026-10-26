import path from "node:path";
import { defineConfig } from "@playwright/test";

// KNOWLEDGE_E2E_PORT runs the suite on its own dev server, beside one already on 4176.
const port = Number(process.env.KNOWLEDGE_E2E_PORT ?? 4176);
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
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: process.env.KNOWLEDGE_E2E_PORT ? `pnpm dev --port ${port} --strictPort` : "pnpm dev",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
