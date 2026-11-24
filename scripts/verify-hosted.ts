// Hosted pre-merge gate: the hosted test jobs on this branch merged with
// origin/main (docs/features/hosted-branch-gate.md). It is the other way to
// pass the gate besides a full local `pnpm run verify:pr`.
//
// 1. Runs the fast local checks of verify:pr for the changed areas, with its
//    result cache: doctor, ci-areas, lint and typecheck, unit tests and the
//    solver regression (local only, as in verify:pr). They start no server,
//    so this does not take the machine-wide verify lock.
// 2. Makes the commit to test: HEAD when it already holds origin/main, else
//    the merge commit "Merge branch '<branch>'" with origin/main as its first
//    parent (git merge-tree, no checkout). The commit is the same for the same
//    inputs and git identity, so a second run of the same tree pushes nothing
//    new. Landing that exact commit on main is a fast-forward.
// 3. Pushes the branch and refs/heads/gate/<tree> in one push. That ref
//    starts .github/workflows/ci.yml, which selects the suites that the push
//    to main would select. A green run lets main skip those suites when the
//    same tree lands there within 24 hours (scripts/ci-gate-reuse.sh).
// 4. Waits for the run, prints one line per finished job, then PASSED or
//    FAILED with the failed jobs and the failed test lines from their logs.
//    When only browser-suite jobs failed, it reruns those jobs one time
//    (gh run rerun --failed). A pass on the rerun is green, but the tests
//    that failed first are flaky: record each in BUGS.md before the merge.
//    A second failure, or a failure of any other job (lint, typecheck, unit
//    tests, build, area selection), is red with no rerun.
//    Writes output/verify-hosted.json and output/verify-hosted.exit, then
//    deletes the gate ref and the Actions caches saved on it, so gate runs
//    do not push main's caches out (the run and its results stay).
//
// Run it in the background and wait for it to exit; it polls GitHub itself.
// A red gate run is not a debugging tool: reproduce the failure locally
// (scripts/ci-emulate.sh), fix it, commit, and run the gate again.
//
// Usage: pnpm run verify:hosted [-- --dry-run | --no-local]
//   --dry-run   print the plan (areas, local steps, commit, ref) and exit
//   --no-local  skip the local checks (they passed in this tree already)
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openCache, type Decision, type ResultCache } from "./verify-cache.ts";
import { parseAreas, selectSteps, touchesSolver } from "./verify-pr.ts";

/** The verify:pr steps that run here before the push. The hosted jobs run the rest. */
const LOCAL_STEPS = new Set(["doctor", "ci-areas", "lint+typecheck", "unit", "solver-regression"]);
const POLL_MS = 20_000;
const RUN_APPEARS_MS = 180_000;
const RUN_LIMIT_MS = 60 * 60_000;
const MAX_TEST_LINES = 12;
/** Job name prefixes of the browser suites in ci.yml: only these rerun, one time. */
const BROWSER_SUITES = [
  "Capture XR checks",
  "Viewer and Knowledge browser checks",
  "Viewer VR gallery, foot controls and locomotion",
  "Capture to viewer pipeline",
  "Portal view end-to-end",
];
/** The aggregate job fails when any job it needs fails; it reruns with them. */
const AGGREGATE_JOB = "CI Gate";

type Step = ReturnType<typeof selectSteps>[number];

interface Job {
  conclusion: string;
  databaseId: number;
  name: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
}

interface Run {
  attempt: number;
  conclusion: string;
  databaseId: number;
  headSha: string;
  jobs: Job[];
  status: string;
  url: string;
}

class GateError extends Error {}

function run(command: string, args: string[], options: { allowFail?: boolean; env?: NodeJS.ProcessEnv } = {}): { code: number; out: string; err: string } {
  const result = spawnSync(command, args, { encoding: "utf8", env: options.env ?? process.env, maxBuffer: 256 * 1024 * 1024 });
  const code = result.status ?? 1;
  if (code !== 0 && !options.allowFail) {
    throw new GateError(`${command} ${args.join(" ")} failed (exit ${code}): ${(result.stderr || result.stdout).trim()}`);
  }
  return { code, out: result.stdout ?? "", err: result.stderr ?? "" };
}

const git = (...args: string[]) => run("git", args).out.trim();
const gh = (...args: string[]) => run("gh", args).out;

function log(line: string): void {
  console.log(`[verify-hosted] ${line}`);
}

function elapsed(since: number): string {
  const seconds = Math.round((Date.now() - since) / 1000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** The branch to gate; refuses main, a detached HEAD and uncommitted work (the gate tests commits). */
function preflight(): string {
  const branch = run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFail: true }).out.trim();
  if (!branch) throw new GateError("HEAD is detached; check out your branch");
  if (branch === "main") throw new GateError("on main; the gate is for a branch before its merge");
  const dirty = git("status", "--porcelain", "--untracked-files=normal");
  if (dirty) throw new GateError(`uncommitted changes; commit them first (the gate tests commits):\n${dirty}`);
  return branch;
}

function changedAreas(): { areas: Record<string, boolean>; files: string[] } {
  const base = git("merge-base", "origin/main", "HEAD");
  const files = git("diff", "--name-only", `${base}...HEAD`).split("\n").filter(Boolean);
  const dir = mkdtempSync(path.join(tmpdir(), "verify-hosted-"));
  try {
    const list = path.join(dir, "files.txt");
    writeFileSync(list, `${files.join("\n")}\n`, "utf8");
    const result = run("bash", ["scripts/ci-changed-areas.sh"], { env: { ...process.env, CI_AREAS_FILES_FROM: list } });
    return { areas: { ...parseAreas(result.out), authoring_solver: files.some(touchesSolver) }, files };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runStep(step: Step, env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(step.command, { shell: true, stdio: "inherit", env: { ...process.env, ...env } });
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function localChecks(areas: Record<string, boolean>): Promise<void> {
  const steps = selectSteps(areas, false).filter((step) => LOCAL_STEPS.has(step.label));
  const opened = openCache({ read: process.env.VERIFY_PR_NO_CACHE !== "1" });
  let cache: ResultCache | null = "off" in opened ? null : opened;
  if ("off" in opened) log(`result cache off: ${opened.off}`);
  for (const step of steps) {
    let decision: Decision = { action: "run", env: {}, keys: null, note: "", passedSpecs: [] };
    if (cache && step.cache) {
      try {
        decision = cache.decide(step);
      } catch (error) {
        log(`result cache off: ${error instanceof Error ? error.message : String(error)}`);
        cache = null;
      }
    }
    if (decision.action === "skip") {
      log(`= ${step.label}: ${decision.note}; skipped`);
      continue;
    }
    const started = Date.now();
    log(`> ${step.label}: ${step.command}`);
    const code = await runStep(step, decision.env);
    const seconds = Math.round((Date.now() - started) / 1000);
    log(`< ${step.label}: ${code === 0 ? "passed" : `FAILED (exit ${code})`} in ${seconds}s`);
    try {
      for (const line of cache?.record(step, decision, { code, seconds, startedAt: started }) ?? []) log(`  ${line}`);
    } catch (error) {
      // The step's own result stands when its pass cannot be stored.
      log(`  no pass stored: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (code !== 0) throw new GateError(`local check ${step.label} failed; fix it before the hosted run`);
  }
}

/** The commit the gate tests: origin/main merged with HEAD. Deterministic for the same inputs. */
function gateCommit(branch: string): { commit: string; tree: string; merged: boolean } {
  const head = git("rev-parse", "HEAD");
  const main = git("rev-parse", "origin/main");
  if (run("git", ["merge-base", "--is-ancestor", main, head], { allowFail: true }).code === 0) {
    return { commit: head, tree: git("rev-parse", "HEAD^{tree}"), merged: false };
  }
  const merge = run("git", ["merge-tree", "--write-tree", "--name-only", "--no-messages", main, head], { allowFail: true });
  if (merge.code === 1) {
    const conflicts = merge.out.trim().split("\n").slice(1).join(", ");
    throw new GateError(`the branch conflicts with origin/main (${conflicts}); merge origin/main, resolve, commit, then run the gate again`);
  }
  if (merge.code !== 0) throw new GateError(`git merge-tree failed (exit ${merge.code}): ${merge.err.trim()}`);
  const tree = merge.out.trim().split("\n")[0]!;
  // The configured identity, a fixed message and the newer parent's date: the
  // same parents and tree give the same commit. main is the first parent, as
  // in `git merge <branch>` on main, so the commit can land as it is.
  const name = git("config", "user.name");
  const email = git("config", "user.email");
  const date = String(Math.max(Number(git("show", "-s", "--format=%ct", head)), Number(git("show", "-s", "--format=%ct", main))));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: `${date} +0000`,
    GIT_COMMITTER_DATE: `${date} +0000`
  };
  const commit = run("git", ["commit-tree", tree, "-p", main, "-p", head, "-m", `Merge branch '${branch}'`], { env }).out.trim();
  return { commit, tree, merged: true };
}

function listRuns(ref: string): Run[] {
  const fields = "attempt,conclusion,databaseId,headSha,status,url";
  return JSON.parse(gh("run", "list", "--workflow", "ci.yml", "--branch", ref, "--event", "push", "--limit", "5", "--json", fields)) as Run[];
}

function viewRun(id: number): Run {
  return JSON.parse(gh("run", "view", String(id), "--json", "attempt,conclusion,databaseId,headSha,jobs,status,url")) as Run;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)); // wall-clock: waits on GitHub between status reads

async function findRun(ref: string, commit: string): Promise<Run> {
  const started = Date.now();
  while (Date.now() - started < RUN_APPEARS_MS) {
    const found = listRuns(ref).find((candidate) => candidate.headSha === commit);
    if (found) return found;
    await sleep(5_000);
  }
  throw new GateError(`no CI run started for ${ref} within ${RUN_APPEARS_MS / 1000}s`);
}

function jobSeconds(job: Job): string {
  if (!job.startedAt || !job.completedAt) return "";
  const seconds = Math.round((Date.parse(job.completedAt) - Date.parse(job.startedAt)) / 1000);
  return seconds >= 0 ? ` (${seconds}s)` : "";
}

/** Jobs already printed, by name and start time: a rerun carries passed jobs over under new ids. */
const reported = new Set<string>();

async function waitForRun(id: number, started: number): Promise<Run> {
  for (;;) {
    const current = viewRun(id);
    for (const job of current.jobs) {
      const key = `${job.name}@${job.startedAt ?? ""}`;
      if (job.status !== "completed" || reported.has(key)) continue;
      reported.add(key);
      if (job.conclusion === "skipped") continue;
      const mark = job.conclusion === "success" ? "ok  " : "FAIL";
      log(`${mark} ${job.name}${jobSeconds(job)}${job.conclusion === "success" || job.conclusion === "failure" ? "" : ` [${job.conclusion}]`}`);
    }
    if (current.status === "completed") return current;
    if (Date.now() - started > RUN_LIMIT_MS) throw new GateError(`run ${id} still not finished after ${RUN_LIMIT_MS / 60_000} minutes: ${current.url}`);
    await sleep(POLL_MS);
  }
}

// ANSI colours and the runner's timestamp prefix.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const STAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
// Playwright (✘ and the "[chromium] ›" list after "N failed"), node:test (✖, not ok),
// Vitest (FAIL, ×), the capture XR runner ([xr-checks] FAIL), Python (Error:) and the step's ##[error].
const FAILED_TEST = /✘|✖|×|^\s*not ok \d|\bFAIL\b|^\s*\[chromium\] ›|^\w*Error: |##\[error\]/;

/** The failed test lines of a job's log, deduplicated, at most MAX_TEST_LINES. */
export function failedTestLines(logText: string): string[] {
  const lines: string[] = [];
  for (const raw of logText.split("\n")) {
    const line = raw.replace(STAMP, "").replace(ANSI, "").trimEnd();
    if (!FAILED_TEST.test(line)) continue;
    const text = line.trim();
    if (text && !lines.includes(text)) lines.push(text);
    if (lines.length >= MAX_TEST_LINES) break;
  }
  return lines;
}

const failedJobs = (current: Run): Job[] => current.jobs.filter((job) => job.conclusion !== "success" && job.conclusion !== "skipped");

/** True when every failed job (the aggregate job aside) is a browser-suite job that failed or timed out. */
export function onlyBrowserSuitesFailed(jobs: Pick<Job, "conclusion" | "name">[]): boolean {
  const failed = jobs.filter((job) => job.conclusion !== "success" && job.conclusion !== "skipped" && !job.name.startsWith(AGGREGATE_JOB));
  return failed.length > 0 && failed.every((job) =>
    (job.conclusion === "failure" || job.conclusion === "timed_out") && BROWSER_SUITES.some((prefix) => job.name.startsWith(prefix)));
}

/** Starts the one rerun of the failed jobs and returns when GitHub shows the new attempt. */
async function rerunFailed(previous: Run): Promise<void> {
  run("gh", ["run", "rerun", String(previous.databaseId), "--failed"]);
  const started = Date.now();
  while (Date.now() - started < RUN_APPEARS_MS) {
    if (viewRun(previous.databaseId).attempt > previous.attempt) return;
    await sleep(5_000);
  }
  throw new GateError(`the rerun of run ${previous.databaseId} did not start within ${RUN_APPEARS_MS / 1000}s`);
}

function reportFailures(current: Run): string[] {
  const failed = failedJobs(current);
  const summary: string[] = [];
  for (const job of failed) {
    log(`failed job: ${job.name} [${job.conclusion}]`);
    const logs = run("gh", ["api", `repos/{owner}/{repo}/actions/jobs/${job.databaseId}/logs`], { allowFail: true });
    const lines = logs.code === 0 ? failedTestLines(logs.out) : [];
    if (lines.length === 0) log("    (no failed test line in the log; open the job)");
    for (const line of lines) log(`    ${line}`);
    summary.push(`${job.name}: ${lines[0] ?? job.conclusion}`);
  }
  return summary;
}

/** Deletes the gate ref and the Actions caches its run saved (they would push main's caches out). */
function cleanUp(ref: string): void {
  const pushed = run("git", ["push", "--no-verify", "--quiet", "origin", "--delete", `refs/heads/${ref}`], { allowFail: true });
  if (pushed.code !== 0) log(`could not delete ${ref}: ${pushed.err.trim()}`);
  const caches = run("gh", ["cache", "delete", "--all", "--ref", `refs/heads/${ref}`, "--succeed-on-no-caches"], { allowFail: true });
  if (caches.code !== 0) log(`could not delete the caches of ${ref}: ${caches.err.trim()}`);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2).filter((arg) => arg !== "--"));
  const started = Date.now();
  const outDir = path.resolve("output");
  mkdirSync(outDir, { recursive: true });
  const exitFile = path.join(outDir, "verify-hosted.exit");
  rmSync(exitFile, { force: true });
  const record: Record<string, unknown> = { startedAt: new Date(started).toISOString() };
  let status = 1;
  try {
    const branch = preflight();
    run("git", ["fetch", "--quiet", "origin", "main"]);
    const { areas, files } = changedAreas();
    const selected = Object.entries(areas).filter(([, on]) => on).map(([area]) => area);
    log(`${branch}: ${files.length} changed file(s) vs origin/main; areas: ${selected.join(", ") || "none"}`);
    const { commit, tree, merged } = gateCommit(branch);
    const ref = `gate/${tree}`;
    Object.assign(record, { branch, commit, tree, ref, mainSha: git("rev-parse", "origin/main") });
    log(`testing ${merged ? `merge commit ${commit.slice(0, 12)} (origin/main + ${branch})` : `HEAD ${commit.slice(0, 12)} (it holds origin/main)`}, tree ${tree}`);
    if (args.has("--dry-run")) {
      const local = selectSteps(areas, false).filter((step) => LOCAL_STEPS.has(step.label)).map((step) => step.label);
      log(`dry run: local checks ${local.join(", ")}; would push ${branch} and ${ref}`);
      status = 0;
      return;
    }

    if (!args.has("--no-local")) await localChecks(areas);
    log(`local checks done in ${elapsed(started)}`);

    let current = listRuns(ref).find((candidate) => candidate.headSha === commit);
    if (current) {
      log(`run ${current.databaseId} already tested this commit: ${current.url}`);
    } else {
      const remote = run("git", ["ls-remote", "origin", `refs/heads/${ref}`]).out.split("\t")[0]?.trim();
      if (remote && remote !== commit) {
        throw new GateError(`${ref} already holds ${remote.slice(0, 12)}, another commit of this tree (another gate is running it); wait for it, or delete the ref when that gate is gone`);
      }
      // One push for both refs; the local checks above ran more than the pre-push hook would.
      run("git", ["push", "--no-verify", "--quiet", "origin", `HEAD:refs/heads/${branch}`, `${commit}:refs/heads/${ref}`]);
      log(`pushed ${branch} and ${ref}`);
      current = await findRun(ref, commit);
      log(`run ${current.databaseId}: ${current.url}`);
    }
    record.runId = current.databaseId;
    record.url = current.url;
    let finished = await waitForRun(current.databaseId, Date.now());
    let flaky: string[] = [];
    if (finished.conclusion !== "success" && finished.attempt === 1 && onlyBrowserSuitesFailed(finished.jobs)) {
      flaky = reportFailures(finished).filter((line) => !line.startsWith(AGGREGATE_JOB));
      log("only browser-suite jobs failed: rerunning the failed jobs one time");
      await rerunFailed(finished);
      finished = await waitForRun(finished.databaseId, Date.now());
    }
    record.conclusion = finished.conclusion;
    record.attempt = finished.attempt;
    if (finished.conclusion === "success") {
      status = 0;
      if (flaky.length > 0) {
        record.flaky = flaky;
        log("FLAKY: these jobs failed on attempt 1 and passed on the rerun:");
        for (const line of flaky) log(`    ${line}`);
        log("record each flaky test in BUGS.md (the run URL and the failed test line) before the merge");
      }
      log(`PASSED in ${elapsed(started)}: tree ${tree} (run ${finished.databaseId}${finished.attempt > 1 ? `, attempt ${finished.attempt}` : ""})`);
      const land = merged ? `git merge --ff-only ${commit}` : `git merge --ff-only ${branch}`;
      log(`land it while origin/main is ${String(record.mainSha).slice(0, 12)}: in the main checkout, ${land} && git push origin main`);
      log("main then skips the suites this run passed (same tree, within 24 hours); if main moved, merge again and the suites run on main");
    } else {
      if (flaky.length > 0) record.firstAttemptFailures = flaky;
      record.failures = reportFailures(finished);
      log(`FAILED in ${elapsed(started)}: ${finished.url}`);
      log("reproduce locally (scripts/ci-emulate.sh), fix, commit, and run the gate again; do not debug on hosted CI");
    }
    cleanUp(ref);
  } catch (error) {
    if (!(error instanceof GateError)) throw error;
    record.error = error.message;
    log(`FAILED: ${error.message}`);
    status = error.message.startsWith("local check") ? 1 : 2;
  } finally {
    record.exit = status;
    record.seconds = Math.round((Date.now() - started) / 1000);
    writeFileSync(path.join(outDir, "verify-hosted.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    writeFileSync(exitFile, `${status}\n`, "utf8");
    process.exitCode = status;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
