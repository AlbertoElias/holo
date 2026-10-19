import { defineConfig } from "@playwright/test";

// The specs write fixtures into this checkout's docs, so the server must be
// rooted here. Use a dedicated port and never reuse a running server: another
// worktree's dev server on 4176 would silently miss every fixture write.
const e2ePort = 4177;
const baseURL = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${e2ePort} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
