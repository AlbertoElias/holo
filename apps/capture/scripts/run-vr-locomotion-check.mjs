import { spawn } from 'node:child_process';
import { findAvailablePort, runCommand, stopProcess, waitForServer } from '@holoim/tooling-testing/dev-server';

const host = process.env.DEV_HOST ?? '127.0.0.1';
const configuredPort = Number(process.env.DEV_PORT ?? '5174');
const configuredBaseUrl = process.env.BASE_URL;
const startupTimeoutMs = Number(process.env.STARTUP_TIMEOUT_MS ?? '30000');
const reuseDevServer = process.env.REUSE_DEV_SERVER === '1';

let devServer = null;

try {
  let port = configuredPort;
  if (!configuredBaseUrl && !reuseDevServer) {
    try {
      port = await findAvailablePort(host, configuredPort, 20);
    } catch {
      port = configuredPort;
    }
  }
  const baseUrl = configuredBaseUrl ?? `http://${host}:${port}/`;

  if (!reuseDevServer) {
    devServer = spawn('pnpm', ['exec', 'vite', '--host', host, '--port', String(port), '--strictPort'], {
      stdio: 'inherit',
      env: process.env
    });
    await waitForServer(baseUrl, startupTimeoutMs, devServer);
  }

  await runCommand('node', ['scripts/ci-vr-locomotion-playwright.mjs'], {
    env: { ...process.env, BASE_URL: baseUrl }
  });
} finally {
  await stopProcess(devServer);
}
