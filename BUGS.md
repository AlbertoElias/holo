# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-017 — Viewer AR placement wait intermittently times out with no model position

- **Area:** apps/viewer-web (AR placement preview, `useArController`)
- **Severity:** P2 (CI flake in the only intermittent viewer check)
- **Observed:** 2026-10-19 (CI runs 39186342259, 39368121357, 39424935399, 39484635802 on four branches)
- **Evidence:** `e2e/hologram-feed.spec.ts` "AR places the model…" fails in `waitForPlacement`
  with `placement-wait-timeout`; the stuck state is always `placed`/`floor`/`plane-detected`,
  sequence 1, `position: null`, with 10 tracked planes.
- **Expected:** the model's own placement (with position) stays the reported status.
- **Cause (confirmed):** the controller's plane-detected preview interval in
  `useArController` read `placementStatus` from its effect closure and wrote with a
  plain `setPlacementStatus`. On the 2-CPU software-GL runner the model's placement
  commit took >200 ms, so a tick with the stale `searching` closure overwrote it.
  Timeline from `scripts/ci-emulate`-style Docker repro (2 CPUs):
  `17624ms placed|hit-test|hit-test-stable|1|-0.000,1.299,-0.860` then
  `17834ms placed|floor|plane-detected|1|` (no position); the anchored model never
  re-emits, so the position stays lost.
- **Reproduction:** `CI_EMULATE_CPUS=0 scripts/ci-emulate.sh` loop of the spec: 6/30 runs
  time out this way (≈1/80 at 2 CPUs); never on macOS hosts.
- **Fix:** the preview tick re-resolves inside a functional update, so it never replaces a
  status the model already reported. Same 1-CPU loop: 0/30; 2 CPUs: 0/150.

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
