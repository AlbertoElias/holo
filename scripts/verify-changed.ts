import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCheckPlans,
  createDryRunReport,
  discoverWorkspaceGraph,
  listChangedFiles,
  selectAffectedPackages,
  type CheckPlan,
  VERIFY_WORKSPACE_ACTION
} from "./verify-changed-core.ts";

function runPackageScript(packageName: string, script: string): void {
  const result = spawnSync("pnpm", ["--filter", packageName, "run", script], {
    stdio: "inherit"
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runWorkspaceFallback(): void {
  const result = spawnSync(VERIFY_WORKSPACE_ACTION.command, VERIFY_WORKSPACE_ACTION.args, {
    stdio: "inherit"
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runCheck(plan: CheckPlan, label: "lint" | "typecheck" | "test"): void {
  const script = plan[label];
  if (script === null) {
    console.log(`[verify:changed] ${plan.package}: skipping ${label}; script is absent.`);
    return;
  }
  console.log(`[verify:changed] ${plan.package}: running ${script}.`);
  runPackageScript(plan.package, script);
}

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const unknownArgs = args.filter((arg) => arg !== "--" && arg !== "--dry-run");
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown arguments: ${unknownArgs.join(", ")}`);
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(scriptDir, "..");
  const graph = discoverWorkspaceGraph(rootDir);
  const selection = selectAffectedPackages(graph, listChangedFiles(rootDir));

  if (dryRun) {
    process.stdout.write(`${JSON.stringify(createDryRunReport(graph, selection), null, 2)}\n`);
    return;
  }

  if (selection.reason === "no-changes") {
    console.log("[verify:changed] No changed files detected; skipping.");
    return;
  }

  if (selection.reason === "all-packages-fallback") {
    console.log(
      `[verify:changed] Root/shared/unknown changes detected (${selection.fallbackFiles.join(", ")}); running verify:workspace.`
    );
    runWorkspaceFallback();
    return;
  }

  console.log(`[verify:changed] Selected packages: ${selection.selectedPackages.join(", ")}.`);
  const plans = createCheckPlans(graph, selection.selectedPackages);
  for (const check of ["lint", "typecheck", "test"] as const) {
    for (const plan of plans) {
      runCheck(plan, check);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(`[verify:changed] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
