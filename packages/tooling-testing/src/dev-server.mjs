import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} ${args.join(' ')} exited by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
        return;
      }
      resolve();
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
  return spawn(
    'pnpm',
    ['exec', 'vite', '--host', host, '--port', String(port), '--strictPort', ...viteArgs],
    {
      cwd,
      stdio: 'inherit',
      env
    }
  );
}

export async function waitForServer(url, timeoutMs = 30000, processHandle) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (processHandle && processHandle.exitCode !== null) {
      throw new Error(`Process exited before readiness check passed (${url}).`);
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
  if (!processHandle || processHandle.killed) return;
  processHandle.kill('SIGTERM');
  for (let i = 0; i < 20; i += 1) {
    if (processHandle.exitCode !== null) return;
    await delay(100);
  }
  processHandle.kill('SIGKILL');
}
