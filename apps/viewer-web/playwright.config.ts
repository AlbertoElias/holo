import path from "node:path";
import { defineConfig } from "@playwright/test";
import { XR_CHROMIUM_ARGS, XR_CONTEXT_OPTIONS } from "@holoim/tooling-testing/xr-env";

const e2eBaseUrl = process.env.E2E_BASE_URL ?? "https://localhost:3174";
const e2eUrl = new URL(e2eBaseUrl);
const e2ePort = Number(e2eUrl.port || "443");
if (e2eUrl.protocol !== "https:" || !Number.isInteger(e2ePort) || e2ePort < 1 || e2ePort > 65535) {
  throw new Error(`E2E_BASE_URL must be a valid HTTPS URL with a valid port: ${e2eBaseUrl}`);
}
const apiPort = Number(process.env.E2E_API_PORT ?? "3001");
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
  throw new Error(`E2E_API_PORT must be a valid port: ${String(process.env.E2E_API_PORT)}`);
}
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
const reuseExistingServer = process.env.REUSE_DEV_SERVER === "1";
const runPipeline = process.env.RUN_E2E_PIPELINE === "1";
const captureUrl = new URL(process.env.E2E_CAPTURE_URL ?? "https://127.0.0.1:5175/");
const webServers = [
  {
    command: `VITE_HMR_CLIENT_PORT=${e2ePort} VITE_API_PROXY_TARGET=${apiBaseUrl} pnpm exec vite --host 0.0.0.0 --port ${e2ePort} --strictPort`,
    ignoreHTTPSErrors: true,
    timeout: 120000,
    reuseExistingServer,
    url: e2eBaseUrl
  },
  ...(runPipeline
    ? [{
        command: `WEB_ORIGIN=${e2eBaseUrl} TEST_API_PORT=${apiPort} pnpm --filter @holoim/api exec tsx ../../scripts/test-api.ts`,
        gracefulShutdown: { signal: "SIGTERM" as const, timeout: 5000 },
        timeout: 120000,
        reuseExistingServer,
        url: `${apiBaseUrl}/api/holograms?limit=1`
      }, {
        command: `pnpm --filter @holoim/capture exec vite --host ${captureUrl.hostname} --port ${captureUrl.port} --strictPort`,
        ignoreHTTPSErrors: true,
        timeout: 120000,
        reuseExistingServer,
        url: captureUrl.href
      }]
    : [])
];

// Per-test durations land beside the CI step timings (one file per pnpm script).
const suiteName = (process.env.npm_lifecycle_event ?? "test-e2e").replace(/[^a-zA-Z0-9_-]+/g, "-");

export default defineConfig({
  testDir: "./e2e",
  reporter: [
    [process.env.CI ? "dot" : "list"],
    ["json", { outputFile: path.resolve(import.meta.dirname, "../../output/test-results", `playwright-web-${suiteName}.json`) }]
  ],
  use: {
    baseURL: e2eBaseUrl,
    ...XR_CONTEXT_OPTIONS,
    launchOptions: {
      args: [...XR_CHROMIUM_ARGS, ...(runPipeline ? ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] : [])]
    }
  },
  webServer: webServers
});
