# HoloIM Workspace Agent Contract

This document is the canonical command and workflow contract for AI agents operating in `/Users/albertoelias/code/holoim-workspace`.

## Repository Boundary

- Workspace is a pnpm monorepo rooted at `/Users/albertoelias/code/holoim-workspace`.
- Runtime apps:
  - `/Users/albertoelias/code/holoim-workspace/apps/capture`
  - `/Users/albertoelias/code/holoim-workspace/apps/viewer-api`
  - `/Users/albertoelias/code/holoim-workspace/apps/viewer-web`
  - `/Users/albertoelias/code/holoim-workspace/apps/knowledge` (read-only Markdown atlas)
- Shared packages:
  - `/Users/albertoelias/code/holoim-workspace/packages/contracts`
  - `/Users/albertoelias/code/holoim-workspace/packages/config-eslint`
  - `/Users/albertoelias/code/holoim-workspace/packages/config-ts`
  - `/Users/albertoelias/code/holoim-workspace/packages/tooling-testing`
  - `/Users/albertoelias/code/holoim-workspace/packages/tooling-scripts`

## Approved Command Entrypoints

Run automation from these scripts unless a task explicitly requires lower-level commands.

### Workspace root

- `pnpm run doctor`
- `pnpm run verify:agent`
- `pnpm run verify:pr`
- `pnpm run verify:fast`
- `pnpm run verify:xr`
- `pnpm run verify:full`
- `pnpm run verify:workspace`
- `pnpm run verify:repo:tooling`
- `pnpm run verify:repo:capture`
- `pnpm run verify:repo:viewer`
- `pnpm run verify:changed`
- `pnpm run test:xr:capture`
- `pnpm run test:xr:viewer`
- `pnpm run test:xr:all`
- `pnpm run test:smoke:pipeline`
- `pnpm run test:portal`
- `pnpm run dev:capture:ai`
- `pnpm run dev:capture:agent`
- `pnpm run dev:capture:status`
- `pnpm run dev:capture:down`
- `pnpm run dev`
- `pnpm run dev:knowledge`
- `pnpm run test:knowledge`

### App-level (optional when scoping work)

- `pnpm --filter @holoim/capture run doctor`
- `pnpm --filter @holoim/capture run verify:fast`
- `pnpm --filter @holoim/capture run verify:full`
- `pnpm --filter @holoim/capture run verify:changed`
- `pnpm --filter @holoim/capture run iwsdk:adapter:status`
- `pnpm --filter @holoim/contracts run verify:fast`
- `pnpm --filter @holoim/api run verify:fast`
- `pnpm --filter @holoim/web run verify:fast`

## Pre-Handoff Check Policy

- Default during implementation: run `pnpm run verify:agent`. It derives affected
  workspaces and reverse dependents from package manifests, then fails closed to the
  comprehensive workspace checks if it cannot classify a change safely.
- For documentation-only changes, check the edited content and references; do not
  run application suites solely because a Markdown file changed.
- Required before opening or updating a pull request: run `pnpm run verify:pr`
  locally. Hosted CI does not run on branches or pull requests, so this local
  run is the pre-merge gate; do not dispatch hosted CI to substitute for it.
  Hosted CI is only the final check on `main` before deployment: never use it
  to reproduce, debug or verify a change.

### Emulating CI

When running a check directly does not reproduce a problem, and especially a
failure seen only on CI, run it with `scripts/ci-emulate.sh <command>` (Docker
must be running). It copies the working tree, including uncommitted edits,
into a `node:24-bookworm` container pinned to 2 CPUs (`--cpuset-cpus`, so
`availableParallelism()` is 2 and the harness chooses CI's concurrency) and
7 GB, sets `CI=true`, and repeats the CI setup (frozen install, `.env`, Prisma,
Chromium with `--with-deps`) before running the command. The pnpm store and
browsers persist in Docker volumes, so only the first run downloads them.
Outputs and Playwright reports are copied to `output/ci-emulate/`.

```bash
scripts/ci-emulate.sh pnpm run test:xr:viewer
scripts/ci-emulate.sh pnpm --filter @holoim/viewer-web exec playwright test e2e/ar.spec.ts --repeat-each=20 --workers=1
```

`CI_EMULATE_CPUS` overrides the pinned CPUs (default `0,1`). The container is a
close emulation, not the runner image: a failure that reproduces only on
hosted CI is still a defect to explain, not something to rerun.
- `pnpm run verify:pr` is the only full tier: it includes every capture XR flow,
  the viewer AR checks, the capture → viewer pipeline, and the portal view
  checks (`test:portal`: mocked gestures plus a real capture). `verify:full` is an
  alias kept for older notes.
- If GLTF export/import contract is touched, run:
  1. `pnpm run verify:repo:capture`
  2. `pnpm run verify:repo:viewer`
  3. `pnpm run test:smoke:pipeline`

## Fast Agent Loop

Iterate on the narrowest check that exercises the change, then widen once
before pushing. Measured locally on Node 22 (M-series, shared machine):

| Step | Command | Wall time |
|---|---|---|
| Docs-only edit | `pnpm run verify:agent` (runs Knowledge `check:docs` only) | ~2 s |
| One package edit | `pnpm run verify:agent` | 5–10 s |
| One capture XR check | `pnpm --filter @holoim/capture run test:xr:<mock\|recording\|flows\|terrain\|hands\|height\|body>` | 10–45 s |
| One replay fixture | `XR_REPLAY_ONLY=walk-forward pnpm --filter @holoim/capture run test:xr:body` | ~25 s |
| All capture XR checks | `pnpm run test:xr:capture` (checks run in parallel) | ~1.5 min |
| Body fault matrix | `BODY_REPLAY_FAULTS=1 pnpm --filter @holoim/capture run test:xr:body` (`BODY_REPLAY_FAULT=<name>` for one) | ~2 min |
| Hosted CI (manual, full) | `gh workflow run CI --ref main` | ~3.5–4.5 min |
| Hosted CI (push to main) | automatic on merge/push | only suites for the changed areas; docs-only runs no suites |

- Run anything that can pass two minutes (the full XR suite, `verify:pr`,
  CI) in the background and wait for its completion notice. To wait on CI, run
  `gh run watch <id> --exit-status` in the background; do not poll with
  `until grep` or `sleep` loops.
- `test:xr*` starts its own Vite server on the first free port from `5174`,
  so a stale server does not block it. Reuse one you started from the same
  worktree with `REUSE_DEV_SERVER=1 BASE_URL=https://127.0.0.1:<port>/`; never
  reuse a server from another checkout, which serves other code.
- Parallel checks write each check's output to
  `apps/capture/output/xr-checks/<name>.log` and print it when the check ends.
  Set `XR_CHECK_CONCURRENCY=1` for serial, streamed output.
- CI splits capture XR checks across 2 runners with `XR_SHARD=<i>/2`, which
  packs the listed checks by their CI cost (`CHECK_COST` in
  `run-xr-checks.mjs`) so every check runs exactly once. Actions bills each
  job rounded up to the minute against a monthly cap, so add shards or jobs
  only when the wall-time win outweighs the extra billed minutes.
  Each runner still runs its slice serially: this private repo's
  `ubuntu-latest` runner has 2 vCPUs, so the default is 1. Running 2 at a time
  passed on the branch but timed out on main: the hand and body checks each
  open 2 pages at once, and cold page loads then pass the 30 s goto limit.
  The pipeline job runs its two specs as Playwright shards
  (`pnpm run test:smoke:pipeline --shard=<i>/2`); the capture-to-viewer spec
  (~100 s on CI) is the long pole. Update `CHECK_COST` from the CI
  `xr-checks-shard-*.json` timings when a check's cost changes a lot.
- Videos (`HAND_REPLAY_VIDEO=1`, `BODY_REPLAY_VIDEO=1`) screenshot every frame
  and multiply wall time; combine them with `XR_REPLAY_ONLY`.

## Feature Delivery Contract

Follow the canonical process in `docs/FEATURE_WORKFLOW.md` (roles, delivery
sequence, testing rules, and where state lives). This contract remains
canonical only for commands and validation tiers; never present IWER evidence
as physical-headset validation.

## Port Policy

Primary ports:

- Viewer API: `3001`
- Viewer web: `3174`
- Capture dev: `5173`
- Capture mock VR: `5174`
- Capture pipeline E2E: `5175`
- Knowledge Atlas: `http://127.0.0.1:4176` (loopback-only, no XR runtime)

Rules:

- Viewer web E2E and smoke tests assume `https://localhost:3174`.
- Capture XR checks prefer `https://127.0.0.1:5174`.
- Use `https://localhost:*` for desktop/local XR emulation and a non-localhost secure origin for native mobile/headset WebXR.
- When a required port is occupied, scripts should fail fast with a clear message.
- IWSDK's managed capture runtime owns `5174`; stop it with
  `pnpm run dev:capture:down` before starting a separate mock-XR server there.
  Another worktree can run its own managed runtime with
  `CAPTURE_RUNTIME_PORT=<port>`.

## Test Environment Contract

Supported env vars for smoke and XR scripts:

- `DEV_HOST` (default `127.0.0.1`)
- `DEV_PORT` (default `5174` for capture checks)
- `BASE_URL` (default derived from host/port)
- `E2E_BASE_URL` (default `https://localhost:3174`)
- `E2E_API_PORT` (default `3001`; use a free port for isolated local integration)
- `REUSE_DEV_SERVER` (`1` to reuse existing server)
- `STARTUP_TIMEOUT_MS` (default `30000`)
- `XR_CHECK_TIMEOUT_MS` (default `120000` per capture XR check, `360000` for `body`; this only stops hangs, and setting it applies to every check)
- `XR_TEST_VIEWPORT` (default `320x180` for capture XR checks; set `1280x720` when inspecting the page live)
- `E2E_CAPTURE_URL` (default `https://127.0.0.1:5175/` for the pipeline test's capture server)
- `HAND_REPLAY_FIXTURES` (default `fixtures/input-recordings` for `test:xr:hands`)
- `HAND_REPLAY_VIDEO` (`1` renders a spectator video of each hand replay; needs `ffmpeg` to encode)
- `BODY_REPLAY_FIXTURES` (default `fixtures/body-recordings` for `test:xr:body`)
- `BODY_REPLAY_VIDEO` (`1` renders a third-person video of each body replay with the tracked head path; needs `ffmpeg`)
- `BODY_REPLAY_FAULTS` (`1` breaks each body behavior in turn and requires its metric to fail; `BODY_REPLAY_FAULT=<name>` runs one)
- `BODY_REPLAY_CONCURRENCY` (default `2` body replays at once; results do not depend on it)
- `HAND_REPLAY_CONCURRENCY` (default `2` hand replays at once; results do not depend on it)
- `XR_REPLAY_ONLY` (substring, comma-separated for several: replay only matching hand or body fixtures; with `BODY_REPLAY_FAULTS=1`, only faults on those fixtures)
- `XR_SHARD` (`<index>/<total>`, 1-based: `test:xr*` runs one cost-balanced slice of the listed checks; CI uses 2 slices)
- `XR_CHECK_CONCURRENCY` (capture XR checks run at once by `test:xr*`; default half the CPUs, from 1 to 3, so 1 on CI; results do not depend on it)
- `XR_TEST_MODE` (`iwer` or `off`; legacy aliases normalize to `iwer`, and the shim remains unit-test-only)
- `XR_TEST_ARTIFACT_DIR` (optional output path)

## When-To-Run Matrix

| Task type | Required commands |
|---|---|
| Documentation only | `pnpm run verify:agent` (docs link check) plus checking edited content and referenced commands |
| Tooling/config changes | `pnpm run doctor` plus checks affected by the configuration |
| Agent edit loop | `pnpm run verify:agent` |
| API upload or GLTF contract change | `pnpm run verify:agent` + `pnpm run test:smoke:pipeline` (real capture export → upload → viewer render) |
| XR behavior change | `pnpm run verify:agent` + `pnpm run verify:xr` |
| Pull request / pre-merge | `pnpm run verify:pr` locally (hosted CI does not run on PRs) |

## CI Contract

- `.github/workflows/ci.yml` exposes one stable check on main: `CI Gate`.
  It triggers only on pushes to `main` and on manual dispatch — never on
  branches or pull requests. Agents verify locally instead:
  `pnpm run verify:agent` in the edit loop and `pnpm run verify:pr` before
  merging (see Pre-Handoff Check Policy).
- On a push to `main`, a `changes` job (`scripts/ci-changed-areas.sh`,
  diffing the push's `before..sha`) selects only the suites relevant to the
  merged files: quality, unit tests and production build (one runner),
  capture XR checks (2 shards), viewer AR and Knowledge Atlas checks,
  capture → viewer pipeline (2 shards), and portal view checks. A docs-only
  push selects no suite and the gate passes on skips; root, shared-package,
  or unclassified files select every suite (fail closed, mirroring
  `verify:agent`). Manual dispatch always runs every suite. Jobs share
  `.github/actions/setup` (pnpm, Node, install, Prisma, cached Playwright
  Chromium). Wall time follows the slowest selected job, not their sum.
  There is no separate heavy tier and no weekly schedule; dispatch CI
  manually to check runner-image or dependency drift on unchanged code.
- `.github/workflows/deploy.yml` deploys production only after a successful
  CI run from a `main` push, and only the apps that push touched (the same
  script, diffing the head commit against its first parent — exact for the
  squash and merge commits used on `main`): API (Fly), viewer (Pages), and
  capture (Pages) deploy independently, and a docs-only merge deploys
  nothing. Manual dispatch deploys all three. It never gates PRs.
- Capture XR checks are deterministic: they take capture's manual clock
  (`__setManualClock`), advance simulation only through `advanceTime`, and freeze
  the page's timers after XR session entry so IWER's per-frame compositing cannot
  load the runner. Results must not depend on host speed; a check that passes
  locally and fails on CI is a defect in the check or the app.
- Test retries are disabled. Flakes must remain visible and be fixed rather than
  hidden by reruns.
- Every job has a hard timeout. Timed commands write JSON to
  `output/test-results/` and append their duration to the GitHub job summary.
  The same folder gets per-check durations from `run-xr-checks.mjs`
  (`xr-checks[-shard-<i>of<n>].json`) and Playwright JSON reports
  (`playwright-web-<script>.json`, `playwright-knowledge.json`) with per-test
  durations.
- Browser diagnostics are uploaded only after failures. Timing artifacts are kept
  for successful and failed runs so regressions can be compared without bloating
  every artifact set.

## Git Conventions

- Treat this workspace as one monorepo for commits and branches.
- Keep branch names intent-scoped (`codex/*`, `claude/*`, `feature/*`, `fix/*`, `chore/*`).
- Keep changes app-local unless a shared contract/tooling update is required.
