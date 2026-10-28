# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

None.

### B-039 — The face XR check fails on `main`: IWER has no gaze device

- **Area:** `apps/capture/scripts/ci-face-playwright.ts` (eye-gaze sweep), IWER device setup
- **Severity:** P2 (it breaks `verify:pr`'s `test:xr:smoke`)
- **Observed:** 2026-10-28, while verifying `feature/object-resize`. The check fails the same way on `origin/main` (`69f0795382b9`), in a clean worktree.
- **Evidence:** `page.evaluate: TypeError: Cannot set properties of undefined (setting 'connected')` at `ci-face-playwright.ts:230`, because `window.IWER_DEVICE.gaze` is undefined. Every other check in `test:xr:smoke` passes.
- **Intermittent:** the same check passed in a later `test:xr:smoke` run of the same day (ports 5295/5296/3295), so the gaze device is sometimes there.
- **Expected:** the face check's eye-gaze sweep finds a gaze device, or it sets one up.
- **Reproduction:** `cd apps/capture && pnpm run test:xr:face`.

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
