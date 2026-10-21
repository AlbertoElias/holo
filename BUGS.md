# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-017 — Viewer AR placement wait intermittently times out with no model position

- **Area:** apps/viewer-web (AR placement, `ARHologramModel` / `useArController`)
- **Severity:** P2 (CI flake in the only intermittent viewer check)
- **Observed:** 2026-10-19 (CI runs 39186342259, 39368121357, 39424935399, 39484635802 on four branches)
- **Evidence:** `e2e/hologram-feed.spec.ts` "AR places the model…" fails in `waitForPlacement`
  with `placement-wait-timeout`; the stuck state is always `placed`/`floor`/`plane-detected`,
  sequence 1, `position: null`, with 10 tracked planes.
- **Expected:** the model reports its own placement (with position) within the wait, as
  it does locally: `unplaced` → `searching` → `placed` (hit-test, seq 1) → `anchored`.
- **Status:** cause not yet confirmed. The stuck values match both the controller's
  plane-detected preview (`resolvePlacementPreviewStatus`) and the model's own plane
  placement, minus the position, and the model never advances to `anchored`/`locked`, so
  the model side stalls. Not reproduced locally (≈250 runs: serial, 4× CPU throttle,
  8-way contention, CI test order, 25× faster preview tick), which rules out the
  stale-closure preview overwrite as the common path. The spec now dumps the full
  placement-attribute timeline and AR console lines on timeout to pin the stalled step
  on the 2-vCPU runner.
- **Reproduction:** CI only so far (≈3% of e2e runs).

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
