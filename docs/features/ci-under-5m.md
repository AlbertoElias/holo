# Feature brief: Commit to deploy in under five minutes

**Lead:** Claude (Opus)  
**Status:** Implementing
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

- [ ] On a hosted runner, a push touching all areas goes from push to the
      last deploy health check in under 5 minutes, measured on two runs.
- [ ] Every suite that gated deploy on 2026-10-27 still runs before the
      deploy of each app it exercises; the gate lists each one.
- [ ] No browser check waits on wall-clock time for an assertion about motion,
      playback or frame counts; each such wait steps a test clock.
- [ ] The VR, AR and pipeline checks pass 5 runs in a row in
      `scripts/ci-emulate.sh` with identical numeric results.
- [ ] No check swallows its own timeout; each test in a file can run alone
      (`--grep` on one test passes).
- [ ] Browser checks load a production build of the app they test.

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
| Implementer | Claude (Opus), subagents per module | `.github/`, `scripts/ci-*`, `apps/viewer-web/e2e`, viewer XR test hook, `apps/capture/scripts` |
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
| Under 5 minutes | Two pushes to `main`, `gh run view` timings | pending |
| Suites still gate | `ci.yml` / `deploy.yml` review, gate summary | pending |
| No wall-clock waits | grep audit plus 5× `ci-emulate.sh` runs | pending |
| Tests run alone | each spec file run per test with `--grep` | pending |
| Production build in checks | Playwright config, network log of a check | pending |

## Physical-device limits

None: no product behavior changes. Manual-clock checks prove deterministic
emulated behavior only, as before.
