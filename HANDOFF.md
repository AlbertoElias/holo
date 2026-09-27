# Project Handoff

**Updated:** 2026-09-27
**Baseline:** `6738d0e3ceb1` — `docs: establish holographic communication knowledge system`
**Working tree when updated:** uncommitted capture pinch-retarget and IWSDK 0.5.3
work plus the development-reliability changes described below; local viewer API
database files are preserved on disk but removed from Git tracking

## What the project does

HoloIM is a TypeScript/pnpm monorepo for recording an avatar performance in WebXR,
exporting GLTF, uploading it, and viewing it in a 3D feed or AR.

| Surface | Current capability |
| --- | --- |
| `apps/capture` | WebXR avatar locomotion, VR embodiment/hand tracking, recording, GLTF export with a local scene bubble |
| `apps/viewer-api` | GLB upload, metadata/list/detail/delete endpoints, local static uploads, on-demand USDZ conversion |
| `apps/viewer-web` | Upload UI, hologram feed and preview, AR session/placement/recenter, iOS Quick Look link |

## Last completed work

The repository now has a feature delivery contract in `docs/FEATURE_WORKFLOW.md`,
a feature brief template, and a PR evidence checklist. Consequential changes assign
separate lead, design review, implementation, and independent verification roles
with exclusive file ownership. PR CI now runs one fast quality job and one parallel
build/pipeline-smoke job; browser-heavy XR and live integration run in separate
scheduled/manual jobs with retained artifacts.

B-001 is closed. The shared command runner manages complete POSIX process groups,
waits through TERM/KILL cleanup, and rejects timed-out, interrupted, or failed
children. The XR locomotion wrapper prints an explicit final PASS/FAIL result and
bounds a flow at three minutes. Integration coverage proves a hung command is stopped
and a long-lived descendant cannot survive a successful direct-parent exit.

Viewer API route tests now exercise upload/static serving, cursor pagination,
GLB/USDZ deletion, and conversion failure against an isolated temporary database
and uploads directory. API and viewer `verify:fast` commands include inexpensive
Vitest suites, and the workspace fast gate includes shared process tooling tests.
Generated development SQLite files are no longer versioned; `prisma:setup` recreates
local state from committed migrations, while tests own temporary fixtures.

The current working tree fixes unrealistic tracked-hand pinching. The mock hand
fixture now produces coherent joint positions, the retargeter automatically learns
an open-hand pinch reference, and a calibrated contact solver preserves the tracked
thumb/index gap on the avatar. The IWER regression now requires bilateral fingertip
contact instead of accepting a loose 9 cm gap. See `git log --oneline -10` for the
authoritative committed history and `apps/capture/progress.md` for older
capture-specific investigation notes.

The workspace now uses `@iwsdk/vite-plugin-dev` and `@iwsdk/cli` 0.5.3 with
IWER 2.3. Capture supports managed collaborate/headless agent sessions, project-
scoped MCP runtime control (Codex and Claude Code), screenshots, console inspection, and XR session
control. HoloIM remains on its custom Three/Rapier runtime; native IWSDK ECS and
scene editing are intentionally not exposed. See `docs/IWSDK_AI_WORKFLOW.md`.

## Validation snapshot

- `pnpm run verify:fast` — passed: tooling 4 tests, capture 11 tests, viewer API
  10 tests, and viewer web 38 tests plus lint/type checks
- `pnpm run test:all` — passed through capture XR flows and subsequent viewer tests;
  the locomotion runner printed its final PASS and released port 5174
- `pnpm run verify:xr` — passed on an unrestricted desktop host: capture mock XR
  and all 5 viewer IWER/SEM AR cases; source
  pinch 1.30 cm, avatar right 1.19 cm, avatar left 0.90 cm
- `pnpm run build:all` — passed; capture scene optimization reduced `scene.glb`
  from 493.4 KB to 206.2 KB
- `pnpm run test:smoke:pipeline` — passed export, upload, fetch, and cleanup
- `pnpm --filter @holoim/api run prisma:setup` — passed with all three committed
  migrations applied/current
- Shared process-helper integration tests — passed success, non-zero propagation,
  timeout cleanup, and descendant cleanup cases
- CI workflow YAML parsing and `git diff --check` — passed
- IWSDK managed agent runtime — passed: browser connected and command-ready,
  Quest 3 emulation detected, immersive VR session entered, and a 640 x 640
  runtime screenshot captured

## Known constraints

- Browser-driven XR tests require a host that lets Playwright Chromium launch;
  sandboxed macOS sessions can fail before application assertions run.
- IWER provides deterministic simulated XR coverage. Physical headset validation is
  still required for real-device AR placement, controller/hand tracking, and
  VR enter/exit quality.
- The API is currently a local-development implementation: SQLite + filesystem
  uploads, no user authentication or cloud storage.

## Recommended next action

Start a new agent session so it loads the project MCP config (`.codex/config.toml`
or `.mcp.json`), then use `pnpm run dev:capture:ai` for the next capture iteration. Validate the new pinch
contact behavior on a physical headset, including slow pinch/release transitions
and both hands, then perform real-device AR placement validation. Start subsequent
product behavior changes from `docs/templates/FEATURE_BRIEF.md` and give an
independent verifier the original acceptance criteria.

Product exploration now has a separate, non-implementation home in
[`docs/product/README.md`](docs/product/README.md). Start new holographic
communication ideas in its registry; promote a single bounded user outcome into
a PRD only after product exploration.

## How to resume

1. Read this file, then `BUGS.md` and `TODOs.md`.
2. Check `git status --short` and `git log --oneline -10` before assuming the
   baseline above is current.
3. Use the command policy in `AGENT_CONTRACT.md`; start with an app-scoped check.
4. Refresh this handoff and the appropriate tracker before ending the session.
