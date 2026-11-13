# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

None.

### B-065 — A prop carried when AR starts hangs frozen in the air

- **Area:** `apps/capture` (`ObjectSystem`, `ObjectInteraction`; the AR spectator frame)
- **Severity:** P2 (a phone that carries a prop and taps Enter AR starts its take with the prop hovering at hand height, un-placeable)
- **Observed:** 2026-11-13, replay `reachStates` / `arEntryWhileCarrying` in `scripts/ci-object-playwright.mjs`
- **Evidence:** the prop is `held` by `right`, reach phase `carry`, at y 1.32 m before entry and y 1.311 m for the next 30 AR frames. `ObjectSystem` returns early on `frame.arSpectator`, so neither the hold nor the reach is ever updated or released (VR entry resets both).
- **Expected:** AR entry lets the hold go like VR entry does, and the prop falls to the floor.
- **Reproduction:** desktop or phone page, `G` to carry the prop, Enter AR; read `objects.items[0].heldBy` and `objects.reach.phase`.
- **Fix:** open.

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
