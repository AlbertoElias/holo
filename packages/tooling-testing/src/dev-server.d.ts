import type { ChildProcess, SpawnOptions } from "node:child_process";

export type WaitForServerOptions = {
  retries?: number;
  retryDelayMs?: number;
  retryOnStatuses?: number[];
  processHandle?: ChildProcess | null;
};

export function runCommand(
  command: string,
  args: string[],
  options?: SpawnOptions & { timeoutMs?: number }
): Promise<void>;

export function canBindPort(host: string, port: number): Promise<boolean>;
export function findAvailablePort(host: string, startPort: number, span?: number): Promise<number>;
export function createHttpsBaseUrl(host: string, port: number): string;
export function startViteDevServer(options: {
  host: string;
  port: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  viteArgs?: string[];
}): ChildProcess;
export function startTestBuildServer(options: {
  app: "web" | "capture";
  host: string;
  port: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): ChildProcess;
export function waitForServer(url: string, timeoutMs?: number, processHandle?: ChildProcess | null): Promise<void>;
export function fetchWithRetry(url: string, init?: RequestInit, options?: WaitForServerOptions): Promise<Response>;
export function stopProcess(processHandle?: ChildProcess | null): Promise<void>;
