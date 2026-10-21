# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-018 — Entering AR stalls the main thread 10–16 s on software GL

- **Area:** apps/viewer-web (AR entry under the IWER emulator)
- **Severity:** P2 (residual Viewer AR flake: `enterMockAr`'s 10 s `waitForIwerSession`
  times out when the stall overlaps it)
- **Observed:** 2026-10-21 (`scripts/ci-emulate.sh` loops; likely CI run 39368121357)
- **Evidence:** a long-task observer shows one 10–16 s task in every 1-CPU run (≈1/120
  failures at 2 CPUs). CPU profiles: it was IWER `computeDepthSensing` → synchronous
  `readRenderTargetPixels` (17 s of 21 s); with depth sensing no longer requested under
  IWER the stall moves to `WebGLRenderer.forceContextLoss` when the feed card canvas is
  disposed on navigation to `/ar` (13.6 s), so it is a software-GL backlog flushed at
  the first synchronous GL call.
- **Partial fix:** request `depthSensing` only outside IWER (occlusion is already off
  there): 1-CPU session-start failures 5/90 → 0/60. Smaller viewports do not help
  (390×844 still 11–12 s; the feed's AR trigger is unclickable at 320×180).
- **Next:** trace the GPU process (chrome://tracing categories `gpu`, `viz`) during
  feed → AR navigation to find what queues the backlog (feed card render loop, shader
  compiles, IWER compositing).
- **Reproduction:** `CI_EMULATE_CPUS=0 scripts/ci-emulate.sh` loop of "AR places the model"
  with a `longtask` PerformanceObserver.

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
