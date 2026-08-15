import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createCheckPlans,
  createDryRunReport,
  discoverWorkspaceGraph,
  listChangedFiles,
  selectAffectedPackages,
  type DryRunReport
} from "./verify-changed-core.ts";

interface FixturePackage {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name: string;
  path: string;
  scripts?: Record<string, string>;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createWorkspace(packages: readonly FixturePackage[]): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "holoim-selector-"));
  writeFileSync(path.join(rootDir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n");
  for (const workspacePackage of packages) {
    writeJson(path.join(rootDir, workspacePackage.path, "package.json"), {
      name: workspacePackage.name,
      private: true,
      scripts: workspacePackage.scripts,
      dependencies: workspacePackage.dependencies,
      devDependencies: workspacePackage.devDependencies
    });
  }
  return rootDir;
}

function runGit(rootDir: string, args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("selects a changed package and all transitive reverse dependents", (context) => {
  const rootDir = createWorkspace([
    { name: "@fixture/app", path: "apps/app", dependencies: { "@fixture/feature": "workspace:*" } },
    { name: "@fixture/feature", path: "packages/feature", dependencies: { "@fixture/core": "workspace:*" } },
    { name: "@fixture/core", path: "packages/core" },
    { name: "@fixture/unrelated", path: "packages/unrelated" }
  ]);
  context.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const graph = discoverWorkspaceGraph(rootDir);
  const selection = selectAffectedPackages(graph, ["packages/core/src/deleted.ts"]);

  assert.equal(selection.reason, "package-changes");
  assert.deepEqual(selection.directPackages, ["@fixture/core"]);
  assert.deepEqual(selection.selectedPackages, ["@fixture/app", "@fixture/core", "@fixture/feature"]);
});

test("fails closed to every package for root, shared, or unknown files", (context) => {
  const rootDir = createWorkspace([
    { name: "@fixture/app", path: "apps/app" },
    { name: "@fixture/core", path: "packages/core" }
  ]);
  context.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const graph = discoverWorkspaceGraph(rootDir);
  const selection = selectAffectedPackages(graph, ["README.md", "packages/core/src/index.ts"]);

  assert.equal(selection.reason, "all-packages-fallback");
  assert.deepEqual(selection.fallbackFiles, ["README.md"]);
  assert.deepEqual(selection.selectedPackages, ["@fixture/app", "@fixture/core"]);
  const report = createDryRunReport(graph, selection);
  assert.deepEqual(report.checks, []);
  assert.deepEqual(report.rootActions, [{ command: "pnpm", args: ["run", "verify:workspace"] }]);
});

test("keeps no-change behavior as an empty skip", (context) => {
  const rootDir = createWorkspace([{ name: "@fixture/app", path: "apps/app" }]);
  context.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const selection = selectAffectedPackages(discoverWorkspaceGraph(rootDir), []);

  assert.equal(selection.reason, "no-changes");
  assert.deepEqual(selection.selectedPackages, []);
});

test("plans lint, typecheck, and the preferred available unit-test script", (context) => {
  const rootDir = createWorkspace([
    {
      name: "@fixture/all",
      path: "packages/all",
      scripts: { lint: "eslint .", typecheck: "tsc --noEmit", test: "fallback", "test:unit": "preferred" }
    },
    { name: "@fixture/none", path: "packages/none" }
  ]);
  context.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const graph = discoverWorkspaceGraph(rootDir);
  assert.deepEqual(createCheckPlans(graph, ["@fixture/none", "@fixture/all"]), [
    {
      lint: "lint",
      package: "@fixture/all",
      path: "packages/all",
      test: "test:unit",
      typecheck: "typecheck"
    },
    {
      lint: null,
      package: "@fixture/none",
      path: "packages/none",
      test: null,
      typecheck: null
    }
  ]);

  const report = createDryRunReport(
    graph,
    selectAffectedPackages(graph, ["packages/all/src/index.ts"])
  );
  assert.deepEqual(report.rootActions, []);
  assert.deepEqual(report.checks.map((check) => check.package), ["@fixture/all"]);
});

test("git discovery includes deleted and untracked package files", (context) => {
  const rootDir = createWorkspace([
    { name: "@fixture/app", path: "apps/app", dependencies: { "@fixture/core": "workspace:*" } },
    { name: "@fixture/core", path: "packages/core" }
  ]);
  context.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deletedFile = path.join(rootDir, "packages/core/src/deleted.ts");
  const untrackedFile = path.join(rootDir, "packages/core/src/untracked.ts");
  mkdirSync(path.dirname(deletedFile), { recursive: true });
  writeFileSync(deletedFile, "export {};\n");

  runGit(rootDir, ["init"]);
  runGit(rootDir, ["add", "."]);
  runGit(rootDir, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "fixture"]);
  unlinkSync(deletedFile);
  writeFileSync(untrackedFile, "export {};\n");

  const changedFiles = listChangedFiles(rootDir);
  assert.deepEqual(changedFiles, [
    "packages/core/src/deleted.ts",
    "packages/core/src/untracked.ts"
  ]);
  assert.deepEqual(
    selectAffectedPackages(discoverWorkspaceGraph(rootDir), changedFiles).selectedPackages,
    ["@fixture/app", "@fixture/core"]
  );
});

test("the CLI dry-run emits deterministic machine-readable data for the real workspace", () => {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(scriptDir, "..");
  const args = ["exec", "tsx", path.join(scriptDir, "verify-changed.ts"), "--", "--dry-run"];
  const first = spawnSync("pnpm", args, { cwd: rootDir, encoding: "utf8" });
  const second = spawnSync("pnpm", args, { cwd: rootDir, encoding: "utf8" });

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  const report = JSON.parse(first.stdout) as DryRunReport;
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.changedFiles, [...report.changedFiles].sort());
  assert.deepEqual(report.selection.selectedPackages, [...report.selection.selectedPackages].sort());

  if (report.selection.reason === "all-packages-fallback") {
    assert.deepEqual(report.checks, []);
    assert.deepEqual(report.rootActions, [{ command: "pnpm", args: ["run", "verify:workspace"] }]);
  } else {
    assert.deepEqual(report.rootActions, []);
    assert.deepEqual(report.checks.map((check) => check.package), report.selection.selectedPackages);
  }
});
