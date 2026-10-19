import { defineConfig } from "@playwright/test";
const port = process.env.KNOWLEDGE_TEST_PORT ?? "4276";
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `KNOWLEDGE_PORT=${port} pnpm dev`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
