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
- Do not count on hosted CI. It is only the final check for changes that land
  on `main`, before deployment. Reproduce, fix and verify everything locally;
  never push or dispatch CI to find out whether something works.
- When running a test directly does not reproduce a problem (for example a
  failure seen only on CI), emulate CI in Docker with `scripts/ci-emulate.sh
  <command>`: a 4-CPU, 16 GB Linux container with Node 24 and Chromium, like a
  hosted runner. See "Emulating CI" in `AGENT_CONTRACT.md`.
- Every feature, project, and bug fix ends with a proof video: a real-time
  recording of the actual workflow showing the change working (for a bug,
  the fixed behavior). Write it, and any script that records it, under the
  ignored `output/` directory or your scratchpad; never commit, merge, or
  link it from docs. Watch it yourself as a verification loop (preview it
  with `preview.mjs`), fix what it shows, then send it to the user before
  handoff. Durable evidence stays in the e2e checks and their reports.

This pnpm monorepo contains `apps/capture` (WebXR recording and GLTF export),
`apps/viewer-api` (upload and storage), `apps/viewer-web` (feed and AR viewer),
and `apps/knowledge` (read-only Markdown atlas).
Shared contracts, configuration, and tooling live in `packages/`.

Use TypeScript and existing shared configuration. Keep app-specific logic local;
share cross-app code through workspace packages. Keep API endpoints backward compatible
unless versioning is explicit. Preserve GLTF export → upload → render compatibility.

Read `AGENT_CONTRACT.md` when selecting commands, validation scope, or XR environment
settings. Use `pnpm run verify:agent` in the edit loop and `pnpm run verify:pr`
locally before merging. Hosted CI runs only on pushes to `main` (only the
suites relevant to the merged files) and on manual dispatch; it never runs
on branches or pull requests, so local verification is the pre-merge gate.
Documentation-only edits need documentation checks, not every application test.
Complete relevant checks and fixes before handoff.

For feature requests or substantial behavior changes, follow the canonical
process in `docs/FEATURE_WORKFLOW.md` (via the `feature-delivery` skill in
`.agents/skills/feature-delivery/SKILL.md`); do not wait for the user to name it.
Judge product behavior against `docs/product/concepts/what-a-hologram-is.md`:
a hologram is a recorded event, viewed through a portal on flat screens.
Judge any UI or visual change against `docs/product/design/styleguide.md`
and take its values from `docs/product/design/tokens.json`.

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
Split work into small tasks and give each one to a subagent on the matching
tier (one module, one check run, one search); the lead keeps only design,
integration, and decisions. Smaller tasks keep each context short.

| Tier | Work | Claude Code | Codex | Muse |
|---|---|---|---|---|
| Deep | Lead on recording, retargeting, contracts or the export → upload → render pipeline; design review; hard debugging | `--model opus` | `-p deep` (gpt-6-astra, xhigh) | `--effort high` |
| Standard | Implementing a settled brief; routine bugs | default (Sonnet) | `-p standard` (gpt-6.1-sol, medium) | default |
| Light | Searches, running checks or CI and summarizing, doc and queue bookkeeping | `searcher` / `check-runner` subagents | `-p light` (gpt-6-luna, low) | `--effort low` |

Routing is the agent's job, not the user's. Do it automatically:

- Before the first action of a task, and again when the kind of work changes,
  classify it against the table. If the current model is not the matching
  tier, say so in one line and keep going: `Model check: <task> is <tier>;
  I'm on <model>. <Cheaper|Stronger> option: <model or subagent> (<why>).`
  Say nothing when the model already fits.
- Warn in both directions. Opus on Standard or Light work wastes budget:
  delegate it to a pinned subagent. Sonnet on Deep work risks a wrong
  design: tell the user and recommend a fresh Opus session before starting.
- Escalate instead of looping: when a Standard model fails the same check
  twice, stop, report the failure, and recommend Opus (as a subagent for
  one hard step, or a fresh session for the whole task).
- Never inherit a model by default. Every `Agent` and `start_session` call
  sets `model` explicitly from the table; the app's model picker or
  `set_session_model` changes a running session only at a task boundary,
  because a model change discards the prompt cache of the whole context.
- Parallel sessions are fine; going past the limit is not. Before starting
  another lead session, read the 5-hour percentage with `get_usage` and
  hold off above about 70%.

- Codex usage is scarce: the user runs out of it fast. Spend it only on the
  independent verifier and design-screenshot validation, never on routine
  implementation or searches (Claude subagents do those). Apply the same
  tier check: `-p light` for a bounded diff or log read, `-p standard` for
  verifier and design reviews, `-p deep` only when the user approves it in
  that task. Prefer Muse or a Claude subagent when either fits.
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
Always work in your own worktree under `.worktrees/` (a Claude Code session
worktree under `.claude/worktrees/` is also fine); the main checkout is the
integration point only and never takes edits. A Claude Code hook
(`scripts/hooks/guard-main-checkout.mjs`) blocks Edit and Write there, except
for git-ignored files and while resolving a merge, cherry-pick or rebase.

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
- Worktrees isolate files, not runtime. Ports (`3001`, `3174`, `5173`, `5174`,
  `5175`, `4176`), dev servers, and local databases are still shared, so only one agent runs
  the XR harness or a dev server at a time unless ports are reassigned via
  `CAPTURE_RUNTIME_PORT` / `E2E_API_PORT`. A parallel `verify:pr` also needs
  `E2E_BASE_URL`, `E2E_POLYPIZZA_PORT`, `E2E_POLYHAVEN_PORT`,
  `E2E_CAPTURE_URL` and `KNOWLEDGE_E2E_PORT` moved off their defaults.
- As soon as your change is working and verified, commit and push your branch.
  You are pre-authorized to commit, push your branch, and merge it into
  `main` locally once `pnpm run verify:pr` passes, without asking; do not stop
  for approval on those steps. Do not open pull requests unless the user asks
  (CI never runs on them). After the push to `main`, confirm the automated
  deploy health checks passed and report the live URLs. Still ask before product or scope decisions, secret or billing
  changes, and destructive operations (force-push, volume or snapshot
  actions). Stage only the files you changed by name — never commit another
  agent's in-progress work, and never use a broad `git add`.
- Git transport is HTTPS with the `gh` credential helper (repo-local config:
  `credential.https://github.com.helper` → `gh auth git-credential`). SSH
  fails inside sandboxed agent sessions (`No user exists for uid 501` — the
  sandbox blocks the user-database lookup SSH requires); HTTPS through `gh`
  works with no approval. Do not switch the remote back to SSH.
- The lead merges the verified branch into `main`, pushes, then removes the
  worktree (`git worktree remove`) and deletes the merged branch (check
  `git branch --merged main` afterwards). If a push is
  rejected because another agent landed first, pull with rebase, re-run the
  affected check, and push again. Do not force-push.
- Every push to `main` runs CI and a deploy, so batch within a task: commit
  each step and its follow-up fixes locally, and merge to `main` once, when
  the whole task is finished and verified. That merge happens in the same
  session, documentation-only changes included, so the session can be
  archived; never park finished work as "ready" for a later merge. A newer
  push also cancels in-flight CI test jobs (never deploys), and the cancelled
  run's minutes are lost.

## Agent configuration (Codex and Claude Code)

Keep one source of truth for both agents; `pnpm run doctor` checks the
`CLAUDE.md` and `.claude/skills` symlinks and that `.mcp.json` and
`.codex/config.toml` register the same MCP server names. Everything else here
is convention.

- Instructions: edit `AGENTS.md` files only. Each `CLAUDE.md` is a symlink to the
  `AGENTS.md` beside it; add the same symlink when creating a new nested guide.
  The exception is `.agents/skills/gstack/CLAUDE.md`, which is upstream-owned
  and exempt from the symlink rule (its browser rules apply under that directory).
- When an instruction file and the code disagree, follow the code and report the
  mismatch in your final reply; then fix the stale line in the owning file.
- Typecheck with each package's own `typecheck` script (root uses `tsc`;
  `apps/knowledge` uses `tsgo`).
- Skills: add skill directories under `.agents/skills/`. `.claude/skills` is a
  symlink to that directory, so never create files inside `.claude/skills` directly.
- MCP servers: put launch logic in an executable `scripts/mcp/<name>.sh`, then
  register the same `<name>` in both `.codex/config.toml` and `.mcp.json`. Those
  config formats differ and cannot be symlinked.
- Claude Code permission defaults live in `.claude/settings.json`; personal
  overrides belong in the ignored `.claude/settings.local.json`.
