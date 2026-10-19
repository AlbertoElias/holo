# Feature brief: Refit XR height and inspectable visual evidence

**Lead:** Codex height owner
**Status:** Complete

## User outcome

Switch sitting/standing without leaving VR using an explicit Refit height action,
and inspect real rendered avatar comparisons rather than UI-only screenshots.

## Scope and acceptance

- [x] Refit height in the VR floating panel and capture overlay starts a new stable
  0.5 second fit; current avatar size/camera mapping remains until a valid fit.
- [x] Crouching alone never resizes. Missing tracking interrupts pending fit;
  successful refit resets the crouch baseline to the new neutral posture.
- [x] Recording startup, recording, and export reject refit to preserve GLB size.
- [x] Sitting→standing→sitting E2E verifies new fit, base/hand alignment and UI.
- [x] Full-body rendered screenshots show actual avatar, floor, metric grid,
  tracked-eye/rig-eye markers, and measured height labels at consistent scale.
- [x] Existing XR and export pipeline regression gate passes.

## Failure cases and design review

Refitting while recording corrupts static export scale: disabled UI plus handler
guard. Resetting size to baseline while waiting creates a jump: retain previous
scale and floor mapping. Animation-derived eye height biases a crouched refit:
reuse neutral bind eye metric. Body/camera double scale: unchanged asset-only
boundary. Existing floating recording panel used floor-local offsets despite
floor-mapped camera: position both actions relative to actual headset local pose.
Visual artifacts previously undrawn: explicitly render a full-body diagnostic view
of actual scene/avatar with fixed orthographic meter framing and markers.

## Ownership

Lead/implementer owns capture UI, calibration request, debug evidence rendering,
height E2E, brief/index. Scoped design reviewer and independent verifier are
read-only. No animator/motor or shared UI package changes.

Review changes: retain committed eyeHeight separately from refit sampling;
disable repeated refits and initial auto-fit requests; interrupt pending samples at
record startup; seed neutral crouch baseline and clear smoothing on accepted refit.
Independent review found controller action ambiguity: select handlers now capture
only the triggering controller, and the E2E points the opposite controller at
Record while selecting Refit to prevent cross-controller actions.

## Verification and evidence

Passed `pnpm run verify:agent`, capture `verify:fast`, and the full `verify:pr`
gate on a fresh port range (5474/3474/3301/5475). The first full run hit an
occupied viewer port; a complete rerun passed. Final capture XR wrapper 75.7s,
height/refit 35.3s; capture→upload→viewer pipeline 1/1 in 28.5s; viewer AR 2/2
in 21.5s. Existing 244-frame XRHand replay remains at zero wrist p95 error,
1.00 pinch agreement and worst jerk 1.18x.

The real IWER right trigger selected Refit while the left ray pointed at Record;
the action refitted rather than starting recording. DOM action, interrupted
sampling, startup recording rejection and GLB scale retention also passed.

High-resolution visual mode passed separately in 108.3s (111.5s wrapper):

```sh
DEV_PORT=5274 XR_HEIGHT_VISUALS=1 XR_CHECK_TIMEOUT_MS=180000 pnpm --filter @holoim/capture run test:xr:height
DEV_PORT=5474 E2E_BASE_URL=https://localhost:3474 E2E_API_PORT=3301 E2E_CAPTURE_URL=https://127.0.0.1:5475 XR_CHECK_TIMEOUT_MS=180000 pnpm run verify:pr
```

`XR_HEIGHT_VISUALS=1` opens a fixed 1000×1056 XR context. Resizing an active XR
context produced miniature images and was removed; default CI uses 320×180 and
skips diagnostic draws. Both modes exercise the same real input/refit workflow.

Committed evidence:

- [Three-height comparison](evidence/xr-height-refit/height-comparison.png)
- [Same-session seated→standing→seated sequence](evidence/xr-height-refit/refit-sequence.png)
- [Measured refit states and PNG checksums](evidence/xr-height-refit/results.json)
- Full-size individual PNGs live beside these comparisons.

These are direct renders of the live avatar, not generated mockups. The scene
floor is replaced only for diagnostics by a grid at the actual avatar base; the
avatar, bone pose and tracked/animated eye markers use live app transforms. A
fixed orthographic camera makes size comparable. Final full-resolution images
were visually verified by the lead; independent review identified and verified
the controller-source fix and inspected the earlier full-body renders.

Physical headset feel/interaction remains unverified. Refit deliberately adopts
the current neutral eye height; it does not estimate standing stature or add a
seated animation. In the last sequence image the simulator controllers remain
high in floor space from the preceding standing selection, so the arms point up;
that pose is preserved rather than staged for the screenshot.

## Integration with locomotion

Integrated separately after locomotion main `3310ff4d3925`. The resolved frame
order restores terrain and crouch offsets before calibration, preserves additive
parent-local crouch translations, then applies terrain before camera and tracked
hands. Both AR recenter and VR refit controls remain available in their modes.
The height harness uses a local browser interface, preserving main's unified
TypeScript 7 source/script check without conflicting global Window declarations.
Independent resolved-source review and `verify:agent` passed.

The complete `verify:pr` passed on the combined tree: both capture pipelines
(including real microphone/audio, upload-time USDZ and fidelity challenges), all
five capture XR suites, and all five viewer tests. Height completed in 41.0s;
locomotion 14.2s, terrain 11.7s, hands 20.9s, mock VR 9.3s. The measured short,
tall and seated calibration/refit/lifecycle states are retained in
[evidence/xr-height-refit/integration-height-report.json](evidence/xr-height-refit/integration-height-report.json).
The recording case exported a real GLB and checked calibrated asset scale across
XR exit and export. These results remain emulation evidence; the physical-device
limits above still apply.
