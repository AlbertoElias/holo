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
- Required before opening or updating a pull request: run `pnpm run verify:pr`.
- `pnpm run verify:pr` is the only full tier: it includes every capture XR flow,
  the viewer AR checks, and the capture → viewer pipeline. `verify:full` is an
  alias kept for older notes.
- If GLTF export/import contract is touched, run:
  1. `pnpm run verify:repo:capture`
  2. `pnpm run verify:repo:viewer`
  3. `pnpm run test:smoke:pipeline`

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

## Test Environment Contract

Supported env vars for smoke and XR scripts:

- `DEV_HOST` (default `127.0.0.1`)
- `DEV_PORT` (default `5174` for capture checks)
- `BASE_URL` (default derived from host/port)
- `E2E_BASE_URL` (default `https://localhost:3174`)
- `E2E_API_PORT` (default `3001`; use a free port for isolated local integration)
- `REUSE_DEV_SERVER` (`1` to reuse existing server)
- `STARTUP_TIMEOUT_MS` (default `30000`)
- `XR_CHECK_TIMEOUT_MS` (default `120000` per capture XR check; checks finish in seconds, so this only stops hangs)
- `XR_TEST_VIEWPORT` (default `320x180` for capture XR checks; set `1280x720` when inspecting the page live)
- `E2E_CAPTURE_URL` (default `https://127.0.0.1:5175/` for the pipeline test's capture server)
- `HAND_REPLAY_FIXTURES` (default `fixtures/input-recordings` for `test:xr:hands`)
- `HAND_REPLAY_VIDEO` (`1` renders a spectator video of each hand replay; needs `ffmpeg` to encode)
- `XR_TEST_MODE` (`iwer` or `off`; legacy aliases normalize to `iwer`, and the shim remains unit-test-only)
- `XR_TEST_ARTIFACT_DIR` (optional output path)

## When-To-Run Matrix

| Task type | Required commands |
|---|---|
| Documentation only | Check edited content, links, and referenced commands |
| Tooling/config changes | `pnpm run doctor` plus checks affected by the configuration |
| Agent edit loop | `pnpm run verify:agent` |
| API upload or GLTF contract change | `pnpm run verify:agent` + `pnpm run test:smoke:pipeline` (real capture export → upload → viewer render) |
| XR behavior change | `pnpm run verify:agent` + `pnpm run verify:xr` |
| Pull request / pre-merge | `pnpm run verify:pr` |

## CI Contract

- `.github/workflows/ci.yml` is the only GitHub Actions workflow and exposes one
  stable required check: `CI Gate`.
- Every event (push, pull request, manual, and a weekly schedule that only
  catches runner or dependency drift) runs the same three parallel jobs: quality
  and unit tests, production build, and browser end-to-end (capture XR checks,
  viewer AR checks, capture → viewer pipeline). There is no separate heavy tier.
- Capture XR checks are deterministic: they take capture's manual clock
  (`__setManualClock`), advance simulation only through `advanceTime`, and freeze
  the page's timers after XR session entry so IWER's per-frame compositing cannot
  load the runner. Results must not depend on host speed; a check that passes
  locally and fails on CI is a defect in the check or the app.
- Test retries are disabled. Flakes must remain visible and be fixed rather than
  hidden by reruns.
- Every job has a hard timeout. Timed commands write JSON to
  `output/test-results/` and append their duration to the GitHub job summary.
- Browser diagnostics are uploaded only after failures. Timing artifacts are kept
  for successful and failed runs so regressions can be compared without bloating
  every artifact set.

## Git Conventions

- Treat this workspace as one monorepo for commits and branches.
- Keep branch names intent-scoped (`codex/*`, `claude/*`, `feature/*`, `fix/*`, `chore/*`).
- Keep changes app-local unless a shared contract/tooling update is required.
