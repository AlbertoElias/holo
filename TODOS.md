# TODOS

## Workspace Hygiene

### ~~P2: Tighten capture tsconfig strict settings~~ (Done)
- Enabled `noUncheckedIndexedAccess: true` and `exactOptionalPropertyTypes: true` in `apps/capture/tsconfig.json`.
- Fixed all resulting type errors across XrSessionService.ts, HandFingerRetargeter.ts, GltfExportComposer.ts, AppOrchestrator.ts, LocomotionAnimator.ts, CameraController.ts, FrameCaptureStore.ts, GLTFAudioPlugin.ts, SceneBubbleSampler.ts, and exportWorker.ts.

### ~~P3: Add .npmrc with workspace hygiene settings~~ (Done)
- Created `.npmrc` with `strict-peer-dependencies=true`, `auto-install-peers=true`, `shamefully-hoist=false`.

### ~~P3: Add CI/CD pipeline~~ (Done)
- Created `.github/workflows/ci.yml` with 4-job DAG: verify-fast (lint + typecheck) -> test + build (parallel) -> smoke.

### P4: Migrate capture tsconfig to extend shared chain
- **What:** When `tsgo` supports `baseUrl` and non-relative `extends` paths, migrate `apps/capture/tsconfig.json` to extend `@holoim/config-ts/web.json` instead of duplicating strict settings.
- **Why:** Eliminates the need to manually keep capture's tsconfig in sync with `tsconfig.base.json`.
- **Depends on:** tsgo feature support.
