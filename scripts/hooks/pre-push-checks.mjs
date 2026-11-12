// pre-push: lint and typecheck only what the push changes, in parallel, so
// agents see format/lint/type errors in seconds instead of in CI.
// Reuses the package selection of `pnpm run verify:agent`. Bypass: git push --no-verify.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCheckPlans,
  discoverWorkspaceGraph,
  selectAffectedPackages
} from "../verify-changed-core.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ZERO = /^0+$/;
const started = Date.now();

const git = (...args) => spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
const ok = (result) => result.status === 0;

function mergeBase(sha) {
  for (const base of ["origin/main", "main"]) {
    const result = git("merge-base", base, sha);
    if (ok(result)) return result.stdout.trim();
  }
  return null;
}

function changedFilesForPush() {
  const files = new Set();
  const lines = readFileSync(0, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    const [, localSha, , remoteSha] = line.split(" ");
    if (!localSha || ZERO.test(localSha)) continue; // branch deletion
    let base =
      remoteSha && !ZERO.test(remoteSha) && ok(git("cat-file", "-e", `${remoteSha}^{commit}`)) ? remoteSha : null;
    base ??= mergeBase(localSha);
    const diff = base
      ? git("diff", "--name-only", "--no-renames", "--diff-filter=ACMR", `${base}...${localSha}`)
      : git("ls-tree", "-r", "--name-only", localSha);
    for (const file of diff.stdout.split("\n").filter(Boolean)) files.add(file);
  }
  return [...files].sort();
}

const changed = changedFilesForPush();
const graph = discoverWorkspaceGraph(rootDir);
const selection = selectAffectedPackages(graph, changed);

if (selection.reason === "no-changes" || selection.reason === "docs-only") {
  console.log(`[pre-push] ${selection.reason === "docs-only" ? "Documentation only" : "No changed files"}; checks skipped.`);
  process.exit(0);
}

const jobs = [];
// Lint the packages that changed; typecheck them and everything that depends on them.
const typecheckPackages =
  selection.reason === "all-packages-fallback" ? selection.directPackages : selection.selectedPackages;
const lintPackages = new Set(selection.directPackages);
for (const plan of createCheckPlans(graph, typecheckPackages)) {
  if (plan.lint && lintPackages.has(plan.package)) {
    jobs.push({ label: `${plan.package} lint`, args: ["--filter", plan.package, "run", "lint"] });
  }
  if (plan.typecheck) {
    jobs.push({ label: `${plan.package} typecheck`, args: ["--filter", plan.package, "run", "typecheck"] });
  }
}
const isToolingTs = (file) => file.startsWith("scripts/") && file.endsWith(".ts");
const toolingChanged = selection.fallbackFiles.some(isToolingTs);
if (toolingChanged) {
  jobs.push({ label: "root tooling lint", args: ["run", "lint:tooling"] });
  jobs.push({ label: "root tooling typecheck", args: ["run", "typecheck:tooling"] });
}
const unchecked = selection.fallbackFiles.filter((file) => !isToolingTs(file));

console.log(`[pre-push] ${changed.length} changed file(s); running ${jobs.length} check(s) in parallel.`);
if (unchecked.length > 0) {
  console.log(`[pre-push] No fast check for: ${unchecked.join(", ")} (left to verify:agent and CI).`);
}

function run(job) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn("pnpm", job.args, { cwd: rootDir, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => resolve({ ...job, status: 1, output: String(error), ms: Date.now() - t0 }));
    child.on("close", (status) => resolve({ ...job, status: status ?? 1, output, ms: Date.now() - t0 }));
  });
}

const results = [];
const queue = [...jobs];
await Promise.all(
  Array.from({ length: Math.max(1, Math.min(availableParallelism(), queue.length)) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const result = await run(job);
      results.push(result);
      console.log(`[pre-push] ${result.status === 0 ? "ok  " : "FAIL"} ${result.label} (${(result.ms / 1000).toFixed(1)}s)`);
    }
  })
);

const failed = results.filter((result) => result.status !== 0);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (failed.length > 0) {
  for (const result of failed) {
    console.error(`\n[pre-push] ---- ${result.label} ----\n${result.output.trim()}`);
  }
  console.error(
    `\n[pre-push] PUSH BLOCKED: ${failed.map((result) => result.label).join(", ")} failed (${seconds}s).` +
      "\n[pre-push] Fix the errors above and push again. To push anyway, use: git push --no-verify"
  );
  process.exit(1);
}
console.log(`[pre-push] All checks passed (${seconds}s).`);
