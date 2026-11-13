# Closed Bugs (archive)

Closed entries moved from `BUGS.md` so the live tracker stays scannable.
`BUGS.md` remains the authority for open, verified defects.

### B-001 — XR locomotion runner lacks an observable final result

- **Area:** `apps/capture` test tooling
- **Severity:** P2 — test confidence / developer workflow
- **Observed:** 2026-08-10
- **Evidence:** `pnpm run test:all` created the expected locomotion screenshots,
  but the enclosing command returned without the final pass/fail transcript or the
  subsequent viewer test output.
- **Expected:** The command exits with a clear pass/fail status after all capture
  and viewer test stages, and leaves no child server or browser process behind.
- **Reproduction:** Run `pnpm run test:all` on a desktop host where Playwright can
  launch Chromium.
- **Fix:** The runner now prints explicit final `PASS`/`FAIL` output, preserves a
  non-zero status on failure, timeout, or interruption, and terminates the dev-server
  and browser process group. The tooling integration suite proves a hung command is
  bounded and a descendant cannot survive a successful direct-child exit. `pnpm --filter @holoim/capture run
  test:xr:flows` passed with final cleanup output, and port 5174 was immediately
  available afterward.

### B-002 — Avatar fingertips do not meet during tracked pinch

- **Area:** `apps/capture` hand/finger retargeting
- **Severity:** P1 — core VR embodiment quality
- **Observed:** 2026-08-15
- **Evidence:** A physically coherent IWER source pinch reduced thumb/index distance
  from 9.01 cm to 1.30 cm, while the avatar initially retained a 5.52 cm gap.
- **Expected:** The avatar preserves the tracked hand's relative pinch closure and
  reaches fingertip contact on both hands.
- **Reproduction:** Run `pnpm run test:xr:capture` with the pre-fix retargeter and
  coherent joint-position fixture.
- **Fix:** Current uncommitted working tree adds automatic open-hand reference
  learning plus calibrated fingertip contact correction. `pnpm run test:xr:capture`
  passes at 1.19 cm right / 0.90 cm left; capture `verify:fast` and `verify:full`
  also pass.

### B-003 — Scheduled XR locomotion flow is slow and flaky on CI

- **Area:** `apps/capture` test clock and XR harness
- **Severity:** P1 — CI reliability
- **Observed:** 2026-09-28 to 2026-10-11 (10 of 14 nightly runs failed)
- **Evidence:** the flow took 268–606 s on GitHub runners against 60 s locally,
  tripping the 180 s and then 600 s guards; the 2026-10-05 timeline shows a queued
  jump that never applied. A 2-vCPU Docker reproduction of `main` took 372 s and
  failed the same `jump-airborne` step.
- **Cause:** realtime frames ticked and rendered between deterministic steps (and
  window events cleared edge-triggered input); every simulated step drew a
  software-GL frame; IWER composited and GPU-synced every device frame.
- **Fix:** capture's manual clock (`__setManualClock`) stops realtime ticks,
  stepping no longer draws, tests freeze page timers after XR entry, and inputs
  apply in the same page turn as their first step. Same reproduction: 31 s for
  both capture XR suites, with identical results across runs. Details in
  [`../features/archive/deterministic-lean-ci.md`](../features/archive/deterministic-lean-ci.md).

### B-004 — VR hand targets land near the room origin instead of the avatar

- **Area:** `apps/capture` XR camera rig
- **Severity:** P1 — VR embodiment broken on device whenever the avatar is away from the origin
- **Observed:** 2026-10-17 by the new headset-input replay (`test:xr:hands`)
- **Evidence:** wrist error 2,104 cm; IK targets at y≈1.5 while the avatar stood at y≈22.
- **Cause:** `SceneBootstrap` parented `renderer.xr.getCamera()` to the camera
  rig. three.js writes that camera's world pose into its position, so
  `getWorldPosition()` applied the rig twice and `updateHandTrackingTargets`
  subtracted a head position one rig-offset too high. VR crouch read the same
  camera's world height as tracking-space height.
- **Fix:** stop parenting the XR camera; read tracking-space head height from the
  rig-local user camera. Wrist error dropped to 8.7 cm; reintroducing the
  parenting fails `test:xr:hands` at 2,083 cm.

### B-006 — Viewer AR never placed the model; tests passed on a preview status

- **Area:** `apps/viewer-web` AR placement
- **Severity:** P1 — hit-test placement never ran on any device
- **Observed:** 2026-10-17 while adding placement geometry checks
- **Cause:** the hit-test effect reported `searching` but never set the runtime
  placement stage, so the frame loop, timeout fallback, and IWER assist all
  waited forever in `unplaced`. The controller's IWER/timeout preview reported
  `placed` anyway, which satisfied the old checks; the hit-test-disabled check
  patched an `XRSession` prototype IWER never used.
- **Fix:** enter `searching` in the runtime state; accept only upward-facing
  hit-test surfaces; report the placed position. Checks now require a
  model-reported position in front of the viewer on a surface, and disable
  hit-test through IWER's supported features.
- **Follow-up (2026-10-17):** removed the IWER-only placement assist. It raced the
  real hit-test on slow runners and could place the model outside the emulated
  room; IWER implements `frame.detectedPlanes`, so the standard path covers it.

### B-005 — Avatar finger shape and wrist placement diverge from tracked hands

- **Area:** `apps/capture` hand retargeting and arm IK
- **Severity:** P1 — VR embodiment fidelity
- **Observed:** 2026-10-17 by `test:xr:hands` (finger curl off by 30–68°, wrist 7.5 cm and 49° off)
- **Causes:** (1) the index–pinky mapping aimed each phalanx along the segment one
  joint earlier (the proximal phalanx followed the metacarpal); (2) `toBindAimInParent`
  reused its caller's scratch vector, so every finger bone aimed with its parent
  segment's axis; (3) `captureTrackedHandJoints` reused the caller's scratch
  vector, so the hand target became the pinky tip, ~10 cm past the wrist;
  (4) hand rotation came from hand-tuned Euler offsets instead of the tracked palm.
- **Fix:** anatomical mapping generated per finger; dedicated scratch vectors;
  hand rotation aligns the avatar palm frame (wrist, index/middle/pinky
  knuckles) to the tracked palm frame. On IWER's relaxed/point/pinch poses: curl
  error thumb 8.4°, others ≤ 3.9°, correlation ≥ 0.98, wrist 0.0 cm / 0.0°,
  segment jitter 1.01× tracked. CI now enforces 15°, 0.9, 2 cm, 10°, 1.5×.

### B-007 — Viewer AR spams `GL_INVALID_OPERATION` during IWER sessions

- **Area:** `apps/viewer-web` AR depth occlusion
- **Severity:** P3 — rendering correctness; on device the occlusion draw could be rejected
- **Observed:** 2026-10-17 in `test:xr:viewer`
- **Evidence:** `glDrawElements: Active draw buffers with missing fragment shader
  outputs`, 56 times per AR session until Chromium suppressed it. A draw-call
  trace (`getError()` after each draw) pinned it to three.js's WebXR
  depth-sensing `ShaderMaterial`, drawn to the XR framebuffer with color writes on.
- **Cause:** three's `WebGLRenderer` draws `xr.getDepthSensingMesh()` itself in
  every XR render once the session grants GPU depth sensing. Its shader writes
  only `gl_FragDepth`. `ARDepthOcclusion` made the mesh depth-only
  (`colorWrite = false`) only when occlusion was enabled, and occlusion is
  disabled under IWER, so three drew the unconfigured mesh and WebGL rejected
  the draw. When enabled, the component also added the mesh to the scene,
  which drew it a second time.
- **Fix:** `ARDepthOcclusion` makes three's mesh depth-only whenever it exists,
  uses `visible` as the on/off switch, and no longer adds it to the scene. The
  viewer e2e fixture now fails on `GL_INVALID_OPERATION` console warnings; the
  pre-fix component fails the placement test that way. With occlusion forced on
  under IWER, the depth pass draws every frame with the color mask off and no
  GL errors. `test:xr:viewer` (2 passed, 0 GL errors), `test:smoke:pipeline`, and
  `verify:agent` pass. This is emulation evidence, not a headset run.

### B-009 — On a headset, VR hand targets land ~21 m from the avatar (B-004 in device frame order)

- **Area:** `apps/capture` XR head pose (`XrSessionService`)
- **Severity:** P1 — VR hands broken on device while IWER checks passed
- **Observed:** 2026-10-18 while investigating room-scale body motion
- **Evidence:** with the simulation ticked inside the XR frame (a headset's
  order), wrist error 21.0 m in an IWER probe and 2,082 cm in `test:xr:hands`;
  in the harness's old manual-clock order, 0.0 cm.
- **Cause:** during an XR frame three.js leaves `renderer.xr.getCamera()`
  holding the tracking-space left-eye pose until `render()` calls
  `updateCamera`; `updateHandTrackingTargets`, `getCurrentHeadLocalY`, and the
  hand-side scoring read it as world space. The replay harness ran
  `updateCamera` before each simulation step, which hid it.
- **Fix:** `XrSessionService.updateHeadPose()` reads the eye midpoint and
  orientation from the XR views' tracking-space transforms
  (`getCamera().cameras[i].matrix`) and maps them through the rig, independent
  of render order; all head consumers use it. The hands and body replays now
  tick inside XR frames (`__setFrameStepping`), and `test:xr:hands` fails at
  2,082 cm with the old read. Emulation evidence, not a headset run.

### B-010 — Hand sensor spheres block the character in VR

- **Area:** `apps/capture` physics (`CharacterMotor`)
- **Severity:** P1 — VR movement stalls or is cut short
- **Observed:** 2026-10-18 by the room-scale body replay
- **Evidence:** with 3 cm of movement requested per frame, the capsule moved
  0 on alternating frames; the controller reported collisions with the hand
  sensor colliders, which sit inside the capsule's radius in front of the body.
  The VR locomotion check passed partly because of this: its sideways trial
  travelled only a short way.
- **Cause:** `computeColliderMovement` included sensor colliders.
- **Fix:** movement queries pass `QueryFilterFlags.EXCLUDE_SENSORS`. The VR
  locomotion check now runs on the flat test floor, since freed movement on the
  default scene's spawn slope runs off a drop.

### B-011 — A standing character creeps down slopes

- **Area:** `apps/capture` physics (`CharacterMotor`)
- **Severity:** P2 — drift while idle; exposed by the B-010 fix
- **Observed:** 2026-10-18 by `test:xr:mock` (dropout recovery fingertip
  3.8 mm off; limit 2 mm)
- **Evidence:** on the default scene's spawn slope the avatar slid 2.3 mm/s
  with no input.
- **Cause:** the character controller slides the grounded gravity step along a
  walkable slope; the hand sensors had been holding the capsule in place.
- **Fix:** a grounded character with no movement keeps its horizontal
  position. `test:xr:mock` passes; the probe shows no drift over 2.4 s.

### B-012 — Room-scale motion does not reach the avatar's body in VR

- **Area:** `apps/capture` VR embodiment (`CameraController`, `CharacterMotor`,
  `AppOrchestrator`)
- **Severity:** P1 — VR embodiment and recordings
- **Observed:** 2026-10-18 (investigation for the room-scale body brief)
- **Evidence:** walking the IWER headset 1 m left the avatar where it stood;
  the camera rig sat 0.08 × avatar height in front of the eye anchor along the
  look direction, so turning in place swung the world around a ~14 cm circle;
  body yaw copied head yaw every frame; the avatar head never pitched or
  rolled; feet slid under a fixed-rate walk clip.
- **Fix:** `VrBodySolver` (root follows the head through the physics
  controller, body yaw with a neck allowance and turn lag, planted stepping
  feet, leg IK, pelvis and spine solved to put the avatar's eyes on the
  tracked eyes, head orientation) and a world-locked rig. `test:xr:body`
  measures it; its fault run shows each behavior's metric failing when broken
  (for example the old rig placement fails world lock). See
  [`../features/room-scale-body-motion.md`](../features/room-scale-body-motion.md).

### B-013 — XR replay tooling: fixtures with unmoved wrists, slow and order-dependent frames

- **Area:** `apps/capture` and `packages/tooling-testing` test tooling
- **Severity:** P2 — test fidelity and CI time
- **Observed:** 2026-10-18
- **Evidence:** (1) `iwer-poses-relaxed-point-pinch.json` held both wrists at
  IWER's default (−0.25, 1.5, −0.4) although the generator moved them; (2) a
  CPU profile of a replay spent 5.3 s of 8.4 s in `getParameter`; (3) once
  frames were fast, replays started before three's XR loop and the first
  sample's time varied (19, 32, 34 ms) between runs.
- **Causes:** (1) IWER's DevUI rewrites device and hand transforms every
  frame unless `controlMode` is `programmatic`; (2) IWER reads the clear
  color, depth, and stencil with `gl.getParameter` around every emulated frame,
  and each read stalls software GL; (3) three awaits a real-time
  `makeXRCompatible()` before starting its XR loop, and the frozen clock's
  16 ms frame grid is phased by real time.
- **Fix:** generators set programmatic control (the hand fixture was
  regenerated, `test:xr:hands` passes); `attachXrEnvironment` tracks clear state
  so those reads do not stall (about 6× faster frames); `waitForXrRenderLoop`
  waits for steady XR frames and aligns the frozen clock to a 48 ms boundary
  before a replay. Three runs of the same replay produce byte-identical samples.

### B-014 — Avatar falls through the scene in the production capture build

- **Area:** `apps/capture` build + physics
- **Severity:** P1 — capture unusable at the deployed URL
- **Observed:** 2026-10-19 at https://holoim-capture.pages.dev
- **Evidence:** A Node simulation running the real `CharacterMotor` against
  the built `scene.glb` fell from y 22.26 to y 1.91 in 5 s; against the
  source GLB it stayed grounded at 22.25. The optimizer's output flipped
  winding on ~850 of 5570 trimesh triangles (up-facing 3702 → 2852) and
  mirrored some meshes, and its public-dir path ignores `exclude`.
- **Cause:** `optimizeGLTF` rewrote `scene.glb`; Rapier reads downward
  triangles as ceilings, so floors stopped colliding. Development never
  optimized the asset, so local and CI flows stayed grounded.
- **Fix:** `scene.glb` joins `avatar.glb` in the copy-verbatim preserve
  mechanism in `vite.config.ts`; `buildWorldTrimeshData` also aligns each
  triangle's winding with its vertex normals as defense. New
  `CharacterMotor.test.ts` covers flipped-winding floors; the rebuilt
  `dist/gltf/models/scene.glb` is byte-identical to source and the
  simulation stays grounded. Redeployed to Pages and verified live.
### B-015 — VR Start Recording pill invisible / unclickable on headset

- **Area:** `packages/xr-ui-three`, `apps/capture` VR HUD
- **Severity:** P1 — recording could not be started in VR
- **Observed:** 2026-10-18 on Quest 3; reproduced in IWER (`test:xr:mock` screenshots showed no pill)
- **Cause:** three stacked defects: UIKit's px→unit conversion plus the group scale `0.0013` rendered the pill 4.4 mm wide; UIKit's instanced glyphs drew blank text on device; the select ray started at the hand, which can sit past the 0.55 m panel plane; pills were `depthTest: false` (always over the hands).
- **Fix:** plain Three.js pills with canvas-drawn text (0.44 m), hover and press feedback, a visible aim ray per controller, select along the controller's aim line extended 0.6 m behind the hand, and touch-to-toggle (tracked hand within 14 cm of the record pill, re-armed after 1.2 s); depth-tested. Found and first fixed in the device session (which hit-tested from the head; replaced so the drawn ray and the selectable target agree), ported in `infra/iwsdk-runtime-refactor`. Verified in IWER: select with the hand 0.8 m out, touch toggle, and the height check's real-VR refit select ([screenshot](../evidence/iwsdk-runtime-refactor/b015-vr-pills.png)); recording on device in the original session.

### B-016 — Stop/export hangs forever in "exporting"

- **Area:** `apps/capture` recording stop path
- **Severity:** P1 — UI locked, avatar size locked, headset input recording lost
- **Observed:** 2026-10-18 on Quest 3
- **Cause:** stop awaited `requestAnimationFrame` before saving the headset input; with the headset asleep or the session ended that frame never fires. The same unbounded wait sat in `GltfExportComposer`.
- **Fix:** the input save runs first on stop; frame waits fall back to 100 ms (`shared/async.ts`); GLB export is capped at 60 s and the input upload at 15 s. Regression check `test:xr:recording` (in `test:xr`) stalls frames during stop and fails without the fix. Verified on device in the original session (fixture saved, `meta.source: headset`).

### B-008 — Mobile Upload button covers the hologram title

- **Area:** `apps/viewer-web` feed layout
- **Severity:** P2
- **Observed:** 2026-10-18
- **Evidence:** At a 390×844 viewport the collapsed Upload button sits on top of
  the card's title pill; only "By Albe…" and the time stay visible.
- **Expected:** The hologram name and author are fully readable on phones.
- **Reproduction:** `pnpm run dev:viewer`, upload any GLB, open
  `https://localhost:3174/` at 390×844.
- **Fix:** `a664ebe2f9dd` reserves a mobile bottom row for Upload/audio and
  constrains metadata between side controls. The original 390×844 layout fails
  the browser overlap assertion; 320×568, 390×844, 667×375, and 768×1024 pass
  with readable titles/bylines, portal-control clearance, and working Upload
  expansion/collapse. `verify:agent` and `verify:pr` pass on Node 22 using
  isolated browser ports (the knowledge port override is local to verification).

### B-017 — Viewer AR placement wait intermittently times out with no model position

- **Area:** apps/viewer-web (AR placement preview, `useArController`)
- **Severity:** P2 (CI flake in the only intermittent viewer check)
- **Observed:** 2026-10-19 (CI runs 39186342259, 39368121357, 39424935399, 39484635802 on four branches)
- **Evidence:** `e2e/hologram-feed.spec.ts` "AR places the model…" fails in `waitForPlacement`
  with `placement-wait-timeout`; the stuck state is always `placed`/`floor`/`plane-detected`,
  sequence 1, `position: null`, with 10 tracked planes.
- **Expected:** the model's own placement (with position) stays the reported status.
- **Cause (confirmed):** the controller's plane-detected preview interval in
  `useArController` read `placementStatus` from its effect closure and wrote with a
  plain `setPlacementStatus`. On the 2-CPU software-GL runner the model's placement
  commit took >200 ms, so a tick with the stale `searching` closure overwrote it.
  Timeline from `scripts/ci-emulate`-style Docker repro (2 CPUs):
  `17624ms placed|hit-test|hit-test-stable|1|-0.000,1.299,-0.860` then
  `17834ms placed|floor|plane-detected|1|` (no position); the anchored model never
  re-emits, so the position stays lost.
- **Reproduction:** `CI_EMULATE_CPUS=0 scripts/ci-emulate.sh` loop of the spec: 6/30 runs
  time out this way (≈1/80 at 2 CPUs); never on macOS hosts.
- **Fix (cd54bc23):** the preview tick re-resolves inside a functional update, so it never replaces a
  status the model already reported. Same 1-CPU loop: 0/30; 2 CPUs: 0/150.

### B-018 — Entering AR stalls the main thread 10–16 s on software GL

- **Area:** apps/viewer-web (AR entry under the IWER emulator)
- **Severity:** P2 (residual Viewer AR flake: `enterMockAr`'s 10 s `waitForIwerSession`
  times out when the stall overlaps it)
- **Observed:** 2026-10-21 (`scripts/ci-emulate.sh` loops; likely CI run 39368121357)
- **Evidence:** a long-task observer shows one 10–16 s task in every 1-CPU run (≈1/120
  failures at 2 CPUs). CPU profiles: it was IWER `computeDepthSensing` → synchronous
  `readRenderTargetPixels` (17 s of 21 s); with depth sensing no longer requested under
  IWER the stall moves to `WebGLRenderer.forceContextLoss` when the feed card canvas is
  disposed on navigation to `/ar` (13.6 s), so it is a software-GL backlog flushed at
  the first synchronous GL call.
- **Partial fix:** request `depthSensing` only outside IWER (occlusion is already off
  there): 1-CPU session-start failures 5/90 → 0/60. Smaller viewports do not help
  (390×844 still 11–12 s; the feed's AR trigger is unclickable at 320×180).
- **Cause (confirmed):** a Chrome trace (categories `gpu`, `gpu.angle`) shows the feed
  card's first frames cost 12–16 s of SwiftShader GPU time at 1 CPU
  (`vkQueueSubmit` chunks of ~2 s each). The tests clicked AR as soon as the trigger
  appeared, before those frames finished, so the AR page's synchronous GL calls (the
  card's `forceContextLoss` on unmount, the AR canvas's context creation) waited behind
  them on the shared GPU thread. Disabling the context loss only moved the wait into
  the session (up to 8 s tasks). Once the card has finished drawing, entry is fast.
- **Reproduction:** `CI_EMULATE_CPUS=0 scripts/ci-emulate.sh` loop of "AR places the model"
  with a `longtask` PerformanceObserver (a 13–18 s task in every run before the fix).
- **Fix:** the e2e helpers `observeFeedCardRenderer` / `waitForFeedCardPresented`
  (`apps/viewer-web/e2e/bootstrap.ts`) wait, before the AR tap, until the card is
  rendered and a WebGL fence on its context has signalled (polled, never blocking).
  Used by `enterMockAr` and the ar-bubble feed → AR test. 1-CPU Docker loop: longest
  task 2.8 s (was 13–18 s), 0 failures; `test:e2e:mocked` green at 2 CPUs.

### B-019 — Desktop pointing take ends its link early on hosted CI, blocking deploys

- **Area:** apps/capture (pointing desktop take), apps/viewer-web pointing pipeline e2e
- **Severity:** P1 (the CI gate skips every deploy while it fails)
- **Observed:** 2026-10-24, main CI on `cbf22beb`, `935f02e1` and `3538a339`
- **Evidence:** `e2e/pointing.pipeline.spec.ts:145` › desktop-recorded take:
  `B: link 4.8–5.75 s is not within 0.35 s of the hold 4.8–6.2 s`, the same
  numbers on every run. Passes locally on macOS and under `scripts/ci-emulate.sh`
  (pipeline shard 1, 6/6).
- **Expected:** the recorded link ends within 0.35 s of the scripted hold.
- **Reproduction:** push to `main` with a pipeline-area change; pipeline shard 1
  fails. Not reproduced off the hosted runner; the cause was found by logging
  the take's DOM events under an x86_64 `ci-emulate.sh` container.
- **Fix:** Linux headless Chromium grants the real pointer lock (the take
  assumed it never did) and then reports the cursor warping between the
  viewport origin and centre as trusted mousemoves of ±(480, 270) px at
  wall-clock moments; each turns capture's look by over a radian. The take
  re-aims only at fixed steps, so a warp landing after hold B's last re-aim
  (on the fast runner, during its screenshot) moved the aim off B and the link
  ended at the last on-target sample. The desktop take now releases a granted
  lock and always uses its DOM-level stand-in, so input is identical on every
  host, and fails if any trusted mouse movement reaches capture under the lock.
  CI's pipeline failure artifact now includes the take reports. Verified with
  `test:xr:pointing` on macOS and pipeline shard 1 (6/6) under x86_64 emulation.

### B-022 — Recorded floor is not the viewer's floor (feed cloche, AR placement)

- **Area:** `apps/viewer-web` (feed cloche, R3F AR); same pattern on
  `feature/viewer-xr-interface` (`features/xr/hologramAssets.ts` `standOnFeet`)
- **Severity:** P1 (every capture with a scene; a recorded person stands on the floor)
- **Observed:** 2026-10-25, reported by the user on https://holoim-viewer.pages.dev
- **Evidence:** the floor check in `e2e/bubble-capture.pipeline.spec.ts` on a
  real capture export: feed cloche foot 2.77 m below the recorded floor; AR
  recorded floor 12.5 m above the placement surface. Live uploads are
  consistent (ground 3–15 cm under the foot bones), so export is not at fault.
- **Expected:** the capture scene's ground under the author is the floor the
  viewer uses: the cloche's foot and shade on it, and in AR, it on the room floor.
- **Reproduction:** open a capture with a scene in the feed (the dome's foot
  sits under the terrain, so the grass reads at mid-height of the hologram) or
  in AR (the author floats far above the room floor). AR stood the model on the
  lowest point of the whole scene bubble (terrain flanks, the 6 m bubble
  sphere); the cloche stood on the lowest drawn point inside the bubble.
- **Fix:** `7e67238c82cc`. The recorded floor is the `RecordedAvatar` origin
  (capture stands it on the ground under the author). AR no longer lifts by
  scene bounds when a file has one and sizes by the person, not the scene;
  `fitCloche` takes `floorY` and fits the dome to what is above it, in the
  feed (world floor) and AR (the group's origin). Validation: the floor check
  in `e2e/bubble-capture.pipeline.spec.ts` (cloche foot and AR placement within
  5 cm of the recorded floor; before: 2.77 m and 12.5 m), `verify:agent`,
  `test:e2e:mocked`, `test:e2e:pipeline`. Not fixed on
  `feature/viewer-xr-interface`: `standOnFeet` there grounds on the whole
  scene and needs the same rule when that branch merges.
  The recorded ground below the author's floor (slopes, water) stays visible
  under the dome and below the room floor, unclipped (user decision, 2026-10-25).
  Superseded in the feed by B-033 (user decision, 2026-10-27): there the dome
  wraps that ground too, its foot on the lowest drawn ground; AR keeps the
  recorded floor on the room floor.
- **Physical:** 2026-10-26, after checking desktop and an iPhone (the feed
  and Quick Look), the user: "i think we fixed b022". AR placement on a
  Quest or an Android phone is Unverified, skipped by the user's choice (no
  Android device; the Quest is away).

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
- **Cause:** IWSDK's ray stamps a press and its release with the render
  loop's frame time and counts a press longer than 800 ms as no click (the
  phone bridge: 500 ms of real time). The spec pressed and released on
  wall-clock sleeps, so the press lasted at least one frame, and on a
  loaded 2-CPU machine one emulated frame lasts 0.5–1.3 s. Its other waits
  had the same flaw: a 700 ms stick hold slid one 50 ms step (CI's `slid
  0.160 m`), a button aimed before its reach row had opened and laid out
  was missed (CI: recenter and the gallery's Play), and a fade could finish
  between two sampled frames. Separately, audio and motion ran on separate
  clocks: the container's audio clock ran 2% slow, 77 ms behind after 4 s.
- **Expected:** one emulated press is one click. Unknown whether real
  devices drop inputs this way too (HANDOFF device checks).
- **Reproduction:** run the VR gallery or locomotion test with `--repeat-each=3` at load 20 with `pressFor`'s retries removed.
- **Fix:** branch `claude/xr-viewer-spec-flake-e86824`. The dev probe
  counts XR frames and the spec waits on them: a click presses on one
  frame and releases on the next with the emulated rays' long-press rule
  lifted (the spec drives the controls, not that rule), a phone tap lands
  within one frame, buttons are aimed once their row has settled, stick
  holds, the fade and the teleport aim hold for frames, VR runs on a
  480×270 canvas, and `pressFor`'s retries are gone. Product: the playback
  system restarts audio from the clip clock once it drifts over 30 ms, and
  the probe samples the audio offset on the clip clock's frame.
  The gallery's timeline seek is read on a held clock (a playing clock
  steps a whole frame's delta past a ±8% window), and the slow steps have
  time budgets sized for 1.4 s frames. Validation: `xr-viewer.spec.ts` 8/8
  in six consecutive local runs at load 16–39 (6.5–12.5 min) and the last
  two `scripts/ci-emulate.sh` runs (15.4, 15.2 min; amd64 on arm64, about
  1.4 s a frame). Earlier container runs failed only on what was then
  fixed: the seek window, preview loads past 15 s, and two test budgets.
  `verify:fast` for `@holoim/web`. Still a device question: a
  press spanning a frame hitch over 800 ms is no click (HANDOFF).

### B-027 — Three immersive viewer checks fail on hosted runners

- **Area:** `apps/viewer-web/e2e/xr-viewer.spec.ts` "VR gallery:", "VR foot controls:", "VR locomotion:" (and, once split from locomotion, "VR recenter after moving:")
- **Severity:** P2
- **Observed:** 2026-10-26, CI runs 40406523825 and 40436776761 on `main`
- **Closed:** 2026-10-26, with B-026 on branch `claude/xr-viewer-spec-flake-e86824`
- **Cause:** B-026: the spec held its input for wall-clock time while IWSDK
  reads it on frame time, so a slow runner lost clicks and long frames
  stretched the locomotion slide past its window.
- **Fix:** the spec waits on rendered frames (B-026). The four checks keep
  their own CI job, `xr-viewer-vr` (`test:e2e:xr-viewer-vr`), now without
  `continue-on-error` and back in the CI Gate.
### B-030 — Quick Look conversions fail while production's shared CPU is throttled

(Filed as a second B-022, which `349b5e9` and the comment in
`usdz-worker.ts` still call it; renumbered 2026-10-26, and again to B-030 on
2026-10-27 because AR recording had filed B-028 meanwhile. B-022 is the floor
bug above.)

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
- **Fix:** the worker now tells timeouts apart from real failures
  (`isUsdzConversionTimeout` in `usdz-converter.ts`: the converter's
  "exceeded 100 seconds" stderr, `ETIMEDOUT`, or a `SIGTERM` kill). A
  timed-out record stays `processing` with a fresh claim time and the
  reason kept in `usdzError`, so the stale-claim path reclaims and retries
  it after `USDZ_STALE_CLAIM_MS` instead of parking it at `failed`; genuine
  failures still go to `failed`. Regression test "defers timed-out
  conversions for a later retry instead of failing them" in
  `apps/viewer-api/test/hologram-routes.test.ts` failed before (`failed`)
  and passes after, including the retry succeeding once the claim goes
  stale. `pnpm --filter @holoim/api run verify:fast` passes (26 tests).
  The one-off `rebuild:usdz` keeps its journal + `--retry-failed` flow,
  where a timeout leaves the old preview served.

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
- **Fix:** the failing wait had moved into `waitForFeedCardPresented`
  (`apps/viewer-web/e2e/bootstrap.ts`) and still used Playwright's 5 s
  default, which B-018's 12–16 s software-GL first frames cannot meet
  under load. It now polls with `FEED_CARD_RENDERED_TIMEOUT_MS` (30 s,
  matching the pipeline specs' waits for the same state), so it returns
  as soon as the card renders; the same constant covers the identical
  wait in `hologram-feed.spec.ts`. Verified: `test:e2e:mocked` 19/19,
  the ar-bubble test 6/6 on `--repeat-each=6`, and viewer-web
  `verify:fast` (lint, typecheck, 40 unit tests).

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
- **Fix:** the API now allows this project's Pages preview hosts itself,
  without the secret: `isAllowedWebOrigin` accepts exactly one label under
  `holoim-viewer.pages.dev` or `holoim-capture.pages.dev` over HTTPS
  (`apps/viewer-api/src/lib/cors.ts`). `test/cors.test.ts` drives the built
  app with simple and preflight requests: preview deploy and branch origins
  get `access-control-allow-origin`, while `evil.pages.dev`,
  `holoim-viewer.pages.dev.evil.com`, nested labels, `http:` and ports get
  none. The secrets are unchanged.

### B-029 — The portal tilt check cannot find the pressed tilt toggle

(Filed as a second B-022; renumbered 2026-10-26. B-022 is the floor bug above.)

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
- **Closed:** 2026-10-26, not reproducible
- **Validation:** the check passes alone at every commit it was said to fail
  on and around them: `02d0282`, `31c082a`, `e413c26` and its parent (1 of 1
  each), and `main` at `b4de940` (3 of 3, `--repeat-each=3`), all on private
  ports (3675/3676/5675). CI's "Portal view end-to-end" job, which runs it,
  passed on `main` (run 40282648462). The toggle's names in
  `controlNames.ts` are unchanged since slice 3. Unconfirmed explanation: the
  failing runs reached another agent's dev server on the shared default ports.

### B-031 — The camera-take loop check times render jitter, not playback

- **Area:** `apps/viewer-web` e2e (`camera-take.pipeline.spec.ts:453`, the
  pipeline shard of CI)
- **Severity:** P1 (fails `main`'s CI, so nothing deploys)
- **Observed:** 2026-10-27, CI run 40455936695 on `a8dc19b`
- **Evidence:** "time passes as the wall clock does across each wrap"
  received 0.085 s against `CLOCK_TOLERANCE_S` 0.08; the two later tests in
  the file fail only because this one left no take. `sampleLoop` compares,
  frame by frame, the mixer's advance with `performance.now()` read in its
  own `requestAnimationFrame` callback. The mixer advances by the R3F
  clock's delta, read in R3F's callback before it renders, so each sampled
  interval also carries the change in that frame's render time: on a 2-CPU
  runner one slow frame next to a fast one exceeds 80 ms while playback
  runs at real speed.
- **Expected:** the check fails when playback runs at the wrong speed or
  wraps at the wrong length, and not when frames take uneven time.
- **Reproduction:** `scripts/ci-emulate.sh pnpm --filter @holoim/web exec
  playwright test e2e/camera-take.pipeline.spec.ts --workers=1` with
  `RUN_E2E_PIPELINE=1 XR_TEST_MODE=iwer`.
- **Fix:** `sampleLoop` samples inside the card's `mixer.update` for the
  watch (an own-property wrapper, removed when it ends), so each step pairs
  the mixer's advance with the wall clock read at that update, free of the
  frame's other renders. The per-step bound stays 80 ms: it still shows a
  hold, pause or jump at a wrap. A new rate check (the clip's unwrapped
  advance against the wall clock over the whole watch, within 2%) catches a
  wrong playback speed, which no per-step bound at real frame rates could.
- **Validation:** in `scripts/ci-emulate.sh` the unchanged check failed
  (0.240 s); the fixed spec passed 20 of 20 (`--repeat-each=5`, worst step
  error 3.5 ms, rate 1.00015). Native: worst 0.2 ms, rate 1.00002. A
  mutation run with the mixer at 1.05× passed the per-step check and failed
  the rate check (1.0500×).

### B-032 — A 1 s phone hold on TargetA came out "too brief" on CI

- **Area:** `apps/capture` AR recording (`ar-record` XR check, `marks-a`;
  `PointResolver.ts` `rejectReason`, `POINT_DWELL_SEC` 0.4 s)
- **Severity:** P1 (failed `main`'s Capture XR shard 1, so nothing deploys)
- **Observed:** 2026-10-27, CI run 40460444582 on `2f3067a`
- **Evidence:** `hold-on-target-a` (`phoneHold`, 1000 ms of wall time) made no
  link: the resolver's unlinked runs end with `"too brief"`, so the take had 2
  links, and the check paired the walking hold (12.083–12.683 s) with the
  stationary one's touch (11.233–11.533 s). The run recorded 789 camera keys;
  three emulated shard runs (`scripts/ci-emulate.sh`, `XR_SHARD=1/2 pnpm run
  test:xr:capture`) recorded 942–978 and passed, so the hosted runner was
  slower than the emulation and the failure did not reproduce. The same job
  passed on `a8dc19b`.
- **Expected:** a 1 s hold on a target makes its link whatever the frame rate,
  or the check says why it cannot; if a slow phone can lose a deliberate mark,
  that is a capture defect, not only a check's.
- **Reproduction:** two causes, each reproduced on demand. (1) The check: under
  the manual clock it advanced the take 150 ms per touch step, so a slow host
  fit fewer steps into the 1 s wall-clock hold; with every step slowed 350 ms,
  `marks-a` lost all three holds as "too brief". A 6x CPU throttle did not
  reproduce it: it slows the page, not the steps. (2) Capture: at about 4 fps
  on the realtime clock, with the lift delivered before the frame's callbacks
  (as Chromium fires XR input events), a 507 ms hold left no hold at all (no
  step came between the 300 ms delay ending and the lift), and a 1 s hold's
  span ended a frame early (0.77 s), stamped with the previous step's time.
- **Fix:** `ScreenHolds` judges a lift as a step would: a finger down past the
  hold delay and inside the slop at the lift holds then, even when no step saw
  the delay end (so a Stop before the next step still closes it), and the next
  step, the lift's own frame, ends the hold; a cancelled touch (pinch, session
  end) still closes at once. The slop at the lift compares the touchdown and
  lift directions in the viewer's own frame (`ScreenTouchEnd.viewDirection`,
  new, read from the lift event's frame), because that frame has no viewer
  pose of its own. The independent verifier (Codex) found three faults in
  earlier versions, each now covered by a scenario that failed on that
  version: a finger that slid past the slop as it lifted became a hold, a Stop
  before the next step lost the hold, and a phone turned in the lift's frame
  read as finger movement. The check advances the take by at least the wall
  time since its last step while a finger is down, as a phone's clock runs. A
  new `marks-low-fps` phase holds on TargetA at about 4 fps on the realtime
  clock with browser-order lifts (`phoneFingerUp(page, { aheadOfApp: true })`,
  new in the shared phone harness, with `at` and `headPose`): 0.5 s and 1 s
  holds and one whose phone turns 4 degrees as it lifts each link, spanning
  the touch within a frame, and a finger that slides 100 apx as it lifts makes
  none. The half-second hold failed before the fix; the slowed `marks-a`
  passes with the new stepping; all 16 `ar-record` phases pass. Inferred
  pointing's dwell is unchanged: it runs in a headset at 72 Hz or more, where
  a frame is under 14 ms.

### B-033 — The feed cloche wraps only the avatar on a take that starts on a hilltop

- **Area:** `apps/viewer-web` feed cloche (`HologramCardCanvas.tsx`),
  `packages/xr-ui-core` `fitCloche`
- **Severity:** P1 (every take whose ground falls away from the author)
- **Observed:** 2026-10-26, reported by the user on
  https://holoim-viewer.pages.dev (`cmvmm7i6q0000oeju1y8pu7eo`,
  "avatar-recording-1792859402009")
- **Evidence:** the take starts on a hilltop (recorded floor y 21.33) and walks
  3.6 m downhill in a 6 m bubble. B-022's fit kept only the points at or above
  the recorded floor: 562 of 1262, which left the author's own points, so the
  dome was 2.0 × 2.0 m inside a 12 m bubble of scenery. A take on flatter
  ground (`cmvo1tcvc0000oejtzuhpu726`) lost less and still looked whole.
- **Expected:** the halo wraps the whole scene the bubble draws, not the avatar.
- **Fix:** the feed fits the cloche to everything drawn, its foot on the
  lowest drawn ground (user's choice, 2026-10-27, from both renders of this
  take). With a floor (AR and the XR viewer, the room floor), `fitCloche` lifts
  points below it onto the floor instead of dropping them, so they still widen
  the foot. A camera take keeps its set's origin as the feed's floor, as
  `e2e/camera-take.pipeline.spec.ts` requires. The take's dome is now 11.7 × 10.6 m. Validation: the floor check in
  `e2e/bubble-capture.pipeline.spec.ts` now requires the feed's foot on the
  lowest drawn ground, never above the recorded floor, and every drawn point
  of the recorded scene under the glass; AR's foot stays on the recorded floor.

### B-034 — The viewer's deploy health check fails on Pages' switchover

- **Area:** `.github/workflows/ci.yml` and `deploy.yml`, the Pages health checks
- **Severity:** P2 (marks a good deploy as failed and turns the CI gate red)
- **Observed:** 2026-10-27, CI run 40576218115 on `main` at `d83b0a3a3258`
- **Evidence:** wrangler printed "Deployment complete" at 20:30:00.21 and the
  health check's single `curl -fsS` ran at 20:30:00.37 and got a 500. The site
  and that deployment (`0ea600cc.holoim-viewer.pages.dev`) answered 200
  minutes later, with the feed snapshot in the page. The feed function
  (`apps/viewer-web/functions/index.ts`) never calls the API and serves the
  plain page on any error of its own, so the 500 came from Pages moving the
  `holoim-viewer.pages.dev` alias to the new Functions bundle.
- **Expected:** a deploy that serves its page passes; a site that stays down fails.
- **Fix:** all four Pages health checks (viewer and capture, in `ci.yml` and
  `deploy.yml`) use `curl --retry 6 --retry-delay 5 --retry-all-errors`, so
  they wait up to 30 s. Validation: the same command against a local server
  that answers 500 twice and then 200 exits 0 on the third request, and
  against one that always answers 500 exits 22 after seven tries.

### B-035 — A fresh visit lands on the last hologram instead of the newest

- **Area:** `apps/viewer-web` feed (`FeedPage.tsx`), edge first page (`functions/index.ts`)
- **Severity:** P1 — the feed opens on the wrong hologram
- **Observed:** 2026-10-27, on the deployed viewer (desktop browser, fresh load)
- **Evidence:** With an edge snapshot that holds only the oldest hologram and
  the live API holding five, the deployed feed ends at `scrollTop` 2880 of a
  720 px card (card 5 of 5); a snapshot missing the newest one or two lands
  one or two cards down. Scroll snapping holds the card that was snapped when
  the live list inserts newer cards above it; `overflow-anchor: none` does not
  change it.
- **Expected:** A reader who has not scrolled stays on the newest hologram when
  the API's list replaces the edge snapshot.
- **Reproduction:** Serve `/` with a `__HOLOIM_FEED__` older than the API's
  first page and load it.
- **Fix:** The feed returns to the top when a new first card arrives while the
  reader is still at the top (`useStayOnNewest`); a reader who has scrolled
  keeps their card. The edge-snapshot test in `e2e/hologram-feed.spec.ts` now
  requires the newer card in the viewport and the feed at the top; it fails
  without the fix.

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
- **Fix:** The check loaded the page on the real-time clock and only
  switched to the manual clock before its baseline, so the character's
  settling slide (up to 0.45 mm) depended on how long the page ran
  before that, which varies with host load. The page now loads with
  `?manualClock=1`, like the other replay checks, so it never ticks on real
  time. Three back-to-back runs give byte-identical reports, and
  `compare-xr-reports.ts` no longer tolerates differences in this file.

### B-036 — An object search can take 20 s when one Poly Pizza download stalls

- **Area:** `apps/viewer-api` object search (`src/services/polypizza.ts`)
- **Severity:** P2 — Find shows nothing for 20 s on some searches
- **Observed:** 2026-10-28, on the deployed API
- **Evidence:** New searches for "sofa" and "teapot" took 20.6 s and 20.5 s
  (Fly logs: `responseTime` 20288 ms and 20212 ms), while "chairs", "lamp" and
  "guitar" took 0.9–1.05 s. Poly Haven alone answered "sofa" in 2.0 s and had
  no "teapot" results, so the wait was Poly Pizza's: its search downloads and
  vets every candidate before answering, and one stalled download held it for
  the 20 s fetch timeout.
- **Expected:** A search answers within a couple of seconds even when one
  model's file host is slow.
- **Fix:** Poly Pizza's search answers at a 2 s deadline with the models that
  have passed vetting (unless none has yet, when it waits for the first) and
  keeps vetting the rest, so a repeated search lists them. Validation: the new
  stalled-download tests in `test/object-routes.test.ts` (the deadline test
  fails without the fix), and the same "chair" search with a 20 s stall took
  20.1 s before and 2.0 s after, with the same six results.

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
- **Closed:** 2026-10-28
- **Cause:** a real product bug, not test-order pollution. In `freeze`, a
  mouse drag on a playing card scrolls the feed; on release a settle
  suspends snapping, glides to the card and waits up to 800 ms for the
  glide's `scrollend`. A drag that left the feed on its card had no glide,
  so no `scrollend` came, and the 800 ms fallback then put the feed back on
  that card, undoing any scroll away made in between. The whole spec runs
  fast enough on a warm server to land inside that window; alone it did not.
- **Fix:** a release that leaves the feed on its card lands at once
  (snapping back, nothing pending), and a wheel or key in the feed during a
  settle takes it over instead of being pulled back
  (`usePortalTriggers.ts`). The new `portal.spec.ts` check "desktop freeze:
  scrolling away just after a drag on a playing card stays scrolled" fails
  without the fix (feed back at 0) and passes with it; the whole spec passed
  27 of 27 (`--repeat-each=3`, one worker).

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
- **Reproduction:** a 900 ms real-time stall between the press and the
  release in `rayClick` (what one long runner frame looks like to IWSDK)
  fails the test locally with the same signature at the same line.
- **Fix:** `rayClick` lifts the emulated rays' `clickThresholdMs`, as
  `xr-viewer.spec.ts` does since B-026: any press and release on one target
  is a click, whatever the frame times; the spec drives the controls, not
  IWSDK's long-press rule. Stepping a frozen page clock (the suggested fix)
  also passed, but installing the clock before the feed loads let the feed's
  reach controls fold (`tokens.glyph.idleAfter`) before Playwright's click on
  View in your room landed on a slowed page, a new race. With the fix, the
  900 ms stall passes locally and in `scripts/ci-emulate.sh` (×2), the test
  alone passes 5 of 5 there, and the whole viewer shard 1 passes 2 of 2.

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
- **Closed:** 2026-10-28
- **Cause:** the test's own restore, not the product. The check turns
  snapping off and glides to 300 with a programmatic smooth scroll; the tap
  does not stop that glide, and snapping was put back after a fixed 400 ms.
  When the glide was still running (a loaded machine), Chrome finished it at
  300 and never re-snapped; snapping put back after its `scrollend` lands on
  a card every time (probe: mid-glide 2 of 2 stuck at 300, after `scrollend`
  2 of 2 at 0). The app itself only puts snapping back on a glide's
  `scrollend`, on its instant-landing fallback, or when a user scroll takes over.
- **Fix:** the check waits for the glide's `scrollend` before putting
  snapping back. The same spec's desktop wheel check also took a scroll
  that had not started yet for "settled at the top" under load (2 of 6 at
  load ~60); it now waits for the scroll to begin before settling. The
  whole `portal.spec.ts` passed 54 of 54 (`--repeat-each=6`, one worker),
  the drag check alone 8 of 8 at load ~45.

### B-036 — Knowledge live-update check fails after other browser suites

- **Note:** this number also labels the object-search entry above, filed a
  day later; this one is the Knowledge check cited in `ci-under-5m.md`.
- **Area:** `apps/knowledge/e2e/atlas.spec.ts` ("any docs Markdown is discoverable and live updates through atomic replacement and rename")
- **Severity:** P3
- **Observed:** 2026-10-27, `scripts/ci-emulate.sh` on `infra/ci-under-5m`
- **Evidence:** `toBeVisible` finds no element after the atomic replacement
  when `test:knowledge` runs after three viewer mocked shards in one
  container; passes 4 of 4 when it runs first (CI's order, viewer shard 4).
  Likely a file-watch event missed or late under load.
- **Expected:** the live update lands regardless of earlier load.
- **Reproduction:** `scripts/ci-emulate.sh bash -c 'VITE_IWER_SEM_SCENE=office_small pnpm --filter @holoim/web run test:e2e:mocked:shard1 && pnpm run test:knowledge'`
- **Fix:** No watcher event was missed. Logging chokidar's raw polls in the
  emulated run showed every edit, atomic replacement and rename reached Vite
  within 0.5 s, and the reload loaded the new content. Each live update is a
  full reload, and boot parsed all docs Markdown (about 1.2 MB) with remark
  before the first render. In the container after the viewer shards that took
  more than the 5 s `expect` budget: the failing trace showed the new module
  fetched 0.4 s after the write and no card 5 s later, and even the first
  `page.goto` took 7.8 s. The Vite plugin now computes each document's title
  and description in Node, cached per file so an update re-parses only the
  changed file, and the client parses a document's tree only when a page reads
  it. A local reload to the first card dropped from about 1,230 ms to 80 ms.
  The reproduction plus two further `test:knowledge` runs in the same container
  all passed.

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
- **Fix:** `scripts/ci-ffmpeg.sh` installs pinned static ffmpeg and ffprobe
  (eugeneware/ffmpeg-static `b6.1.1`, ffmpeg 7.0.2; `inspect_usdz.py` needs
  ffprobe), checked against their sha256 and kept in `actions/cache`, so no
  apt mirror is on the path: a warm install takes about 2 s. It runs as its
  own "Install ffmpeg" step with `timeout-minutes: 2` in the pipeline and
  Quick Look tool jobs, so a stall names the install. `scripts/ci-emulate.sh`
  ran whatever `node:24-bookworm` the host had pulled, with one Playwright
  volume for every architecture: it held an arm64 `chromium-1208` beside an
  x86 headless shell, each marked installed, so neither was redone. It now
  pins `linux/amd64` like the runner, names its architecture-specific
  volumes per platform, installs the viewer's Chromium and headless shell and
  launches one before the command, and uses the same pinned ffmpeg. Every
  pipeline shard passes inside it.

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
- **Fix:** `triangleInsideBubble` keeps a triangle when its closest point
  lies within the radius of a sample (any vertex inside settles it cheaply;
  otherwise a box rejection, then `Triangle.closestPointToPoint`). A kept
  triangle that reaches past the bubble with an edge over 1 m is split by
  midpoints (up to six levels) and only the pieces inside are kept, so a
  coarse floor ends about a metre past the bubble, as a dense one always
  did; the viewer still clips drawing to `RecordedBubbleSphere`. Each
  clipped mesh now carries only the vertices its triangles use (split
  vertices blended from their source triangle), where before it carried
  the source's whole vertex buffer, so its bounds are the kept geometry's.
  The marks check now requires `PointingFloor_RecordedBubble` in every
  phase's take and the AR record check in `phone-a`/`phone-b`; ar-record's
  floor hold, which had "no referent" only because the floor was missing,
  now names the floor with a highlight radius (four links, four
  no-referent holds).
- **Framing rule (user's call, 2026-10-28):** a camera take's feed card
  centres the dome, and the dome wraps the whole floor the take keeps, so
  the standing set sits small above the card's middle rather than being
  framed on its own ("A: whole floor", chosen over framing the standing set
  with the floor running out to the card's edges). `camera-take.pipeline.spec.ts`
  checks that the set's drawn vertices lie inside the viewing box and that
  the dome's middle (where the card aims), not the set, is centred.
- **Validation:** `test:xr:marks`, `test:xr:ar-record`, `recording` and
  `terrain` pass, as do the camera-take pipeline spec and `verify:pr`; a
  proof video replays a take in the viewer feed with its floor.

### B-039 — The face XR check fails intermittently: the page has no IWER gaze device

- **Area:** `apps/capture/scripts/ci-face-playwright.ts` (eye-gaze sweep), IWER device setup
- **Severity:** P2 (it breaks `verify:pr`'s `test:xr:smoke`)
- **Observed:** 2026-10-28, while verifying `feature/object-resize`. The check fails the same way on `origin/main` (`69f0795382b9`), in a clean worktree.
- **Evidence:** `page.evaluate: TypeError: Cannot set properties of undefined (setting 'connected')` at `ci-face-playwright.ts:230`, because `window.IWER_DEVICE.gaze` is undefined. Every other check in `test:xr:smoke` passes.
- **Intermittent:** the same check passed in a later `test:xr:smoke` run of the same day (ports 5295/5296/3295), so the gaze device is sometimes there.
- **Expected:** the face check's eye-gaze sweep finds a gaze device, or it sets one up.
- **Reproduction:** `cd apps/capture && pnpm run test:xr:face`.
- **Root cause:** `waitForServer` accepted any HTTP 200 from the port, even when
  the server it had just started lost the port (`--strictPort` exit) to another
  run's server. When that was a Quest 3 default build, the face check got a page
  with no gaze device. Reproduced deterministically with a stub server holding
  the port: `waitForServer` accepted it.
- **Fix:** `startTestBuildServer` pipes the server's stdout and exposes `listening`,
  resolved when Vite prints its `Local:` line (only after this process holds the
  port); `waitForServer` waits for it, so a lost port now fails fast with
  "Process exited before readiness check passed".
- **Evidence:** stub-server repro now rejects; `test:xr:face` passed 10 of 10 on
  the rebased branch (and 7 of 7 before the rebase); `test:xr:smoke` capture checks
  pass; `verify:pr` exits 0 on `a86fd2c23163` plus the fix (viewer e2e 30 passed).
  Closed 2026-11-09 by the fix commit on branch `claude/b039-face-gaze-84de5a`.
- **Harness note:** the viewer pipeline and knowledge e2e hardcode default ports
  (`E2E_BASE_URL` 3174, `E2E_POLYHAVEN_PORT` 3199, `E2E_CAPTURE_URL` 5175,
  `KNOWLEDGE_E2E_PORT` 4176); parallel sessions must set all of them.
- Follow-up (2026-11-10): the first push to `main` failed both capture XR
  shards with "Server did not become ready". With `CI` set, Vite colours its
  `Local:` line even into a pipe (`\x1b[1mLocal\x1b[22m:`), so the readiness
  match never fired; local runs print it plain. The match now strips colour
  codes first. Reproduced and fixed locally with `CI=1`: `test:xr` on capture
  passes in both modes.

### B-040 — The e2e shard check once listed two VR tests at other line numbers

- **Area:** `scripts/check-e2e-shards.mjs` (CI "Quality, unit tests and build")
- **Severity:** P2 (blocks deploy when it fires)
- **Observed:** 2026-11-10, CI run 42755796134 on `57d72f0`
- **Evidence:** the full mocked suite listed `xr-viewer.spec.ts:1574` and
  `:1690` ("VR locomotion", "VR recenter after moving"), while
  `test:e2e:xr-viewer-vr:shard2` listed the same titles at `:1831` and `:1964`.
  At that commit the file has them at 1574 and 1690, so the shard's listing
  reported other lines.
- **Expected:** every listing reports source lines, and the check passes.
- **Reproduction:** `PWTEST_CACHE_DIR=<a new empty directory> pnpm run
  check:e2e-shards` after a build, repeated. It failed 2 of 5 times from a
  cold cache on the merge of `feature/positional-audio` (once naming
  `spatial-audio.spec.ts:249` for a test at line 236, once 18 lines about
  `redesign.spec.ts`), and passed every time on a warm cache.
- **Closed:** 2026-11-10
- **Cause:** the check listed the full suite and every shard at once. On a
  cold transform cache one listing reported a spec's tests at other line
  numbers, most likely because it read a spec another listing had just
  compiled before its source map was there (inferred from when it happens;
  the cache files were not inspected). The check matches tests by
  `file:line:col › title`, so the same tests no longer matched.
- **Fix:** the full suite lists alone first, which fills the cache; the
  shards then list in parallel as before.
- **Evidence:** 14 of 14 cold-cache runs pass with the fix (each with a new
  `PWTEST_CACHE_DIR`). Not yet watched over several hosted CI runs.

### B-041 — Avatar object checks release props just over the 3 cm limit on `unreal-cm`

- **Area:** `apps/capture` avatar-formats suite (`scripts/ci-avatar-formats-playwright.ts`, `test:xr:avatars`)
- **Severity:** P2 (local suite only; hosted CI does not run `avatars`, so it fails on `main` unnoticed)
- **Observed:** 2026-11-10 on `main` `623e4645f986`; first seen by the locomotion retarget session, which also saw `reoriented-axes` and `no-fingers` fail their object checks
- **Evidence:** 3 of 3 runs fail with identical numbers, `unreal-cm: object check failed`:
  `desktop-object-bracket` "the put-down object was let go 0.0322 m above the floor (limit 0.03 m)",
  plus "walking into the resting object moved it only -0.0001 m along the walk (expected at least 0.1 m)";
  `desktop-mouse-object` 0.0324 m; `phone-touch-object` 0.0306 m. The other object checks pass.
  Report and frames in `apps/capture/output/ci-avatars/unreal-cm/object/`.
- **Expected:** a still release puts the prop down within 3 cm of the surface on every fixture, and walking into it moves it.
- **Reproduction:** `XR_AVATAR_ONLY=unreal-cm pnpm --filter @holoim/capture run test:xr:avatars` (about 160 s). Not yet rerun for `reoriented-axes` and `no-fingers`. Suspect: the palm-derived grip offset (`OBJECT_ON`) sits 0.3–2 mm too high on centimetre-scaled rigs, or the limit is too tight; the failed walk-into suggests the prop was not at rest.
- **Fix:** five causes, none of them the 3 cm limit (`ca93cf80fc3d`, `54dfc07eb5e6`):
  1. `unreal-cm` drop height: every rig's squat hand bottoms out and the prop is let go by timeout. The crouch bent only
     mapped spine bones, and `unreal-cm` maps chest to the inserted `spine_03` (4 cm above the default chest), so its
     unmapped `spine_02` stayed straight (torso 40.5° vs 42.2°). `AvatarRig` now shares each mapped bone's bend with
     the unmapped joints below it: drop 0.0233 m, still release 0.0234 m.
  2. Walk-into: the take lined the root up 9 cm left of the prop, so a shin 7.5 cm off centre missed it. It now aims
     the rig's own right shin. That exposed a character-controller snag. Rapier's combined down-and-across shape cast
     sometimes hit flat floor at time zero and stopped the avatar for a step. `CharacterMotor` retries a move
     cancelled on walkable floor only as across, then down. Contact speed now holds at 3.18 m/s, and the prop is
     shoved 1.2–1.6 m on every rig, including the default.
  3. `no-fingers` bat: a hand with unnamed finger joints had no palm collider. `AvatarColliders` now ends the palm at
     the centroid of the hand's child joints: 0.237 → 0.857 m/s.
  4. `no-fingers` throw: the harness sometimes runs two frames on one pose, and the newest-weighted release fit read
     the repeated last pose as a stop (2.40 vs 3.07 m/s). `ObjectPhysics.fitVelocity` drops a stalled last pose:
     3.02 vs 3.07.
  5. `reoriented-axes` surface "not at rest": the scenario's 3 m/s rig walk left the VR body solver's feet 3–4 m
     behind. Strides were clamped to the other, stranded foot, and the urgent step always picked the right foot,
     so the legs lay level behind the body at hip height and the dropped prop rested on them. `VrBodySolver` now
     measures a stride only from a foot within a stride of its slot, and steps the foot furthest behind first.
     The prop now touches the avatar for 3–8 steps instead of about 150, and it sleeps.
  Evidence: `test:xr:avatars` passes on all 17 fixtures (762 s, 2026-11-10).
  Residual, left on purpose: while the rig walks backwards at 3 m/s, about twice a room-scale walk, the feet still
  trail the body. Each catch-up swing is capped at 3 m/s on average. Thumbstick walking uses the clip-driven legs and
  is unaffected.

### B-045 — Creator sign-in never sends its email, and uploads do not need it

- **Area:** `apps/viewer-api/src/services/auth.ts`, `apps/viewer-web/src/features/auth`, `apps/viewer-web/src/features/upload`
- **Severity:** P1 (nobody can sign in on the live app)
- **Observed:** 2026-11-11, live viewer. Settings → "Email me a sign-in link" shows "Check your inbox", and nothing arrives.
- **Cause:** creator accounts shipped with a mailer seam and no mailer (`deliverMagicLink` only logged). Production sets no `AUTH_*` secret, so the request succeeded and the link went nowhere. The form also boxed one panel inside another, off the Upload sheet's fields.
- **Fix (`bug/creator-sign-in`):** `deliverMagicLink` sends through Resend (free tier) or Cloudflare Email Service and throws when it cannot, so the route answers 503 and drops the unsent token; the form says "sent" only after a send. The form reuses the Upload sheet's fields and word-and-glyph control. Uploads now need a signed-in account (API 401 otherwise; the Upload sheet shows sign-in), and are always credited to the account name. `showcase:upload` reads a session token from `HOLOIM_SESSION`. On a phone, a long feed notice (the empty feed) no longer covers the Settings chip, and the empty notice stays off Settings' sheet.
- **Closed 2026-11-11:** merged to `main` (`0e20b8c`) and deployed (API, viewer, capture). On the live app an anonymous upload answers 401, and a sign-in request for the user's address answered 202 and arrived in the inbox from `signin@mail.holostud.io` (not spam). CI's gate was red only for B-043's `bubble-capture` shard.
- **Operator setup (done 2026-11-11):** sending domain `mail.holostud.io` verified in Resend, `RESEND_API_KEY` and `AUTH_EMAIL_FROM` set as Fly secrets (`docs/DEPLOYMENT.md`, "Sign-in email").

### B-048 — AR views: a late anchor pulls the model back to a spot it left

- **Area:** `apps/viewer-web/src/features/ar/ARHologramModel.tsx` (`requestWorldAnchor`), reached through `/ar/:id?shell=r3f`, the fallback shell; and `apps/viewer-web/src/features/xr/placementSystems.ts` (`ArPlacementSystem.adoptAnchor`), the default IWSDK shell
- **Severity:** P3 (needs `createAnchor` to answer after a re-placement; both shells)
- **Found:** 2026-11-11 by a TLA+ model of the placement stage, then replayed against the real view
- **Cause:** `createAnchor`'s answer was accepted whenever the placement mode was set, so an anchor asked for at one spot was adopted after the model had moved. The frame loop then set the model to the anchor's pose. Two orderings:
  1. Placed on a surface, anchor pending, the viewer turns away and the visibility fallback puts the model in front of them, the anchor arrives: the model jumps back to the unseen surface spot, and the status reads `visibility-fallback` with `anchored: true`.
  2. Placed, anchor pending, Recenter places it again elsewhere, and the old anchor arrives after the new one (WebXR does not order the answers): the model jumps back to the first spot.
- **Fix, on `bug/ar-late-anchor`:** `anchorRequestEpochRef` counts placements; `clearActiveAnchor` (every re-placement, reset and anchor loss) and the visibility fallback bump it, and an answer from an older epoch is deleted instead of adopted. The other modes (`hit-test`, `plane-detected`, `floor`) place and anchor as before.
- **Replay:** `apps/viewer-web/e2e/ar-late-anchor.spec.ts` holds `XRFrame.createAnchor` open with a shim and steps exact frames (clock frozen). Before the fix, orderings 1 and 2 failed (model back at `[0, 1.299, -0.86]` from `[0, 1.38, 1.53]`, and from `[1, 0.129, -1.8]`); after it all three checks pass. Reports in `output/ar-late-anchor/` (`run-before.log`, `run-after.log`, `*.json`; ignored). Wired into `test:e2e:mocked` and its shard 1. `verify:agent` (lint, typecheck, unit tests) passes.
- **Model's second claim did not hold:** "an anchor overwrites a `locked` model, and anchored models get no monitoring". Replayed (the third check): the anchor resolves after the 45-frame lock, the stage label goes `locked` → `anchored`, and the model does not move (it was anchored at the spot it stood on). Nothing reads the label but the `data-placement-stage` attribute and `arController`, which treats both as placed, so there is no user-visible defect and no change was made. Frames spent with an anchor skip the visibility monitor, so looking away does not trigger the fallback (also pinned by the third check); that fits the placement being a point in the room the viewer chose. The model was wrong to treat `locked` as terminal: the code never said so. A device that answers `createAnchor` within a few frames never reaches the fallback for surface placements; that is by design, not a recorded requirement either way, so it is left as a note.
- **Default IWSDK shell, same defect (`bug/ar-late-anchor-iwsdk`, 2026-11-12):** `ArPlacementSystem.adoptAnchor` discarded an anchor only while the hologram was `searching` or gone, so an answer for a spot the hologram had left was adopted, and the frame loop then followed it. Three orderings, all replayed before the change:
  1. Floor tap (`placeAtTap`) after the first anchor was asked, the old anchor answers (before or after the tap's own): the hologram moved from the tapped `[0.6, 0, -0.2]` back to `[0, 0, -0.6]`. With the old answer last it also replaced the tap's anchor.
  2. Two-hand move after the anchor was asked, the old anchor answers during the move: after the hands let go and re-grounding ended, the hologram went from `[0.5, 0.77, -0.6]` back to `[0, 0, -0.6]`.
  3. Recenter has the same shape (an old answer arriving after the new placement) but was not replayed on its own; the change covers it, since it bumps the same count. No other path asks for an anchor.
  Fix: `ArRecordState.anchorEpoch`, as in the R3F view. A request remembers the count it was asked at; `invalidateAnchor` (tap, grab start, Recenter, forget) bumps it and lets go of the anchor, and `adoptAnchor` deletes an answer from an older count. Hit-test, floor, stage placements and anchored following are unchanged.
  Replay: `apps/viewer-web/e2e/ar-late-anchor-iwsdk.spec.ts`, the same `createAnchor` shim (patching `XRFrame` and `XRHitTestResult`), clock frozen, exact frames. Phone AR for the taps, Quest-style AR with two controllers for the hand move. Before the fix all three failed (`output/ar-late-anchor-iwsdk/run-before.log`, `run-before-grab.log`); after it all three pass (`run-after.log`, `*.json`; ignored). Wired into `test:e2e:mocked` and its shard 1.
  In IWER the first placement falls back to the floor (`hit-test-timeout`), so its anchor is the frame's `createAnchor`; a hit-test result's `createAnchor` (the `hit.createAnchor` call in `searchAhead`) is patched by the shim but was not exercised. It carries the same epoch.
- **Not done:** emulation (IWER) only, no physical headset or phone.
- **Closed 2026-11-12:** both shells fixed and replayed.

### B-047 — Hosted CI on `main` fails on a different browser test each push, so deploys are skipped

- **Area:** `apps/viewer-web` e2e (hosted CI shards), `apps/viewer-web/src/features/feed/HologramCardCanvas.tsx`
- **Severity:** P1 (the CI Gate failed, so the viewer, capture and API deploys were skipped; production stayed at `2fba1e6`)
- **Observed:** 2026-11-11, three pushes in a row (runs 43098856282, 43103556566, 43112916268).
- **Cause:** four separate causes. Each depended on how long a frame or the page load took on a loaded runner:
  1. `camera-take.pipeline.spec.ts`, "the initial is drawn in deep sea": counted centre pixels darker than a hard
     cutoff. The 18 px initial covers pixels in part, and where its edges fall on the grid moves ink between
     neighbours. Count on macOS 9, in Linux emulation 7, on CI 4 (threshold 6).
  2. `bubble-capture.pipeline.spec.ts`, "feed sphere follows recorded motion": the 1.5 s walk take moves only for
     its first 70%, and the looping feed was sampled from wherever the upload and load had left it. On a slow
     runner both samples could fall in the still tail.
  3. `spatial-audio.spec.ts`, "resumed, every source starts where the motion is": the motion time came from the
     last frame and the audio clock from now, read between frames, so one stalled frame counted as skew
     (0.1506 s against 0.15).
  4. Pipeline shard 1 cancelled (run 43103556566): GitHub never assigned a runner (no runner name, no steps,
     cancelled at 15 min). Not a test.
  Emulation also found a fifth, in the app: the feed fitted the cloche on its first frame, after
  `mixer.update(delta)` had already moved the take. A long first frame fitted the dome over different ground
  ("cloche foot on the lowest drawn ground", 0.0537 m against 0.05).
- **Fix (`bug/b-047-ci-flakes`):**
  1. The face check sums each centre pixel's share of deep sea (integrated ink) instead of counting pixels past
     a cutoff: 13.3 px native, 11.8 px in Linux emulation, threshold 6; an empty face has none.
  2. After freezing the clock, the test starts the feed's take from 0, so both reads fall in the walk. The message
     now prints clip times and `isRunning`.
  3. `voicesInStep` samples in animation frames, after the card's own loop, over 5 frames, and takes each voice's
     median error.
  4. No change; a runner-capacity cancellation is retried by the next push.
  5. `HologramCardCanvas` holds the take at its first pose until the dome is fitted (or found to have nothing to
     wrap), so the dome no longer depends on the first frame's length.
- **Evidence:** `scripts/ci-emulate.sh` (4 CPU, 16 GB, Linux), all fixes: `test:e2e:pipeline:shard1` ×6, 6 passed
  (10.8 min); `test:e2e:pipeline:shard3` ×3, 21 passed (13.3 min); `test:e2e:mocked:shard2` ×5, 50 passed
  (14.5 min). Before the fixes, shard 1 failed 1 run in 4 in emulation. `verify:agent` passes.
- **Not this bug:** B-043 (an overlay intercepts the AR button click after the avatar-format uploads) has a
  different cause and stays open.

### B-049 — Capture take lifecycle: a starting take reads as idle, and a late mic refusal reads as "no microphone"

- **Area:** `apps/capture/src/recording/RecordingSession.ts`, `AudioRecorder.ts`
- **Severity:** P3 (the start window lasts as long as the microphone prompt; the second needs two `getUserMedia` calls that disagree)
- **Found:** 2026-11-12 by a TLA+ model of the take lifecycle (`TakeLifecycle.tla`, in the side-session notes for this run), each claim replayed against the real page
- **Reproduced 1, `isTakeBusy()` was false while a performer take started:** Record pressed, the microphone not yet answered: `ui.recordingState` is `idle`, size is locked (`sizeLocked`), and `isTakeBusy()` (`startingCamera !== null || recordingState !== 'idle'`) is false. Its consumers read it as "no take", so `CapturePlace.load` accepted a scan (`?placeCapture=1`) under the starting take instead of refusing it as it does while recording. The same gap was in a camera take letting go of the microphone after a hidden page or a session end (`await audio.stop()` with the size still locked). The camera start itself was covered by `startingCamera`.
- **Reproduced 3, the shown microphone state came from whichever request spoke last:** `requestMicPermission()` (page load) and the take's own request (`getOrCreateStream`) are two `getUserMedia` calls; each wrote `micPermission`. The take's request granted and recording began, then the probe's refusal arrived: `micPermission` `denied`, and the overlay said "No microphone: takes save without sound." over a take that records sound (the export does carry `KHR_audio`). Needs the two calls to disagree (a transient device error on one), so it is rare; the replay answers them by hand.
- **Fix, on `bug/take-lifecycle`:** `RecordingSession` keeps one `TakePhase` (`idle | starting | recording | exporting | abandoning`) in place of `sizeLocked`, `startingCamera`-as-busy and the `recordingState` reads. `isTakeBusy()` and `isSizeLocked` are `phase !== 'idle'`, `toggle()` acts only in `idle` (start) and `recording` (stop). `ui.recordingState` is unchanged for everything the user sees. One writer, `publishMicPermission()`, sets `micPermission` from `AudioRecorder.getPermissionState()`, which is `granted` while a stream is live whatever a separate request last heard; the probe's refusal no longer overwrites a live stream's grant. `render_game_to_text` gains `heightAdaptation.recordingTakeBusy`. No change to the exported GLB.
- **Replay:** `pnpm --filter @holoim/capture run test:xr:take` (`apps/capture/scripts/ci-take-lifecycle-playwright.ts`; desktop, manual clock, the microphone answered by hand). Before the fix `start-window` and `mic-order` failed (scan load accepted during the start, `isTakeBusy` not true, UI `denied` while recording); after it all four phases pass. Reports in `output/take-lifecycle/` (`run-before.log`, `run-after.log`, `report.json`; ignored). The fixed model (`TakeLifecycleFixed.tla`) holds every rule.
- **Did not reproduce, suspected 2:** "`endCameraTake()` ignores performer takes, so a page hide or an XR session end mid-start leaves a take running or half-started." The omission is real but not a defect. The `performer-ends` phase hides the page and ends a VR session while the microphone is pending: the start completes, the take records on the desktop, a hidden page mid-take does not stop it, and Stop exports one GLB and unlocks size. Nothing is stuck. The documented promise (`docs/features/archive/ar-recording.md:253`) is for camera takes, which stop and export; the model's rule for them (`CameraTakeEndsWithSession`) holds, and the existing `ar-record` phases (`hidden-at-start`, `ended-at-start`, `session-end`, `page-hidden`) cover it. Not replayed: a performer take across a long hidden page on the real clock (the manual clock cannot show a time gap).
- **Also checked, no defect:** a double Record in one task makes one start and one microphone request; a double Stop makes one export and one download (`toggle-races`); the model found no way for a second take to begin while one is starting, recording or exporting.
- **Not done:** emulation (IWER) and Chromium's fake microphone only, no physical headset or phone. While the microphone prompt is open Record is refused without a message and there is no way to cancel a starting performer take (unchanged; if the prompt is never answered the take never starts). The model leaves out the input-recording await (test builds only), the held microphone's release, and the export's own steps.

### B-043 — The bubble pipeline test cannot click its card's AR button after the avatar-format uploads

- **Area:** `apps/viewer-web` e2e (`test:smoke:pipeline`, part of `verify:pr`)
- **Severity:** P2 (fails `verify:pr` locally; the pipeline stage is not in hosted CI)
- **Observed:** 2026-11-11 on `main` `623e4645f986` and on `bug/b041-avatar-objects`
- **Evidence:** `e2e/bubble-capture.pipeline.spec.ts:44` "real capture bubble exports, uploads and draws in feed and
  immersive AR" times out after 6 min at `bubble-capture.pipeline.spec.ts:126`: clicking the new card's
  `.ar-trigger-button` keeps hitting `<div data-reach="hidden" class="portal-controls" data-portal-mode="follow">`
  (and `.portal-controls-side`), which "intercepts pointer events". 2 of 2 full-stage runs on the branch and 1 of 1 on
  `main` fail the same way; the other 27 tests pass.
- **Update 2026-11-12:** it also fails intermittently when the spec runs alone on clean `main` `fff8507`
  (same click, same overlay, 6 min timeout): in two simultaneous runs of `main` and of `main` plus unrelated
  CI-script changes, round 1 failed on both and round 2 passed on both, so it is a timing race, not tied to
  the avatar-format uploads alone. Under heavy machine load it failed 0 of 5, then passed on a quiet retry
  (`test:smoke:pipeline` 34 passed, 5 skipped).
- **Expected:** the card's AR button is clickable whatever other cards the feed already holds.
- **Reproduction:** `pnpm run test:smoke:pipeline` (about 17 min). The spec alone passes
  (`RUN_E2E_PIPELINE=1 XR_TEST_MODE=iwer pnpm exec playwright test e2e/bubble-capture.pipeline.spec.ts` in
  `apps/viewer-web`, 57 s), so it depends on the three `avatar-formats` uploads that run before it. Suspect: a
  portal-controls overlay marked `data-reach="hidden"` still takes pointer events over the neighbouring card.
- **Cause:** the reach controls fold 4 s after the last cursor move and, folded, take no presses (`pointer-events: none`). `pressViewInAr` hovered, then clicked; on a page stalled between the two (a loaded machine, the pipeline's 3D feed) the controls folded first, and Playwright waited on the `data-reach="hidden"` overlay without ever moving the cursor again. Logged under CPU load: reach shown 68 ms after the move, hidden about 25 s later, before the click's hit test. The app behaves as designed (styleguide 1.2); the avatar-format uploads were not involved.
- **Fix:** `pressReach` (`e2e/bootstrap.ts`) moves the cursor and presses together and retries both when the controls fold; `pressViewInAr` uses it. Regression check: `portal.spec.ts` "desktop reach" folds the controls just before the first press; it fails on the old helper with the exact overlay error and passes now.
- **Closed 2026-11-12:** `verify:pr` passed (pipeline stage included), and the spec passed under `scripts/ci-emulate.sh`. A separate load-only flake remained: the click can sit at Playwright's "stable" check when the page produces no frames on a starved machine; not seen on a quiet one.

### B-050 — The Poly Haven object-search case fails inside the full pipeline and passes alone

- **Area:** `apps/capture` (`src/objects`, `scripts/lib/summon-take.mjs`), `apps/viewer-web` e2e (`object-search.pipeline.spec.ts`)
- **Severity:** P2 (fails the `pipeline` step of `verify:pr`)
- **Observed:** 2026-11-12, in several full `test:smoke:pipeline` runs and in `verify:pr`; also alone at a load average of about 45
- **Evidence:** `object-search.pipeline.spec.ts:168`: `TimeoutError: page.waitForFunction: Timeout 10000ms exceeded` in `trayHolds`, the tray never holding the second item.
- **Cause:** the second tray item's thumbnail readback (`readRenderTargetPixelsAsync`: a PBO, a fence, then a `clientWaitSync` poll) stalls between capture's own marks `tray:drawn` and `tray:read` (compile and draw done). Measured 0.1 s normally, 3-7 s, 32-35 s and twice no answer within 90 s, only under heavy machine load (load average 30-113); the page was starved (heartbeat gaps of 2.6-3 s with no long task). The thumbnail is cosmetic, but the tray load awaited it with no bound and the e2e wait was a fixed 10 s. The OS/GPU-level reason for the delayed fence was not isolated.
- **Fix:** `d83eab182830`. `trayThumbnail.ts` waits at most 5 s for the read (its own pixel buffer; a late read calls back); `CaptureObjects.ts` adds the item with its fallback glyph and attaches the late thumbnail, republishing the tray; `trayHolds` waits on the condition with a 30 s ceiling and reports the items, loading flag and `tray:<step>` marks when it times out.
- **Validation:** new `tray-stall` phase of `test:xr:summon` (the fence reports "not ready" until released): before the fix the tray never holds 2 items in 30 s and the marks end at `tray:drawn`, B-050's signature; after it the tray holds in about 12 s and the thumbnails arrive on release. The case passes alone and in two full `test:smoke:pipeline` runs on the fixed tree. Other failures in those runs were not caused by the change: `hologram-budgets.pipeline.spec.ts:341` (both runs; the same load flake recorded in B-051's landing note: the stored place's detail never reading `ready` in 120 s), `profiles.pipeline.spec.ts:175` (B-052), and the summon check's `desktop-anytime` phase (filed as B-054, it fails without the fix too).
- **Closed:** 2026-11-12.

### B-052 — The profiles "copy link" check fails locally and passes on hosted CI

- **Area:** `apps/viewer-web` e2e (`e2e/profiles.pipeline.spec.ts:175`), pipeline shard 8
- **Severity:** P3 (fails the `pipeline` step of a local `verify:pr`; hosted CI passes it)
- **Observed:** 2026-11-12 on macOS: inside a full `test:smoke:pipeline` and, run alone twice, on this tree and on clean `origin/main` (`eb9add54d707`), with the ports moved off their defaults; the other four tests of the spec pass
- **Evidence:** "copy link and delete wait out of sight until the card is reached; delete is the owner's alone": `expect(getByRole("status")).toContainText("Link copied")` times out after 5 s, "element(s) not found" (`profiles.pipeline.spec.ts:190`). Hosted CI shard 8 passed it in runs 43272311181 and 43260608085, then failed it once on run 43319865598 (`37a99105`, no source change) and passed on rerun.
- **Expected:** the status line appears after "Copy link" is pressed, as on CI.
- **Reproduction:** `RUN_E2E_PIPELINE=1 XR_TEST_MODE=iwer pnpm --filter @holoim/web exec playwright test e2e/profiles.pipeline.spec.ts --workers=1` from a clean `main` worktree on a Mac.
  Suspect (disproved): the clipboard write or its permission differs locally (the status appears only after `navigator.clipboard.writeText` resolves), or the moved base URL origin.
- **Cause (2026-11-12):** reproduced under `scripts/ci-emulate.sh` (the file alone failed 3 of 3; the one test alone passed). The press never reached the button: a debug run showed it landing on a `DIV` and the status never appearing. The reach row folds 4 s after the last cursor movement and, folded, takes no press; the spec's hand-timed `pressReached` (cursor steps, then a press once two box readings 150 ms apart matched) could fire on a row that had folded or not yet started to unfold. The same stall as B-043, which `pressReach` in `e2e/bootstrap.ts` already handles.
- **Fix:** `pressReached` now calls `pressReach` (cursor over the card, then Playwright's own click, which waits for a stable target that receives the press). A first attempt that only moved the cursor first still failed on hosted CI (run 43330664456). Shard 8's files pass under `ci-emulate` with this version. Verified: shard 8 passed on hosted CI (run 43332883624, `b9239f0c4535`) and in two `ci-emulate` runs of the shard.

### B-053 — Place gate: a card that becomes first after its dome is fitted takes the place late

- **Area:** `apps/viewer-web/src/features/feed/HologramCard.tsx` (`placeRequest`), `HologramCardCanvas.tsx` (`placeGate`), `features/place/PlaceMount.tsx`
- **Severity:** P3 (the scanned place is a dev and e2e build feature, `testHooks` only; production never asks)
- **Found by:** `/find-implicit-state-machines` (2026-11-12), replayed 2026-11-12. Model: gate states `off | loading | ready | failed | timeout`; rule "a place draws only if the gate said ready before the dome was fitted".
- **Replay, reproduced:** `place.spec.ts` "a card that becomes first once its dome is fitted does not take the place". A faked two-card feed with `?place=` shows the place on the first card; deleting that card (the real Delete button, the real `DELETE` path) makes the second the first in the list. Its `placeRequest` was keyed on `first`, so it went from `null` to a request, `createPlaceGate` made a new gate in `loading`, `PlaceMount` mounted on a card whose dome was fitted long before, loaded the (cached) scan and reported `ready`: the place drew late, over a card the fit had treated as placeless. Before the fix the check read `status: "ready"` for the second card; after it, no place report exists.
- **Cause:** whether a scan is wanted was derived from `first` (the card's index), which changes while the card lives; the gate and the fit assume it is settled at mount.
- **Fix:** `HologramCard` reads `first` once, at mount (`useState`), so a card that later becomes first is not handed a place, and one that stops being first keeps its own. `?place=` on a fresh page, `placeFor`, and the fit's wait are unchanged.
- **Same cause, not replayed:** the card demoted by an upload at the top (`onUploaded` → `addToTop`) used to lose its `PlaceMount` while its recorded set stayed hidden from the fit. Needs a real upload; the fix removes the cause (the request no longer changes), the delete replay is the check.
- **Did not reproduce (suspected 1, as framed):** "the place mounts after the gate timeout and changes what the viewer sees". The late scan does set `place`, but `PlaceMount` renders it only while `gate.status === "ready"`, and the gate never leaves `timeout`. Check kept: `place.spec.ts` "a scan that is still loading when the fit gives up is not shown late" (scan held past `placeWait=1500`, then served whole: pixels and dome equal today's card, report `timeout`, one warning).
- **Did not reproduce for the user (suspected 2):** "`fail()` overwrites `timeout`". The gate does not: every writer checks `loading` first, so a terminal gate status never changes (a late failure leaves `timeout`). Only the diagnostic report differs (`status` reads `failed` after a timeout then a failure, `timeout` after a timeout then a success, and `loading` between the timeout and the load settling); the card is the same recorded one in every order, and the one-warning rule holds (`place.spec.ts` "a slow scan that then fails warns once"). Not changed.
- **Not done:** emulation in headless Chromium only; the upload demotion path was not replayed; no real-device run.
- **Landed:** on `main` as `93087d65187b` (2026-11-12). Local `verify:pr` passed every stage but two pipeline checks that failed under load from another session's run and passed alone (`bubble-capture` is B-043's race; `hologram-budgets` "the API stores the light GLB", the stored place's detail never reading `ready` in 120 s). Hosted CI run 43322984644 failed its gate on shard 8 (B-052, `profiles.pipeline.spec.ts:175`) and shard 9 (`hologram-budgets` KTX2 case: `browser.newContext: Failed to find browser context`, a browser crash before the page loaded), neither near the place gate; the deploys were skipped. Close this entry (move it to `docs/archive/closed-bugs.md`) once a run of `main` is green and the viewer deploy health check passes.
- **Closed:** 2026-11-12. Hosted CI on `main` at `336c4495f10e` passed the gate and all three deploys (capture, API, viewer) with the fix in place; the earlier red runs were the B-052 and hologram-budgets shards, unrelated to this change.

### B-056 — Portal tilt: a motion-permission answer that arrives late still writes the tilt state

- **Area:** `apps/viewer-web/src/features/portal/usePortalTriggers.ts` (`enableTilt`), `portalStore.ts` (`tiltStatus`), `PortalControls.tsx`
- **Severity:** P3 (tilt is the `?portal=tilt` trial variant only; the default `drag` variant has no tilt)
- **Found by:** `/find-implicit-state-machines` (2026-11-12), replayed 2026-11-12. Model: `tiltStatus` off | on | denied | unsupported, with "requesting" held only in the pending promise; rules "after reset the status is `off` until the viewer asks again" and "an answer to an ask the viewer has since cancelled is ignored".
- **Replay, reproduced** (`portal.spec.ts`, phone, `?portal=tilt`, `DeviceOrientationEvent.requestPermission` shim that holds each call open):
  - "an answer that arrives after the card was left does not turn tilt on": press the tilt button, scroll to the next card (the card resets), grant; scroll back and the first card reads `on` with the button pressed, though the viewer never turned tilt on for this visit.
  - "a denial that arrives after the card was left leaves the card as new": the same order with a denial leaves `denied` (the declined tooltip) on a card that reset.
  - "with two asks open, the newest answer is the one that counts": two presses before an answer give two asks; a grant to the newer, then a denial to the older, ends `denied`.
- **Cause:** the ask is an `await` whose continuation writes the store unconditionally; `reset()` (card left) and the off press never cancel it.
- **Fix:** the store keeps a tilt epoch that every viewer move bumps (an ask, the off press, `reset()`). `enableTilt` takes a `settle` function from `store.beginTiltRequest()`, which drops its answer once the epoch has moved. Nothing else changes: an answer on the card the viewer stayed on works as before (replayed in "the answer on the card the viewer stayed on still works").
- **Did not reproduce:** unmount while an ask is pending. The store is per card and nothing renders from it afterwards, so the late write is unobservable.
- **Not done:** emulation in headless Chromium with a shim, no iPhone. Leaving the card while iOS's modal prompt is up needs a scroll glide still running at the press (or a feed change), and a double ask needs two taps before the prompt shows; iOS very likely answers both asks alike, so the differing answers in the third replay are shim-only. The fix covers all three orders regardless.
- **Landed:** on `main` as `a24aa75541ac` (2026-11-12). Local `verify:pr` passed doctor, ci-areas, lint+typecheck, unit, build, e2e-shards and knowledge; the pipeline, portal and xr-viewer stages were run apart with ports moved (stale servers from another worktree held 3174, 5175, 3198, 3199). Their failures under a load average near 30 (hand-traces, pointing, bubble-capture, place-capture, spatial-audio, and one `ERR_NETWORK_CHANGED` CDN fetch in the portal spec) all passed when rerun alone. My own check pressed the tilt button with a bare click and tripped B-043's controls-fold race under that load; it now uses `pressReach`.
- **Closed:** 2026-11-12. Hosted CI on `main` at `d0ad79a8f3dd` passed the gate and all three deploys. The runs for `a24aa75541ac` and two later commits were cancelled by newer pushes, so that run is the first complete one.

### B-051 — Feed spatial audio's motion-wrap step flakes on hosted CI

- **Area:** `apps/viewer-web` e2e (`e2e/spatial-audio.spec.ts`), `test:e2e:mocked:shard2`
- **Severity:** P2 (fails the CI Gate, which skips every deploy)
- **Observed:** 2026-11-12 on hosted CI twice: run 43158849962 (`d0182e3c`, "after the motion wraps, every source is where the motion is") and run 43268222950 (`6b531875`, "the motion wraps", the poll at `spatial-audio.spec.ts:364` never seeing the clip time drop within `SPATIAL_CLIP_S + 4` s)
- **Evidence:** local runs pass (3/3 with `--repeat-each=3` on 2026-11-12); not yet run under `scripts/ci-emulate.sh`.
- **Expected:** the animated sources' clip wraps and the step passes on a 4-CPU runner as it does locally.
- **Reproduction:** `scripts/ci-emulate.sh pnpm --filter @holoim/web run test:e2e:mocked:shard2`, or rerun the CI shard.
  Suspect: the feed's clock runs slower than real time on a loaded software-GL runner, so the wrap misses the fixed poll window.
- **Cause (2026-11-12):** two wall-clock judgements of the page's own clock. The wrap poll read the clip time once per
  `voicesInStep` (5 frames); on a starved runner that period nears the 8 s clip and aliases, so no sample landed after the
  wrap within its real-time deadline, and the `waitForTimeout(600)` after it landed at an arbitrary clip time. The sync
  checks allowed a fixed 0.15 s between the motion's time and the audio clock, which are read a frame apart, and a starved
  frame is longer: under `CI_EMULATE_LOAD=2` the "resumed" check failed at 0.35 s (1 of 5 runs, the old spec).
- **Fix:** `waitForWrap` watches the clip time every animation frame until it drops and runs on to 0.5 s; the sync
  tolerance is the larger of 0.15 s and 1.5 frames measured where the voices are read. A real desync is off by seconds.
- **Evidence:** `scripts/ci-emulate.sh` on `spatial-audio.spec.ts --repeat-each=5`: 5/5 with no load, 5/5 with
  `CI_EMULATE_LOAD=2` (frames 107–130 ms; before the fix, 4/5 under the same load). Closes after a green hosted run on `main`.
- **Closed:** 2026-11-13. Hosted CI on `main` run 43347464007 (`d0ad79a8f3dd`, with the fix from `86151906f638`) passed the gate and all three deploys.

### B-058 — Upload panel: closing the sheet mid-upload lets a second upload start beside the first

- **Area:** `apps/viewer-web/src/features/upload/UploadPanel.tsx`, `features/feed/FeedPage.tsx` (`uploadStatus`, `onUploaded`), `packages/ui-dom/src/SideSheet.tsx`
- **Severity:** P3 (the viewer has to close and reopen the sheet inside one upload; the result is a duplicate or crossed upload, not data loss)
- **Found by:** `/find-implicit-state-machines` (2026-11-12), replayed 2026-11-12. Model: a panel instance holds idle, chosen and uploading; `SideSheet` unmounts the panel after close, so the instance's state dies while the request and its callbacks into `FeedPage` live on. Rules: "the result shown belongs to the file uploaded", "a reset never discards a choice made after the upload started", "one upload in flight at a time". Model notes: the session notes folder, `upload-panel-model.md`.
- **Replay, reproduced** (`upload-panel.spec.ts`, mocked API, the multipart request held and released on cue): press Upload, close the sheet, open it again. The new panel has `isUploading` false, so its picker, name and button are live. A second file can be chosen and sent (two requests in flight). When the first answer arrives, `onUploaded` closes the sheet over the second form and the chip changes from "Uploading “second”…" to "Uploaded “first”" while the second is still in flight.
- **Cause:** "an upload is running" lived only in the panel instance, and the sheet gives the viewer a new instance.
- **Fix:** `FeedPage` already holds the status chip's `uploading` state across the sheet closing, so it passes `uploadInFlight` to the panel, which treats it like its own flag: picker, name, switch, drops and presses are shut, and the button reads "Uploading…". Nothing else changes: the answer closes the sheet as it does when the upload was watched from the start, and a form closed over an upload is empty on reopening, as it is for any closed sheet.
- **Did not reproduce (the suspected picker race):** "the picker stays enabled mid-upload and the success reset clears a file chosen after the start". The file input, the name field and the switch are `disabled` while the panel's own request runs, a file dropped on the zone mid-upload is ignored (`onDrop` returns on `isUploading`), and a second press sends nothing. Checks kept: `upload-panel.spec.ts` "in the open panel nothing can change the upload".
- **Did not reproduce (failure after a new pick):** no new pick is possible in the same panel. A failure keeps the form and a retry sends the same file (check kept).
- **Not replayed:** success and error both writing state. `onUploaded` is the feed's own callback and cannot throw, so the `try` never reaches the `catch` after a success. The direct-upload path (`/uploads/initiate`, then storage, then `/complete`) was not held step by step: it shares the one `await` the replay holds.
- **Not done:** emulation in headless Chromium on a mocked API; no real-device run.

### B-057 — A long animated showcase piece fails Quick Look conversion on the extent budget

- **Area:** `apps/viewer-api/tools/glb_to_usdz.py` (`animate`, `extents`)
- **Severity:** P3 (two pieces, "The way down" and "The way down II", had no iPhone AR preview; the feed plays both)
- **Observed:** 2026-11-12. The production upload of "The way down" (`cmwcte5x20005oeiqsmobz8mf`, 19.8 MB, a 60 s loop) ended `usdzStatus: "failed"` with `Animation extent evaluation exceeds conversion budget`; "The way down II" (`cmwebg1uf0001oeir6jshwa3k`, 45 MB) with `Baked animation exceeds conversion budget`.
- **Cause:** three, found one behind the other. (1) A glTF key on the 30 Hz grid is float32, so it lands up to half a float32 step off the grid's own float64 time; the bake counted both, so a 30 Hz export baked almost every frame twice ("The way down II": 3,492 times, 1,812 distinct), doubling both budgets. (2) With that fixed, "The way down II" ran past the 100 s CPU budget in the extent pass (226 of 245 profiled seconds): every frame recomputed each morph mesh's blend-shape point indices and sub-shape offsets and looked up 2,943 weight names with `list.index` (76 s alone). (3) "The way down" is 230 M rigid point-frames (79,848 moving vertices, 2,881 frames), over the 100 M budget sized for deformed meshes, though rigid ones cost a fraction as much.
- **Fix:** `6dd352dd7c7f`. Bake times within 4 microseconds are one time (`SAME_TIME`, under the 10 microseconds of a STEP pre-sample). The extent pass computes the morph constants once; rigid meshes transform per mesh on one thread from one reused `XformCache` and skip a frame when their local box already lands inside the bound so far; rigid point-frames budget apart (500 M) from deformed ones (100 M).
- **Validation:** both pieces convert locally: "The way down II" in 21 CPU-seconds (was over 100), "The way down" in 27 (refused before). Their extents are bit-identical to the old pass run with its budget lifted. `check_usdz_tools.sh` passed all six cases on the pipeline walk take; `test_cloche.py` passed; `verify:pr` passed.
- **Note:** "The way down II"'s extent is about 345 m wide: its floor and figures morph that far out in the GLB itself (evaluated straight from the accessors), so the bound is faithful to the piece.
- **Landed:** 2026-11-13 in `0a2d56b6fc8c`; CI run 43354945206 passed (Quick Look tool check included) and deployed the API. "The way down II" re-uploaded as `cmwee44na0001oeiqq93qtiim` with `usdzStatus: "ready"`.

### B-059 — Capture mic state: an older microphone request that answers last overwrites a newer one

- **Area:** `apps/capture/src/recording/AudioRecorder.ts` (`permissionState`), shown by `CaptureOverlay.tsx` and read by `FaceSystem`
- **Severity:** P3 (needs the page-load probe and the take's own `getUserMedia` to disagree, a transient device error on one; the replay answers them by hand)
- **Found:** 2026-11-12 by `/find-implicit-state-machines` (queue item 7), modeled in `MicPermission.tla` (side-session notes), replayed against the real page
- **Reproduced (`test:xr:take`, phase `mic-stale`):** B-049 made `RecordingSession.publishMicPermission()` the one writer of `ui.micPermission`, but `AudioRecorder` still took whichever request spoke last, the probe included, unless a stream was live. Two orders get past that guard:
  - (a) the take's request is refused (the take records without sound, the overlay says "No microphone"), then the probe, asked first, is granted: the UI turns `granted` and the line disappears under a take that is still silent;
  - (b) the take's request is granted, the take stops (the stream is released), then the probe is refused: no stream is live, so the UI turns `denied` and says "No microphone" over a recorder that just recorded sound.
- **Change:** every `getUserMedia` call is numbered when asked; an answer older than one already heard is dropped (`hear()`). The probe still releases its own stream.
- **Union mismatch, not a defect:** `micPermission` in `contracts.ts` (`pending | granted | denied`) against `UiPermissionStatus` in `xr-ui-core` (adds `unsupported`). Nothing used the shared type (`PermissionUiState` had no reader), and a browser without `getUserMedia` throws inside the request and reads as `denied`, which the overlay words correctly. Both were deleted from `xr-ui-core`; no behavior changes.
- **Not a writer:** `VoiceLevel` (the face meter) and `voiceInput.ts` (object search) call `getUserMedia` too but never write `micPermission`; voice input is queue item 8.
- **Fix:** `21535ac6446d`. Replay `mic-stale` in `test:xr:take`: before the fix both orders failed, after it all five phases pass; `verify:pr` passed locally.
- **Closed:** 2026-11-13. Hosted CI on `main` run 43459544312 (`634a42ec02b6`, which includes the fix) passed every job, the three deploys included. The run on the fix commit itself (43360131531) failed only in the api tests (`test/fixtures/db.ts` migrations, B-061), not in capture.

### B-061 — API tests build their database on several SQLite connections and fail on a stale schema

- **Area:** `apps/viewer-api/test/fixtures/db.ts` (`applyMigrations`), used by five API test files
- **Severity:** P2 (fails the CI Gate's quality job, which skips every deploy)
- **Observed:** 2026-11-13 on hosted CI run 43360131531 (`21535ac6446d`): `auth-delivery.test.ts` "answers 503 and stores no token when no mailer is configured…" threw `P2010 … there is already another table or index with this name: Hologram` at `db.ts:27`. Introduced by the test-audit commit `350fee308eb6` (real migrations instead of hand-copied DDL).
- **Reproduced:** `CI_EMULATE_LOAD=2 scripts/ci-emulate.sh pnpm --filter @holoim/api exec vitest run`, repeated: about one full run in four failed, in `auth-delivery`, `hologram-routes` and `hologram-budgets` (a one-file loop, and every run without load, passed).
- **Cause:** `applyMigrations` awaited each statement on `prisma.$executeRawUnsafe`, and Prisma's SQLite pool gives successive statements to different connections. Under load one acts on a stale schema: `ALTER TABLE "new_Hologram" RENAME TO "Hologram"` failed with "already another table" while `sqlite_master` held only `new_Hologram`, and `CREATE INDEX "Hologram_createdAt_idx"` failed with "already exists" while the index was not in `sqlite_master`. The old fixture used `CREATE TABLE IF NOT EXISTS`, which hid it.
- **Fix:** all statements run in one interactive transaction, which pins one connection (and applies the migrations atomically).
- **Landed:** `634a42ec02b6`, 2026-11-13.
- **Closed:** 2026-11-13. Hosted CI on `main` run 43459544312 (`634a42ec02b6`) passed every job, the three deploys included. The previous run (43454587497, `c1de7fda2104`) had failed on this defect.

### B-046 — The face XR check finds no IWER gaze device

- **Area:** `apps/capture` XR checks (`test:xr:smoke` → `test:xr` face, part of `verify:pr`)
- **Severity:** P2 (fails `verify:pr` locally)
- **Observed:** 2026-11-11 on `origin/main` `1f4ec3a02077` (clean worktree) and on `feature/undo-redo`
- **Evidence:** `node --import tsx scripts/run-xr-checks.ts face` fails after about 17 s:
  `page.evaluate: TypeError: Cannot set properties of undefined (setting 'connected')`, from
  `window.IWER_DEVICE!.gaze!.connected = true` (`scripts/ci-face-playwright.ts:232`). 3 of 3 runs; every other
  XR check passes.
- **Expected:** the face check gets the IWER device with eye gaze and passes.
- **Reproduction:** in `apps/capture`, `node --import tsx scripts/run-xr-checks.ts face` (with `DEV_PORT` moved if
  5174 is taken). Suspect: the device the check gets no longer has `gaze`, after an IWER or harness change.
- **Investigation (2026-11-13):** not reproduced. On `main` `cd0e705cca87` in a fresh worktree the face check passed 3 of 3 runs (80 s each, also with a stray listener held on `::1:5176`), and under `FACE_VIDEO=1`. The harness gives the face check its own server built with `CAPTURE_IWER_DEVICE=metaQuestPro` (`CHECK_SERVER_ENV` in `run-xr-checks.ts`, `device` in `vite.config.ts`); IWER 2.6.0 creates `gaze` only for a profile whose features include gaze tracking, and the Quest 3 profile (the default build) has none. No IWER, harness or `ci-face-playwright.ts` change between `1f4ec3a02077` and now touches that path. The likeliest cause was the check reaching a Quest 3 default-build server: other sessions' `vite preview` servers (one was still listening on `localhost:5175` during this investigation) share ports 5174-5176. If it recurs, check `lsof -iTCP:5174-5180 -sTCP:LISTEN` first and reopen with the port table.
- **Closed:** 2026-11-13 as not reproducible, with no code change.
