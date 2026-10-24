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
  const selection = selectAffectedPackages(graph, ["package.json", "packages/core/src/index.ts"]);

  assert.equal(selection.reason, "all-packages-fallback");
  assert.deepEqual(selection.fallbackFiles, ["package.json"]);
  assert.deepEqual(selection.selectedPackages, ["@fixture/app", "@fixture/core"]);
  const report = createDryRunReport(graph, selection);
  assert.deepEqual(report.checks, []);
  assert.deepEqual(report.rootActions, [{ command: "pnpm", args: ["run", "verify:workspace"] }]);
});

test("documentation-only changes run the docs check instead of package checks", (context) => {
  const rootDir = createWorkspace([
    { name: "@fixture/app", path: "apps/app", scripts: { test: "unit" } },
    { name: "@fixture/core", path: "packages/core" }
  ]);
  context.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const graph = discoverWorkspaceGraph(rootDir);
  const docsOnly = selectAffectedPackages(graph, ["TODOS.md", "apps/app/README.md", "docs/features/brief.png"]);
  assert.equal(docsOnly.reason, "docs-only");
  assert.deepEqual(docsOnly.selectedPackages, []);
  const docsReport = createDryRunReport(graph, docsOnly);
  assert.deepEqual(docsReport.checks, []);
  assert.deepEqual(docsReport.rootActions, [{ command: "pnpm", args: ["--filter", "@holoim/knowledge", "run", "check:docs"] }]);

  // Docs alongside code: the code selects packages; the docs add only their check.
  const mixed = selectAffectedPackages(graph, ["docs/guide.md", "apps/app/src/index.ts"]);
  assert.equal(mixed.reason, "package-changes");
  assert.deepEqual(mixed.selectedPackages, ["@fixture/app"]);
  assert.deepEqual(createDryRunReport(graph, mixed).rootActions.map((action) => action.args.at(-1)), ["check:docs"]);
});

// A token edit lives under docs/ but generates @holoim/design-tokens, and the
// shared lint rule reads its colours: classing it as docs-only would skip the
// drift check and every lint (failure case in docs/features/ui-redesign.md).
test("a design token edit runs the token package, its dependents and every linted package", (context) => {
  const rootDir = createWorkspace([
    { name: "@holoim/web", path: "apps/viewer-web", dependencies: { "@holoim/design-tokens": "workspace:*" }, devDependencies: { "@holoim/config-eslint": "workspace:*" } },
    { name: "@holoim/design-tokens", path: "packages/design-tokens", devDependencies: { "@holoim/config-eslint": "workspace:*" } },
    { name: "@holoim/config-eslint", path: "packages/config-eslint" },
    { name: "@holoim/meaning", path: "packages/meaning", devDependencies: { "@holoim/config-eslint": "workspace:*" } },
    { name: "@holoim/unlinted", path: "packages/unlinted" }
  ]);
  context.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const graph = discoverWorkspaceGraph(rootDir);

  for (const file of ["docs/product/design/tokens.json", "./docs/product/design/tokens.json"]) {
    const selection = selectAffectedPackages(graph, [file]);
    assert.equal(selection.reason, "package-changes", file);
    assert.deepEqual(selection.docFiles, []);
    assert.deepEqual(selection.directPackages, ["@holoim/config-eslint", "@holoim/design-tokens"]);
    assert.deepEqual(selection.selectedPackages, ["@holoim/config-eslint", "@holoim/design-tokens", "@holoim/meaning", "@holoim/web"]);
  }

  const generated = selectAffectedPackages(graph, ["packages/design-tokens/src/generated/tokens.json"]);
  assert.deepEqual(generated.directPackages, ["@holoim/config-eslint", "@holoim/design-tokens"]);

  // The styleguide beside it is still documentation.
  assert.equal(selectAffectedPackages(graph, ["docs/product/design/styleguide.md"]).reason, "docs-only");
});

test("a design token edit selects every CI area", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "holoim-ci-areas-"));
  try {
    mkdirSync(path.join(rootDir, "docs/product/design"), { recursive: true });
    writeFileSync(path.join(rootDir, "docs/product/design/styleguide.md"), "a\n");
    writeFileSync(path.join(rootDir, "docs/product/design/tokens.json"), "{}\n");
    runGit(rootDir, ["init"]);
    runGit(rootDir, ["add", "."]);
    runGit(rootDir, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "base"]);
    const areas = (): Record<string, string> => {
      const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "ci-changed-areas.sh");
      const result = spawnSync("bash", [script, "HEAD~1", "HEAD"], { cwd: rootDir, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return Object.fromEntries(result.stdout.trim().split("\n").map((line) => line.split("=") as [string, string]));
    };
    const commit = (file: string, text: string) => {
      writeFileSync(path.join(rootDir, file), text);
      runGit(rootDir, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-am", file]);
    };

    commit("docs/product/design/styleguide.md", "b\n");
    assert.equal(areas().docs_only, "true");
    assert.equal(areas().quality, "false");

    commit("docs/product/design/tokens.json", "{ }\n");
    const tokenAreas = areas();
    assert.equal(tokenAreas.docs_only, "false");
    for (const area of ["quality", "capture_xr", "e2e", "pipeline", "portal", "web", "capture_app"]) {
      assert.equal(tokenAreas[area], "true", area);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
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
  // Run the CLI on this Node directly: a pnpm wrapper can print engine
  // warnings to stdout when the shell's Node differs from engines.node.
  const args = ["--import", "tsx", path.join(scriptDir, "verify-changed.ts"), "--dry-run"];
  const first = spawnSync(process.execPath, args, { cwd: rootDir, encoding: "utf8" });
  const second = spawnSync(process.execPath, args, { cwd: rootDir, encoding: "utf8" });

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  const report = JSON.parse(first.stdout) as DryRunReport;
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.changedFiles, [...report.changedFiles].sort());
  assert.deepEqual(report.selection.selectedPackages, [...report.selection.selectedPackages].sort());

  const workspaceActions = report.rootActions.filter((action) => action.args.includes("verify:workspace"));
  if (report.selection.reason === "all-packages-fallback") {
    assert.deepEqual(report.checks, []);
    assert.deepEqual(workspaceActions, [{ command: "pnpm", args: ["run", "verify:workspace"] }]);
  } else {
    assert.deepEqual(workspaceActions, []);
    assert.deepEqual(report.checks.map((check) => check.package), report.selection.selectedPackages);
  }
});
