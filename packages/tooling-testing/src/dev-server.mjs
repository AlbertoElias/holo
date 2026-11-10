import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const managedProcessGroups = new WeakMap();
const stoppingProcesses = new WeakMap();

function spawnManaged(command, args, options = {}) {
  const useProcessGroup = process.platform !== 'win32';
  const child = spawn(command, args, {
    ...options,
    detached: useProcessGroup
  });
  if (useProcessGroup && child.pid) {
    managedProcessGroups.set(child, child.pid);
  }
  return child;
}

function hasExited(processHandle) {
  return processHandle.exitCode !== null || processHandle.signalCode !== null;
}

function isProcessGroupRunning(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

function signalProcess(processHandle, signal) {
  const processGroupId = managedProcessGroups.get(processHandle);
  try {
    if (processGroupId) {
      process.kill(-processGroupId, signal);
    } else if (!hasExited(processHandle)) {
      processHandle.kill(signal);
    }
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessToStop(processHandle, timeoutMs) {
  const processGroupId = managedProcessGroups.get(processHandle);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const running = processGroupId
      ? isProcessGroupRunning(processGroupId)
      : !hasExited(processHandle);
    if (!running) return true;
    await delay(50);
  }
  return false;
}

export function runCommand(command, args, options = {}) {
  const { timeoutMs, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawnManaged(command, args, { stdio: 'inherit', ...spawnOptions });
    let settled = false;
    let timeoutHandle = null;

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      callback(value);
    };
    const settleAfterCleanup = (callback, value) => {
      void stopProcess(child).then(
        () => settle(callback, value),
        (cleanupError) => {
          const originalMessage = value instanceof Error ? `${value.message}; ` : '';
          settle(reject, new Error(`${originalMessage}process cleanup failed: ${cleanupError.message}`));
        }
      );
    };
    const stopForSignal = (signal) => {
      settleAfterCleanup(
        reject,
        new Error(`${command} ${args.join(' ')} interrupted by ${signal}`)
      );
    };
    const onSigint = () => stopForSignal('SIGINT');
    const onSigterm = () => stopForSignal('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        settleAfterCleanup(
          reject,
          new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`)
        );
      }, timeoutMs);
      timeoutHandle.unref();
    }

    child.on('error', (error) => settle(reject, error));
    child.on('exit', (code, signal) => {
      if (signal) {
        settleAfterCleanup(reject, new Error(`${command} ${args.join(' ')} exited by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        settleAfterCleanup(reject, new Error(`${command} ${args.join(' ')} exited with code ${code}`));
        return;
      }
      settleAfterCleanup(resolve);
    });
  });
}

export function canBindPort(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host, port }, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function findAvailablePort(host, startPort, span = 20) {
  for (let port = startPort; port < startPort + span; port += 1) {
    if (await canBindPort(host, port)) return port;
  }
  throw new Error(`No available port found from ${startPort} to ${startPort + span - 1}.`);
}

export function createHttpsBaseUrl(host, port) {
  return `https://${host}:${port}/`;
}

export function startViteDevServer({
  host,
  port,
  cwd,
  env,
  viteArgs = []
}) {
  return spawnManaged(
    'pnpm',
    ['exec', 'vite', '--host', host, '--port', String(port), '--strictPort', ...viteArgs],
    {
      cwd,
      stdio: 'inherit',
      env
    }
  );
}

const testBuildScript = fileURLToPath(new URL('./test-build.mjs', import.meta.url));

/**
 * Serves an app's e2e test build with `vite preview` (test-build.mjs `serve`),
 * or its dev server when HOLOIM_VITE_DEV=1. Call ensureTestBuild first so the
 * server's readiness wait does not include the build.
 */
export function startTestBuildServer({ app, host, port, cwd, env }) {
  const child = spawnManaged(
    process.execPath,
    [testBuildScript, 'serve', app, '--', '--host', host, '--port', String(port), '--strictPort'],
    // The caller built already; a forced rebuild must not repeat here.
    { cwd, stdio: ['inherit', 'pipe', 'inherit'], env: { ...(env ?? process.env), HOLOIM_TEST_BUILD_FORCE: '' } }
  );
  // Vite prints its "Local:" line only once this process holds the port
  // (--strictPort makes a taken port exit instead). A response from the port
  // alone does not prove it: another run's server may already answer there,
  // and waitForServer would accept it (a Quest 3 build where the face check
  // needs a Quest Pro, B-039). So readiness waits for this line.
  child.listening = new Promise((resolve) => {
    let seen = '';
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      if (seen !== null) {
        seen += chunk.toString('utf8');
        // eslint-disable-next-line no-control-regex
        if (/Local:\s+(?:\u001b\[[0-9;]*m)*https?:\/\//.test(seen)) {
          seen = null;
          resolve();
        }
      }
    });
    child.once('exit', resolve);
  });
  return child;
}

export async function waitForServer(url, timeoutMs = 30000, processHandle) {
  const startedAt = Date.now();
  let processError = null;
  const onProcessError = (error) => {
    processError = error;
  };
  processHandle?.once('error', onProcessError);

  try {
    // A server this process started proves it owns the port by announcing it.
    if (processHandle?.listening) {
      await Promise.race([processHandle.listening, delay(timeoutMs)]);
    }
    while (Date.now() - startedAt < timeoutMs) {
      if (processError) {
        throw new Error(`Process failed before readiness check passed (${url}): ${processError.message}`);
      }
      if (processHandle && hasExited(processHandle)) {
        const outcome = processHandle.signalCode
          ? `signal ${processHandle.signalCode}`
          : `exit code ${processHandle.exitCode}`;
        throw new Error(`Process exited before readiness check passed (${url}; ${outcome}).`);
      }
      try {
        const response = await fetch(url, { method: 'GET' });
        if (response.ok) return;
      } catch {
        // Server not ready yet.
      }
      await delay(500);
    }
    throw new Error(`Server did not become ready in ${timeoutMs}ms (${url}).`);
  } finally {
    processHandle?.off('error', onProcessError);
  }
}

export async function fetchWithRetry(url, init = {}, options = {}) {
  const retries = Number(options.retries ?? 3);
  const retryDelayMs = Number(options.retryDelayMs ?? 400);
  const retryOnStatuses = options.retryOnStatuses ?? [429, 502, 503, 504];
  const processHandle = options.processHandle;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (processHandle && processHandle.exitCode !== null) {
      throw new Error(`Process exited before request completed (${url}).`);
    }

    try {
      const response = await fetch(url, init);
      if (!retryOnStatuses.includes(response.status) || attempt === retries) {
        return response;
      }
      lastError = new Error(`Request returned retryable status ${response.status} (${url}).`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === retries) {
        throw lastError;
      }
    }

    await delay(retryDelayMs * (attempt + 1));
  }

  throw lastError ?? new Error(`Request failed without a retryable error (${url}).`);
}

export async function stopProcess(processHandle) {
  if (!processHandle) return;
  const existingStop = stoppingProcesses.get(processHandle);
  if (existingStop) return existingStop;

  const stop = (async () => {
    signalProcess(processHandle, 'SIGTERM');
    if (await waitForProcessToStop(processHandle, 2000)) return;

    signalProcess(processHandle, 'SIGKILL');
    if (await waitForProcessToStop(processHandle, 2000)) return;

    const processGroupId = managedProcessGroups.get(processHandle);
    throw new Error(
      processGroupId
        ? `Process group ${processGroupId} did not stop after SIGTERM and SIGKILL.`
        : `Process ${processHandle.pid ?? '<unknown>'} did not stop after SIGTERM and SIGKILL.`
    );
  })();
  stoppingProcesses.set(processHandle, stop);
  return stop;
}
