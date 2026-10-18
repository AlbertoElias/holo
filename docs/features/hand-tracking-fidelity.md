# Feature brief: Hand-tracking fidelity from real headset input

**Lead:** Claude Code
**Status:** Verifying

## User outcome

The avatar's hands move like the user's tracked hands, and CI proves it with
input recorded on a real headset rather than synthetic poses. Reviewers can
watch the avatar replay that input and inspect per-check screenshots.

## Scope

**Included:**
- A development-only recorder in capture that saves raw headset input (head,
  hands, controllers) with each capture recording, in IWER's replayable
  `ActionRecorder` format.
- Deterministic replay of a recording through the app's real WebXR input path
  (XRHand joints → retargeter → avatar bones), not the mock-pose shortcut.
- Fidelity metrics comparing tracked hands with avatar hands per frame, and
  CI thresholds on them.
- A replay video and per-check screenshots as inspectable artifacts.
- Viewer AR checks that assert where the model is placed, not only status
  strings, and run faster.

**Excluded:** changing the retargeting algorithm unless a metric exposes a
defect (that becomes a bug entry first); controller-only animation; physical
headset validation of feel and comfort.

## Acceptance criteria

- [ ] On a headset, starting and stopping a capture recording also saves the
  raw input to `apps/capture/fixtures/input-recordings/` through the dev server.
- [ ] Replaying a recording in IWER drives the avatar through real XRHand
  joints, deterministically (identical metrics run to run).
- [ ] CI fails when avatar finger curl, pinch contact, wrist pose, smoothness,
  or latency diverge from the tracked hands beyond stated thresholds.
- [ ] A replay video shows the avatar beside the tracked-hand source, and every
  check writes a screenshot artifact.
- [ ] Viewer AR checks assert the placed model lies on a detected plane in front
  of the viewer, and the suite is faster on CI than 60 s.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Retargeter reads mock state, so tests never exercise XRHand input | Replay keeps `mockVr.enabled` false and asserts the source is `XRHand` |
| Avatar hand is a different size than the user's | Compare in wrist-local space normalized by hand length |
| Smoothing hides tracking but adds lag | Cross-correlate source and avatar curl; bound the lag |
| Retargeter adds jitter | Compare fingertip jerk of avatar against source |
| False pinches or missed pinches | Match pinch contact intervals both ways |
| Joint dropouts in real data | Recording keeps invalid frames; metrics skip them and count them |
| Recording files bloat the repo | Downsample to 30 Hz and cap length; report size |
| Replay depends on host speed | Step recorded frames and the app clock together, one frame at a time |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude Code | Brief, integration, handoff |
| Design reviewer | Claude Code (sequential; no separate agent requested) | Review before implementation |
| Implementer | Claude Code | `apps/capture` recorder, debug bridge, scripts; `apps/viewer-web` AR checks |
| Independent verifier | Claude Code (sequential) | Replay artifacts and CI runs |

## Design decision

Use IWER's `ActionRecorder`/`ActionPlayer` (already shipped with IWSDK 0.5)
rather than a custom format: the recorder only uses standard WebXR calls, so it
runs on a Quest, and the player replays into IWER with deterministic
`stepFrames`.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Recorder | emulated session against the dev server (same code path as a headset) | `fixtures/input-recordings/iwer-emulated-pinch.json`: 2 hands × 25 joints, 30 Hz; **headset recording still pending** |
| Deterministic replay through XRHand | `pnpm --filter @holoim/capture run test:xr:hands` | Identical metrics on macOS and the 2-vCPU container, with and without video; 100% of tracked frames from XRHand, none from mock input |
| Fidelity thresholds | same, on `iwer-poses-relaxed-point-pinch.json` | curl ≤ 15°, correlation ≥ 0.9, wrist ≤ 2 cm / 10°, segment jitter ≤ 1.5× (B-005 fixed) |
| Catches real regressions | reintroduce the B-004 camera parenting | Fails at 2,083 cm wrist error |
| Video and screenshots | `HAND_REPLAY_VIDEO=1 XR_CAPTURE_SUCCESS_SCREENSHOTS=1 pnpm run test:xr:capture`; `E2E_SCREENSHOTS=1` for viewer suites | `output/ci-hand-replay/<name>.mp4`, per-suite PNGs |
| Viewer AR placement | `pnpm run test:xr:viewer` | Model-reported position checked against the viewer pose; 2 sessions, 41 s on 2 vCPU (was 61 s) |
| Speed | 2-vCPU container | capture XR (mock-VR, locomotion, hands) 109 s before the draw-free replay change, hands alone 12 s locally after |

### Defects found by the new checks

- B-004 (fixed): VR hand targets landed ~21 m from the avatar because the XR
  camera was parented to the rig.
- B-005 (fixed 2026-10-17): finger curl offsets of 30–68° and a 7.5 cm / 49°
  wrist offset, from a shifted finger mapping, two scratch-vector aliasing bugs,
  and hand-tuned palm offsets. Now curl ≤ 8.4°, wrist 0 cm / 0°.
- B-006 (fixed): viewer AR never ran its placement; tests passed on a preview
  status, and the hit-test-disabled test never disabled hit-test.
- B-007 (fixed): viewer AR logged `GL_INVALID_OPERATION` every frame in IWER
  because three's depth-occlusion mesh drew with color writes on.

### Review

Codex (`codex exec`, read-only, 2026-10-17) confirmed the camera-rig fix and
the surface-normal math and raised three issues, all fixed: hand samples now
carry the true per-frame source (`xr-hand`, `controller`, `held`, `fallback`,
`mock`) and each finger needs enough XRHand samples; the reported AR position
refreshes when an anchor moves the model; and the AR check verifies the base
against an independent downward raycast through IWER's room model.

### Open question

Hit-test placement accepts any upward surface, so in IWER's office the
life-size hologram lands on a 1.3 m cabinet 0.86 m away. Floor-only placement
may suit life-size holograms better; that is a product decision.

## Physical-device limits

The recording comes from a real headset, but replay runs in IWER. The checks
prove the retargeting math against real tracked motion; they do not prove
rendering latency, comfort, or how the hands feel on device.
