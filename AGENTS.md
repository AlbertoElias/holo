# HoloIM agent guide

## Testing doctrine

- Highly prefer end-to-end tests as the sole behavior-verification mechanism for
  complex features when the real workflow can exercise them. Finish with a
  repeatable, inspectable artifact such as a transcript, screenshot, or
  deterministic output file.
- Never add unit tests after implementation merely to ratify code that already
  exists. If isolated testing is genuinely necessary, first enumerate all
  plausible system failure modes and use that list to drive the test design and
  implementation.

This pnpm monorepo contains `apps/capture` (WebXR recording and GLTF export),
`apps/viewer-api` (upload and storage), and `apps/viewer-web` (feed and AR viewer).
Shared contracts, configuration, and tooling live in `packages/`.

Use TypeScript and existing shared configuration. Keep app-specific logic local;
share cross-app code through workspace packages. Keep API endpoints backward compatible
unless versioning is explicit. Preserve GLTF export → upload → render compatibility.

Read `AGENT_CONTRACT.md` when selecting commands, validation scope, or XR environment
settings. Use `pnpm run verify:agent` in the edit loop and `pnpm run verify:pr` before
merging; CI runs that same single tier on every push.
Documentation-only edits need documentation checks, not every application test.
Complete relevant checks and fixes before handoff.

For feature requests or substantial behavior changes, follow the canonical
process in `docs/FEATURE_WORKFLOW.md` (via the `feature-delivery` skill in
`.agents/skills/feature-delivery/SKILL.md`); do not wait for the user to name it.
Judge product behavior against `docs/product/concepts/what-a-hologram-is.md`:
a hologram is a recorded event, viewed through a portal on flat screens.

For ongoing work, each phase has one authority — queue in `TODOS.md`, in-flight
feature in its brief under `docs/features/`, open defects in `BUGS.md`, and
`HANDOFF.md` as a pointer only — as defined in `docs/FEATURE_WORKFLOW.md`.
Read and update only the owning file. `apps/capture/progress.md` is historical context.

For XR automation, use the repository's IWSDK/IWER harness and its HTTPS setup.
Read `docs/IWSDK_AI_WORKFLOW.md` for the managed capture workflow. Treat emulation
results separately from physical-headset validation. Shared Three.js values may
cross module boundaries; use structural flags where constructor identity is unreliable.

For other browser QA, use the browser tool suited to the task and available session.
Project-local gstack skills live in `.agents/skills/gstack`; load the requested workflow
when using gstack. Its setup command is `cd .agents/skills/gstack && PATH="$HOME/.bun/bin:$PATH" ./setup`.

## Working efficiently

Every turn re-reads the whole conversation, so context size is the main cost
and session length multiplies it.

- One task per session. When a question turns into implementation, or a
  shipped change into the next feature, record state in the owning file
  (brief, `TODOS.md`, `BUGS.md`) and tell the user to continue in a fresh session.
- Never read a full-size image. Preview it first with
  `node packages/tooling-testing/src/preview.mjs <image-or-frame-dir>` (an
  800px JPEG, or a 12-frame contact sheet for a frame directory); the hand
  and body replays already write `<label>-sheet.jpg`. Prefer numeric reports
  (`*-report.json`) over looking at frames.
- Run commands that may take over two minutes in the background and wait for
  the completion notice; do not poll in a loop or let a foreground command
  reach its timeout.
- Send broad searches and file sweeps to a subagent so only its conclusion
  enters the conversation. Print excerpts (`sed -n`, `grep`, `head`) instead
  of whole large files or logs.
- Iterate on the narrowest check, then widen once: one capture XR check
  (`pnpm --filter @holoim/capture run test:xr:body`), one replay fixture
  (`XR_REPLAY_ONLY=<name>`), and the full tier only before pushing. See
  "Fast Agent Loop" in `AGENT_CONTRACT.md`.

## Model routing

Pick the tier when starting a session; an agent cannot change its own model
mid-session, so a lead delegates lighter work to a pinned subagent instead.

| Tier | Work | Claude Code | Codex | Muse |
|---|---|---|---|---|
| Deep | Lead on recording, retargeting, contracts or the export → upload → render pipeline; design review; hard debugging | `--model opus` | `-p deep` (gpt-6-astra, xhigh) | `--effort high` |
| Standard | Implementing a settled brief; routine bugs | default (Sonnet) | `-p standard` (gpt-6.1-sol, medium) | default |
| Light | Searches, running checks or CI and summarizing, doc and queue bookkeeping | `searcher` / `check-runner` subagents | `-p light` (gpt-6-luna, low) | `--effort low` |

- The independent verifier in `docs/FEATURE_WORKFLOW.md` uses a different
  vendor from the implementer (for example Codex implements, Claude verifies);
  same-model review shares the implementer's blind spots.
- Claude Code subagents live in `.claude/agents/` with pinned models:
  `searcher` (Haiku), `check-runner` (Sonnet), `design-reviewer` (Opus).
- A cheaper model does not offset a long session; context size still dominates.
- Node must be 24 (`.nvmrc`). Claude Code sessions get it from a SessionStart
  hook; in other shells run `eval "$(scripts/agent-node-env.sh)"`. Never switch
  the machine-wide Node (`fnm default <version>`): other sessions share it.

## Sharing work between agents

Multiple agents share this repo, so uncommitted work is invisible to the others.
Always work in your own worktree under `.worktrees/`; the main checkout is the
integration point only and never takes edits.

- Before starting, run `git fetch` and check `git status`; read any in-flight
  brief in `docs/features/README.md` before touching overlapping files.
- For implementation work, create a worktree on your own branch and install
  there (pnpm's shared store makes this cheap):
  `git worktree add .worktrees/<task> -b <type>/<task> origin/main`, then
  `pnpm install` in that directory. If typecheck reports clashing
  `@types/three` copies in a reused worktree, its `node_modules` is stale:
  `rm -rf node_modules apps/*/node_modules packages/*/node_modules && pnpm install`
  (seconds, from the shared store). One feature or agent per worktree. Branch
  by change type, never by agent: `feature/`, `bug/`, `docs/`, `infra/`
  (e.g. `feature/ar-recenter`, `infra/metavr-setup`). Never edit files another
  agent has modified in a shared tree.
- Worktrees isolate files, not runtime. Ports (`3001`, `3174`, `5173`, `5174`),
  dev servers, and local databases are still shared, so only one agent runs
  the XR harness or a dev server at a time unless ports are reassigned via
  `CAPTURE_RUNTIME_PORT` / `E2E_API_PORT`.
- As soon as your change is working and verified, commit and push your branch.
  You are pre-authorized to commit, push, open a pull request, and merge on
  green CI without asking; do not stop for approval on those steps. After
  merge, confirm the automated deploy health checks passed and report the
  live URLs. Still ask before product or scope decisions, secret or billing
  changes, and destructive operations (force-push, volume or snapshot
  actions). Stage only the files you changed by name — never commit another
  agent's in-progress work, and never use a broad `git add`.
- Git transport is HTTPS with the `gh` credential helper (repo-local config:
  `credential.https://github.com.helper` → `gh auth git-credential`). SSH
  fails inside sandboxed agent sessions (`No user exists for uid 501` — the
  sandbox blocks the user-database lookup SSH requires); HTTPS through `gh`
  works with no approval. Do not switch the remote back to SSH.
- The lead merges the verified branch into `main`, pushes, then removes the
  worktree (`git worktree remove`) and deletes the merged branch. If a push is
  rejected because another agent landed first, pull with rebase, re-run the
  affected check, and push again. Do not force-push.

## Agent configuration (Codex and Claude Code)

Keep one source of truth for both agents; `pnpm run doctor` enforces this layout.

- Instructions: edit `AGENTS.md` files only. Each `CLAUDE.md` is a symlink to the
  `AGENTS.md` beside it; add the same symlink when creating a new nested guide.
- Skills: add skill directories under `.agents/skills/`. `.claude/skills` is a
  symlink to that directory, so never create files inside `.claude/skills` directly.
- MCP servers: put launch logic in an executable `scripts/mcp/<name>.sh`, then
  register the same `<name>` in both `.codex/config.toml` and `.mcp.json`. Those
  config formats differ and cannot be symlinked.
- Claude Code permission defaults live in `.claude/settings.json`; personal
  overrides belong in the ignored `.claude/settings.local.json`.
