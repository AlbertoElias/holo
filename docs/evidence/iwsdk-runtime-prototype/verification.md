# Independent verification: IWSDK runtime prototype

Verified the working tree on branch `infra/iwsdk-prototype`, based on
`70e56826faa9`, on October 18, 2026 (America/New_York). The verifier changed
only verification artifacts and did not implement runtime fixes.

## Acceptance criteria

| Criterion from brief | Result | Evidence |
| --- | --- | --- |
| Default capture runs without selecting prototype | PASS | Independent default capture mock/locomotion/hand suites; reviewed native E2E default-entry assertions |
| One World/renderer/animation loop; XR enter/exit | PASS | Source has one World.create and externalFrameLoop suppresses custom loop; native E2E evidence includes enter/exit/re-entry and one application canvas |
| Desktop movement, hand replay, recording | PASS | Native E2E real character displacement and recorded frame increments; independent 244-frame XRHand replay and full recording pipeline |
| Native tools find state, pause/step, diff | PASS, in-page dispatch scope | Reviewed real SDK runtime dispatch test and evidence; paused snapshot stable, single step advances one simulation and recording frame, diff finds CaptureState change |
| Recorded GLB loads animated and passes viewer pipeline | PASS | Independent real export/upload/render pipeline and independent USDZ readback |
| Repeatable commands, JSON/screenshots, limits | PASS | Commands/artifacts below and native evidence.json; explicit physical-device and transport limits |

**Lead follow-up:** the native prototype E2E was rerun after the audio-listener
fix and independent browser suites. It exited 0, produced `result: pass`, no
browser errors, and fresh JSON/screenshots/GLB artifacts. The native runtime JSON
and successful hand metrics are preserved beside this report as
`native-runtime.json` and `hand-replay.json`.

## Scope and evidence provenance

Source review covered prototype bootstrap, native CaptureSystem, orchestrator
injection seams, default createApp behavior, SDK lifecycle/debug dispatch,
deterministic replay, and capture-to-viewer pipeline configuration. Existing
end-to-end workflows were exercised against the prototype, with isolated ports.

The lead's native prototype E2E evidence was independently inspected, rather
than repeated without a source change. It calls the real SDK in-page
`FRAMEWORK_MCP_RUNTIME.dispatch`; outer MCP transport/editor integration is
not established by that test.

## Hand replay: PASS

Command from worktree root:

```bash
DEV_PORT=5474 BASE_URL=https://127.0.0.1:5474/iwsdk-prototype.html \
  XR_TEST_MODE=iwer XR_CAPTURE_SUCCESS_SCREENSHOTS=1 \
  XR_TEST_ARTIFACT_DIR=output/iwsdk-prototype/hand-replay \
  pnpm --filter @holoim/capture run test:xr:hands
```

Final run exited 0 after 59.8 seconds, with no browser-error failure. The
existing thresholds were unchanged. Both hands used XRHand input for all
244 frames of the 8.137-second fixture; no controller or mock fallback occurred.

| Metric | Left | Right |
| --- | ---: | ---: |
| XRHand coverage | 100% | 100% |
| Largest mean finger curl error | 8.564 degrees (thumb) | 8.584 degrees (thumb) |
| Lowest curl correlation | 0.97572 | 0.97616 |
| Curl lag, all fingers | 0 frames | 0 frames |
| Pinch agreement | 0.99590 | 0.99590 |
| Pinch contact frames | 57 | 57 |
| Wrist position p95 | 5.75e-8 m | 6.37e-8 m |
| Wrist orientation p95 | 6.47e-6 degrees | 9.24e-6 degrees |
| Worst segment jerk ratio | 1.1758 | 1.1768 |

Local artifacts under `apps/capture/output/iwsdk-prototype/`:

- `hand-replay/iwer-poses-relaxed-point-pinch-report.json`
- `hand-replay/iwer-poses-relaxed-point-pinch-samples.json`
- `hand-replay/iwer-poses-relaxed-point-pinch-final.png`

The final screenshot was visually inspected: prototype label, loaded VR state,
rendered avatar/hands, and IWER UI are present. Hand replay does not grant
microphone permission; audio compatibility is exercised separately by pipeline.

## Reproduced defect and fix verification

The initial replay failed with 0% XRHand coverage and SDK AudioListener
`linearRampToValueAtTime` receiving a negative time after the existing test
installed its frozen performance clock. SDK InputSystem traversed the listener
before capture could update. The lead removed the unused SDK spatial playback
system and listener from the prototype; microphone MediaRecorder remains the
capture audio owner. The identical replay then passed, as above.

Initial failure report and samples are retained under
`hand-replay-initial-failure/`. No private SDK clock patch or shared replay
threshold change was used.

## Capture to viewer pipeline: PASS

Command from worktree root:

```bash
E2E_BASE_URL=https://localhost:3674 E2E_API_PORT=3501 \
  E2E_CAPTURE_URL=https://127.0.0.1:5675/iwsdk-prototype.html \
  USDZ_PYTHON=/private/tmp/holoim-quicklook-python/bin/python \
  E2E_SCREENSHOTS=1 pnpm run test:smoke:pipeline
```

One test passed, test duration 58.8 seconds, total command approximately 1.2
minutes. This exercised real synthetic-microphone MediaRecorder bytes, animated
skinned GLB export, recorded scene bubble, upload returning 201 with matching
stored size, animated feed rendering, and byte-identical cached USDZ responses.
Independent OpenUSD readback passed for geometry, materials, transforms, and
audio. All six source-derived conversion challenges passed.

Persistent artifacts: worktree-root
`output/quicklook/pipeline-1792373610372/`, including `capture-export.glb`,
`capture-quicklook.usdz`, `quicklook-validation.json`,
`source-derived-challenges/exercise-summary.json`,
`capture-recording-in-progress.png`, and
`uploaded-capture-rendered-in-feed.png`. These survive subsequent viewer suites
clearing their temporary test-results directory.

The viewer screenshot was visually inspected. It shows the recorded portal and
scene loaded, with the avatar partly occluded by recorded environment geometry;
this establishes compatibility rather than ideal portal framing. The USD
inspector warns that source audio lasts 2.460 seconds while simulated animation
lasts 1.483 seconds; the conversion preserves this source mismatch. This is not
evidence of synchronized real-time audio/animation recording.

An initial pipeline attempt on ports 3474/3301/5475 stopped during preflight
because viewer port 3474 was reported busy. No app assertions ran in that
attempt; the successful run used the isolated ports above.

## Default capture and viewer regression: PASS

```bash
DEV_PORT=5574 E2E_BASE_URL=https://localhost:3874 E2E_API_PORT=3701 \
  XR_TEST_MODE=iwer XR_CAPTURE_SUCCESS_SCREENSHOTS=1 \
  XR_TEST_ARTIFACT_DIR=output/iwsdk-prototype/default-entry-xr \
  pnpm run verify:xr
```

The runner selected available capture port 5575 because 5574 was occupied;
BASE_URL was unset, so this exercised the ordinary `/` entry.

- Capture mock VR passed (8.8 seconds), including pinch agreement measurements.
- Capture locomotion passed (14.1 seconds), including directional movement at
  four view yaws, jump/landing, crouch, crouch speed, desktop keyboard behavior,
  and desktop crouch/walk.
- Capture hand replay passed (25.4 seconds), with both hands 100% XRHand coverage
  over all 244 fixture frames. Capture combined duration was 50.4 seconds.
- Viewer passed both AR tests (24.8 seconds total): surface placement,
  recenter/exit, and placement fallback without hit-test.

Capture JSON, samples, and screenshots are under `default-entry-xr/` in this
directory. The XR runner confirmed its child server and browser cleanup;
the viewer command exited 0. `git diff --check` also exited 0.

## Limits

- This adapter retains AppOrchestrator, Rapier locomotion, custom retargeting,
  IK, recording, and export. It demonstrates lifecycle and observability
  feasibility; it does not establish reduced architecture complexity yet.
- Legacy `advanceTime` intentionally bypasses ECS. Native ECS and legacy manual
  stepping are separate control modes and must not be mixed.
- Legacy manual clock's draw=false flag does not suppress World's render after
  ECS update. Prototype replay therefore retains rendering work on released
  frames, unlike the custom entry's optimized simulation-only path.
- The prototype is a Vite development entry, not a production build entry.
- AR spectator/recenter and optional hand-replay spectator video are excluded.
- All XR evidence is IWER emulation. Physical Quest performance, tracking feel,
  comfort, device lifecycle, and completed height/locomotion integration remain
  unmeasured.
- Sandboxed Chromium failed macOS Mach port startup before exercising the app;
  browser verification used an approved unsandboxed run.
