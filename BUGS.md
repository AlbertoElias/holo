# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

None.

### B-041 — Avatar object checks release props just over the 3 cm limit on `unreal-cm`

- **Area:** `apps/capture` avatar-formats suite (`scripts/ci-avatar-formats-playwright.ts`, `test:xr:avatars`)
- **Severity:** P2 (local suite only; hosted CI does not run `avatars`, so it fails on `main` unnoticed)
- **Observed:** 2026-11-10 on `main` `623e4645f986`; first seen by the locomotion retarget session, which also saw `reoriented-axes` and `no-fingers` fail their object checks
- **Evidence:** 3 of 3 runs fail with identical numbers, `unreal-cm: object check failed`:
  `desktop-object-bracket` "the put-down object was let go 0.0322 m above the floor (limit 0.03 m)",
  plus "walking into the resting object moved it only -0.0001 m along the walk (expected at least 0.1 m)";
  `desktop-mouse-object` 0.0324 m; `phone-touch-object` 0.0306 m. The other object checks pass.
  Report and frames in `apps/capture/output/ci-avatars/unreal-cm/object/`.
- **Expected:** a still release puts the prop down within 3 cm of the surface on every fixture, and walking into it moves it.
- **Reproduction:** `XR_AVATAR_ONLY=unreal-cm pnpm --filter @holoim/capture run test:xr:avatars` (about 160 s). Not yet rerun for `reoriented-axes` and `no-fingers`. Suspect: the palm-derived grip offset (`OBJECT_ON`) sits 0.3–2 mm too high on centimetre-scaled rigs, or the limit is too tight; the failed walk-into suggests the prop was not at rest.

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
