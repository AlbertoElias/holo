// Local pre-merge gate: run only the suites the change can affect.
//
// The areas come from scripts/ci-changed-areas.sh, the same mapping hosted CI
// uses, applied to everything that differs from the merge-base with the latest
// origin/main (commits, uncommitted edits and untracked files). The mapping
// fails closed: an unusable base, a lockfile change or an unclassified file
// selects every suite.
//
// A selected step does not run again when the same inputs already passed it,
// in this worktree or another one (scripts/verify-cache.ts,
// docs/features/verify-result-cache.md). A viewer Playwright step runs only
// the spec files that have no pass with the current inputs.
//
// Usage: pnpm run verify:pr [-- --full | --dry-run | --no-fetch | --no-cache]
//   --full      run every suite regardless of the diff or of stored passes (verify:full)
//   --dry-run   print the plan, with what the stored passes would skip, and exit
//   --no-fetch  skip `git fetch origin main` (offline)
//   --no-cache  run every selected step (also VERIFY_PR_NO_CACHE=1); passes are still stored
//
// Only one verify:pr runs its checks at a time on the machine
// (scripts/verify-lock.ts): a second run waits and prints who holds the lock.
// A run takes the lock before the first step that runs and is not `free`
// (doctor and ci-areas: seconds, no server). Thus a run whose steps all passed
// before with the same inputs does not wait. VERIFY_PR_NO_LOCK=1 skips the
// lock for a run whose suites use moved ports.
//
// Progress goes to stdout with NUL bytes made visible (Vite prints module ids
// prefixed with \0, which makes grep treat a log as binary). The final status
// is written to output/verify-pr.exit, so a watcher can wait for that file
// instead of grepping a log: `until [ -s output/verify-pr.exit ]; do sleep 20; done`.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { openCache, type Decision, type ResultCache, type StepCache } from "./verify-cache.ts";
import { acquireLock, type HeldLock } from "./verify-lock.ts";

type Area =
  | "quality"
  | "capture_xr"
  | "e2e"
  | "pipeline"
  | "portal"
  | "usdz_tools"
  | "web";

interface Step {
  area: Area | "always";
  /** How a stored pass is keyed. Without it the step always runs. */
  cache?: StepCache;
  command: string;
  /** Runs for seconds and starts no server, so it does not need the machine-wide lock. */
  free?: boolean;
  label: string;
  /** The port of a server that the suite uses when one is already there (Playwright `reuseExistingServer`). */
  reusesPort?: () => number;
}

// The viewer's Playwright suites: one stored pass per spec file. The report
// name comes from the pnpm script that runs the suite (playwright.config.ts).
const viewerSpecs = (script: string): StepCache => ({
  inputs: "code",
  specs: { dir: "apps/viewer-web/e2e", report: `output/test-results/playwright-web-${script}.json` }
});

// Mirrors the old verify:pr order. `e2e` is the knowledge app; the viewer's
// mocked XR checks follow `web` because knowledge-only changes cannot affect
// them.
export const STEPS: Step[] = [
  { area: "always", label: "doctor", command: "pnpm run doctor", free: true },
  { area: "always", label: "ci-areas", command: "pnpm run check:ci-areas", free: true },
  { area: "quality", label: "lint+typecheck", command: "pnpm run check:all", cache: { inputs: "tree" } },
  { area: "quality", label: "unit", command: "pnpm run test:unit:all", cache: { inputs: "tree" } },
  // Later steps load the dist folders this makes, so a skipped build still runs before the first later step that runs.
  { area: "quality", label: "build", command: "pnpm run build:all", cache: { inputs: "tree", artifact: true } },
  { area: "quality", label: "e2e-shards", command: "pnpm run check:e2e-shards", cache: { inputs: "tree" } },
  {
    area: "e2e",
    label: "knowledge",
    command: "pnpm run test:knowledge",
    cache: { inputs: "tree" },
    reusesPort: () => Number(process.env.KNOWLEDGE_E2E_PORT ?? 4176)
  },
  { area: "pipeline", label: "pipeline", command: "pnpm run test:smoke:pipeline", cache: viewerSpecs("test-e2e-pipeline") },
  { area: "portal", label: "portal", command: "pnpm run test:portal", cache: viewerSpecs("test-e2e-portal") },
  // Not cached: it passes with SKIPPED when Python packages are missing, and it reads tools outside the repo.
  { area: "usdz_tools", label: "usdz-tools", command: "pnpm run test:usdz-tools" },
  { area: "capture_xr", label: "xr-capture", command: "pnpm run test:xr:capture", cache: { inputs: "code" } },
  { area: "web", label: "xr-viewer", command: "pnpm run test:xr:viewer", cache: viewerSpecs("test-e2e-mocked") }
];

export function parseAreas(output: string): Record<string, boolean> {
  const areas: Record<string, boolean> = {};
  for (const line of output.split("\n")) {
    const match = /^([a-z0-9_]+)=(true|false)$/.exec(line.trim());
    if (match) areas[match[1]!] = match[2] === "true";
  }
  return areas;
}

export function selectSteps(areas: Record<string, boolean>, full: boolean): Step[] {
  return STEPS.filter((step) => full || step.area === "always" || areas[step.area] === true);
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function changedFiles(base: string): string[] {
  const committed = git(["diff", "--name-only", `${base}...HEAD`]);
  const working = git(["diff", "--name-only", "HEAD"]);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  return [...new Set(`${committed}${working}${untracked}`.split("\n").filter(Boolean))];
}

function resolveAreas(full: boolean, fetch: boolean): { areas: Record<string, boolean>; note: string } {
  if (full) return { areas: {}, note: "full run requested" };
  if (fetch) spawnSync("git", ["fetch", "--quiet", "origin", "main"], { stdio: "inherit" });
  const base = spawnSync("git", ["merge-base", "origin/main", "HEAD"], { encoding: "utf8" });
  if (base.status !== 0) return { areas: {}, note: "no merge-base with origin/main; running everything" };
  const files = changedFiles(base.stdout.trim());
  const dir = mkdtempSync(path.join(tmpdir(), "verify-pr-"));
  const list = path.join(dir, "files.txt");
  try {
    writeFileSync(list, `${files.join("\n")}\n`, "utf8");
    const result = spawnSync("bash", ["scripts/ci-changed-areas.sh"], {
      encoding: "utf8",
      env: { ...process.env, CI_AREAS_FILES_FROM: list }
    });
    if (result.status !== 0) return { areas: {}, note: "area script failed; running everything" };
    return { areas: parseAreas(result.stdout), note: `${files.length} changed file(s) vs origin/main` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Each step runs in its own process group, so a stopped verify:pr takes its dev
// servers and browsers down with it instead of leaving them on the ports the
// next lock holder needs.
const running = new Set<number>();

function stopChildren(signal: NodeJS.Signals): void {
  for (const pid of running) {
    try {
      process.kill(-pid, signal);
    } catch {
      // already gone
    }
  }
}

const SIGNAL_EXIT: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    stopChildren("SIGTERM");
    process.exit(SIGNAL_EXIT[signal]);
  });
}

function runStep(step: Step, env: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(step.command, { shell: true, detached: true, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    if (child.pid) running.add(child.pid);
    const forward = (stream: NodeJS.WriteStream) => (chunk: Buffer) =>
      stream.write(chunk.toString("utf8").replaceAll("\0", "\\0"));
    child.stdout.on("data", forward(process.stdout));
    child.stderr.on("data", forward(process.stderr));
    const finish = (code: number) => {
      if (child.pid) running.delete(child.pid);
      resolve(code);
    };
    child.once("error", () => finish(1));
    child.once("exit", (code) => finish(code ?? 1));
  });
}

/** True when a server answers on the port. */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const answer = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1000, () => answer(false));
    socket.once("connect", () => answer(true));
    socket.once("error", () => answer(false));
  });
}

const NO_DECISION: Decision = { action: "run", env: {}, keys: null, note: "", passedSpecs: [] };

/** Run or skip, from the stored passes. A cache that cannot decide turns itself off for the rest of the run. */
function decide(state: { cache: ResultCache | null }, step: Step): Decision {
  if (!state.cache || !step.cache) return NO_DECISION;
  try {
    return state.cache.decide(step);
  } catch (error) {
    // CacheOff is a decision. Any other error (a file that went away during the read) also means: run.
    console.log(`[verify-pr] result cache off: ${error instanceof Error ? error.message : String(error)}`);
    state.cache = null;
    return NO_DECISION;
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2).filter((arg) => arg !== "--"));
  const full = args.has("--full");
  const exitFile = path.resolve("output", "verify-pr.exit");
  mkdirSync(path.dirname(exitFile), { recursive: true });
  rmSync(exitFile, { force: true });

  const { areas, note } = resolveAreas(full, !args.has("--no-fetch"));
  const noAreaInfo = Object.keys(areas).length === 0;
  const steps = selectSteps(noAreaInfo ? { quality: true, capture_xr: true, e2e: true, pipeline: true, portal: true, usdz_tools: true, web: true } : areas, full || noAreaInfo);
  const skipped = STEPS.filter((step) => !steps.includes(step)).map((step) => step.label);
  console.log(`[verify-pr] ${note}`);
  console.log(`[verify-pr] running: ${steps.map((step) => step.label).join(", ")}`);
  if (skipped.length > 0) console.log(`[verify-pr] skipped (unaffected): ${skipped.join(", ")}`);

  const readCache = !full && !args.has("--no-cache") && process.env.VERIFY_PR_NO_CACHE !== "1";
  const opened = openCache({ read: readCache });
  const state = { cache: "off" in opened ? null : opened };
  if ("off" in opened) console.log(`[verify-pr] result cache off: ${opened.off}`);
  else if (!readCache) console.log("[verify-pr] result cache: not read in this run; passes are stored");

  if (args.has("--dry-run")) {
    for (const step of steps) {
      const decision = decide(state, step);
      if (decision.action === "skip") console.log(`[verify-pr] = ${step.label}: ${decision.note}; would skip`);
      else console.log(`[verify-pr] ~ ${step.label}: would run${decision.note ? ` ${decision.note}` : ""}`);
    }
    return;
  }

  // The lock is taken before the first step that needs it, not at the start.
  const noLock = process.env.VERIFY_PR_NO_LOCK === "1";
  if (noLock) console.log("[verify-pr] VERIFY_PR_NO_LOCK=1: running without the machine-wide lock");
  let lock: HeldLock | null = null;
  /** True when this call waited for the lock: the stored passes can be different after the wait. */
  const takeLock = async (): Promise<boolean> => {
    if (noLock || lock) return false;
    lock = await acquireLock();
    return true;
  };

  let status = 0;
  const started = Date.now();
  const execute = async (step: Step, decision: Decision): Promise<number> => {
    const stepStarted = Date.now();
    console.log(`[verify-pr] > ${step.label}: ${step.command}${decision.note ? ` (${decision.note})` : ""}`);
    // A report left by an earlier run must not be read as this run's.
    if (step.cache?.specs) rmSync(step.cache.specs.report, { force: true });
    const code = await runStep(step, decision.env);
    const seconds = (Date.now() - stepStarted) / 1000;
    console.log(`[verify-pr] < ${step.label}: ${code === 0 ? "passed" : `FAILED (exit ${code})`} in ${seconds.toFixed(0)}s`);
    try {
      for (const line of state.cache?.record(step, decision, { code, seconds: Math.round(seconds), startedAt: stepStarted }) ?? []) {
        console.log(`[verify-pr]   ${line}`);
      }
    } catch (error) {
      // The step's own result stands when its pass cannot be stored.
      console.log(`[verify-pr]   no pass stored: ${error instanceof Error ? error.message : String(error)}`);
    }
    return code;
  };
  // Skipped steps whose output a later step loads (build). They run when a later step runs.
  let deferred: Step[] = [];
  steps: for (const step of steps) {
    let decision = decide(state, step);
    if (decision.action === "run" && !step.free && (await takeLock())) decision = decide(state, step);
    // A pass against a server from an unknown tree says nothing about this tree: it is not stored.
    if (decision.action === "run" && step.reusesPort && (await listening(step.reusesPort()))) {
      console.log(`[verify-pr] ! ${step.label}: a server that this run did not start is on port ${step.reusesPort()}; the suite uses it, so no pass is stored`);
      decision = NO_DECISION;
    }
    if (decision.action === "skip") {
      console.log(`[verify-pr] = ${step.label}: ${decision.note}; skipped`);
      if (step.cache?.artifact) deferred.push(step);
      continue;
    }
    for (const earlier of deferred) {
      console.log(`[verify-pr]   ${step.label} runs, so ${earlier.label} runs first (its output is needed)`);
      status = await execute(earlier, NO_DECISION);
      if (status !== 0) break steps;
    }
    deferred = [];
    status = await execute(step, decision);
    if (status !== 0) break;
  }
  console.log(`[verify-pr] ${status === 0 ? "PASSED" : "FAILED"} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  writeFileSync(exitFile, `${status}\n`, "utf8");
  if (!lock && !noLock) console.log("[verify-pr] no step needed the machine-wide lock");
  await (lock as HeldLock | null)?.release();
  process.exitCode = status;
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
