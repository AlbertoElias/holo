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

### B-008 — On a headset, VR hand targets land ~21 m from the avatar (B-004 in device frame order)

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

### B-009 — Hand sensor spheres block the character in VR

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

### B-010 — A standing character creeps down slopes

- **Area:** `apps/capture` physics (`CharacterMotor`)
- **Severity:** P2 — drift while idle; exposed by the B-009 fix
- **Observed:** 2026-10-18 by `test:xr:mock` (dropout recovery fingertip
  3.8 mm off; limit 2 mm)
- **Evidence:** on the default scene's spawn slope the avatar slid 2.3 mm/s
  with no input.
- **Cause:** the character controller slides the grounded gravity step along a
  walkable slope; the hand sensors had been holding the capsule in place.
- **Fix:** a grounded character with no movement keeps its horizontal
  position. `test:xr:mock` passes; the probe shows no drift over 2.4 s.

### B-011 — Room-scale motion does not reach the avatar's body in VR

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

### B-012 — XR replay tooling: fixtures with unmoved wrists, slow and order-dependent frames

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
