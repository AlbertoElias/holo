# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-008 — Mobile Upload button covers the hologram title

- **Area:** `apps/viewer-web` feed layout
- **Severity:** P2
- **Observed:** 2026-10-18
- **Evidence:** At a 390×844 viewport the collapsed Upload button sits on top of
  the card's title pill; only "By Albe…" and the time stay visible.
- **Expected:** The hologram name and author are fully readable on phones.
- **Reproduction:** `pnpm run dev:viewer`, upload any GLB, open
  `https://localhost:3174/` at 390×844.

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
