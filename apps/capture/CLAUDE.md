# Capture App Context

## Overview

`apps/capture` is the WebXR runtime used to record avatar motion and export GLTF for the viewer pipeline.

## Workspace role

- Produces GLTF that is uploaded to `apps/viewer-api` and rendered by `apps/viewer-web`.
- Uses shared workspace contracts/tooling from `packages/*`.

## Stack

- TypeScript (strict)
- Three.js
- Rapier (`@dimforge/rapier3d-compat`)
- Vite
- Playwright + Vitest

## Commands

```bash
# from workspace root
pnpm --filter @holoim/capture dev
pnpm --filter @holoim/capture dev:mock-vr
pnpm --filter @holoim/capture lint
pnpm --filter @holoim/capture typecheck
pnpm --filter @holoim/capture test:unit
pnpm --filter @holoim/capture test:vr:mock
pnpm --filter @holoim/capture test:vr:flows
pnpm --filter @holoim/capture verify:fast
pnpm --filter @holoim/capture verify:full
```

## Structure

- `src/app` - app composition/root orchestration
- `src/xr` - XR session/input/hand tracking services
- `src/recording` - frame capture and GLTF export pipeline
- `src/physics` - locomotion and character controller
- `src/animation` - animation state/mixing
- `src/ui` - HUD and runtime controls
- `scripts` - XR checks and script runners

## Integration expectations

- Exported GLTF must remain compatible with viewer upload/render flow.
- If export format changes, run workspace smoke: `pnpm run test:smoke:pipeline`.
- Keep debug hooks used by automation stable unless intentionally versioned.
