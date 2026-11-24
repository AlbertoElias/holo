// Machine-wide lock so only one heavy local check runs at a time across
// worktrees: `verify:pr` and `scripts/ci-emulate.sh` both take it.
//
// Parallel runs collided on the suites' fixed default ports and on CPU (B-039's
// verify:pr passed on its eighth run; timing checks failed at load averages of
// 57-77). The lock is a TCP listener on loopback: binding is exclusive and the
// kernel releases it the moment the holder exits, however it dies (kill -9
// included), so there is no stale file to detect and no PID-reuse race. A
// second run connects, reads the holder's owner record (PID, worktree, branch,
// start time) and waits, printing who holds it. ci-emulate shares the lock
// because overlapping emulations starve each other the same way (crashed
// pages, navigation timeouts; AGENT_CONTRACT.md, "Emulating CI").
//
// Run any command under the lock:
//   tsx scripts/verify-lock.ts <label> -- <command...>
//
// Waiters take turns in arrival order (B-110): each run writes a ticket file
// (arrival time and PID) to `holoim-verify-lock-queue/` in the git common
// directory, which every worktree shares, and tries the port only while its
// ticket is the oldest one whose PID is alive. Before this, every waiter polled
// every 5 s and the first poll after a release won, so one run waited 1 h 40 min
// while later runs got the lock. A dead waiter's ticket (or one older than a
// day, whose PID can be reused) is skipped and removed.
//
// Escape hatch: a run whose suites use moved ports (AGENTS.md, "Sharing work
// between agents") can skip the lock with VERIFY_PR_NO_LOCK=1 (for
// ci-emulate, CI_EMULATE_NO_LOCK=1).
// VERIFY_PR_LOCK_PORT moves the lock itself (default 39417).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface LockOwner {
  tool: "holoim-verify-pr";
  pid: number;
  label: string;
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

function currentOwner(label: string): LockOwner {
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
  return {
    tool: "holoim-verify-pr",
    pid: process.pid,
    label,
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
  return `${owner.label ?? "verify-pr"}, PID ${owner.pid}, branch ${owner.branch}, worktree ${owner.worktree}, running ${minutes} min`;
}

/** The shared queue directory: the git common directory, else the temp directory. */
function queueDir(port: number): string {
  const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
  const base = common.status === 0 && common.stdout.trim() ? common.stdout.trim() : os.tmpdir();
  return path.join(base, `holoim-verify-lock-queue-${port}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A ticket name sorts by arrival: zero-padded milliseconds, then the PID. */
function ticketName(pid: number): string {
  return `${String(Date.now()).padStart(15, "0")}-${pid}`;
}

/** True when this ticket is the oldest ticket of a live process. Removes dead tickets. */
function isFirst(dir: string, mine: string): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return true;
  }
  for (const name of names) {
    if (name === mine) return true;
    const [at, pidText] = name.split("-");
    const pid = Number(pidText);
    // A ticket older than a day belongs to a reused PID, not to a waiter.
    const fresh = Date.now() - Number(at) < 24 * 3600 * 1000;
    if (fresh && Number.isInteger(pid) && pid > 0 && alive(pid)) return false;
    fs.rmSync(path.join(dir, name), { force: true });
  }
  // My ticket is gone (removed by hand): do not wait for ever.
  return true;
}

export interface AcquireOptions {
  port?: number;
  /** The queue directory; tests move it. */
  queue?: string;
  pollMs?: number;
  label?: string;
  log?: (line: string) => void;
}

/** Wait until this process holds the lock. Resolves with a release function. */
export async function acquireLock(options: AcquireOptions = {}): Promise<HeldLock> {
  const port = options.port ?? lockPort();
  const pollMs = options.pollMs ?? 5000;
  const log = options.log ?? ((line: string) => console.log(line));
  const label = options.label ?? "verify-pr";
  const owner = currentOwner(label);
  let lastReport = "";
  let waitedSince = 0;
  const dir = options.queue ?? queueDir(port);
  fs.mkdirSync(dir, { recursive: true });
  const ticket = ticketName(process.pid);
  const ticketPath = path.join(dir, ticket);
  fs.writeFileSync(ticketPath, `${JSON.stringify(owner)}\n`);
  const dropTicket = () => fs.rmSync(ticketPath, { force: true });
  process.once("exit", dropTicket);
  for (;;) {
    const first = isFirst(dir, ticket);
    const server = first ? await tryListen(port, owner) : null;
    if (server) {
      dropTicket();
      process.off("exit", dropTicket);
      if (waitedSince) log(`[${label}] lock acquired after ${((Date.now() - waitedSince) / 1000).toFixed(0)}s of waiting`);
      else log(`[${label}] lock acquired (127.0.0.1:${port})`);
      return {
        owner,
        release: () => new Promise((resolve) => server.close(() => resolve()))
      };
    }
    if (!waitedSince) waitedSince = Date.now();
    const holder = await readOwner(port);
    const ahead = first ? "" : " (an earlier run is first in the queue)";
    const report =
      holder === "free"
        ? first
          ? "lock holder just exited; retrying"
          : `lock is free; an earlier run takes it first`
        : holder === "foreign"
          ? `port ${port} is held by a process that is not verify:pr; free it or set VERIFY_PR_LOCK_PORT`
          : `waiting for the machine-wide check lock (${describe(holder)})${ahead}`;
    if (report !== lastReport) {
      log(`[${label}] ${report}`);
      lastReport = report;
    }
    if (holder !== "free" || !first) await new Promise((resolve) => setTimeout(resolve, first ? Math.min(pollMs, 1000) : pollMs));
  }
}

async function runUnderLock(argv: string[]): Promise<void> {
  const split = argv.indexOf("--");
  const label = split > 0 ? argv[0]! : "check";
  const command = split >= 0 ? argv.slice(split + 1) : [];
  if (command.length === 0) {
    console.error("usage: tsx scripts/verify-lock.ts <label> -- <command...>");
    process.exit(2);
  }
  const lock = await acquireLock({ label });
  const child = spawn(command[0]!, command.slice(1), { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
  child.once("exit", (code, signal) => {
    void lock.release().then(() => process.exit(code ?? (signal ? 1 : 0)));
  });
  child.once("error", (error) => {
    console.error(error.message);
    void lock.release().then(() => process.exit(1));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) void runUnderLock(process.argv.slice(2));
