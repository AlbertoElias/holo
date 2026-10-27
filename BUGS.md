# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-025 — Portal "desktop freeze" check finds the feed back at the top

- **Area:** `apps/viewer-web/e2e/portal.spec.ts` ("desktop freeze: … scrolling away resets"), portal scroll capture
- **Severity:** P3
- **Observed:** 2026-10-26, on `main` at `ac700f0f`
- **Evidence:** `expect(await feedScrollTop(page)).toBeGreaterThan(0)` at
  `portal.spec.ts:408` receives 0. Fails 3 of 3 on `main` when the whole
  `portal.spec.ts` runs (`--repeat-each=3`, one worker), passes 3 of 3 when
  the test runs alone. The paused card's capture may undo the instant
  `scrollIntoView` before the reset lands.
- **Expected:** scrolling to the next card from a paused card stays there.
- **Reproduction:** `E2E_BASE_URL=https://localhost:3274 E2E_API_PORT=3101 VITE_IWER_SEM_SCENE=office_small XR_TEST_MODE=iwer pnpm --filter @holoim/web exec playwright test e2e/portal.spec.ts --repeat-each=3 --workers=1`

### B-024 — CI's pipeline shard can spend its whole timeout installing ffmpeg

- **Area:** `.github/workflows/ci.yml` pipeline job (`apt-get install ffmpeg`), `scripts/ci-emulate.sh`
- **Severity:** P2
- **Observed:** 2026-10-26, runs for `4178f157` and `da4a008b`
- **Evidence:** in both runs shard 1/2 never started its tests: the
  "Install Quick Look conversion dependencies" step pulled ffmpeg's ~90
  packages from `azure.archive.ubuntu.com` at minutes per package and the
  job hit `timeout-minutes: 20` (cancelled; CI Gate failed, deploy
  skipped). Shard 2/2 installed the same packages in seconds. The same
  tests pass locally in 5.2 min. Separately, `ci-emulate.sh` cannot run
  this suite: it installs Chromium through `@holoim/capture`, but the
  pipeline launches `chromium_headless_shell-1208`, which is missing.
- **Expected:** a slow apt mirror does not cancel the run; e.g. a
  static ffmpeg binary or a cached `.deb` set, and a step timeout so the
  failure names the install rather than the job.
- **Reproduction:** intermittent on hosted runners; see the two runs above.

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

### B-022 — The portal tilt check cannot find the pressed tilt toggle

- **Area:** `apps/viewer-web` e2e (`test:portal`, part of `verify:pr`)
- **Severity:** P2 (fails `verify:pr` on `main` for every branch)
- **Observed:** 2026-10-25
- **Evidence:** `e2e/portal.spec.ts:109` ("phone › tilt") clicks "Look
  around by tilting the phone", then finds no button named "Stop looking
  around by tilting" within 5 s. It fails every run on `main` (`31c082a`)
  and on `02d0282`, the redesign commit with "fewer controls", so it
  arrived with that commit. Unknown whether the toggle itself broke or
  only the check's expectation is stale.
- **Expected:** tilting the phone can be turned on and off from the card,
  and the check passes.
- **Reproduction:** `VITE_IWER_SEM_SCENE=office_small XR_TEST_MODE=iwer npx
  playwright test e2e/portal.spec.ts -g tilt` from `apps/viewer-web`.

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
