# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-040 — The e2e shard check once listed two VR tests at other line numbers

- **Area:** `scripts/check-e2e-shards.mjs` (CI "Quality, unit tests and build")
- **Severity:** P2 (blocks deploy when it fires)
- **Observed:** 2026-11-10, CI run 42755796134 on `57d72f0`
- **Evidence:** the full mocked suite listed `xr-viewer.spec.ts:1574` and
  `:1690` ("VR locomotion", "VR recenter after moving"), while
  `test:e2e:xr-viewer-vr:shard2` listed the same titles at `:1831` and `:1964`.
  At that commit the file has them at 1574 and 1690, so the shard's listing
  reported other lines.
- **Expected:** every listing reports source lines, and the check passes.
- **Reproduction:** not yet. It passes locally and 3 of 3 times in
  `scripts/ci-emulate.sh` from a cold cache. Suspect: the check lists every
  shard at once (`Promise.all`), so Playwright's shared transform cache may
  race on a cold runner.

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
