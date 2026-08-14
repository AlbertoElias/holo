# Project Handoff

**Updated:** 2026-08-14  
**Baseline:** `3f03c4dd2feb` — `Stabilize XR locomotion jump check`  
**Working tree when updated:** clean before this documentation change

## What the project does

HoloIM is a TypeScript/pnpm monorepo for recording an avatar performance in WebXR,
exporting GLTF, uploading it, and viewing it in a 3D feed or AR.

| Surface | Current capability |
| --- | --- |
| `apps/capture` | WebXR avatar locomotion, VR embodiment/hand tracking, recording, GLTF export with a local scene bubble |
| `apps/viewer-api` | GLB upload, metadata/list/detail/delete endpoints, local static uploads, on-demand USDZ conversion |
| `apps/viewer-web` | Upload UI, hologram feed and preview, AR session/placement/recenter, iOS Quick Look link |

## Last completed work

The most recent commits focused on XR runtime stability rather than new product
scope: UI/runtime modularization, hardened VR CI screenshots, and a locomotion
jump check. See `git log --oneline -10` for the authoritative history and
`apps/capture/progress.md` for older capture-specific investigation notes.

## Validation snapshot

- `pnpm run doctor` — passed
- `pnpm run verify:workspace` — passed (lint, type checks, capture unit tests)
- Capture mock-VR browser check — passed on an unrestricted desktop host
- Full browser-XR completion transcript — still needs follow-up; see B-001 in
  `BUGS.md`

## Known constraints

- Browser-driven XR tests require a host that lets Playwright Chromium launch;
  sandboxed macOS sessions can fail before application assertions run.
- IWER provides deterministic simulated XR coverage. Physical headset validation is
  still required for real-device AR placement, controller/hand tracking, and
  VR enter/exit quality.
- The API is currently a local-development implementation: SQLite + filesystem
  uploads, no user authentication or cloud storage.

## Recommended next action

Investigate B-001 first: run the XR suites on an unrestricted local desktop, confirm
whether the runner actually leaks/terminates early, then make the runner report a
single explicit final result. Follow with physical-headset validation of VR
embodiment and AR placement.

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
