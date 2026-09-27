# HoloIM Workspace Agent Contract

This document is the canonical command and workflow contract for AI agents operating in `/Users/albertoelias/code/holoim-workspace`.

## Repository Boundary

- Workspace is a pnpm monorepo rooted at `/Users/albertoelias/code/holoim-workspace`.
- Runtime apps:
  - `/Users/albertoelias/code/holoim-workspace/apps/capture`
  - `/Users/albertoelias/code/holoim-workspace/apps/viewer-api`
  - `/Users/albertoelias/code/holoim-workspace/apps/viewer-web`
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
- `pnpm run verify:nightly`
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
- `pnpm run verify:nightly` is the exhaustive browser-XR and live-API tier. Run it
  when those systems change or when diagnosing the scheduled workflow.
- `pnpm run verify:full` composes the PR and nightly tiers; it is intentionally not
  the normal edit-loop command.
- If GLTF export/import contract is touched, run:
  1. `pnpm run verify:repo:capture`
  2. `pnpm run verify:repo:viewer`
  3. `pnpm run test:smoke:pipeline`

## Feature Delivery Contract

- Start product behavior changes from `docs/templates/FEATURE_BRIEF.md` and follow
  `docs/FEATURE_WORKFLOW.md`.
- The lead owns the user outcome, acceptance criteria, scope, and integration.
- Consequential changes use a design reviewer before implementation and an
  independent verifier after implementation. The verifier receives the original
  criteria and inspects the working result directly.
- Assign exclusive file or module ownership before parallel edits. Parallelize
  investigation freely; parallelize implementation only across separate ownership.
- Report verification results and inspectable artifacts, plus any physical-device
  checks that remain. Never present IWER evidence as physical-headset validation.

## Port Policy

Primary ports:

- Viewer API: `3001`
- Viewer web: `3174`
- Capture dev: `5173`
- Capture mock VR: `5174`

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
- `XR_FLOW_TIMEOUT_MS` (default `180000` for capture locomotion flows)
- `XR_TEST_MODE` (`iwer` or `off`; legacy aliases normalize to `iwer`, and the shim remains unit-test-only)
- `XR_TEST_ARTIFACT_DIR` (optional output path)

## When-To-Run Matrix

| Task type | Required commands |
|---|---|
| Documentation only | Check edited content, links, and referenced commands |
| Tooling/config changes | `pnpm run doctor` plus checks affected by the configuration |
| Agent edit loop | `pnpm run verify:agent` |
| API upload or GLTF contract change | `pnpm run verify:agent` + `pnpm run test:smoke:pipeline` |
| XR behavior change | `pnpm run verify:agent` + `pnpm run verify:xr` |
| Pull request / pre-merge | `pnpm run verify:pr` |
| Scheduled or exhaustive confidence sweep | `pnpm run verify:nightly` |

## CI Contract

- `.github/workflows/ci.yml` is the only GitHub Actions workflow and exposes one
  stable required check: `CI Gate`.
- Pull requests and pushes run quality/unit checks first, then build/pipeline smoke
  and fast IWER XR coverage. Scheduled and explicitly heavy manual runs replace the
  fast XR job with exhaustive locomotion flows and viewer live-API integration.
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
