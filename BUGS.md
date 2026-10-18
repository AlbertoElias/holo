# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-008 — On a headset, VR hand targets land ~21 m from the avatar (B-004 in device frame order)

- **Area:** `apps/capture` XR head pose (`XrSessionService`)
- **Severity:** P1 — VR hands broken on device; IWER checks pass
- **Observed:** 2026-10-18 while investigating room-scale body motion
- **Evidence:** IWER probe with the simulation ticked inside the XR frame (the
  headset's order): wrist error 21.0 m; the same session in the replay
  harness's manual-clock order: 0.0 m.
- **Cause:** during an XR frame three.js leaves `renderer.xr.getCamera()`
  holding the tracking-space left-eye pose until `render()` calls
  `updateCamera`; `updateHandTrackingTargets` and `getCurrentHeadLocalY` read
  it as world space. The manual clock runs `updateCamera` before each step,
  which hides it.
- **Expected:** head pose read from the XR views' tracking-space transforms
  and mapped through the rig, independent of render order.
- **Reproduction:** enter VR in IWER, freeze the page clock, call
  `__setManualClock(false)`, release frames, compare `__sampleHands()` wrists.
- **Fix:** pending — in progress under
  [`docs/features/room-scale-body-motion.md`](docs/features/room-scale-body-motion.md).

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
