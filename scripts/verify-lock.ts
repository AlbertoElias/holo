// Machine-wide lock so only one `verify:pr` runs at a time across worktrees.
//
// Parallel runs collided on the suites' fixed default ports and on CPU (B-039's
// verify:pr passed on its eighth run; timing checks failed at load averages of
// 57-77). The lock is a TCP listener on loopback: binding is exclusive and the
// kernel releases it the moment the holder exits, however it dies (kill -9
// included), so there is no stale file to detect and no PID-reuse race. A
// second run connects, reads the holder's owner record (PID, worktree, branch,
// start time) and waits, printing who holds it.
//
// Escape hatch: a run whose suites use moved ports (AGENTS.md, "Sharing work
// between agents") can skip the lock with VERIFY_PR_NO_LOCK=1.
// VERIFY_PR_LOCK_PORT moves the lock itself (default 39417).
import { spawnSync } from "node:child_process";
import net from "node:net";

export interface LockOwner {
  tool: "holoim-verify-pr";
  pid: number;
  worktree: string;
  branch: string;
  startedAt: string;
}

export interface HeldLock {
  owner: LockOwner;
  release: () => Promise<void>;
}

export const DEFAULT_LOCK_PORT = 39417;

export function lockPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.VERIFY_PR_LOCK_PORT;
  const port = raw ? Number(raw) : DEFAULT_LOCK_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`VERIFY_PR_LOCK_PORT is not a port: ${raw}`);
  return port;
}

function currentOwner(): LockOwner {
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
  return {
    tool: "holoim-verify-pr",
    pid: process.pid,
    worktree: process.cwd(),
    branch: branch.status === 0 ? branch.stdout.trim() : "unknown",
    startedAt: new Date().toISOString()
  };
}

function tryListen(port: number, owner: LockOwner): Promise<net.Server | null> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.end(`${JSON.stringify(owner)}\n`);
    });
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(null);
      else reject(error);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      // Never keep the event loop alive for the lock alone.
      server.unref();
      resolve(server);
    });
  });
}

/** Ask whoever listens on the lock port who they are. */
export function readOwner(port: number, timeoutMs = 2000): Promise<LockOwner | "free" | "foreign"> {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const done = (value: LockOwner | "free" | "foreign") => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(timeoutMs, () => done("foreign"));
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    socket.on("end", () => {
      try {
        const parsed = JSON.parse(data) as LockOwner;
        done(parsed.tool === "holoim-verify-pr" ? parsed : "foreign");
      } catch {
        done("foreign");
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) => done(error.code === "ECONNREFUSED" ? "free" : "foreign"));
  });
}

function describe(owner: LockOwner): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(owner.startedAt)) / 60000));
  return `PID ${owner.pid}, branch ${owner.branch}, worktree ${owner.worktree}, running ${minutes} min`;
}

export interface AcquireOptions {
  port?: number;
  pollMs?: number;
  log?: (line: string) => void;
}

/** Wait until this process holds the lock. Resolves with a release function. */
export async function acquireLock(options: AcquireOptions = {}): Promise<HeldLock> {
  const port = options.port ?? lockPort();
  const pollMs = options.pollMs ?? 5000;
  const log = options.log ?? ((line: string) => console.log(line));
  const owner = currentOwner();
  let lastReport = "";
  let waitedSince = 0;
  for (;;) {
    const server = await tryListen(port, owner);
    if (server) {
      if (waitedSince) log(`[verify-pr] lock acquired after ${((Date.now() - waitedSince) / 1000).toFixed(0)}s of waiting`);
      else log(`[verify-pr] lock acquired (127.0.0.1:${port})`);
      return {
        owner,
        release: () => new Promise((resolve) => server.close(() => resolve()))
      };
    }
    if (!waitedSince) waitedSince = Date.now();
    const holder = await readOwner(port);
    const report =
      holder === "free"
        ? "lock holder just exited; retrying"
        : holder === "foreign"
          ? `port ${port} is held by a process that is not verify:pr; free it or set VERIFY_PR_LOCK_PORT`
          : `waiting for another verify:pr (${describe(holder)})`;
    if (report !== lastReport) {
      log(`[verify-pr] ${report}`);
      lastReport = report;
    }
    if (holder !== "free") await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
