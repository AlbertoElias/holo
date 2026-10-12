# Feature brief: Deterministic, lean CI

**Lead:** Claude Code
**Status:** Verifying

## User outcome

Every push gets one CI result that is fast, deterministic, and proves the real
product flow (capture → export → upload → viewer) works. Flakes and slow
runners no longer produce failure emails for unchanged code.

## Scope

**Included:** capture's test clock, the capture XR browser flows, a real
cross-app pipeline end-to-end test, CI job layout, removal of tests that only
ratify scaffolding or duplicate stronger coverage, and the docs that describe
those commands.
**Excluded:** new product behavior, physical-headset validation, Playwright
container images, and sharding.

## Acceptance criteria

- [ ] Capture test runs cannot be advanced by wall-clock frames while a test
  drives time; the same inputs produce the same simulation state on any host.
- [ ] Locomotion assertions check every tested heading moves in the expected
  world direction instead of accepting the best of several trials.
- [ ] One end-to-end test records in capture, exports the real GLB, uploads it
  through the viewer UI to a real API, and renders it in the viewer feed.
- [ ] Push, pull-request, and scheduled runs execute the same single tier; the
  separate heavy nightly tier is removed.
- [ ] Browser coverage on CI finishes well inside job limits on 2-vCPU runners.
- [ ] Removed tests are either testing test scaffolding or fully covered by a
  stronger end-to-end check, and each removal is listed below.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Real animation frames mutate physics between test steps | Manual clock stops realtime ticks while tests drive time |
| Edge-triggered input (jump) dropped by blur/visibility handlers between calls | Inputs and the first step run in one page evaluation |
| Skipping per-step draws changes simulation results | Mock VR state is read from `mockVrState`; world matrices still update each step; one draw per call keeps screenshots current |
| Scenario reuse leaks state between checks | Each scenario asserts its own baseline (grounded, idle, standing) before acting |
| Export regresses but upload of a fixture still passes | Pipeline test uploads the GLB capture just exported, not a fixture |
| Viewer accepts upload but cannot render it | Pipeline test waits for the uploaded model to finish loading in the feed |
| Interactive IWSDK sessions freeze unexpectedly | Manual clock is opt-in through an explicit hook; realtime is the default |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude Code | Brief, integration, final handoff |
| Design reviewer | Claude Code (sequential) | Read-only review before implementation |
| Implementer | Claude Code | `apps/capture` clock and scripts, `scripts/`, `apps/viewer-web/e2e`, `.github/workflows/ci.yml` |
| Independent verifier | Claude Code (sequential) | CI runs and artifacts |

## Design decision

Root causes found on 2026-10-12 from nightly logs and artifacts:

1. `advanceTime` drew a full software-GL frame for every 1/60 s step, and the
   realtime loop kept rendering and ticking alongside it. CI time scaled with
   runner CPU (268–606 s on CI against 60 s locally).
2. Realtime frames and window events interleaved with the test's steps. The
   2026-10-05 failure timeline shows the queued jump never applied.

Chosen approach: an explicit manual clock in capture, draw-free stepping, two
long-lived scenario pages instead of eighteen fresh ones, exact direction
assertions, and one real pipeline test that supersedes the fixture upload smoke
and the live-API shell check.

## Test plan and evidence

CI reproduction: `mcr.microsoft.com/playwright:v1.58.2-noble` (Ubuntu 24.04,
same as `ubuntu-latest`) with `--cpus=2 --memory=7g`. In it, `main` at
`fe8ff4c6` took 372 s for the locomotion flow and failed `jump-airborne`, which
matches the CI failures.

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Determinism | locomotion flow run repeatedly on macOS and in the container | Identical per-move distances and heading errors run to run (`[vr-locomotion] moves:` log line) |
| Exact direction checks | `pnpm run test:xr:capture` | 16 moves (4 yaws × forward/back/left/right) each nearest its expected direction; worst terrain deflection 0.476 rad against a π/4 bound |
| Speed on 2 vCPU | container run of the CI e2e job | capture XR 31 s, viewer AR 61 s, pipeline 35 s; 129 s total versus 155 s (PR) plus 270–606 s (nightly) before |
| Real pipeline | `pnpm run test:smoke:pipeline` | Records 1.5 s in capture, exports the GLB, checks skins, `RecordedBubbleSphere`, and animation length, uploads through the viewer UI to the test API, and waits for `data-model-state="rendered"` with an active bubble |
| Viewer checks can fail | recenter check against a no-op `handleRecenter` | Fails (stage history never resets); passes against the real handler |
| Diagnostics | forced failure | Timeline JSON plus a 1280×720 screenshot of the head view |
| Single CI tier | `.github/workflows/ci.yml` | pending: first branch run |

### Tests removed or replaced

| Removed | Why | Coverage now |
|---|---|---|
| `scripts/test-smoke-pipeline.ts` | Uploaded a static fixture; exercised neither export nor rendering | `capture-to-viewer.pipeline.spec.ts`, plus `hologram-routes.test.ts` for API detail |
| `e2e/hologram-feed.integration.spec.ts` | Only checked the feed shell rendered against a live API | Pipeline test renders an uploaded capture from the live API |
| `src/test/setupXr.test.ts` | Tested the test harness's own XR stub | — (test scaffolding) |
| `src/features/feed/useFeed.test.tsx` | Asserted a stubbed `fetch` returned its own fixture | Pipeline test loads the feed and prepends a real upload |
| Feed-shell and SEM-placement viewer tests | Each repeated AR entry already covered by the merged tests | Three viewer tests: entry/exit, SEM placement + recenter, hit-test fallback |

Also fixed while auditing: viewer console and page errors now fail tests
(they were only logged), and the recenter check could not fail before (it
asserted `sequence >= initial` after a click IWER's overlay swallowed).

## Physical-device limits

None of this changes headset behavior. IWER evidence does not establish
tracking feel or device performance; the existing headset TODO stands.
