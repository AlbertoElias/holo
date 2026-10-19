# Feature brief: Native IWSDK capture runtime refactor

**Lead:** Claude Code
**Status:** Implementing on `infra/iwsdk-runtime-refactor` (from `origin/main` `de26df9eb70c`)
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

The height failure is pre-existing on unmodified main: it reproduced only when
height ran after the other checks in one server, and passed alone. It is tracked
here as a baseline flake, not a migration regression; the same full suite is
rerun on the refactor and compared.

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
5. **Tracking camera identity:** `world.player` (XROrigin) is capture's camera
   rig and `world.camera` the XR tracking camera; a separate desktop camera is
   selected only by the frame loop's present step. `world.camera` is never
   swapped, and `renderer.xr.getCamera()` is never parented.
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

The spectator and height-evidence renders stay post-draw passes of the frame
loop's present step; they draw extra views but never tick or sample.
