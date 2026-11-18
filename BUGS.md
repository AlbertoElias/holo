# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-068 — Desktop and phone object checks fail on `main` (outside `verify:pr`)

- **Area:** apps/capture (objects)
- **Severity:** P2
- **Observed:** 2026-11-18
- **Evidence:** `pnpm --filter @holoim/capture run test:xr:object` on `main`'s sources:
  desktop-object-bracket (walking into the resting prop moves it 0.014 m, needs 0.1),
  desktop-mouse-object (aim 10 px off centre; a still release lets go 0.076 m up and the prop
  rests at 0.094 m), phone-touch-object (ankle jumps 0.041 m on a still lift),
  desktop-floor-reach (ankles dip 0.022 m during the reach, an ankle trails 0.35 m),
  reach-trench (G starts no reach), fetch-desktop (the let-go prop rests at 0.092 m, on no
  surface). The suite is not in `test:xr`, so nothing gates it. On `bug/desktop-gait` the same
  set fails, plus the floor-reach step stopping 0.18 m from the grasp point (needs 0.20–0.30)
  and still releases 1–2 cm higher (bracket put-down 0.043 m, phone lift 0.041 m, limit 0.03),
  since the desktop arms now rest in the Idle's pose instead of the bind pose.
- **Expected:** every object check passes, and the suite runs in `verify:pr`.
- **Reproduction:** `cd apps/capture && OBJECT_ONLY=desktop,mouse,phone,reach,trench,fetchDesktop node --import tsx scripts/run-xr-checks.ts object`


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
