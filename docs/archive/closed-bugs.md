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
