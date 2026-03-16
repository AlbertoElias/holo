import { defineConfig } from "@playwright/test";
import { XR_CHROMIUM_ARGS, XR_CONTEXT_OPTIONS } from "@holoim/tooling-testing/xr-env";

const e2eBaseUrl = process.env.E2E_BASE_URL ?? "https://localhost:3174";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: e2eBaseUrl,
    ...XR_CONTEXT_OPTIONS,
    launchOptions: {
      args: [...XR_CHROMIUM_ARGS]
    }
  },
  webServer: {
    command: "pnpm exec vite --host 0.0.0.0 --port 3174 --strictPort",
    ignoreHTTPSErrors: true,
    timeout: 120000,
    reuseExistingServer: process.env.REUSE_DEV_SERVER === "1",
    url: e2eBaseUrl
  }
});
