# Feature brief: Native IWSDK capture runtime refactor

**Lead:** Claude Code
**Status:** Verifying on `infra/iwsdk-runtime-refactor` (from `origin/main` `de26df9eb70c`)
**Prepared:** 2026-10-19

The user added a requirement when implementation started: treat the migration
as a strict cleanup pass. End behavior must stay exactly the same while the
capture codebase becomes much cleaner and easier to iterate on. Baseline,
design decisions and evidence are in [Implementation record](#implementation-record)
at the end of this brief.

## User outcome and decision

Make capture easier to extend, inspect, test, and iterate on with agents by using
IWSDK as its application runtime. Preserve the recorded event: true-scale body,
hands, voice, environment, and time, independent of the viewer's camera. The user
has finished the locomotion fixes and asked for this implementation handoff.
This chat is delivering the plan and prompt; it is not performing the refactor.

Use native IWSDK for scene/renderer/XR lifecycle and ordered feature systems.
Preserve the current movement and recording algorithms initially. A wrapper that
continues to run the complete old AppOrchestrator is a transitional milestone,
not the final refactor. Demonstrate actual infrastructure deletion and useful
agent controls. Do not assume the SDK improves rendering performance.

## Baselines and how to start

| Reference | Observed state, 2026-10-19 |
| --- | --- |
| `origin/main` | `cdad1c4a869eb1d75242e7a14dbfc292c78d0cd6`; contains desktop/terrain locomotion, XR height/refit, room-scale body solver, portal viewer, and deployment work |
| Prototype implementation | `fb5c1d61d22d`, branch `infra/iwsdk-prototype`, originally based on `70e56826faa9` |
| Local shared checkout | `2bce890ee6a0`, behind fetched main; dirty with another session's hand tracking/recording/IK/UI/export fixes and a new headset fixture |
| Prototype tests | Passed on the older prototype baseline on October 18; NOT validation of the completed movement baseline |

Fetch and inspect again before implementation: refs, dirty files, feature briefs,
versions, tests and ports may have changed. Start a NEW implementation worktree
from latest `origin/main` on `infra/iwsdk-runtime-refactor`. Keep this prototype
branch as a reference. Import this brief and the selected prototype evidence via
`git show`; port code deliberately against current main. Do not merge/cherry-pick
the full old prototype runtime commit or copy its whole orchestrator, package.json,
lockfile, tsconfig, trackers, or old Node engines over current files. The old
branch's unrelated trackers and instructions are historical.

The shared checkout had uncommitted changes in AppOrchestrator, AvatarRig,
ArmIkSolver, inputRecording, GltfExportComposer, VrRecordingPanel, hand-fidelity,
`packages/xr-ui-three/src/index.ts`, and
`headset-open-fist-pinch-point-wave-reach.json`, among its tracking docs. Its
handoff says this fixture exists/was committed, but Git reported it untracked.
Treat Git as authoritative. Do not stash, stage, copy, reset, commit, or overwrite
that session's work. Refresh refs and include the owner's committed hand fixes
before migrating overlapping modules; preparation and baseline work can proceed
independently. If ownership cannot be resolved, ask only about that concrete
blocker after completing unaffected work. A newer committed version supersedes
this snapshot.

Authoritative movement references at the observed baseline (use latest versions
when starting):

- [Locomotion and terrain](https://github.com/AlbertoElias/holo/blob/cdad1c4a869eb1d75242e7a14dbfc292c78d0cd6/docs/features/archive/avatar-locomotion.md).
- [XR height adaptation](https://github.com/AlbertoElias/holo/blob/cdad1c4a869eb1d75242e7a14dbfc292c78d0cd6/docs/features/archive/xr-height-adaptation.md)
  and [same-session refit](https://github.com/AlbertoElias/holo/blob/cdad1c4a869eb1d75242e7a14dbfc292c78d0cd6/docs/features/archive/xr-height-refit.md).
- [Room-scale body motion](https://github.com/AlbertoElias/holo/blob/cdad1c4a869eb1d75242e7a14dbfc292c78d0cd6/docs/features/room-scale-body-motion.md).
  The code is merged, though its brief still says Verifying. It includes five
  body fixtures, twelve fault injections and 2-vCPU evidence.
- [Hologram concept](https://github.com/AlbertoElias/holo/blob/cdad1c4a869eb1d75242e7a14dbfc292c78d0cd6/docs/product/concepts/what-a-hologram-is.md).
  GLB event data is canonical; USDZ is an opt-in flattened preview. Keep tracked
  motion distinct from inferred locomotion; a provenance format feature remains
  separate work, not an excuse to relabel inferred data during this refactor.

## Prototype inventory: reuse and limits

Read [the prototype guide](../IWSDK_RUNTIME_PROTOTYPE.md),
[verification](../evidence/iwsdk-runtime-prototype/verification.md),
[native JSON](../evidence/iwsdk-runtime-prototype/native-runtime.json), and
[hand metrics](../evidence/iwsdk-runtime-prototype/hand-replay.json).

- Verified set: IWSDK core/CLI/dev-plugin/scene-composition 1.0.1, IWER 2.6.0,
  shared `super-three` r181, UIKit 1.0.77. Current main still declares IWSDK
  0.5.3 and IWER 2.3.0, now has UIKit in runtime dependencies, and requires Node
  22 (`>=22 <23`). Reconcile dependencies intentionally; do not restore Node 20.
  Current capture typechecking includes TypeScript scenario scripts; preserve
  their local browser interfaces instead of reintroducing conflicting global
  Window declarations from the old spike.
  Confirm installed SDK APIs/schemas and deduplication, rather than coding from
  a newer documentation example. Put production World imports in runtime
  dependencies; keep CLI/dev tooling as dev dependencies. Regenerate the lock.
- `src/prototype/main.ts` proves World bootstrap, origin/camera boundaries and
  disabling competing default features. `CaptureSystem.ts` proves native system
  ticking and ECS diagnostics. Constructor/presentation seams in AppOrchestrator
  and `externalFrameLoop` in createApp prevent duplicate rendering.
- One native step advanced one actual recording frame and 1/60 second; paused
  frames did not accumulate. Existing synthetic hand replay and full real
  microphone/export/upload/animated viewer/USDZ workflow passed.
- `CaptureState` was observational only. Editing it did not control the product.
  Implement genuine domain-owned state/controls in the refactor; do not merely
  mirror JSON from the old orchestrator.
- Vite initially bundled old UIKit without `ContainerPropertiesSchema`: align
  versions and dedupe. Avoid constructor-identity checks across Three instances.
- The SDK's automatically installed, unused spatial AudioListener threw negative
  AudioParam ramp times after replay rebased performance time. The prototype
  unregistered AudioSystem and detached that listener using public lifecycle
  APIs; capture's microphone MediaRecorder was unaffected. Keep or replace that
  deliberate boundary, and prove capture audio survives. No private clock patch.
- Not established: full outer MCP/editor transport, current height/body solver
  integration, production bundling of World, capture AR spectator/recenter,
  optional hand/body spectator video, headset performance/comfort, or exact
  audiovisual sync. Legacy manual stepping bypassed ECS and World still drew
  released frames. Close these software gaps instead of carrying them as the
  final architecture. Device-only evidence stays separate.

## Scope

Included: production capture entry uses World; one authoritative simulation clock
and frame pipeline; XR/desktop/AR lifecycle; feature systems; current recording
and UI controls; native agent observation/control; deterministic test adapters;
production build and deployment compatibility; removal of superseded glue.

Excluded: viewer runtime migration (it uses R3F/@react-three/xr), Havok migration,
replacement of Rapier movement/collision behavior, new thumbstick/snap-turn
features, new IK/naturalness algorithms, UI redesign, semantic scene-format
migration for its own sake, API/storage/auth changes, and export schema redesign.
Preserve portal view, bubble rendering, Quick Look and deployed configuration.

## Architecture and ownership contract

Names below describe responsibilities, not mandatory filenames. Prefer a small
number of cohesive systems and typed services over an entity/component for every
bone or a class for every method. Keep Three skeleton/IK objects in typed services;
make meaningful domain state visible through components. Reuse public SDK
features where they replace infrastructure without changing recorded behavior.

| Owner | Responsibility / permitted writes |
| --- | --- |
| World / runtime host | Single scene, renderer, render loop, XR lifecycle, cleanup, active render camera; tiny composition root |
| Input + tracking adapter | Valid per-frame head, hand, controller data and source/validity; explicit reference/rig/world spaces; no avatar scaling |
| Calibration system | Stable one-shot fit and explicit refit; asset-only scale and bind metrics; recording/export size lock |
| Movement system + CharacterMotor | Collision-aware artificial and room-scale root displacement; baseline Rapier capsule, slopes/steps and sensor exclusion |
| Animation / body pose systems | Preserve LocomotionAnimator, TerrainLegSolver, VrBodySolver and legIk; mutually exclusive lower-body ownership by mode |
| Tracked arm/hand system | Existing arm IK/finger retargeter; world/local conversions and calibrated reach; no competing head/root writes |
| Camera / presentation | World-locked real-VR origin, independent desktop views, transparent AR placement/recenter, diagnostics/spectator passes |
| Recording system | Sample completed pose once at simulation time; mic/raw input lifecycle, asynchronous export and locks; no playback-camera baking |
| UI adapter / diagnostics | Current DOM + VR recording/refit interactions, correct triggering controller/touch source; native inspectable state and bounded commands |

Before extraction, record current frame order and transform ownership from latest
main as executable acceptance criteria. Use native system priorities deliberately;
order constraints matter more than the labels above:

1. Within a valid XR frame, acquire/copy raw floor head and source data BEFORE
   physics/pose systems. Current `onRealtimeFrame` calls `captureFloorHeadPose`,
   raw input recording, and `noteXrFrame`. Preserve device order, not a test-only
   present-then-tick shortcut. No retaining XRFrame past its callback.
2. Handle session/reference changes, restore prior procedural corrections and
   update height/refit before dependent pose math. Snapshot a coherent origin.
3. Real XR room-scale: prepare/align the world-locked rig as required, plan root
   displacement, then pass it through the motor. Refresh head/world mapping after
   permitted rig changes; keep head-only turns/sway from moving the whole world.
4. Align root and run mixer. Real XR body solver owns hips/spine/head/legs/feet;
   legacy mock/desktop path uses additive crouch + terrain legs. Never apply both
   lower-body solvers to the same frame. Preserve pose restore on exit/refit.
5. Preserve current camera/rig update and matrix refresh before tracked arms/hands.
   Record only after final body and hand pose; draw after simulation. Debug
   spectator passes may draw more views, but never tick/sample a second time.

`avatarRoot`, environment and tracking rig retain unit scale. Only the avatar
asset gets calibrated scale; public height metrics are meters, bind/bone values
stay in their own units. Retain parent-local conversions, visual base compensation,
world-length IK caches, refit sampling interruption and recording/export size lock.
Keep floor-relative and rig/world coordinates explicit. Do not let IWSDK default
locomotion/grabbing/physics also write the origin or root. Retain current real-XR
world-lock semantics and separately preserve mock input behavior.

The SDK bootstrap captures a tracking camera/origin while rendering can select a
different camera. Preserve that identity deliberately: no double parenting of
`renderer.xr.getCamera()`, no camera-rig following the animated eye/head. Support
VR and AR entry from the same app, floor reference requirements, alpha/depth state,
resize and return to desktop. Inspect default input objects before reparenting
capture hands/grips; SDK input and recording should not steal each other's nodes.

Use one simulation time source. Native pause must freeze physics, animation,
calibration state, recording samples and raw recording time; fixed step must
advance them exactly once. Keep XR input acquisition valid while paused. Retain
`?manualClock=1`, `advanceTime`, `__setManualClock`, `__setFrameStepping`, body
fault injection, sampling and evidence hooks as adapters over that same pipeline,
with explicit mutually exclusive clock modes. Reconcile the SDK debugger's render-
loop stepping with IWER frozen clocks. Do not solve it with two independent loops,
wall-time sleeps, test-only simulation ordering, hidden retries or relaxed metrics.

## Delivery sequence and ownership

Follow current AGENTS.md, feature-delivery skill, FEATURE_WORKFLOW.md and
AGENT_CONTRACT.md in the new implementation tree. Claude leads integration and
owns this brief. Use separate read-only design review and independent verification
for changes to recording/retargeting. Assign one implementer per overlapping
module before any parallel work; bodies/orchestration/tracking/recording share
boundaries and cannot be edited independently without an agreed interface.

1. **Baseline.** Refresh source/hand-owner commits; record exact main SHA, versions,
   named test scenarios and existing failures. Run current XR/pipeline checks and
   save same-workload samples, deterministic hashes, screenshots and performance
   baselines before runtime edits. The room-scale brief reports a portal pipeline
   swipe failure reproduced on main (runs 39193786345 / 39213476784); recheck its
   current status. Do not attribute it automatically to the migration or hide it.
2. **Design review.** Commit a short decision/ownership table and extraction map.
   Identify default SDK systems to disable, native clock integration, cleanup,
   tracking-camera identity, production packaging and real MCP verification path.
3. **Runtime foundation.** Align dependencies; install World lifecycle with
   competing movement/physics disabled; wire current app through a temporary
   compatibility boundary. Desktop, VR/AR, height/body and export must remain
   runnable at this checkpoint. Do not claim the wrapper is completion.
4. **Feature extraction.** Move calibration, movement/body/animation, tracked
   hands, recording and presentation into ordered native systems/typed services.
   Keep established algorithms; remove superseded orchestration, session/render
   loop/bootstrap and fake framework-ready bridge. Retain a thin composition root.
   Commit coherent steps with relevant E2E evidence.
5. **Agent workflow and build.** Query meaningful native domain state and exercise
   real controls through installed CLI/MCP transport, not just calling in-page
   dispatch. Pause, single-step, diff snapshots and disable/restore a feature
   system; prove actual pose/record samples respond. Test reload/teardown and
   repeat session entry without leaked input listeners/canvases. Build/serve the
   production entry and preserve asset/worker/hosting paths. Make the prototype
   entry/test redundant or archive it; do not ship a second permanent runtime.
6. **Independent verification.** Run current suite from the brief, compare baseline
   behavior and faults, inspect actual renders/video and export readback. Compare
   performance on the same device/workload. Fix migration failures before handoff.
7. **Close.** Update only owning trackers, record deletions and retained custom
   code, commands, evidence, regressions and device gaps. Commit/push the verified
   implementation; run `verify:pr` before opening/updating a PR or merging. Use the
   current repository integration policy, no force push. This planning push does
   not merge the old prototype into production.

## Acceptance criteria

- [ ] Production capture uses one native World/scene/renderer and authoritative
  simulation pipeline; the old all-in-one orchestrator wrapper and fake native
  bridge are removed or reduced to genuine composition, with a deletion map.
- [ ] Desktop first/third person, keyboard, current VR controls, hand/controller
  switching, world-locked room-scale movement, AR spectator/recenter, XR exit/
  re-entry/visibility/reference reset and resize preserve current behavior.
- [ ] Locomotion, terrain, height/refit, body and hand scenarios retain current
  thresholds, input-source checks, device frame order and fault sensitivity.
  No fabricated tracked data or substituting mock input to make tests pass.
- [ ] At short/tall/seated/refitted sizes, base grounding and head/hand alignment
  remain correct. Recording startup, recording and asynchronous export preserve
  size lock, including exit/re-entry, denied mic and repeated UI actions.
- [ ] Full GLB event/bones/audio/bubble export still uploads and renders/animates
  in the current viewer and portal; USDZ remains valid. No camera-dependent
  corruption, playback scale drift, or loss of captured data.
- [ ] Real outer CLI/MCP transport discovers native components/systems, queries
  coherent body/tracking/calibration/recording state, pauses/steps actual samples
  with no wall-time catch-up, and requests real height refit while idle through
  a native control, with the same recording/export rejection as the UI.
- [ ] Deterministic replay modes share the production pipeline. Preserve byte-
  identical cold-run/cross-host evidence where current tests require it; retain
  all twelve body fault detections and substantive source/bone-derived metrics.
- [ ] Production build and managed development reload work, without duplicate
  frames, stale controllers, extra canvases or leaked resources. SDK runtime
  packages and shared Three/UIKit resolution are correct in production.
- [ ] Repeatable comparison records frame time/latency/memory/load observations
  and real benefits (deleted glue, simpler feature entry points, fewer custom
  agent hooks). Host-browser diagnostics are clearly labeled. No material
  regression is accepted without explanation and mitigation; investigate changes
  outside measured baseline variance before merging.
- [ ] Current `verify:agent` and complete `verify:pr` pass with inspectable
  artifacts; independent review has no unresolved migration findings. Device-only
  gaps remain explicitly unverified, not represented as a software pass.

## Failure cases considered

| Failure | Required shield |
| --- | --- |
| Old spike overwrites completed movement or new hand fixes | Fresh main worktree, selective port, refresh overlapping owners' commits |
| SDK defaults and custom motor both move rig | Explicit single writer, disabled default locomotion/physics |
| Body solver and terrain/crouch fight over bones | Mode-specific ownership + restore order + body/terrain regressions |
| Head read before camera is world-updated | Capture raw poses in valid XR frame, device-order replay and injected faults |
| Scale or parent origin applied twice | Height/refit/room-scale input-vs-bone metrics and unit-scale invariants |
| ECS paused but callbacks still tick/record | Actual sample/time counters frozen; step/restore checks through outer tools |
| SDK time overrides deterministic time | Single clock adapter, cold-run/cross-host hashes and resume bounds |
| Two render calls or lost spectator rendering | One presentation owner; preserve explicit diagnostics without a second tick |
| Negative audio ramps under fake clocks | Deliberate SDK playback boundary plus real microphone pipeline |
| Duplicate UIKit/Three modules or rig identity misses | Version alignment, structural flags, dev and production smoke |
| AR becomes opaque, head-relative or unrecoverable | AR alpha/reference/recenter/exit workflow in production entry |
| Hand events trigger other controller's action | Existing refit-source and touch/record regression scenarios |
| Export deadlocks after session exit | Real recorded GLB download + size lock/audio/asynchronous completion evidence |
| Tests weaken to hide a changed solver | Existing thresholds/faults and independent source-derived comparisons |
| Full SDK import increases cost unnoticed | Repeated same-workload baseline, production bundle/startup and device profiling |

## Validation plan

Read scripts in latest main before running. As of the observed baseline, capture
`test:xr` runs **mock-vr, locomotion, terrain, hands, height, body**. The pipeline
runs **capture-to-viewer, bubble-capture, portal**; viewer mocked E2E includes
hologram-feed and ar-bubble. Preserve all of them and current knowledge/tooling
checks; the old spike's smaller suite is insufficient.

Choose free ports and run browser suites sequentially unless all runtime resources
are isolated. Suggested, NOT reserved: capture 5774, viewer 3974, API 3801,
pipeline capture 5775. Do not stop another chat's managed server on 5174.

```bash
pnpm run verify:agent
DEV_PORT=5774 pnpm --filter @holoim/capture run test:xr:height
DEV_PORT=5774 pnpm --filter @holoim/capture run test:xr:body
DEV_PORT=5774 E2E_BASE_URL=https://localhost:3974 E2E_API_PORT=3801 \
  E2E_CAPTURE_URL=https://127.0.0.1:5775/ pnpm run verify:pr
```

For fault injection, use capture as cwd (the runner resolves script paths from
cwd):

```bash
cd apps/capture
DEV_PORT=5774 BODY_REPLAY_FAULTS=1 node scripts/run-xr-checks.mjs body
```

Save before/after body and hand samples/reports and fault matrix; height/refit
JSON and fixed-scale rendered images; terrain contacts/transitions; recording
frame/time evidence; downloaded GLBs; viewer/portal/bubble and USDZ artifacts;
outer-MCP transcript; production asset/load and cleanup diagnostics; performance
method/environment/results; final deleted/retained infrastructure map.

If headset hand input lands, include that fixture with the owner's accepted
thresholds, distinguish it from synthetic IWER fixtures, and keep all validity
and coverage assertions. Do not change the threshold policy as part of migration.
If native Quest access is unavailable, finish software work and publish explicit
missing-device measurements; do not claim latency/comfort/performance proof.

## Planning validation

This is a documentation-only handoff prepared against the pinned refs above.
Prototype test results are historical evidence, not new baseline runs. No runtime
source, shared uncommitted work, application dependencies or test thresholds were
modified here. Planning checks passed: local documentation links, pinned Git source references,
current validation scripts/suite membership, and whitespace. Runtime suites are
requirements for Claude's implementation, not claimed planning results.

## Implementation record

### Baseline (main `de26df9eb70c`, 2026-10-19, macOS host, Node 22.23.3)

Runtime versions before migration: `@iwsdk/*` 0.5.3 (dev-only), IWER 2.3.0 via
the dev plugin, `super-three` r181, `@pmndrs/uikit` 1.0.75+.

| Check | Result | Artifacts (`apps/capture/output/`) |
| --- | --- | --- |
| `test:xr` (mock-vr, locomotion, terrain, hands, height, body) on port 5774 | mock-vr, locomotion, terrain, hands PASS; **height FAILED** (`short calibrated height: 0 expected 1.25`) after the four earlier checks, so body did not run in that invocation | `baseline-xr/` |
| `test:xr:height` alone | PASS (21.1 s) | `baseline-height/` |
| `test:xr:body` alone | PASS (45.8 s, five fixtures) | `baseline-body/` |
| Body fault matrix (`BODY_REPLAY_FAULTS=1`) | PASS: 12/12 faults caught by their metrics (170.9 s) | `baseline-body-faults/fault-matrix.json` |

**Dependency step (old runtime, new SDK).** With `@iwsdk/core|cli|vite-plugin-dev|scene-composition`
1.0.1, IWER 2.6.0 and capture's UIKit pinned to 1.0.77, the unchanged custom
runtime passed mock-vr, locomotion, terrain, hands and height (68.1 s) and body
(45.1 s). Every deterministic sample file (five body replays, hand replay,
locomotion samples) is **byte-identical** to the main baseline
(`output/iwsdk-refactor/deps-old-runtime/`). These hashes are the exactness
target for the refactored runtime. The height report is not deterministic even
between two runs on main (it differs in thousands of lines), so height is
compared by its assertions, not by hash.

The height failure on unmodified main is a test race (see D1 under Independent
verification): the check froze the page clock before XR frames started.

### Design decisions

1. **World owns the scene, renderer, XR session lifecycle and ECS; capture owns
   one frame loop on World's renderer.** IWSDK's built-in loop always renders
   `world.camera` after `world.update` and reads XR input only inside the
   (pausable) ECS update. Capture needs device-order input acquisition that stays
   valid while the ECS is paused, a draw/no-draw decision per frame for
   deterministic replay, and a diagnostic pass after the main draw. The capture
   `FrameLoop` replaces the SDK loop through the public
   `renderer.setAnimationLoop` and calls `world.update(delta, time)` exactly once
   per simulated step, so the SDK debugger's pause/step (which wraps
   `world.update`) controls the real simulation. One loop, one clock.
2. **One simulation clock with explicit, mutually exclusive modes:**
   `realtime` (default), `manual` (`?manualClock=1` / `__setManualClock`; frames
   only present, `advanceTime` steps 1/60 s synchronously) and `frame-stepping`
   (`__setFrameStepping`; each XR frame steps with its own delta, as a headset).
   Simulation time is accumulated by the first ECS system, so a paused ECS freezes
   time and recording timestamps, and one debugger step advances them once.
3. **SDK features that would become a second owner are off or removed:**
   locomotion, physics, grabbing, spatial UI, canvas pointer forwarding are
   disabled in `World.create`. `InputSystem` is unregistered: it would load and
   render its own controller/hand models from a CDN and drive ray pointers,
   while capture reads three's controllers/hands. `AudioSystem` is unregistered
   and its unused listener detached (wall-clock AudioParam ramps break under
   replay's rebased clock; capture audio is MediaRecorder). Rapier stays.
4. **XR entry uses `world.launchXR`/`exitXR`.** The VR request is identical to
   three's VRButton (optional `local-floor`, `bounded-floor`, `layers`,
   `hand-tracking`; `offerSession` via `offer: 'always'`), with `local-floor`
   required at reference-space resolution. AR keeps `local-floor` mandatory the
   same way, but the request now lists it as optional and also offers `layers`;
   an AR device without `local-floor` now starts then ends the session instead of
   rejecting the request. `#VRButton`/`#ARButton` keep their DOM, text and style.
5. **Capture's rig, cameras and world group stay plain three objects, not ECS
   transform entities.** IWSDK's `TransformSystem` replaces an entity's
   `position`/`quaternion`/`scale` with views over `Transform` storage, which is
   `Float32Array` (elics `Vec3`/`Vec4`). Using `world.player` as the camera rig
   would round every rig write to float32 and change replay results. The capture
   rig parents the XR tracking camera; a separate desktop camera is selected only
   by the frame loop's present step; `renderer.xr.getCamera()` is never parented.
   World's own player/camera are left unused (`restoreCameraOnExit: false`).
6. **Renderer differences accepted from World:** the canvas context is opaque
   (capture's desktop background is always opaque; XR layers carry alpha
   regardless), and three's `multiviewStereo` is enabled, which only takes effect
   with WebXR layers on devices with `OCULUS_multiview` (Quest). That path cannot
   run in IWER and is a physical-device gap.
7. **Systems keep current frame order exactly** (priorities below), with typed
   services holding Three/Rapier objects and ECS components publishing domain
   state. Native controls are component fields consumed by the owning system with
   the same rules as the UI (refit request, recording toggle).

| Priority | System | Owns (writes) | Was in `AppOrchestrator.update` |
| ---: | --- | --- | --- |
| 0 | `SimulationClockSystem` | simulation step count and time | `tick` accumulators |
| 5 | `CaptureControlSystem` (dev builds) | applies native control requests (`refitRequested`, `toggleRequested`) through the UI's services | — (new) |
| 10 | `XrSessionSystem` | XR enter/exit handling, AR spectator placement, head pose, look yaw, desktop/mock rig placement | transition block, AR path, `updateHeadPose`/`syncYaw`, mock/desktop rig |
| 20 | `RoomScaleSystem` | real-XR rig alignment and planned root displacement | `prepareBodyFrame` |
| 30 | `CalibrationSystem` | restore of last frame's procedural pose, height fit/refit, asset scale | `restore*`, `updateHeightAdaptation`, `requestHeightRefit` |
| 40 | `MovementSystem` | crouch amount, Rapier motor, rig carry, avatar root | `updateCrouchState`, motor, rig carry, `syncAvatarPoseFromCharacter` |
| 50 | `BodyPoseSystem` | mixer, body solver vs. crouch/terrain legs | animator, solver/crouch/terrain |
| 60 | `CameraSystem` | rig/desktop camera, first-person visuals | `camera.update`, rig matrices |
| 70 | `TrackedHandsSystem` | arm IK, finger retargeting, hand sensors | `updateVrHandEmbodiment` |
| 80 | `CaptureUiSystem` | mode publication, VR recording panel | `publishMode`, `vrHud.update` |
| 90 | `RecordingSystem` | recorded frame sampling | `recorder.capture` |
| 100 | `DiagnosticsSystem` | head-path and hand-joint overlays | overlay updates |
| 110 | `CaptureStateSystem` (dev builds) | publishes domain state to the `capture` entity's components | — (new) |

#### Design review outcome (independent read-only reviewer, 2026-10-19)

Accepted changes to the plan:

- Rig/camera precision (decision 5) was independently confirmed: three's
  `updateUserCamera` would also round the tracked camera pose if it were an
  entity. Camera fov 70, near 0.005, far 2000 at (0, 2, 6) stay capture's own.
- Every simulated step is followed by a present step (draw or matrix-only),
  including each `advanceTime` step and debugger steps; present is skipped until
  assets have loaded, as before. The frame loop is installed after `World.create`
  resolves (the SDK loop must run the initial level load) and `?manualClock=1` is
  applied before the first capture frame. Simulation time does not accumulate
  before capture systems start.
- XR enter/exit handling stays one synchronous block in `XrSessionSystem` that
  calls camera, motor, crouch, calibration, body, retargeter, HUD and input
  services in the original order. Cross-owner writes inside height adaptation
  (crouch reset, arm-chain lengths, body rescale/reset, camera floor origin, UI)
  are explicit service calls from `CalibrationSystem`. All later systems check
  one `arSpectator` flag computed after transitions; `bodyActive` stays stale in
  AR because `__sampleBody` reads it.
- Native controls are applied before calibration runs (implemented as
  `CaptureControlSystem` at priority 5, development builds only), so a
  recording start still locks size before the height fit runs that step. UI and VR select keep calling services synchronously, and
  `requestHeightRefit` still returns its result immediately.
- Debugger interplay: the frame loop calls `world.update` through the property
  every time (the SDK debugger rewraps it). While the SDK debugger is paused,
  `advanceTime` throws instead of silently doing nothing (frame stepping, like
  realtime frames, simply does not advance);
  `ecs_step` is supported in the realtime clock mode only. Raw headset input
  recording follows device frames and keeps recording while paused (it is the
  device's record, not simulation output).
- `EnvironmentSystem` and `LightSystem` are unregistered too: the environment
  system would clear the AR background and clear alpha, duplicating capture's AR
  spectator owner. `LevelSystem` stays only for World's initial empty level;
  capture never loads levels. The frame loop updates `world.visibilityState`
  each frame as the SDK loop did.
- XR entry keeps a pending session mode set by the button, settled on
  `sessionstart`, and cleared when a request ends without a session. Button text
  follows `sessionstart`/`sessionend`, so offered sessions are reflected.
- Scene graph and window listener counts are diffed against the old runtime to
  confirm unregistered SDK input objects add nothing visible or leaking.

The spectator and height-evidence renders stay post-draw passes of the frame
loop's present step; they draw extra views but never tick or sample.

### Result

Capture's production entry runs on IWSDK World with one frame loop and ordered
systems; every deterministic replay sample is byte-identical to the
pre-refactor runtime on the same SDK versions.

**Structure.** `src/main.ts` boots `runtime/createCaptureRuntime.ts`, the
composition root (218 lines): `captureStage` (World and its SDK boundary,
scene objects), `xrEntry` (`#VRButton`/`#ARButton` over `world.launchXR`),
`FrameLoop` (the only animation loop and clock), `automationHooks` and
`captureTextState`. `src/systems/` holds the eleven ordered systems plus the
dev-only native state/control pair, reading typed services from
`captureContext`. New services own state the orchestrator used to hold:
`BodyTracking`, `CrouchState`, `HeightFit`, `HandEmbodiment`
(+ `LegacyFingerRetargeter` for `?handRetargetMode=legacy`), `RecordingSession`,
`ArSpectator`, `DiagnosticViews`, and `XrTracking` + `MockVrPose`.

**Deleted** (old line counts): `app/AppOrchestrator.ts` (1,587),
`xr/XrSessionService.ts` (1,102, replaced by `XrTracking` 751 + `MockVrPose`
96: one input-slot table instead of three copies of grip/hand/controller code),
`scene/SceneBootstrap.ts` (185, incl. the custom AR button and three's VRButton),
`debug/DebugBridge.ts` (77), `app/createApp.ts` (65), the stub
`debug/iwsdkMcpRuntime.ts` (28), the unused teardown chain (`dispose` methods,
`System`/`FrameContext` contracts), dead members (`bodyCapsuleBefore`,
`isLikelySidePosition`, `AudioRecorder.clear/hasPermission`, unused constructor
parameters), `InputController`'s eight camera getter/setter callbacks (now a
typed `DesktopLook`), hand-written finite checks (shared helpers), the duplicate
resize `setSize` (World sizes the canvas) and the dead `src/scene` chunk rule.
Total capture source is about the same size (9,692 → 9,878 lines, including
~370 new lines of native ECS state/controls and XR entry that three's VRButton
used to provide); no file now owns more than one concern.

**Retained deliberately:** Rapier `CharacterMotor`, `LocomotionAnimator`,
`TerrainLegSolver`, `VrBodySolver`/`legIk`, height calibration, arm IK and
finger retargeting algorithms (unchanged apart from finite-check helpers); the
automation hooks and their names; `?manualClock=1`; the DOM overlay.

**SDK boundaries** (each documented at its call site and in
`docs/IWSDK_AI_WORKFLOW.md`): capture's frame loop replaces World's loop;
`InputSystem`, `AudioSystem`, `EnvironmentSystem`, `LightSystem` are
unregistered; World's locomotion, physics, grabbing and spatial UI are off;
three's shared audio context is an `OfflineAudioContext` (World.create would
open a real one for a listener capture removes); capture's rig, cameras, world
group and avatar are never ECS transform entities (float32); production builds
give UIKitML empty kits and a two-icon lucide subset; `restoreCameraOnExit` is
off.

#### Evidence

| What | Result | Where |
| --- | --- | --- |
| Deterministic exactness | After every refactor commit, body (5 fixtures), hand replay and locomotion samples were byte-identical to the dependency-step reference (runs r1–r5) | `output/iwsdk-refactor/r*/`, `apps/capture/output/r*-*` (local) |
| Capture XR suite | mock-vr, locomotion, terrain, hands, height and body pass in one run; height alone 6/6 after the D1 fix | `xr-smoke.log` |
| Body fault matrix | 12/12 caught; every failure message (with its metric value) identical to main's | `apps/capture/output/r5-body-faults/fault-matrix.json` |
| Pipeline | capture-to-viewer and bubble-capture passed in all 4 refactor runs. Portal passed 3 of 4: one post-merge run failed the viewer's phone-feed swipe assertion (`swipe scrolls the feed while playing`), the intermittent failure the room-scale brief recorded on main CI; it passed in the 2 immediate re-runs, as did 2 runs on main | `pipeline*.log` |
| Viewer AR / mocked | 9/9 pass | `xr-smoke.log` |
| `verify:pr` | doctor, lint, typecheck, all unit tests and every build pass. Knowledge Atlas e2e fails identically on untouched main here: another session's Atlas server holds 127.0.0.1:4176 and the config reuses it, so fixtures written in this worktree are never served (`check:docs` passes) | `verify-pr.log` |
| Native ECS through the outer CLI | Systems listed in frame order; pause holds state through wall time; `ecs step` advances exactly N steps and N/60 s; native recording samples once per step at simulation time; toggling `RecordingSystem` stops and resumes samples; refit refused on desktop and while recording, accepted after export; VR enter/exit through World's offered session; no browser errors | [CLI transcript](../evidence/iwsdk-runtime-refactor/ecs-cli-transcript.md) |
| Reload and re-entry | After a source edit the managed page reloads with one canvas and one set of systems; two VR enter/exit cycles re-offer the session, track controllers, no errors; World's unused player meshes stay invisible on desktop and in VR | managed runtime on 5874 |

#### Same-workload comparison (production builds, headless Chromium, SwiftShader, this Mac)

| Measure | main | refactor | Notes |
| --- | ---: | ---: | --- |
| Startup JS (index + preloaded chunks) | 3,915 KB / 1,475 KB gz | 4,772 KB / 1,545 KB gz | World runtime: ECS, xr-input, locomotor, scene composition. Before the UIKitML boundary the xr chunk alone was 6.66 MB |
| Time from navigation to "Loaded" (5 runs) | 247–256 ms | 310–385 ms | Larger parse plus World init; World's audio context removed ~190 ms |
| Retained JS heap after load + GC | 51 MB | 48 MB | Was 78 MB before the UIKitML boundary (zod schemas) |
| Steady frame (desktop, drawing) | 50–58 ms | 50–58 ms | Software GL bound |
| 600 simulation steps, idle / walking | 542–567 / 72–75 ms | 611–629 / 100–105 ms | Same end state; ~+0.05–0.1 ms per step on this host, spread across system dispatch and scene updates; no single hotspot |
| Deployed assets on disk | 4.4 MB | 14.6 MB | UIKitML's per-font chunks are lazy and never fetched |

These are host-browser diagnostics, not device performance. Quest CPU/GPU
frame time, latency, memory and thermals on the same workload remain
unmeasured; the per-step overhead and three's multiview path (enabled by
World's renderer, active only with WebXR layers on Quest) are the first
things to profile there.

#### Remaining limits

- Physical-device validation (Quest performance, multiview rendering, AR on a
  headset or phone, tracking feel) has not been run.
- AR session request now lists `local-floor` as optional (it stays mandatory at
  reference-space resolution) and offers `layers`; a device without
  `local-floor` starts then ends the session instead of rejecting the request.
- World's offer flow re-offers VR after any session end, where VRButton only
  re-offered after its own exit click.
- Native ECS controls apply at the next simulation step; under the manual
  clock that is the next `advanceTime`. `ecs step` is for the realtime clock.
- Pre-existing: the height report is not byte-deterministic between runs on
  main; Knowledge Atlas e2e depends on a free 4176.

#### Independent verification (separate agent, 2026-10-19)

Exactness re-run independently: every locomotion, hand and body sample and
report, and all 25 fault-matrix files, byte-identical to the references; 12/12
faults caught. Every block of the old `update()` was traced to its system with
order and conditions preserved; the clock and all 15 debug hooks match. One
canvas (plus IWER's overlay in a session), one loop owner, one main draw per
frame, listener counts stable across VR/AR re-entry, production preview loads
without errors.

**D1 (fixed):** `test:xr:height` alone failed 3 of 4 runs on the refactor (6/6
on main). The check froze the page clock as soon as the app reported VR mode;
three starts its XR frame loop only after real-time work in session entry, and
World's entry adds a reference-space probe before `setSession`, so the first
XR frame could be starved. The same race caused the baseline full-suite failure
on main. The check now calls the harness's `waitForXrRenderLoop` after freezing
the clock and after re-entry, as the body and hand replays already do (frames
released under the manual clock change no state); assertions are unchanged.
Height then passed 6/6 alone.

**After merging `origin/main` `c6bec9bc0492`** (GLB optimizer terrain fix,
Atlas spec fix, auto-deploy): typecheck, lint and unit tests pass; the full
capture XR suite and body pass with every sample still byte-identical; the
production build preserves both GLBs and loads in 286 ms with a 48 MB heap and
no errors.
