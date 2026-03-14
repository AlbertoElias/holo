import { defineConfig } from "@playwright/test";

const e2eBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3174";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: e2eBaseUrl
  },
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 3174 --strictPort",
    timeout: 120000,
    reuseExistingServer: true,
    url: e2eBaseUrl
  }
});
