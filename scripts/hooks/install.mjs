// Points this repository's git hooks at scripts/hooks/git (no dependency).
// core.hooksPath is relative to each worktree's top level, so one setting in the
// shared config serves the main checkout, .worktrees/* and .claude/worktrees/*.
// Runs from `pnpm install` (prepare) and `pnpm run hooks:install`; never fails an install.
import { spawnSync } from "node:child_process";

const HOOKS_PATH = "scripts/hooks/git";

const git = (...args) => spawnSync("git", args, { encoding: "utf8" });

if (git("rev-parse", "--is-inside-work-tree").stdout?.trim() === "true") {
  const current = git("config", "--get", "core.hooksPath").stdout.trim();
  if (current !== HOOKS_PATH) {
    const result = git("config", "core.hooksPath", HOOKS_PATH);
    console.log(
      result.status === 0
        ? `[hooks] core.hooksPath set to ${HOOKS_PATH} (pre-push runs changed-file lint and typecheck).`
        : `[hooks] Could not set core.hooksPath: ${result.stderr.trim()}`
    );
  }
}
