# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use `TODOs.md` for planned work and `HANDOFF.md` for session context.

## Open

No verified open bugs.

## Closed

### B-001 — XR locomotion runner lacks an observable final result

- **Area:** `apps/capture` test tooling
- **Severity:** P2 — test confidence / developer workflow
- **Observed:** 2026-08-10
- **Evidence:** `pnpm run test:all` created the expected locomotion screenshots,
  but the enclosing command returned without the final pass/fail transcript or the
  subsequent viewer test output.
- **Expected:** The command exits with a clear pass/fail status after all capture
  and viewer test stages, and leaves no child server or browser process behind.
- **Reproduction:** Run `pnpm run test:all` on a desktop host where Playwright can
  launch Chromium.
- **Fix:** The runner now prints explicit final `PASS`/`FAIL` output, preserves a
  non-zero status on failure, timeout, or interruption, and terminates the dev-server
  and browser process group. The tooling integration suite proves a hung command is
  bounded and a descendant cannot survive a successful direct-child exit. `pnpm --filter @holoim/capture run
  test:xr:flows` passed with final cleanup output, and port 5174 was immediately
  available afterward.

### B-002 — Avatar fingertips do not meet during tracked pinch

- **Area:** `apps/capture` hand/finger retargeting
- **Severity:** P1 — core VR embodiment quality
- **Observed:** 2026-08-15
- **Evidence:** A physically coherent IWER source pinch reduced thumb/index distance
  from 9.01 cm to 1.30 cm, while the avatar initially retained a 5.52 cm gap.
- **Expected:** The avatar preserves the tracked hand's relative pinch closure and
  reaches fingertip contact on both hands.
- **Reproduction:** Run `pnpm run test:xr:capture` with the pre-fix retargeter and
  coherent joint-position fixture.
- **Fix:** Current uncommitted working tree adds automatic open-hand reference
  learning plus calibrated fingertip contact correction. `pnpm run test:xr:capture`
  passes at 1.19 cm right / 0.90 cm left; capture `verify:fast` and `verify:full`
  also pass.

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
