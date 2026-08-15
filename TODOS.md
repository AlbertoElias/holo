# TODOS

## Test Infrastructure

### Expand contract coverage in high-risk runtime packages

**What:** Add contract-focused tests for capture orchestration, API upload/routes, and the `ui-dom`, `xr-ui-r3f`, and `xr-ui-three` packages.

**Why:** Autonomous refactors can currently remain green despite behavioral regressions in complex runtime paths and shared packages that have little or no direct test coverage.

**Context:** Capture has 33 source files but only three unit-test files. The shared `ui-dom`, `xr-ui-r3f`, and `xr-ui-three` packages currently use `--passWithNoTests`, while API CRUD and upload behavior relies primarily on one happy-path smoke flow. Start with public behavior and state-transition contracts rather than implementation details.

**Effort:** L
**Priority:** P2
**Depends on:** Canonical `verify:agent`, `verify:pr`, and `verify:nightly` gates so new tests run in the correct tier.

### Profile and restructure the exhaustive XR harness

**What:** Split the serial locomotion harness into named TypeScript scenario groups, then evaluate safe sharding or browser reuse.

**Why:** The exhaustive XR harness remains the dominant nightly cost at roughly one minute locally and has historically taken several minutes in CI; it is difficult to extend or diagnose as one large custom script.

**Context:** The harness deliberately creates fresh IWER pages and sessions to isolate pose baselines and runtime state. Preserve that isolation until stage timing and standardized failure artifacts can prove that reuse or parallelism does not reintroduce the races fixed in August 2026.

**Effort:** M
**Priority:** P3
**Depends on:** Stage timing, standardized diagnostics, and the canonical nightly gate.

## Workspace Hygiene

### ~~P2: Tighten capture tsconfig strict settings~~ (Done)
- Enabled `noUncheckedIndexedAccess: true` and `exactOptionalPropertyTypes: true` in `apps/capture/tsconfig.json`.
- Fixed all resulting type errors across XrSessionService.ts, HandFingerRetargeter.ts, GltfExportComposer.ts, AppOrchestrator.ts, LocomotionAnimator.ts, CameraController.ts, FrameCaptureStore.ts, GLTFAudioPlugin.ts, SceneBubbleSampler.ts, and exportWorker.ts.

### ~~P3: Add .npmrc with workspace hygiene settings~~ (Done)
- Created `.npmrc` with `strict-peer-dependencies=true`, `auto-install-peers=true`, `shamefully-hoist=false`.

### ~~P3: Add CI/CD pipeline~~ (Done)
- Consolidated CI into one event-aware workflow with a stable `CI Gate`, parallel PR checks, failure-only diagnostics, timings, and separate fast XR versus nightly exhaustive coverage.

### P4: Migrate capture tsconfig to extend shared chain
- **What:** When `tsgo` supports `baseUrl` and non-relative `extends` paths, migrate `apps/capture/tsconfig.json` to extend `@holoim/config-ts/web.json` instead of duplicating strict settings.
- **Why:** Eliminates the need to manually keep capture's tsconfig in sync with `tsconfig.base.json`.
- **Depends on:** tsgo feature support.
