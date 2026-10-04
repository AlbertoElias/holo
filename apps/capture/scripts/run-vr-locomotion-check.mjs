import {
  createHttpsBaseUrl,
  findAvailablePort,
  runCommand,
  startViteDevServer,
  stopProcess,
  waitForServer
} from '@holoim/tooling-testing/dev-server';

const host = process.env.DEV_HOST ?? '127.0.0.1';
const configuredPort = Number(process.env.DEV_PORT ?? '5174');
const configuredBaseUrl = process.env.BASE_URL;
const startupTimeoutMs = Number(process.env.STARTUP_TIMEOUT_MS ?? '30000');
const flowTimeoutMs = Number(process.env.XR_FLOW_TIMEOUT_MS ?? '600000');
const reuseDevServer = process.env.REUSE_DEV_SERVER === '1';

let devServer = null;
let interruptedSignal = null;
let failure = null;
let baseUrl = null;
const startedAt = Date.now();

const handleSignal = (signal) => {
  interruptedSignal = signal;
  void stopProcess(devServer);
};
const onSigint = () => handleSignal('SIGINT');
const onSigterm = () => handleSignal('SIGTERM');
process.once('SIGINT', onSigint);
process.once('SIGTERM', onSigterm);

try {
  let port = configuredPort;
  if (!configuredBaseUrl && !reuseDevServer) {
    try {
      port = await findAvailablePort(host, configuredPort, 20);
    } catch {
      port = configuredPort;
    }
  }
  baseUrl = configuredBaseUrl ?? createHttpsBaseUrl(host, port);
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  console.log(`[vr-locomotion] Starting deterministic XR flow check against ${baseUrl}`);

  if (!reuseDevServer) {
    devServer = startViteDevServer({
      host,
      port,
      cwd: process.cwd(),
      env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }
    });
    await waitForServer(baseUrl, startupTimeoutMs, devServer);
  }

  await runCommand('node', ['scripts/ci-vr-locomotion-playwright.mjs'], {
    env: { ...process.env, BASE_URL: baseUrl, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    timeoutMs: flowTimeoutMs
  });
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
} finally {
  try {
    await stopProcess(devServer);
  } catch (error) {
    const cleanupError = error instanceof Error ? error : new Error(String(error));
    failure = failure
      ? new Error(`${failure.message}; cleanup failed: ${cleanupError.message}`)
      : cleanupError;
  }
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
}

const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
if (failure) {
  console.error(`[vr-locomotion] FAIL after ${elapsedSeconds}s: ${failure.message}`);
  process.exitCode = interruptedSignal === 'SIGINT' ? 130 : interruptedSignal === 'SIGTERM' ? 143 : 1;
} else {
  console.log(`[vr-locomotion] PASS after ${elapsedSeconds}s; child server and browser processes exited.`);
}
