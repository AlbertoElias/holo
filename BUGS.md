# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-023 — The live API rejects Pages preview origins

- **Area:** `holoim-api` CORS (`WEB_ORIGINS` secret, `apps/viewer-api/src/lib/cors.ts`)
- **Severity:** P3
- **Observed:** 2026-10-26, verifying the GLB probe fix on a Pages preview
- **Evidence:** `curl -H "Origin: https://bug-glb-probe-cache.holoim-viewer.pages.dev"
  "https://holoim-api.fly.dev/api/holograms?limit=1"` returns no
  `access-control-allow-origin`, so a preview's feed fails with a CORS
  error. `isAllowedWebOrigin` does match wildcards, so the secret most
  likely lacks the `https://*.holoim-viewer.pages.dev` entry that
  `docs/DEPLOYMENT.md` sets (not checked: secret values are not readable).
- **Expected:** previews at `*.holoim-viewer.pages.dev` load the live feed.
- **Reproduction:** the curl above; or open any preview deploy of the viewer.

### B-022 — Quick Look conversions fail while production's shared CPU is throttled

- **Area:** `apps/viewer-api` USDZ worker and `rebuild:usdz` (`glb_to_usdz.py`'s 100 s alarm, the converter's 120 s limit)
- **Severity:** P2
- **Observed:** 2026-10-25, during the production ql3 rebuild
- **Evidence:** after a few minutes of sustained conversion and inspection
  on `holoim-api` (shared-cpu-2x), the long take `cmvmig68e0000oejsj9pd83rz`
  converted past 100 s three times (12.6 s on a laptop) and its inspection
  ran past 900 s (75 s on a laptop): Fly's shared CPU drops to its baseline
  once the burst balance is spent. The record went to `failed`, so Quick
  Look returned 202 until a later request re-queued it on a recovered CPU.
- **Expected:** a conversion that fails only because the CPU is slow is
  retried later, not marked failed; or the limits follow the work.
- **Reproduction:** drain the burst balance (several conversions in a row,
  or the rebuild with both inspections), then request
  `/api/holograms/<id>/usdz` for a long take whose preview is not current.

### B-020 — Capture's height check is not repeatable

- **Area:** `apps/capture` XR checks (`test:xr:height`)
- **Severity:** P3
- **Observed:** 2026-10-24
- **Evidence:** two runs of `main` (`eebf013`) with
  `XR_CHECK_CONCURRENCY=2` give `output/ci-xr-height/height-report.json`
  positions up to 0.45 mm apart (`baseWorldY`, sensor and bone positions),
  found while comparing the slice 0 port in
  `docs/features/ui-redesign.md`. The check still passes.
- **Expected:** identical reports, as `AGENT_CONTRACT.md` says of the XR
  checks; `compare-xr-reports.ts` tolerates 1 mm in this file meanwhile.
- **Reproduction:** run `pnpm --filter @holoim/capture run test:xr:height`
  twice and compare the two output folders with
  `node --import tsx scripts/compare-xr-reports.ts`.

### B-021 — The AR bubble render check sometimes times out waiting for the card

- **Area:** `apps/viewer-web` e2e (`test:xr:viewer`)
- **Severity:** P3
- **Observed:** 2026-10-24
- **Evidence:** `e2e/ar-bubble.spec.ts:70` fails at
  `toHaveAttribute("data-model-state", "rendered")` after 5 s with
  `"ready"`: 1 of 12 repeats on `main` (`eebf013`) and 3 of 18 on the
  slice 0/1 branch of `docs/features/ui-redesign.md`, with other sessions
  loading the machine.
- **Expected:** the card renders within the wait every time, or the wait
  follows the work it waits on rather than a fixed 5 s.
- **Reproduction:** `VITE_IWER_SEM_SCENE=office_small XR_TEST_MODE=iwer npx
  playwright test e2e/ar-bubble.spec.ts:70 --workers=1 --repeat-each=6`
  from `apps/viewer-web`.

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
