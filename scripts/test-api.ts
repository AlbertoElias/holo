import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { runCommand } from "@holoim/tooling-testing/dev-server";

function findWorkspaceRoot(startDir: string): string {
  let currentDir = path.resolve(startDir);
  while (true) {
    if (existsSync(path.join(currentDir, "pnpm-workspace.yaml"))) return currentDir;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Could not find pnpm-workspace.yaml from ${startDir}.`);
    }
    currentDir = parentDir;
  }
}

const workspaceRoot = findWorkspaceRoot(process.cwd());
const scriptPath = path.join(workspaceRoot, "scripts", "test-api.ts");
const apiRoot = path.join(workspaceRoot, "apps", "viewer-api");
const apiSchemaPath = path.join(apiRoot, "prisma", "schema.prisma");
const apiServerPath = path.join(apiRoot, "src", "server.ts");
const requireFromApi = createRequire(path.join(apiRoot, "package.json"));
const tsxLoaderPath = requireFromApi.resolve("tsx");

const handledSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type HandledSignal = (typeof handledSignals)[number];

export type TestApiOptions = {
  host?: string;
  port?: number;
  startupTimeoutMs?: number;
  webOrigin?: string;
};

export type TestApi = {
  baseUrl: string;
  databasePath: string;
  process: ChildProcess;
  readinessUrl: string;
  tempDir: string;
  stop: () => Promise<void>;
  waitForExit: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

function databaseUrl(databasePath: string): string {
  return `file:${databasePath.replaceAll("\\", "/")}`;
}

function formatExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `signal ${signal}` : `code ${String(code)}`;
}

async function stopChildProcess(processHandle: ChildProcess | undefined): Promise<void> {
  if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) return;

  const waitForExit = (timeoutMs: number): Promise<boolean> => new Promise((resolve) => {
    const finish = (exited: boolean) => {
      clearTimeout(timeoutHandle);
      processHandle.off("exit", onExit);
      processHandle.off("error", onError);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(true);
    const timeoutHandle = setTimeout(() => finish(false), timeoutMs);
    processHandle.once("exit", onExit);
    processHandle.once("error", onError);
  });

  processHandle.kill("SIGTERM");
  if (await waitForExit(2_000)) return;
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;

  processHandle.kill("SIGKILL");
  await waitForExit(2_000);
}

async function waitUntilReady(
  url: string,
  timeoutMs: number,
  processHandle: ChildProcess
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
      throw new Error(
        `Test API exited before readiness (${formatExit(processHandle.exitCode, processHandle.signalCode)}).`
      );
    }

    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Connection failures are expected while the server is starting.
    }

    await delay(250);
  }

  throw new Error(`Test API did not become ready in ${timeoutMs}ms (${url}).`);
}

export async function launchTestApi(options: TestApiOptions = {}): Promise<TestApi> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3001;
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  const webOrigin = options.webOrigin ?? "https://localhost:3174";
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "holoim-viewer-api-"));
  const databasePath = path.join(tempDir, "test.db");
  const tempPrismaDir = path.join(tempDir, "prisma");
  const tempSchemaPath = path.join(tempPrismaDir, "schema.prisma");
  const migrationEnv = {
    ...process.env,
    DATABASE_URL: "file:../test.db"
  };

  let apiProcess: ChildProcess | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let stopping = false;
  const signalHandlers = new Map<HandledSignal, () => void>();

  const cleanupTempSync = () => {
    rmSync(tempDir, { recursive: true, force: true });
  };
  process.once("exit", cleanupTempSync);

  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    signalHandlers.clear();
  };

  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      stopping = true;
      removeSignalHandlers();
      await stopChildProcess(apiProcess).catch(() => undefined);
      await rm(tempDir, { recursive: true, force: true });
      process.off("exit", cleanupTempSync);
    })();
    return cleanupPromise;
  };

  try {
    await mkdir(tempPrismaDir);
    await writeFile(databasePath, "");
    await cp(apiSchemaPath, tempSchemaPath);
    await cp(path.join(apiRoot, "prisma", "migrations"), path.join(tempPrismaDir, "migrations"), {
      recursive: true
    });

    // The API imports @holoim/contracts and @holoim/objects through their
    // production entries in this spawned (non-Vite, non-Vitest) process, so
    // build them first.
    for (const workspacePackage of ["@holoim/contracts", "@holoim/objects"]) {
      await runCommand("pnpm", ["--filter", workspacePackage, "build"], {
        cwd: workspaceRoot,
        env: { ...process.env }
      });
    }
    await runCommand(
      "pnpm",
      ["--dir", apiRoot, "exec", "prisma", "generate", "--schema", apiSchemaPath],
      { cwd: workspaceRoot, env: { ...process.env, DATABASE_URL: databaseUrl(databasePath) } }
    );
    await runCommand(
      "pnpm",
      ["--dir", apiRoot, "exec", "prisma", "migrate", "deploy", "--schema", tempSchemaPath],
      { cwd: workspaceRoot, env: migrationEnv }
    );

    apiProcess = spawn(process.execPath, ["--import", tsxLoaderPath, apiServerPath], {
      cwd: tempDir,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl(databasePath),
        PORT: String(port),
        WEB_ORIGIN: webOrigin
      },
      stdio: "inherit"
    });

    const exitResult = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        apiProcess?.once("error", reject);
        apiProcess?.once("exit", (code, signal) => resolve({ code, signal }));
      }
    );

    apiProcess.once("exit", () => {
      if (!stopping) void cleanup();
    });

    for (const signal of handledSignals) {
      const handler = () => {
        stopping = true;
        removeSignalHandlers();
        apiProcess?.kill(signal);
        cleanupTempSync();
        process.off("exit", cleanupTempSync);
        process.exit(128 + os.constants.signals[signal]);
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }

    const baseUrl = `http://${host}:${port}`;
    const readinessUrl = `${baseUrl}/api/holograms?limit=1`;
    await waitUntilReady(readinessUrl, startupTimeoutMs, apiProcess);

    return {
      baseUrl,
      databasePath,
      process: apiProcess,
      readinessUrl,
      tempDir,
      stop: cleanup,
      waitForExit: () => exitResult
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function runCli(): Promise<void> {
  const api = await launchTestApi({
    host: process.env.TEST_API_HOST ?? "127.0.0.1",
    port: Number(process.env.TEST_API_PORT ?? "3001"),
    startupTimeoutMs: Number(process.env.STARTUP_TIMEOUT_MS ?? "30000"),
    webOrigin: process.env.WEB_ORIGIN ?? "https://localhost:3174"
  });

  const result = await api.waitForExit();
  await api.stop();
  if (result.signal) {
    process.exitCode = 128 + os.constants.signals[result.signal];
  } else if (result.code) {
    process.exitCode = result.code;
  }
}

if (path.resolve(process.argv[1] ?? "") === scriptPath) {
  runCli().catch((error: unknown) => {
    console.error("[test-api]", error);
    process.exitCode = 1;
  });
}
