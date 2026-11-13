# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-066 — A held mode that ends early keeps swallowing its hand's selects

- **Area:** `apps/capture/src/xr/HeadsetHolds.ts` (`ownsSelect`, the mark's `swallow`), `packages/xr-ui-core/src/heldMode.ts`
- **Severity:** P2 (the holding hand's ray stops pressing the world panel, Find panel and dock after a take stops or the hand leaves the view: with hands, until the next mark; with a controller, the first click after it comes back)
- **Observed:** 2026-11-13 by the held-modes replay (queue item 8 in `TODOS.md`)
- **Evidence:** `pnpm --filter @holoim/capture run test:xr:held-states` (`output/ci-held-states/report.json`): `pinch-take-stopped`, `pinch-hand-lost` and `trigger-controller-lost` failed with 0 commits on the left-hand Refit press (1 expected); the controls (`control-no-hold`, `hands-control-no-hold`, `trigger-take-stopped`) passed, and with the fix all six pass.
- **Expected:** once a mode has ended early, its source's next select reaches chrome as usual.
- **Reproduction:** with IWER, start a take and hold the mark on the left hand (thumb–middle pinch), then (a) stop the take, or (b) take the hand out of view, and open the pinch; or with a controller hold the left trigger and drop and restore the controller. Aim the left ray at "Refit height" and select: nothing happens. The mark is idle but `swallow` still names the source (`left:thumbMiddle`, `left:trigger`), and only a release of that source clears it: a pinch's release is fed to the mark only while it is held, and a controller that went away sends no `selectend`.
- **Fix:** `releaseSpentSwallow` feeds the swallowed source's release once the source is no longer down (pinch open, trigger up, controller gone, session reset). Replay `held-states` is in `test:xr`.
- **Not reproduced:** a hold that never ends or two holds that overlap (the mark blurs when the take stops, `reset` blurs both modes and clears queued trigger events), a stale mode read after a late step (the Halo summon cancels on session end and a handedness change), the phone's touch hold (`onXrEntered` resets it; a second finger or cancel is a trackingLost), and the desktop point holds (ends on blur, hidden tab and lost pointer lock: B-065's replay).

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
