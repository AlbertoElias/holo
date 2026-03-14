import { listChangedFiles, run, unique } from "@holoim/tooling-scripts/git-changed";

const packageByPrefix = [
  { prefix: "apps/capture/", pkg: "@holoim/capture" },
  { prefix: "apps/viewer-api/", pkg: "@holoim/api" },
  { prefix: "apps/viewer-web/", pkg: "@holoim/web" },
  { prefix: "packages/contracts/", pkg: "@holoim/contracts" }
];

const fullRunPrefixes = [
  "packages/config-eslint/",
  "packages/config-ts/",
  "packages/tooling-testing/",
  "packages/tooling-scripts/",
  "scripts/"
];

const fullRunFiles = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "eslint.config.mjs",
  "tsconfig.base.json"
]);

function detectAffectedPackages(changedFiles) {
  const matchedPackages = [];
  for (const file of changedFiles) {
    for (const mapping of packageByPrefix) {
      if (file.startsWith(mapping.prefix)) {
        matchedPackages.push(mapping.pkg);
      }
    }
  }
  return unique(matchedPackages);
}

function requiresFullRun(changedFiles) {
  return changedFiles.some(
    (file) =>
      fullRunFiles.has(file) ||
      fullRunPrefixes.some((prefix) => file.startsWith(prefix))
  );
}

function main() {
  const changedFiles = listChangedFiles();

  if (changedFiles.length === 0) {
    console.log("[verify:changed] No changed files detected; skipping.");
    return;
  }

  if (requiresFullRun(changedFiles)) {
    console.log("[verify:changed] Shared/root changes detected. Running verify:fast.");
    run("pnpm", ["run", "verify:fast"]);
    return;
  }

  const affectedPackages = detectAffectedPackages(changedFiles);
  if (affectedPackages.length === 0) {
    console.log("[verify:changed] No package scope changes detected. Running verify:fast.");
    run("pnpm", ["run", "verify:fast"]);
    return;
  }

  for (const pkg of affectedPackages) {
    run("pnpm", ["--filter", pkg, "verify:fast"]);
  }
}

main();
