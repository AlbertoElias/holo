// Points this repository's git hooks at scripts/hooks/git (no dependency).
// core.hooksPath is relative to each worktree's top level, so one setting in the
// shared config serves the main checkout, .worktrees/* and .claude/worktrees/*.
// Some tools (the Claude desktop app) also write an absolute core.hooksPath into a
// worktree's own config (config.worktree), which overrides the shared value; this
// replaces such an override with the relative path so each worktree runs its own hook.
// Runs from `pnpm install` (prepare), `pnpm run doctor` (self-heal), the Claude Code
// SessionStart hook, and `pnpm run hooks:install`; never fails an install.
import { spawnSync } from "node:child_process";

export const HOOKS_PATH = "scripts/hooks/git";

const git = (...args) => spawnSync("git", args, { encoding: "utf8" });

/** Sets core.hooksPath where it takes effect; returns the effective value afterwards. */
export function installHooks({ log = console.log } = {}) {
  if (git("rev-parse", "--is-inside-work-tree").stdout?.trim() !== "true") return "";
  const effective = () => git("config", "--get", "core.hooksPath").stdout.trim();
  if (effective() === HOOKS_PATH) return HOOKS_PATH;

  // A worktree-level value wins over the shared one, so replace it there first.
  const worktreeLevel = git("config", "--worktree", "--get", "core.hooksPath");
  const useWorktree = worktreeLevel.status === 0 && worktreeLevel.stdout.trim() !== "";
  const result = useWorktree
    ? git("config", "--worktree", "core.hooksPath", HOOKS_PATH)
    : git("config", "core.hooksPath", HOOKS_PATH);
  log(
    result.status === 0
      ? `[hooks] core.hooksPath set to ${HOOKS_PATH}${useWorktree ? " (replacing this worktree's override)" : ""} (pre-push runs changed-file lint and typecheck).`
      : `[hooks] Could not set core.hooksPath: ${result.stderr.trim()}`
  );
  return effective();
}

if (import.meta.url === `file://${process.argv[1]}`) installHooks();
