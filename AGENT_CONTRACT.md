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
- `pnpm run verify:fast`
- `pnpm run verify:full`
- `pnpm run verify:workspace`
- `pnpm run verify:repo:capture`
- `pnpm run verify:repo:viewer`
- `pnpm run verify:changed`
- `pnpm run test:smoke:pipeline`
- `pnpm run dev`

### App-level (optional when scoping work)

- `pnpm --filter @holoim/capture run doctor`
- `pnpm --filter @holoim/capture run verify:fast`
- `pnpm --filter @holoim/capture run verify:full`
- `pnpm --filter @holoim/capture run verify:changed`
- `pnpm --filter @holoim/contracts run verify:fast`
- `pnpm --filter @holoim/api run verify:fast`
- `pnpm --filter @holoim/web run verify:fast`

## Pre-Handoff Check Policy

- Minimum for scoped changes: run `verify:fast` in each touched app/package.
- Required for high-risk or shared-contract changes: run `pnpm run verify:workspace`.
- If GLTF export/import contract is touched, run:
  1. `pnpm run verify:repo:capture`
  2. `pnpm run verify:repo:viewer`
  3. `pnpm run test:smoke:pipeline`

## Port Policy

Primary ports:

- Viewer API: `3001`
- Viewer web: `3174`
- Capture dev: `5173`
- Capture mock VR: `5174`

Rules:

- Viewer web E2E and smoke tests assume `http://127.0.0.1:3174`.
- Capture XR checks prefer `http://127.0.0.1:5174`.
- When a required port is occupied, scripts should fail fast with a clear message.

## Test Environment Contract

Supported env vars for smoke and XR scripts:

- `DEV_HOST` (default `127.0.0.1`)
- `DEV_PORT` (default `5174` for capture checks)
- `BASE_URL` (default derived from host/port)
- `E2E_BASE_URL` (default `http://127.0.0.1:3174`)
- `REUSE_DEV_SERVER` (`1` to reuse existing server)
- `STARTUP_TIMEOUT_MS` (default `30000`)
- `XR_TEST_MODE` (`polyfill`, `shim`, or `off`; default `polyfill`)
- `XR_TEST_ARTIFACT_DIR` (optional output path)

## When-To-Run Matrix

| Task type | Required commands |
|---|---|
| Docs/config only | `pnpm run doctor` |
| Single-app code change | touched app/package `verify:fast` |
| Multi-app change | `pnpm run doctor` + `pnpm run verify:workspace` |
| API upload or GLTF contract change | `pnpm run verify:workspace` + `pnpm run test:smoke:pipeline` |
| Pre-merge confidence sweep | `pnpm run verify:full` |

## Git Conventions

- Treat this workspace as one monorepo for commits and branches.
- Keep branch names intent-scoped (`codex/*`, `feature/*`, `fix/*`, `chore/*`).
- Keep changes app-local unless a shared contract/tooling update is required.
