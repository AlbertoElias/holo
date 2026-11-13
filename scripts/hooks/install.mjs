// Points this repository's git hooks at scripts/hooks/git (no dependency).
// core.hooksPath is relative to each worktree's top level, so one setting in the
// shared config serves the main checkout, .worktrees/* and .claude/worktrees/*.
// Some tools (the Claude desktop app) also write an absolute core.hooksPath into a
// worktree's own config (config.worktree), which overrides the shared value; this
// replaces such an override with the relative path so each worktree runs its own hook.
// Runs from `pnpm install` (prepare), `pnpm run doctor` (self-heal), the Claude Code
// SessionStart hook, and `pnpm run hooks:install`; never fails an install.
// The same entry points also create git-ignored local env files (see LOCAL_ENV_FILES),
// so a fresh worktree passes `pnpm run doctor` without a manual copy.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOOKS_PATH = "scripts/hooks/git";

/** Git-ignored env files that a fresh checkout or worktree needs, seeded from the committed example. */
export const LOCAL_ENV_FILES = ["apps/viewer-api/.env"];

/** Copies each missing local env file from its `.env.example`; never overwrites. Returns the files created. */
export function ensureLocalEnvFiles({
  rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  log = console.log
} = {}) {
  const created = [];
  for (const file of LOCAL_ENV_FILES) {
    const target = path.join(rootDir, file);
    const example = `${target}.example`;
    if (existsSync(target) || !existsSync(example)) continue;
    copyFileSync(example, target);
    created.push(file);
    log(`[env] Created ${file} from ${file}.example.`);
  }
  return created;
}

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

if (import.meta.url === `file://${process.argv[1]}`) {
  installHooks();
  try {
    ensureLocalEnvFiles();
  } catch (error) {
    console.log(`[env] Could not create local env files: ${error.message}`);
  }
}
