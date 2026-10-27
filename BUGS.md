# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-027 — Three immersive viewer checks fail on hosted runners

- **Area:** `apps/viewer-web/e2e/xr-viewer.spec.ts` "VR gallery:" (`:1259`), "VR foot controls:" (`:733`), "VR locomotion:" (`:1549`)
- **Severity:** P2
- **Owner:** vr-spec-flake session, branch `bug/xr-viewer-spec-flake`
- **Observed:** 2026-10-26, CI runs on `main` at `2610b0ad` and `c6a3b59f`
- **Evidence:** in run 40406523825 gallery and foot controls failed a state
  wait and locomotion failed "slid -0.160 m" along forward (needs > 0.3). In
  run 40436776761 (`c6a3b59`, longer waits, B-026 retries) locomotion still
  failed and shard 3 took 7.4 of its 10 minutes.
  Locally at load 30–50, locomotion missed its mid-fade frame 2 of 3 runs and
  gallery failed once, then passed.
- **Workaround:** CI runs these three in the `xr-viewer-unsteady` job with
  `continue-on-error`, outside the CI Gate. Move them back into the e2e shards
  and the gate when the fix lands.
- **Reproduction:** `pnpm --filter @holoim/web run test:e2e:xr-viewer-unsteady` (with `E2E_BASE_URL`/`E2E_API_PORT` on free ports)

### B-026 — Emulated clicks and taps are now and then lost when frames are slow

- **Area:** `apps/viewer-web/e2e/xr-viewer.spec.ts` (`rayClick`, `phoneTap`), IWER input on IWSDK's pointers
- **Severity:** P3
- **Observed:** 2026-10-26, hosted CI run 40406523825 and `scripts/ci-emulate.sh`
- **Evidence:** a ray click on Play, Recenter or a shelf tile, or a phone
  tap, changes nothing about 1 time in 10 on a 2-CPU runner or at load 20
  locally; the same step passes on retry. Timing the press by rendered
  frames (in a frame callback, by the renderer's counter, or held in the
  page) lost more clicks than the 80 ms press and sometimes selected a tile
  twice, so the cause is still unknown. The spec now presses again, keyed on
  the target state, at most twice (`pressFor`), and reports a
  `clickRetries` annotation per test.
- **Expected:** one emulated press is one click. Unknown whether real
  devices drop inputs this way too (HANDOFF device checks).
- **Reproduction:** run the VR gallery or locomotion test with `--repeat-each=3` at load 20 with `pressFor`'s retries removed.

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
