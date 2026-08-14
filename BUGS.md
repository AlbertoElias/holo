# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use `TODOs.md` for planned work and `HANDOFF.md` for session context.

## Open

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
- **Likely starting point:** `apps/capture/scripts/run-vr-locomotion-check.mjs` and
  `packages/tooling-testing/src/dev-server.mjs`.

## Closed

No entries yet. Move resolved entries here with the fixing commit hash and the
validation that proved the fix.

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
