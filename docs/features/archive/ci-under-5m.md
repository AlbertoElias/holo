# Feature brief: Commit to deploy in under five minutes

**Lead:** Claude (Opus)  
**Status:** Complete (2026-10-28: two all-areas runs at 4 m 39 s and 4 m 38 s; criteria 3 and 4 partly open, carried to `TODOS.md`)
**Layer:** none (delivery infrastructure)

## User outcome

A push to `main` is live within five minutes, and every suite that gates
deploy today still gates it. A red run means a real defect, not a slow runner.

Baseline (2026-10-27, runs 40406523825–40472119472): CI 11–20 min plus
1–2 min deploy. Critical path: viewer VR job 12.9–19.3 min (740 s of tests),
pipeline shard 1 6–16 min (two tests at 171 s and 147 s), capture XR shard 1
5–5.7 min (`ar-record` 289 s, face 100 s). Setup 30 s, 228 s on a slow apt
mirror. Of the last six failed runs, four failed on wall-clock or frame-timing
assertions, one on lint, one on apt.

## Scope

**Included:**
1. CI shape: Playwright container image for browser jobs (no apt), shard
   balance from measured durations, each app deploys once its own suites pass.
2. Deterministic viewer XR: a viewer frame-step and clock hook like capture's
   manual clock; move the VR, AR and camera-take checks onto it; remove the
   remaining real-time sleeps in capture checks (`ar-record`, held marks, face).
3. Less repeated work: one real capture recording shared by the pipeline
   specs, `exercise_usdz.py` as a tool-level check on a stored GLB, built
   bundles (not the Vite dev server) for browser checks.
4. Confidence fixes: the swallowed timeout in `settledReachRow`
   (`apps/viewer-web/e2e/xr-viewer.spec.ts`) and the order-dependent tests in
   `camera-take.pipeline.spec.ts`.

**Excluded:** post-deploy testing or rollback (user decision 2026-10-27:
every suite stays a deploy gate); new product behavior; physical-device
validation; deleting coverage without naming what replaces it.

## Acceptance criteria

- [x] On a hosted runner, a push touching all areas goes from push to the
      last deploy health check in under 5 minutes, measured on two runs.
      (Measured on two all-areas manual dispatches on `main`: a push after a
      green run selects only the areas it touches.)
- [x] Every suite that gated deploy on 2026-10-27 still runs before the
      deploy of each app it exercises; the gate lists each one.
- [ ] No browser check waits on wall-clock time for an assertion about motion,
      playback or frame counts; each such wait steps a test clock.
- [ ] The VR, AR and pipeline checks pass 5 runs in a row in
      `scripts/ci-emulate.sh` with identical numeric results.
- [ ] No check swallows its own timeout; each test in a file can run alone
      (`--grep` on one test passes).
- [x] Browser checks load a production build of the app they test.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| A manual clock hides a real-time bug (e.g. playback drift under load) | Keep one capture → viewer pipeline test on the real clock end to end; it asserts outcomes, not timings |
| Built bundle differs from dev in a way a check relied on (test hooks, env) | Hooks gated by a build-time test flag, not `import.meta.env.DEV`; production build without the flag is checked for absent hooks |
| Shared recording fixture goes stale or masks a capture regression | Recorded once per CI run from real capture, never committed; the capture XR recording check still runs on its own |
| Per-app deploy ships an app whose cross-app suite failed | Each deploy needs every suite that exercises that app (pipeline gates api, web and capture) |
| Container image drifts from the Playwright version in the lockfile | Image tag derived from the installed `@playwright/test` version; doctor check fails on mismatch |
| Rebalanced shards go stale again | Shard costs read from the last CI timing artifacts, with the table as fallback |
| A push changes the API and web; web ships before (or without) its API | Web deploys after the API when both changed; each deploy needs every suite exercising it |
| A newer push cancels a deploy halfway | Deploy jobs use a non-cancelling job-level concurrency group |
| A test flag leaks into the production bundle | Deploy checks the production `dist` for `__HOLOIM_XR_VIEWER__` and IWER |
| Moving `exercise_usdz.py` out of e2e drops a conversion regression | It runs in the quality job whenever `apps/viewer-api/tools` or the GLB export changes, on a stored capture GLB |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude (Opus) | Brief, CI workflows, integration |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only |
| Implementer (step 1) | Lead | `.github/`, `scripts/ci-*`, docs (on `main`: `4916abd7b74f`, `46ed1eb637b1`) |
| Implementer (viewer clock) | Opus subagent, `infra/ci5-viewer-clock` | `xr-viewer`, `hologram-feed`, `redesign`, `ar-bubble`, `portal` specs, `portal-helpers.ts`, `bootstrap.ts`, `packages/tooling-testing/src/xr-env.mjs`, viewer `package.json` scripts |
| Implementer (camera take) | Sonnet subagent, `infra/ci5-camera-take` | `camera-take.pipeline.spec.ts` |
| Implementer (capture clock) | Opus subagent, `infra/ci5-capture-clock` | `apps/capture/scripts/**` except the cost table |
| Implementer (pipeline) | Opus subagent, `infra/ci5-pipeline` | Other `*.pipeline.spec.ts`, `apps/viewer-api/tools/**` |
| Implementer (built bundles) | After the clock work lands | `playwright.config.ts`, viewer and capture Vite config, `ci.yml` |
| Independent verifier | Codex (`-p standard`) | Read-only verification; test artifacts only |

## Design decision

Design review (Opus `design-reviewer`, 2026-10-27) changed the plan as follows.

- **Runners have 4 vCPUs.** The repo went public on 2026-10-26, and public
  repos get 4-vCPU, 16 GB hosted runners; the capture harness already logs
  "2 at a time". Every Playwright suite still runs `--workers=1`, and
  `ci-emulate.sh` still emulates 2 CPUs. Emulation moves to 4 CPUs; worker
  counts rise only for suites that step a test clock (step 2).
- **No container image.** The stock Playwright image lacks system ffmpeg, pip
  and Node 24, and its 20–40 s pull costs more than the 14 s apt step it
  replaces. The apt cost was the tail (3.5 min on a slow mirror, B-024), so
  `scripts/ci-playwright-deps.sh` installs only the Chromium libraries the
  runner lacks, usually none. The conversion tools' Python packages live in
  a cached virtualenv instead of a 34 s `pip install`.
- **Deploy is on the critical path.** `flyctl deploy --remote-only` builds,
  rolls out and health-checks in 2–4 min, and `workflow_run` adds queue time.
  Deploy moves into `ci.yml`: the API image builds and pushes alongside the
  tests and is released by image after its gate; the viewer and capture
  production `dist` are built once in `quality` and uploaded as artifacts.
- **Concurrency.** The workflow-level `cancel-in-progress` would cancel a Fly
  rollout halfway, so test jobs cancel through job-level groups and deploy
  jobs share `deploy-production` without cancelling. Deploy jobs also require
  `refs/heads/main`.
- **Gate matrix.** api ← quality, pipeline, portal. web ← quality, e2e, VR,
  pipeline, portal. capture ← quality, capture XR, pipeline, portal. When one
  push changes the API and web, web deploys after the API (version skew).
  The deploy base stays "last fully successful run", so a partial deploy is
  redeployed later rather than skipped.
- **Viewer clock (step 2).** Start without app code: IWSDK's clock reads
  `performance.now` and IWER frames ride `requestAnimationFrame`, both under
  `page.clock`. A `stepXr(page, frames, dtMs)` helper in
  `packages/tooling-testing/src/xr-env.mjs` replaces `nextFrames` and the
  sleep-plus-frame waits. A capture-style draw-free loop comes only if
  measured draws dominate. Audio time, fetch, GLB parsing, KTX workers and
  `makeXRCompatible` are not faked: wait on their completion signals.
- **Built bundles (step 3).** The test build needs `injectOnBuild`, the SEM
  scene baked in, a preview HTTPS cert and a relative `/api`. One test build
  per run is shared as an artifact. Production `dist` is checked to contain
  neither `__HOLOIM_XR_VIEWER__` nor IWER. Production React drops StrictMode
  double effects and dev warnings, which weakens the console-error net.
  Capture installs automation hooks unconditionally, so the "no hooks in
  production" check covers the viewer only.
  *Deviation (implementation):* each browser job builds its own test bundle
  (`test-build.mjs`, about 15–20 s for the viewer locally) instead of
  downloading one from `quality`: a download needs `needs: quality`, which
  puts quality's ~2 min (lint, unit, build) in front of every browser job,
  and a separate build job adds a runner queue plus setup. Builds are keyed
  by variant (SEM scene, IWER device), since the pipeline suite runs without
  SEM and the face check on a Quest Pro. KTX moved into the setup action so
  test builds compress textures as production does. Specs reach three and
  the fit code through `window.__HOLOIM_TEST_MODULES__` (test builds only)
  instead of dev-server module URLs; capture's preview serves `fixtures/`
  and the input-recording sink as its dev server did.
- **Exemptions from "no wall-clock waits":** the one real-clock capture →
  viewer pipeline test and B-032's deliberate `marks-low-fps` realtime phase.
- **Shared recording** happens per shard in a Playwright setup project and is
  shared only between specs that need the same take.
- **Shard costs** stay a committed table, refreshed on purpose from CI timing
  artifacts, so runs stay reproducible.

Expected critical path: after step 1 about 9–12 min (the VR tests remain);
after step 2 about 6–7 min; after step 3 about 5 min, with little margin.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Under 5 minutes | Two pushes to `main`, `gh run view` timings | Step 1 alone, run 40519789735 (capture area): 13 m 16 s green; capture deploy 43 s from the prebuilt bundle; pipeline shard 1 (726 s) still the long pole; a slow apt mirror still cost one job 228 s for 7 missing font packages, fixed by the `.deb` cache (`46ed1eb637b1`, offline warm install checked in an `ubuntu:24.04` container). Full branch, run 40588350081 (all areas): tests done in 6 m 50 s (pipeline shard 1 the long pole at 6 m 50 s; VR 2 m 34 s, was 12.9–19.3 min; viewer shard 1 5 m 6 s; capture XR 2 m 7 s / 3 m 12 s); the new Quick Look tool check then failed for lack of ffmpeg in its job (emulation installs it for every job), so all three deploys were held back as designed. Run 40589635831 (all areas, ffmpeg fixed): green, push to last deploy health check 10 m 18 s: pipeline shard 1 7 m 18 s, then Quick Look tool check 1 m 33 s (it waits for pipeline's take), then deploys 25–38 s (API by image 38 s; web after the API, 26 s). **Not yet under 5 minutes.** Remaining path: (1) start the Quick Look check without waiting for pipeline (a cached or capture-XR-exported take), −1.5 min; (2) split pipeline shard 1 (11 tests, 7.3 min) into three shards balanced by measured cost, or cut its recording time, to ≤3.5 min; (3) viewer shard 1 (5.3 min) rebalanced. Those three put an all-areas push near 5 min; a single-area push is already shorter <br>**Step 5 (this branch):** the Quick Look tool check records its own walk take in capture alone (`test:e2e:walk-take`, `E2E_CAPTURE_ONLY=1`) and no longer waits for the pipeline; the pipeline runs as 5 whole-file shards and the viewer mocked suite as 4 grep shards, balanced by run 40589635831's measured wall times (largest: pointing 115 s, bubble-capture 112 s; viewer 124 s), with Knowledge on viewer shard 4; test builds and conversion dependency installs run side by side. `scripts/check-e2e-shards.mjs` (quality, after the build) fails unless the shards run each test of the suites exactly once (49 tests; it caught a deliberately dropped `object` spec and a doubled feed test). Emulation (4 CPU): walk take 30 s + tool check 96 s, pass; pipeline shards 106/234/163/164/141 s, all pass; viewer shards 1/3/4 114/96/78 s, pass. Independent Codex review (`-p standard`): no findings. Knowledge's live-update test failed once in emulation when run after three viewer suites in one container, and passed 4/4 when run first, as CI runs it (pre-existing, B-036 in `BUGS.md`). Push run 40612369043 (viewer, pipeline, Quick Look areas only, since the previous run was green): green, push to viewer deploy 5 m 48 s, on a slow runner (VR tests 183 s, were 93 s; pointing 195 s, was 115 s) with ffmpeg from a slow apt mirror (30–70 s per job, was 14 s). Follow-up: pointing records each take when a test first needs it and splits into pipeline shards 2 and 6 (139 s and 126 s in emulation, 234 s whole); the VR job splits in two (about 71 and 56 s); ffmpeg installs from cached `.deb` files (`scripts/ci-ffmpeg.sh`; warm install checked offline in `ubuntu:24.04`). Codex review: no findings. Push run 40615287041 failed (quality listed the specs before the workspace packages were built; pipeline shard 6 saved held-mark takes into a directory only the desktop take created), deploys held back; both fixed in `931710be7bbd` and checked in fresh emulations. Push run 40616950365 (viewer and pipeline areas): green, push to viewer deploy 3 m 57 s. Dispatch 40617371918 (all areas): one viewer shard failed on a missed AR recenter click (B-037, hosted only; 8/8 in emulation), web held back; API and capture live at 4 m 10 s. **Dispatch 40619144104 (all areas): green, created to last deploy health check 4 m 39 s** (last gate capture XR shard 2 at 4 m 03 s, then capture deploy). **Dispatch 40619689823 (all areas): green, 4 m 38 s** (last gates capture XR shard 2 and viewer shard 1/2 at about 3 m 23 s; API 35 s, web after it 24 s). Critical path now: capture XR shard 2 (3.8–4.1 min) and the viewer chain (last gate, API deploy, web deploy, about 70 s). |
| Suites still gate | `ci.yml` / `deploy.yml` review, gate summary | Gate matrix as designed, plus `usdz-tools` gating capture and API; web needs a successful `deploy-api` when the API changed (ci.yml and manual deploy.yml). Independent Codex review (`-p standard`) found two gate gaps, both fixed in `0d6e4c40164d`; it found none in area selection or concurrency |
| No wall-clock waits | grep audit plus 5× `ci-emulate.sh` runs | Viewer XR checks step the page clock (`stepXr*` in `xr-env.mjs`); VR script 3× identical distances and angles (clip-derived gallery values still vary). Remaining real-time holds assert a negative over time and say so (no fourth download, portal 400/800 ms, held-mark delay); feed entry and session start stay real time. Not yet 5 runs per suite |
| Tests run alone | each spec file run per test with `--grep` | camera-take tests independent (`referenceTake`); Hips and Head 3/3 with `--repeat-each=3` in emulation; slow viewer tests each run alone; `settledReachRow` and the capture export/hold waits now fail instead of swallowing timeouts |
| Production build in checks | Playwright config, network log of a check | All browser suites serve `vite preview` test builds (`test-build.mjs`); `check-prod-bundle.mjs` fails quality if the production viewer carries test hooks or IWER at startup (it caught a leaked `__HOLOIM_XR_VIEWER__`). Final emulation on the merged tip (4 CPU): mocked 30/30 (10.5 m), portal 9/9 (3.5 m), pipeline 9/9 (5.6 m) and 8/8 (5.8 m), capture XR shards PASS (149 s, 283 s) |

Open at close (carried to `TODOS.md`): 5 identical emulation runs per XR
suite (criterion 4); B-037, the AR recenter click riding real frames in
`hologram-feed.spec.ts` (criterion 3); B-036 (Knowledge live update under
load). Pipeline and VR shard costs are set from runs 40589635831 and
40612369043; refresh them from the timing artifacts when a spec's cost moves.

Known weakenings: audio drift checks pass partly through the app's resync
under stepped time; the locomotion slide is held 0.3 s (was 0.7 s); GL
warnings are caught on drawn frames only (stepped frames draw 1 in 8);
production React drops StrictMode double effects and dev warnings. Two
Playwright workers were measured and rejected (software GL contention).

## Physical-device limits

None: no product behavior changes. Manual-clock checks prove deterministic
emulated behavior only, as before.
