# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-028 — A take drops set geometry whose vertices are far apart, such as a large floor

- **Area:** `apps/capture/src/recording/SceneBubbleSampler.ts` (`triangleInsideBubble`)
- **Severity:** P2
- **Observed:** 2026-10-25, while building AR recording (`docs/features/archive/ar-recording.md`)
- **Evidence:** the bubble clip keeps a triangle only when two of its
  vertices lie within 6 m of a sample. `fixtures/scenes/pointing-targets.gltf`'s
  `PointingFloor` is a 14 m box with 12 vertices, so no triangle qualifies:
  `output/ci-marks/desktop.glb` and `controllers.glb` (performer takes, the
  same code as `main`) and the camera take `output/ci-ar-record/phone-a.glb`
  hold `TargetA` and `TargetB` but no floor. The capture view shows the floor
  under the author.
- **Expected:** set geometry the take stood on or near is kept whatever its
  tessellation (for example, a triangle is kept when it comes within the
  radius of a sample, not only its vertices).
- **Reproduction:** `pnpm --filter @holoim/capture run test:xr:marks`, then
  list the node names of `apps/capture/output/ci-marks/desktop.glb`: there is
  no `PointingFloor_RecordedBubble`.

## Entry template

```md
### B-### — Short symptom

- **Area:** app/package
- **Severity:** P0 | P1 | P2 | P3
- **Observed:** YYYY-MM-DD
- **Evidence:** link, error, or test name
- **Expected:** behavior
- **Reproduction:** minimal steps
- **Fix:** commit hash and validation (when closed)
```
