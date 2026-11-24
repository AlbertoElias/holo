import { hasHeadCommit, run, runCapture, unique } from "@holoim/tooling-scripts/git-changed";

const lintableExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts"]);
// Repo-relative paths. A change to one of these lints the whole app.
const repoWideTriggers = new Set([
  "package.json",
  "apps/capture/package.json",
  "apps/capture/tsconfig.json",
  "apps/capture/.oxlintrc.json",
  "apps/capture/vite.config.ts"
]);
const sharedLintConfig = "packages/config-eslint/";

function isLintable(pathname) {
  const dotIndex = pathname.lastIndexOf(".");
  if (dotIndex === -1) return false;
  return lintableExtensions.has(pathname.slice(dotIndex));
}

// Changed and untracked files as repo-relative paths. Oxlint skips a path
// that does not exist without an error, so the lint targets must be exact.
function listRepoChangedFiles() {
  const root = runCapture("git", ["rev-parse", "--show-toplevel"]);
  const tracked = hasHeadCommit()
    ? runCapture("git", ["diff", "--name-only", "--diff-filter=ACMR", "HEAD"]).split("\n")
    : [];
  const untracked = runCapture("git", ["-C", root, "ls-files", "--others", "--exclude-standard"]).split("\n");
  return unique([...tracked, ...untracked].filter(Boolean));
}

function main() {
  const prefix = runCapture("git", ["rev-parse", "--show-prefix"]);
  const changedFiles = listRepoChangedFiles();

  if (changedFiles.length === 0) {
    console.log("[verify:changed] No changed files detected; skipping.");
    return;
  }

  const shouldRunRepoWideLint = changedFiles.some(
    (file) => repoWideTriggers.has(file) || file.startsWith(sharedLintConfig)
  );
  const lintTargets = shouldRunRepoWideLint
    ? ["src", "scripts", "vite.config.ts"]
    : changedFiles
        .filter((file) => file.startsWith(prefix) && isLintable(file))
        .map((file) => file.slice(prefix.length));

  if (lintTargets.length > 0) {
    run("pnpm", ["exec", "oxlint", ...lintTargets]);
  } else {
    console.log("[verify:changed] No lintable changed files detected.");
  }

  run("pnpm", ["run", "typecheck"]);
}

main();
