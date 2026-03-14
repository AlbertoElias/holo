import { listChangedFiles, run, unique } from "@holoim/tooling-scripts/git-changed";

const lintableExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts"]);
const repoWideTriggers = new Set([
  "package.json",
  "tsconfig.json",
  "eslint.config.mjs",
  "vite.config.ts"
]);

function isLintable(pathname) {
  const dotIndex = pathname.lastIndexOf(".");
  if (dotIndex === -1) return false;
  return lintableExtensions.has(pathname.slice(dotIndex));
}

function main() {
  const changedFiles = listChangedFiles();

  if (changedFiles.length === 0) {
    console.log("[verify:changed] No changed files detected; skipping.");
    return;
  }

  const shouldRunRepoWideLint = changedFiles.some((file) => repoWideTriggers.has(file));
  const lintTargets = shouldRunRepoWideLint
    ? ["src", "scripts", "vite.config.ts"]
    : unique(changedFiles.filter((file) => isLintable(file)));

  if (lintTargets.length > 0) {
    run("pnpm", ["exec", "eslint", ...lintTargets]);
  } else {
    console.log("[verify:changed] No lintable changed files detected.");
  }

  run("pnpm", ["run", "typecheck"]);
}

main();
