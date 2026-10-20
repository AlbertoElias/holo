# IWSDK runtime prototype

This was an isolated experiment on `infra/iwsdk-prototype`, not a production
migration. The production refactor is
[the IWSDK runtime refactor brief](features/archive/iwsdk-runtime-refactor.md); it
ported the prototype's useful seams onto current main and replaced the
compatibility wrapper this page describes. The prototype branch and its
`iwsdk-prototype.html` entry were not merged. The rest of this page is the
October 18 prototype snapshot.

## Run

From the worktree root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @holoim/capture run dev:prototype
```

Open `https://127.0.0.1:5474/iwsdk-prototype.html`. The regular `/` entry still
uses the custom runtime. The prototype's page uses IWSDK 1.0.1 and the same
avatar/scene assets and recording UI as capture. It supports desktop and VR;
production capture's AR spectator/recenter flow is outside this spike.

## Boundaries

- IWSDK owns the scene, renderer, player origin, XR lifecycle, and animation loop.
- A native `CaptureSystem` runs the retained capture algorithms. `CaptureState`
  exposes simulation time, step count, character position, grounding, and recording
  state through the SDK's native ECS query/snapshot/diff tools.
- Existing Rapier locomotion, retargeting, IK, animation and export remain intact.
  SDK locomotion, Havok, grabbing, spatial UI and DOM pointer forwarding are disabled
  to prevent two owners of the same behavior.
- SDK spatial-audio playback is unregistered and its unused listener is detached.
  Its internal wall clock otherwise produces negative AudioParam ramp times when
  deterministic replay rebases the browser clock. Capture's microphone recording
  and embedded GLB audio remain on the existing MediaRecorder path.
- The original SDK camera remains the tracking camera. A separate desktop camera
  is selected for rendering; both receive capture's resize handling.
- Native ECS pause/step controls the real capture tick and recording sampling.
  Legacy `__setManualClock` / `advanceTime` remain for existing replay checks;
  use one control mode at a time. Legacy stepping intentionally bypasses ECS.
- Capture's UI and IWSDK must resolve a single schema-capable UIKit version.
  The explicit dependency and Vite dedupe prevent the old transitive UIKit from
  being optimized under the newer package's module name.

This adapter is **not evidence of simpler architecture**: `AppOrchestrator` is
still a compatibility layer. For the production refactor, split product
systems around their transform ownership and remove replaced runtime code.

## Repeatable checks

Native runtime compatibility, actual recording timestamps, pause/step,
movement, GLB export, VR enter/exit/re-entry, and default-entry isolation:

```bash
pnpm --filter @holoim/capture run test:iwsdk:prototype
```

The script starts/stops its own server on 5474. Do not run another browser suite
on the same port concurrently. Artifacts are under
`apps/capture/output/iwsdk-prototype/`: `evidence.json`, `desktop.png`, `xr.png`,
and `prototype-recording.glb`. The test calls the SDK's real in-page framework
dispatch; it does not establish the outer MCP transport/editor experience.

Existing tracked-hand replay against the prototype:

```bash
cd apps/capture
DEV_PORT=5474 BASE_URL=https://127.0.0.1:5474/iwsdk-prototype.html \
  XR_TEST_ARTIFACT_DIR=output/iwsdk-prototype/hand-replay \
  pnpm run test:xr:hands
```

Full export/upload/render pipeline, from the worktree root:

```bash
E2E_BASE_URL=https://localhost:3674 E2E_API_PORT=3501 \
  E2E_CAPTURE_URL=https://127.0.0.1:5675/iwsdk-prototype.html \
  E2E_SCREENSHOTS=1 pnpm run test:smoke:pipeline
```

The pipeline also validates the current Quick Look converter. If USD Python is
not installed in this checkout, use an existing environment via `USDZ_PYTHON` as
documented in viewer-api. Do not treat a missing converter as an avatar result.

## Results (October 18, 2026)

The prototype native E2E, existing hand replay, full capture/upload/viewer/USDZ
pipeline, and default capture/viewer XR suites all passed. Workspace validation,
doctor, and the default capture production build passed. See the
[independent verification](evidence/iwsdk-runtime-prototype/verification.md),
[native runtime evidence](evidence/iwsdk-runtime-prototype/native-runtime.json),
and [unchanged-threshold hand report](evidence/iwsdk-runtime-prototype/hand-replay.json).

The synthetic IWER fixture supplied 244 frames per hand, 100% through XRHand,
with zero-frame curl lag and 99.59% pinch agreement. These are emulated input
results. The native test proves that pausing freezes recorded frames, and one
fixed step adds one recording sample exactly 1/60 second later.

This supports continuing the evaluation after the movement fixes. It does not
establish reduced maintenance cost or improved target-device performance yet.

## Decision after the locomotion fixes

Use the new main-based implementation worktree described in the feature brief
and compare:

1. Which input/session/debug/scene infrastructure can actually be deleted?
2. Can an agent diagnose and change avatar state through standard tools with
   fewer HoloIM-specific hooks? Repeat a concrete bug investigation through MCP.
3. Do current hand fixtures, height scenarios and export/playback still pass?
4. On the same physical Quest and workload, compare CPU/GPU frame time, latency,
   memory, startup/asset load, and thermal behavior against the custom runtime.

IWER compatibility and browser renderer statistics do not establish physical
performance, tracking quality, comfort, or completed height-adaptation integration.
