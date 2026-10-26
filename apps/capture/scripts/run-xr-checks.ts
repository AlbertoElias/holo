import type { ChildProcess } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { mapWithConcurrency } from '@holoim/tooling-testing/xr-env';
import {
  createHttpsBaseUrl,
  findAvailablePort,
  runCommand,
  startViteDevServer,
  stopProcess,
  waitForServer
} from '@holoim/tooling-testing/dev-server';

// Runs capture's browser XR checks against one shared dev server.
// Usage: node --import tsx scripts/run-xr-checks.ts mock-vr locomotion
// XR_SHARD=<index>/<total> (1-based) runs one deterministic slice of the
// requested checks, balanced by CHECK_COST, so CI runners split the suite
// without listing checks twice. Per-check durations are written to
// output/test-results/xr-checks[-shard-<i>of<n>].json at the repo root.
// XR_CHECK_CONCURRENCY sets how many checks run at once (default: half the
// CPUs, from 1 to 3). Each check advances its own frozen page clock, so this
// changes wall time only. Parallel checks write their output to
// output/xr-checks/<name>.log, printed when the check ends.
const CHECKS = {
  'mock-vr': 'scripts/ci-mock-vr-playwright.ts',
  recording: 'scripts/ci-recording-export-playwright.ts',
  locomotion: 'scripts/ci-vr-locomotion-playwright.ts',
  terrain: 'scripts/ci-terrain-locomotion.ts',
  hands: 'scripts/ci-hand-replay-playwright.ts',
  height: 'scripts/ci-xr-height-playwright.ts',
  body: 'scripts/ci-body-replay-playwright.ts',
  pointing: 'scripts/ci-pointing-playwright.ts',
  marks: 'scripts/ci-held-mark-playwright.ts',
  'ar-record': 'scripts/ci-ar-record-playwright.ts',
  object: 'scripts/ci-object-playwright.mjs',
  summon: 'scripts/ci-summon-playwright.mjs',
  ui: 'scripts/ci-capture-ui-playwright.ts',
  // Needs the Quest Pro emulator for eye gaze; see CHECK_SERVER_ENV.
  face: 'scripts/ci-face-playwright.ts',
  // Not checks: regenerate the IWER fixtures the hands, body and pointing checks replay.
  'pose-fixture': 'scripts/generate-iwer-pose-fixture.ts',
  'body-fixtures': 'scripts/generate-iwer-body-fixtures.mjs',
  // Not a check: regenerates the synthetic pointing take and its labels.
  'pointing-fixture': 'scripts/generate-iwer-pose-fixture.ts'
} as const;
type CheckName = keyof typeof CHECKS;

// .mjs checks that import TypeScript workspace sources (the meaning and objects packages) run under tsx too.
const USES_TSX: ReadonlySet<CheckName> = new Set(['object', 'summon']);

// Extra environment for entries that share a script.
const CHECK_ENV: Partial<Record<CheckName, Record<string, string>>> = { 'pointing-fixture': { POSE_FIXTURE: 'pointing' } };

// Checks that need their own dev server: the face check emulates a Quest
// Pro (eye gaze) while the others keep the Quest 3 their fixtures came from.
const CHECK_SERVER_ENV: Partial<Record<CheckName, Record<string, string>>> = { face: { CAPTURE_IWER_DEVICE: 'metaQuestPro' } };

// Checks that legitimately run longer than the default hang guard.
const CHECK_TIMEOUT_MS: Partial<Record<CheckName, number>> = {
  // Sixteen phases, two of them driving the phone dock by taps and two holding the phone screen (about 200 s locally).
  'ar-record': 300000,
  body: 360000,
  face: 360000
};

// Serial wall time in seconds on a 2-vCPU CI runner (CI run 39499697917);
// parallel runs start the longest first and XR_SHARD balances on it.
const CHECK_COST: Partial<Record<CheckName, number>> = { face: 40, marks: 19, body: 83, height: 45, terrain: 38, hands: 31, locomotion: 21, 'mock-vr': 18, recording: 11, 'ar-record': 110 };

const isCheckName = (name: string): name is CheckName => name in CHECKS;
const args = process.argv.slice(2);
const unknown = args.filter((name) => !isCheckName(name));
const listed = args.filter(isCheckName);
if (listed.length === 0 || unknown.length > 0) {
  console.error(`[xr-checks] Usage: run-xr-checks.ts <${Object.keys(CHECKS).join('|')}>...${unknown.length ? ` (unknown: ${unknown.join(', ')})` : ''}`);
  process.exit(2);
}

// Greedy longest-first packing into the least-loaded shard; ties keep the
// listed order, so every runner computes the same partition.
function shardChecks(names: CheckName[], index: number, total: number): CheckName[] {
  const loads = Array.from({ length: total }, () => ({ cost: 0, names: [] as CheckName[] }));
  const byCost = [...names].sort((left, right) => (CHECK_COST[right] ?? 0) - (CHECK_COST[left] ?? 0));
  for (const name of byCost) {
    const target = loads.reduce((best, load) => (load.cost < best.cost ? load : best));
    target.cost += CHECK_COST[name] ?? 0;
    target.names.push(name);
  }
  const selected = new Set(loads[index - 1]!.names);
  return names.filter((name) => selected.has(name));
}

const shardMatch = /^(\d+)\/(\d+)$/.exec(process.env.XR_SHARD ?? '');
if (process.env.XR_SHARD && (!shardMatch || Number(shardMatch[1]) < 1 || Number(shardMatch[1]) > Number(shardMatch[2]))) {
  console.error(`[xr-checks] XR_SHARD must be <index>/<total> with 1 <= index <= total, got ${process.env.XR_SHARD}`);
  process.exit(2);
}
const shard = shardMatch ? { index: Number(shardMatch[1]), total: Number(shardMatch[2]) } : null;
const requested = shard ? shardChecks(listed, shard.index, shard.total) : listed;
const timingsPath = path.resolve(
  import.meta.dirname,
  '../../../output/test-results',
  `xr-checks${shard ? `-shard-${shard.index}of${shard.total}` : ''}.json`
);
const timings: Array<{ name: CheckName; status: 'passed' | 'failed'; durationMs: number }> = [];

const host = process.env.DEV_HOST ?? '127.0.0.1';
const configuredPort = Number(process.env.DEV_PORT ?? '5174');
const configuredBaseUrl = process.env.BASE_URL;
const startupTimeoutMs = Number(process.env.STARTUP_TIMEOUT_MS ?? '30000');
// Checks advance simulated time explicitly, so wall time only grows with
// host speed in page loads; this bound exists to stop hangs quickly.
const checkTimeoutMs = Number(process.env.XR_CHECK_TIMEOUT_MS ?? '120000');
const reuseDevServer = process.env.REUSE_DEV_SERVER === '1';
const concurrency = Math.max(1, Number(process.env.XR_CHECK_CONCURRENCY ?? Math.min(3, Math.floor(os.availableParallelism() / 2))) || 1);
const logDir = path.resolve('output/xr-checks');

let devServer: ChildProcess | null = null;
const extraServers: ChildProcess[] = [];
let interruptedSignal: NodeJS.Signals | null = null;
let failure: Error | null = null;
const startedAt = Date.now();

const handleSignal = (signal: NodeJS.Signals) => {
  interruptedSignal = signal;
  void stopProcess(devServer);
  for (const server of extraServers) void stopProcess(server);
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

  const parallel = concurrency > 1 && requested.length > 1;
  if (requested.length === 0) throw new Error(`shard ${process.env.XR_SHARD} selected no checks`);
  console.log(`[xr-checks] Running ${requested.join(', ')}${shard ? ` (shard ${shard.index}/${shard.total})` : ''} against ${baseUrl}${parallel ? `, ${concurrency} at a time` : ''}`);

  if (!reuseDevServer) {
    devServer = startViteDevServer({
      host,
      port,
      cwd: process.cwd(),
      env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }
    });
    await waitForServer(baseUrl, startupTimeoutMs, devServer);
  }

  const extraBaseUrls = new Map<string, Promise<string>>();
  const baseUrlFor = (name: CheckName): string | Promise<string> => {
    const extraEnv = CHECK_SERVER_ENV[name];
    if (!extraEnv || configuredBaseUrl || reuseDevServer) return baseUrl;
    if (Object.entries(extraEnv).every(([key, value]) => process.env[key] === value)) return baseUrl;
    const key = JSON.stringify(extraEnv);
    if (!extraBaseUrls.has(key)) {
      extraBaseUrls.set(key, (async () => {
        const extraPort = await findAvailablePort(host, port + 1 + extraBaseUrls.size, 20);
        const server = startViteDevServer({ host, port: extraPort, cwd: process.cwd(), env: { ...process.env, ...extraEnv, NODE_TLS_REJECT_UNAUTHORIZED: '0' } });
        extraServers.push(server);
        const url = createHttpsBaseUrl(host, extraPort);
        await waitForServer(url, startupTimeoutMs, server);
        return url;
      })());
    }
    return extraBaseUrls.get(key)!;
  };

  const runCheck = async (name: CheckName) => {
    const checkStartedAt = Date.now();
    const script: string = CHECKS[name];
    const args = script.endsWith('.ts') || USES_TSX.has(name) ? ['--import', 'tsx', script] : [script];
    const logPath = path.join(logDir, `${name}.log`);
    const logFd = parallel ? openSync(logPath, 'w') : null;
    let error: Error | null = null;
    try {
      await runCommand('node', args, {
        env: { ...process.env, ...CHECK_ENV[name], BASE_URL: await baseUrlFor(name), NODE_TLS_REJECT_UNAUTHORIZED: '0' },
        timeoutMs: process.env.XR_CHECK_TIMEOUT_MS ? checkTimeoutMs : CHECK_TIMEOUT_MS[name] ?? checkTimeoutMs,
        ...(logFd === null ? {} : { stdio: ['ignore', logFd, logFd] })
      });
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    } finally {
      if (logFd !== null) {
        closeSync(logFd);
        const output = readFileSync(logPath, 'utf8').trimEnd();
        if (output) console.log(output.split('\n').map((line) => `[${name}] ${line}`).join('\n'));
      }
    }
    const durationMs = Date.now() - checkStartedAt;
    timings.push({ name, status: error ? 'failed' : 'passed', durationMs });
    const seconds = (durationMs / 1000).toFixed(1);
    if (error) throw new Error(`${name} failed after ${seconds}s: ${error.message}`);
    console.log(`[xr-checks] ${name} passed in ${seconds}s`);
  };

  if (parallel) {
    await mkdir(logDir, { recursive: true });
    const ordered = [...requested].sort((left, right) => (CHECK_COST[right] ?? 0) - (CHECK_COST[left] ?? 0));
    // The cheapest check runs alone first so Vite transforms the app once;
    // concurrent cold page loads on a 2-vCPU CI runner pass the 30 s goto limit.
    const warmup = ordered.pop();
    const warmupName = warmup!;
    const settle = (name: CheckName) => runCheck(name).then((): Error | null => null, (caught: unknown) => (caught instanceof Error ? caught : new Error(String(caught))));
    // Every check runs to the end so one failure reports all of them.
    const errors = [await settle(warmupName), ...(await mapWithConcurrency(ordered, concurrency, settle))].filter((caught): caught is Error => caught !== null);
    if (errors.length > 0) throw new Error(errors.map((caught) => caught.message).join('; '));
  } else {
    for (const name of requested) await runCheck(name);
  }
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
} finally {
  try {
    await stopProcess(devServer);
    for (const server of extraServers) await stopProcess(server);
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
try {
  await mkdir(path.dirname(timingsPath), { recursive: true });
  const summary = { shard: process.env.XR_SHARD ?? null, requested, totalMs: Date.now() - startedAt, checks: timings };
  await writeFile(timingsPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
} catch (error) {
  console.warn(`[xr-checks] Could not write ${timingsPath}: ${error instanceof Error ? error.message : String(error)}`);
}
if (failure) {
  console.error(`[xr-checks] FAIL after ${elapsedSeconds}s: ${failure.message}`);
  process.exitCode = interruptedSignal === 'SIGINT' ? 130 : interruptedSignal === 'SIGTERM' ? 143 : 1;
} else {
  console.log(`[xr-checks] PASS after ${elapsedSeconds}s; child server and browser processes exited.`);
}
