import { defineConfig } from "@playwright/test";
import { XR_CHROMIUM_ARGS, XR_CONTEXT_OPTIONS } from "@holoim/tooling-testing/xr-env";

const e2eBaseUrl = process.env.E2E_BASE_URL ?? "https://localhost:3174";
const reuseExistingServer = process.env.REUSE_DEV_SERVER === "1";
const webServers = [
  {
    command: "pnpm exec vite --host 0.0.0.0 --port 3174 --strictPort",
    ignoreHTTPSErrors: true,
    timeout: 120000,
    reuseExistingServer,
    url: e2eBaseUrl
  },
  ...(process.env.RUN_E2E_INTEGRATION === "1"
    ? [{
        command: "pnpm --filter @holoim/api exec tsx src/server.ts",
        timeout: 120000,
        reuseExistingServer,
        url: "http://127.0.0.1:3001/api/holograms?limit=1"
      }]
    : [])
];

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: e2eBaseUrl,
    ...XR_CONTEXT_OPTIONS,
    launchOptions: {
      args: [...XR_CHROMIUM_ARGS]
    }
  },
  webServer: webServers
});
