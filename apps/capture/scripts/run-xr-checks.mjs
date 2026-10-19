import {
  createHttpsBaseUrl,
  findAvailablePort,
  runCommand,
  startViteDevServer,
  stopProcess,
  waitForServer
} from '@holoim/tooling-testing/dev-server';

// Runs capture's browser XR checks against one shared dev server.
// Usage: node scripts/run-xr-checks.mjs mock-vr locomotion
const CHECKS = {
  'mock-vr': 'scripts/ci-mock-vr-playwright.mjs',
  locomotion: 'scripts/ci-vr-locomotion-playwright.mjs',
  terrain: 'scripts/ci-terrain-locomotion.ts',
  hands: 'scripts/ci-hand-replay-playwright.mjs',
  height: 'scripts/ci-xr-height-playwright.ts',
  // Not a check: regenerates the IWER pose fixture the hands check replays.
  'pose-fixture': 'scripts/generate-iwer-pose-fixture.mjs'
};

const requested = process.argv.slice(2);
const unknown = requested.filter((name) => !(name in CHECKS));
if (requested.length === 0 || unknown.length > 0) {
  console.error(`[xr-checks] Usage: run-xr-checks.mjs <${Object.keys(CHECKS).join('|')}>...${unknown.length ? ` (unknown: ${unknown.join(', ')})` : ''}`);
  process.exit(2);
}

const host = process.env.DEV_HOST ?? '127.0.0.1';
const configuredPort = Number(process.env.DEV_PORT ?? '5174');
const configuredBaseUrl = process.env.BASE_URL;
const startupTimeoutMs = Number(process.env.STARTUP_TIMEOUT_MS ?? '30000');
// Checks advance simulated time explicitly, so wall time only grows with
// host speed in page loads; this bound exists to stop hangs quickly.
const checkTimeoutMs = Number(process.env.XR_CHECK_TIMEOUT_MS ?? '120000');
const reuseDevServer = process.env.REUSE_DEV_SERVER === '1';

let devServer = null;
let interruptedSignal = null;
let failure = null;
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
  const baseUrl = configuredBaseUrl ?? createHttpsBaseUrl(host, port);
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  console.log(`[xr-checks] Running ${requested.join(', ')} against ${baseUrl}`);

  if (!reuseDevServer) {
    devServer = startViteDevServer({
      host,
      port,
      cwd: process.cwd(),
      env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }
    });
    await waitForServer(baseUrl, startupTimeoutMs, devServer);
  }

  for (const name of requested) {
    const checkStartedAt = Date.now();
    const script = CHECKS[name];
    const args = script.endsWith('.ts') ? ['--import', 'tsx', script] : [script];
    await runCommand('node', args, {
      env: { ...process.env, BASE_URL: baseUrl, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
      timeoutMs: checkTimeoutMs
    });
    console.log(`[xr-checks] ${name} passed in ${((Date.now() - checkStartedAt) / 1000).toFixed(1)}s`);
  }
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
  console.error(`[xr-checks] FAIL after ${elapsedSeconds}s: ${failure.message}`);
  process.exitCode = interruptedSignal === 'SIGINT' ? 130 : interruptedSignal === 'SIGTERM' ? 143 : 1;
} else {
  console.log(`[xr-checks] PASS after ${elapsedSeconds}s; child server and browser processes exited.`);
}
