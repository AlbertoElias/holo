# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-038 — Phone "drag" check can leave the feed resting off a card

- **Area:** `apps/viewer-web/e2e/portal.spec.ts` ("drag (default): a swipe off the hologram scrolls …"), `scrollFeedToTop`
- **Severity:** P3
- **Observed:** 2026-10-28, on `bug/portal-freeze-scroll` (`46c523f0` + B-025 work)
- **Evidence:** once in 3 runs of the whole spec, `settleScroll` threw
  "feed scroll did not settle: 300, 300, 300, 300, 300" at
  `portal.spec.ts:190`: after the test stops a smooth glide to 300 with a
  tap and puts `scroll-snap-type` back, the feed stays at 300 instead of
  snapping to a card. Passed in the other 2 runs and in a later 3 of 3.
- **Expected:** restoring snapping lands the feed on a card (or the test
  returns it to a card itself) before `scrollFeedToTop`.
- **Reproduction:** `E2E_BASE_URL=https://localhost:3294 E2E_API_PORT=3121 VITE_IWER_SEM_SCENE=office_small XR_TEST_MODE=iwer pnpm --filter @holoim/web exec playwright test e2e/portal.spec.ts --repeat-each=3 --workers=1` (intermittent)

### B-037 — AR recenter click sometimes misses on a hosted runner

- **Area:** `apps/viewer-web/e2e/hologram-feed.spec.ts` ("AR places the model on a surface … recenter places again"), `rayClick`
- **Severity:** P2 (fails CI and holds back the viewer deploy)
- **Observed:** 2026-10-28, run 40617371918 (viewer shard 1/4), on `931710be7bbd`
- **Evidence:** the first placement anchors at 8.9 s; after `recenterFromFoot`
  no placement with a higher sequence arrives in 15 s
  (`hologram-feed.spec.ts:463`). Passed 8 of 8 in `scripts/ci-emulate.sh`
  (alone ×5, the whole shard ×3) and on runs 40612369043 and 40616950365.
  Likely cause: `rayClick` presses and releases the trigger one real frame
  apart, and IWSDK counts a press held past 800 ms of frame time as no
  click, so one long frame on a slow runner drops the Recenter select.
- **Expected:** the press and release land deterministically: step the page
  clock (as the xr-viewer checks do) rather than ride real frames.
- **Reproduction:** not yet local; hosted runner only.

### B-036 — Knowledge live-update check fails after other browser suites

- **Area:** `apps/knowledge/e2e/atlas.spec.ts` ("any docs Markdown is discoverable and live updates through atomic replacement and rename")
- **Severity:** P3
- **Observed:** 2026-10-27, `scripts/ci-emulate.sh` on `infra/ci-under-5m`
- **Evidence:** `toBeVisible` finds no element after the atomic replacement
  when `test:knowledge` runs after three viewer mocked shards in one
  container; passes 4 of 4 when it runs first (CI's order, viewer shard 4).
  Likely a file-watch event missed or late under load.
- **Expected:** the live update lands regardless of earlier load.
- **Reproduction:** `scripts/ci-emulate.sh bash -c 'VITE_IWER_SEM_SCENE=office_small pnpm --filter @holoim/web run test:e2e:mocked:shard1 && pnpm run test:knowledge'`

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

### B-028 — A take drops set geometry whose vertices are far apart, such as a large floor

- **Area:** `apps/capture/src/recording/SceneBubbleSampler.ts` (`triangleInsideBubble`)
- **Severity:** P2
- **Observed:** 2026-10-25, while building AR recording (`docs/features/archive/ar-recording.md`)
- **Evidence:** the bubble clip keeps a triangle only when two of its
  vertices lie within 6 m of a sample. `fixtures/scenes/pointing-targets.gltf`'s
  `PointingFloor` is a 14 m box with 12 vertices, so no triangle qualifies:
  `output/ci-marks/desktop.glb` and `controllers.glb` (performer takes, the
  same code as `main`) and the camera take `output/ci-ar-record/phone-a.glb`
  hold `TargetA` and `TargetB` but no floor. The capture view shows the floor
  under the author.
- **Expected:** set geometry the take stood on or near is kept whatever its
  tessellation (for example, a triangle is kept when it comes within the
  radius of a sample, not only its vertices).
- **Reproduction:** `pnpm --filter @holoim/capture run test:xr:marks`, then
  list the node names of `apps/capture/output/ci-marks/desktop.glb`: there is
  no `PointingFloor_RecordedBubble`.

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
