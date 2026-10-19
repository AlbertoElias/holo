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

### B-014 — Knowledge Atlas E2E fails when another checkout serves port 4176

- **Area:** `apps/knowledge` test tooling
- **Severity:** P2 — false failures in `test:knowledge` and `verify:pr`
- **Observed:** 2026-10-18 on a clean `origin/main` (529aeb3) worktree
- **Evidence:** three file-writing tests in `apps/knowledge/e2e/atlas.spec.ts`
  (new Markdown sources, empty canonical bug list, live docs updates) failed with
  `toBeVisible()` "element(s) not found"; the bugs-page snapshot still showed one
  open bug after the test had rewritten `BUGS.md` as empty.
- **Cause:** `playwright.config.ts` set `reuseExistingServer: !process.env.CI`, so a
  local run attached to the main checkout's dev server on 4176. The specs wrote
  fixtures into their own worktree, which that server does not watch. B-008 being
  open was unrelated: the bug-list test replaces `BUGS.md` wholesale.
- **Expected:** The suite always tests a server rooted in its own checkout.
- **Reproduction:** Keep `pnpm run dev:knowledge` running in one checkout, then run
  `pnpm run test:knowledge` from another.
- **Fix:** the E2E run starts its own server on dedicated port 4177 and never
  reuses one; an occupied 4177 fails fast with Playwright's "already used" error.
  With the main checkout's server still on 4176, `pnpm run test:knowledge` passes
  7/7 from the worktree.
