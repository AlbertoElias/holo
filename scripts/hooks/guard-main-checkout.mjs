#!/usr/bin/env node
// Claude Code PreToolUse hook (Edit, Write, MultiEdit, NotebookEdit): the main
// checkout is the integration point only and never takes edits (AGENTS.md,
// "Sharing work between agents"). Blocks (exit 2) a write to a tracked or
// not-yet-ignored path inside the main checkout of this repository.
//
// Allowed: linked worktrees (.worktrees/, .claude/worktrees/), paths outside this
// repository (memory, scratchpad), git-ignored files (.env, settings.local.json),
// and conflict resolution while a merge, cherry-pick or rebase is in progress.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const allow = () => process.exit(0);

const git = (cwd, args) => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  allow(); // never block on a payload we cannot read
}

const target = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
if (!target) allow();

const file = resolve(input.cwd ?? process.cwd(), target);
let dir = dirname(file);
while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
const commonOf = (cwd) => git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
const gitDirOf = (cwd) => git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir']);

const fileCommon = commonOf(dir);
if (!fileCommon) allow(); // not inside any git repository
if (fileCommon !== commonOf(projectDir)) allow(); // a different repository

if (gitDirOf(dir) !== fileCommon) allow(); // linked worktree

if (git(dir, ['check-ignore', '-q', '--', file]) === '') allow(); // ignored, personal file

for (const ref of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD']) {
  if (git(dir, ['rev-parse', '-q', '--verify', ref])) allow(); // resolving conflicts
}

process.stderr.write(
  `Blocked: ${file} is in the main checkout, which is integration-only.\n` +
    'Work in a worktree instead: ' +
    '`git worktree add .worktrees/<task> -b <type>/<task> origin/main`, then `pnpm install` there.\n',
);
process.exit(2);
