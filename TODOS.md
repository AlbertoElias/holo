# TODOs

Use this for planned work that has not yet been started. Record verified defects in
[`BUGS.md`](BUGS.md), and leave the next-session context in
[`HANDOFF.md`](HANDOFF.md). Once work starts, its feature brief (indexed in
[`docs/features/README.md`](docs/features/README.md)) is the authority; link to
it from the item below instead of duplicating its status here.

## Now

- [x] Finish the CI determinism criteria left open by
  [`docs/features/archive/ci-under-5m.md`](docs/features/archive/ci-under-5m.md):
  5 identical `scripts/ci-emulate.sh` runs of the VR, AR and pipeline checks
  (5/5 passes with identical counts, 2026-10-29), and `rayClick` (B-037)
  no longer rides the clock (`clickThresholdMs` lifted).

- [x] Record real Quest hand input for `test:xr:hands` and recalibrate the
  fidelity thresholds against it. Delivered 2026-10-18:
  `apps/capture/fixtures/input-recordings/headset-open-fist-pinch-point-wave-reach.json`
  passes with the wrist-position ceiling recalibrated 2 cm → 4 cm (IK lag on
  moving hands; the synthetic wrist is static) after adding shoulder
  protraction to the arm IK. Owned by
  [`docs/features/hand-tracking-fidelity.md`](docs/features/hand-tracking-fidelity.md).
- [ ] On a physical headset, check only what IWER cannot emulate: real-tracking
  pinch stability (noise, self-occlusion, joint dropouts), Quest browser session
  events (permission prompt, system menu, headset removal or sleep,
  controller↔hand switching), and frame rate, latency, and comfort. IWER
  already covers pinch/release logic, VR enter/exit flows, and retargeting math
  (B-002, B-005 in [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md)).
- [x] Make the XR locomotion command report a reliable final completion status and
  clean up all child processes locally. Delivered in
  [`docs/features/archive/reliability-foundation.md`](docs/features/archive/reliability-foundation.md).

## Next

- [x] "The way down", version 2 (agent-authored, 2026-11-12): the same
  introspection, made to go inside and hit harder. Version 1 (scene
  `introspection`, live as `cmwcte5x20005oeiqsmobz8mf`) reads as a diorama
  seen from outside, with even pacing and a traveller as large in every layer.
  Version 2: the world grows around the feed's target so the viewer descends
  into the man's chest through nested layers (gas inside him, liquid inside
  the gas, the dark at the core); a traveller about 4 cm tall against the 1.8 m
  man, the only light in the dark; a beat sheet with an intensity curve
  approved before building; one heartbeat motif across all layers; the agent
  animates both figures (the user chose this over captured performances).
  First prove the feed's framing survives an animated world scale. Keep its
  moving vertices × frames under the Quick Look extent budget (B-057).
  Lessons go to `docs/product/concepts/agent-authored-holograms.md`.
  Delivered: scene `introspection2` (five passes, draft 12), merged to `main`
  on 2026-11-12; uploaded to production as the agent account after the deploy,
  and again on 2026-11-13 with its Quick Look preview (`cmwee44na0001oeiqq93qtiim`, B-057).
- [ ] "The way down", deep zoom (the user's direction on 2026-11-13): you
  cannot zoom into version 2's inner layers yourself. Its descent is the 60 s
  animation scaling the world about the man's chest (morph targets, a
  `HologramZoom` node), and the feed's wheel and pinch only move the camera
  between fixed limits (`portalStore.ts` `distanceForZoom`, `MAX_INSIDE_SHARE`
  in `HologramCardCanvas.tsx`). The user chose free deep zoom: every layer
  (the man; the gas in his chest, ×100 smaller; the liquid in a gas knot, ×40;
  the dark with the child, ×40) sits at its real nested size and plays its own
  action all the time. The traveller keeps running the current 60 s loop down
  through the layers and back. The viewer can go into any layer at any moment,
  hear that layer's music, zoom back out, and find the traveller wherever the
  loop has him. Needs a viewer deep-zoom range for pieces that declare their
  nesting (aim point and depth per layer, camera near and far that follow the
  zoom, positional sound scaled to the layer, the dome left behind on the way
  in), with holograms without the declaration unchanged. Also needs a rebuild of `introspection2`
  as an always-running nesting (static per-layer node scales, so the feed's fit
  and float32 precision hold at about 160,000× depth). Overlaps the in-flight
  zoom continuum in [`docs/features/portal-view.md`](docs/features/portal-view.md);
  read it first. Start with a brief (`docs/FEATURE_WORKFLOW.md`); which
  surfaces besides the desktop feed get the deep zoom is the user's call.
- [x] Tests should not have to sign in (the user's direction on 2026-11-12).
  Delivered 2026-11-12: the e2e API runs with `TEST_OPEN_UPLOADS` (off by
  default and in production; `scripts/test-api.ts` turns it on), which accepts
  an upload without an account, credited to the submitted name with no owner.
  11 specs now upload anonymously. Three keep `signInForUpload`:
  `profiles.pipeline.spec.ts` (owned uploads, owner-only delete) and
  `bubble-capture` / `capture-to-viewer` (they drive the viewer's Upload sheet,
  which shows sign-in until a session exists; opening that gate in the viewer
  would be a product change). `sign-in-email.spec.ts` runs the API with
  `TEST_OPEN_UPLOADS=false` and still proves an anonymous upload gets 401.

- [ ] Record a take inside a scanned place (split capture slice 2, the
  user's direction on 2026-11-10): capture loads a scan (SPZ or PLY) as the
  take's set, and the place is stored with the hologram through export →
  upload → render (a contract change: `KHR_gaussian_splatting` in the GLB or a
  file it points to). It must work on every capture device: Quest VR, Quest
  passthrough AR, phone AR and the desktop capture page. Open for the brief:
  in AR, whether the scan is lined up with the real room it was taken in or
  replaces the passthrough; how the author brings a scan into capture; scan
  size and frame rate on a phone. Slice 1, the viewer's render end, is in
  [`docs/features/archive/splat-place.md`](docs/features/archive/splat-place.md). Owned by
  [`docs/features/splat-capture.md`](docs/features/splat-capture.md).
- [ ] Record a performer in Quest passthrough AR: today any non-handheld AR
  session is a spectator (`frame.arSpectator`), so a headset in passthrough
  records nothing. Needs its own brief (the body, the floor and the
  microphone in passthrough). Split capture's slice 2d, the place in
  passthrough, waits on it (the user, 2026-11-10, Q1 of
  [`docs/features/splat-capture.md`](docs/features/splat-capture.md)).
- [x] Only one `verify:pr` runs at a time across worktrees (user, 2026-11-10;
  delivered 2026-11-12 on `infra/ci-reliability`). `scripts/verify-lock.ts`
  holds a loopback listener on port 39417 (the kernel frees it however the
  holder dies, so no stale lock to detect); `verify:pr` and
  `scripts/ci-emulate.sh` take it, and a waiter prints the holder's PID,
  branch and worktree. Proved: two worktrees started together, one waited
  205 s and both passed; a holder killed with `kill -9` was taken over in
  5 s and the waiter passed. Moved ports plus `VERIFY_PR_NO_LOCK=1` stay the
  escape hatch.

- [ ] Find an object by asking (PRD-060, built overnight 2026-10-27 on the
  user's request; its provisional decisions await their approval): search
  Poly Haven from capture's tray and carry the credit into the take. Owned by
  [`docs/features/object-search.md`](docs/features/object-search.md). Next
  slices: voice input, Poly Pizza (needs its API key), the headset overlay.
- [x] Hand traces (PRD-023, approved 2026-10-28): paused headset takes show
  each hand's path from the last 3 s in the feed portal. Delivered
  2026-10-29 in
  [`docs/features/archive/hand-traces.md`](docs/features/archive/hand-traces.md);
  its device checks are in the brief's "Physical-device limits". Slice 2
  (detected demonstration spans) waits on the PRD's recipient trial.
- [x] Author-marked hand traces (PRD-023 v1, approved 2026-11-09): in headset
  capture the Halo's Ink toggles a trace, stored as a `recorded` `trace` mark
  (`HOLOIM_meaning` v2) that replays with its original timing; v0's viewer
  Traces control and paused 3 s window are removed. Owned by
  [`docs/features/archive/authored-traces.md`](docs/features/archive/authored-traces.md);
  replace the two v0 test takes on the live feed afterwards.
- [ ] Self-resolving pointing (PRD-022, approved 2026-10-22): highlight what
  the author points at in the feed portal, from headset hands and a desktop
  point action. Owned by
  [`docs/features/self-resolving-pointing.md`](docs/features/self-resolving-pointing.md).
- [ ] Portal view on flat screens: freeze, orbit, zoom continuum, Follow/Free,
  three interaction variants, and a recipient trial. Approved in
  [PRD-002](docs/product/prds/PRD-002-portal-view.md); in flight in
  [`docs/features/portal-view.md`](docs/features/portal-view.md).
- [x] Add realistic walking, crouching, and jumping animations in both XR and
  desktop 2D, with natural transitions and movement that adapts to walls,
  inclines, and other environment geometry. Delivered in
  [avatar-locomotion.md](docs/features/archive/avatar-locomotion.md).
- [x] Add VR thumbstick locomotion and snap turn to capture. Today VR moves the
  avatar only through physical room-scale motion and keyboard/mock input. Move
  the world-locked camera rig with the stick (smooth move relative to head
  yaw, optional snap/smooth turn about the user's head), keep the body solver
  stepping from the resulting root motion, and add a replay check from
  recorded controller input. Builds on
  [`docs/features/room-scale-body-motion.md`](docs/features/room-scale-body-motion.md).
- [x] Clean up expired direct-upload intents and their `incoming/*.glb` objects so abandoned uploads do not leak storage. In flight in [`docs/features/archive/upload-intent-cleanup.md`](docs/features/archive/upload-intent-cleanup.md).
- [ ] Make all avatar movement look completely natural, in XR and 2D; the
  room-scale body solver
  ([`docs/features/room-scale-body-motion.md`](docs/features/room-scale-body-motion.md))
  is correct by its metrics but still reads as robotic. Nail the IK and the
  motion around it:
  - Full-body IK with joint limits and comfort costs (spine, shoulders,
    clavicles, elbows, wrists, knees, ankles) instead of the analytic chains,
    so poses stay anatomical at reach limits; arm IK that places the elbow
    and shoulder shrug from body posture, not a fixed hint.
  - Secondary and overlapping motion: arm swing counter to the legs, hip
    rotation and lateral sway with each step, weight shift onto the stance
    leg, heel-strike/toe-off foot roll on every step, head and torso follow-
    through after turns and stops.
  - Timing: phase-lock steps to the tracked head's bob, vary step length and
    cadence naturally, ease velocity changes so starts and stops are not
    linear ramps.
  - Consider data-driven priors (motion matching or a learned pose prior on
    licensed mocap) for the lower body and posture, with the tracked head
    and hands as hard constraints.
  - Prove it the same way: add naturalness metrics measured against real
    human motion (headset recordings plus reference mocap), such as joint
    angle distributions, arm–leg phase, center-of-mass path, and smoothness,
    and include side-by-side videos with a reference capture.
- [x] Adapt the XR avatar to the person's height, keeping its base grounded and
  neutral head/hands aligned with tracked input. Delivered in
  [`docs/features/archive/xr-height-adaptation.md`](docs/features/archive/xr-height-adaptation.md).

- [x] Production persistence: media is on R2 and the current SQLite database
  is accepted for the long pre-production period; authentication and Postgres
  are not planned work. Decided by the user 2026-10-26.
- [x] Move the generated development SQLite databases out of version control. Local
  setup now runs committed Prisma migrations; route tests own temporary database and
  upload fixtures; generated database files are ignored.
- [x] Add isolated API route tests for upload/static serving, pagination, deletion,
  and USDZ-conversion failure handling.
- [ ] Expand contract-focused tests for `xr-ui-core` and capture orchestration
  only — the durable public behavior and state-transition contracts that survive
  a UI/interaction redesign. Run them in the appropriate `verify:agent` or
  `verify:pr` tier. Tests for `ui-dom`, `xr-ui-r3f`, and `xr-ui-three` are
  deferred to the redesign item below, which owns their new contracts.
- [x] Redesign all UI (2D and 3D) and interaction systems (2D and XR) in a
  dedicated session with its own feature brief. That brief owns: the new
  contract tests for `ui-dom`, `xr-ui-r3f`, and `xr-ui-three` (currently
  `--passWithNoTests`), written against the redesigned contracts rather than
  the current single-file APIs; and the port of the capture XR check scripts
  (`.mjs`, ~880 lines plus `scripts/lib/`) to TypeScript scenario groups,
  since the scripts drive the app through the interaction hooks the redesign
  will change. Preserve the `xr-ui-core` state contracts and the IWER
  behavior checks (`test:xr:*`) across the redesign. Design it through
  `docs/product/concepts/what-a-hologram-is.md`: include the portal viewer
  and Follow/Free, and start marks with "this/here" links read from pointing.
  Brief: [`docs/features/ui-redesign.md`](docs/features/ui-redesign.md).
  Shipped 2026-10-26; its Android and Quest device checks are Unverified
  (the brief's "Physical-device limits").
- [ ] Add a VR viewing mode to `apps/viewer-web`: holograms on their stages
  in the blue-hour room, lit by their own gold light (styleguide 9.1), using
  the redesign's components. Split out of the UI redesign brief on
  2026-10-24 as a separate feature; it needs its own brief.

- [x] Support the standard avatar formats, not one hardcoded skeleton. Slice 1
  delivered 2026-10-27 in
  [`docs/features/archive/avatar-formats.md`](docs/features/archive/avatar-formats.md);
  locomotion retargeting is the next item. Before it, the
  rig found bones by exact names in about five places
  (`AvatarRig.ts`, `VrBodySolver.ts`, `BodyTracking.ts`), matching the shipped
  Ready Player Me export (`LeftArm`, `LeftHandIndex1`); a raw Mixamo download
  (`mixamorigLeftArm`) loses arms, hands, and fingers silently. Ready Player Me
  has shut down, so treat its export as a legacy asset, not a target.
  - One canonical humanoid bone resolver that maps any skeleton to a single
    internal bone set; replace every hardcoded lookup with it.
  - Per-standard maps: Mixamo, VRM 0.x and 1.0 (read the `VRM`/`VRMC_vrm`
    humanoid extension; handle 0.x axis flip), Unity Humanoid, Unreal
    (UE4/UE5 mannequin), Meta Oculus/Movement SDK, Apple (ARKit body skeleton
    and RealityKit/USDZ), and OpenXR `XR_FB_body_tracking`. Track any
    ratified Khronos, OMI, or Metaverse Standards Forum avatar work.
  - Bind-pose normalization (T-pose vs A-pose, bone axes) so retargeting does
    not assume the shipped rig's rest pose.
  - Prove it end to end: one fixture avatar per standard through the replay
    harness, checking hand fidelity and export → upload → render.
- [x] Retarget the locomotion clips (Idle, Walk, Jump, Fall) onto avatars that
  lack their own, with the per-bone T-pose correction that needs: slice 2 of
  [`docs/features/archive/avatar-formats.md`](docs/features/archive/avatar-formats.md).
  Delivered 2026-11-10 in
  [`docs/features/archive/locomotion-retarget.md`](docs/features/archive/locomotion-retarget.md).
- [x] Face and expressions on avatars, as the foundation for phone-driven
  avatars. Delivered 2026-10-24 in
  [`docs/features/archive/avatar-face.md`](docs/features/archive/avatar-face.md); device validation is listed in `HANDOFF.md`. Define one canonical expression set and map
  it to VRM expressions, Apple ARKit's 52 blendshapes, Meta's face blendshapes
  and visemes, and Unity/Unreal facial rigs; include gaze and eyelids. Shares
  its avatar format work with the item above, and its product question with
  [PRD-008](docs/product/prds/PRD-008-hybrid-embodiment.md) and
  [PRD-046](docs/product/prds/PRD-046-lifelike-presence.md).
- [ ] Capture yourself with a phone while your body controls an avatar: the phone
  camera tracks the face and expression (ARKit blendshapes on iPhone, an
  equivalent on Android) and drives the avatar's face, while headset or body
  tracking drives the rest. Needs a PRD first
  ([IDEA-078](docs/product/IDEAS.md)); depends on the two items above.

- [ ] Replay the implicit state machines `/find-implicit-state-machines`
  found but did not yet model (2026-11-12). Each is a hypothesis from a
  read of the code, not a verified defect: model it, replay the bug path
  against the real code, and record a defect in [`BUGS.md`](BUGS.md) only
  when every step can happen. One session per machine, ranked by user harm:
  1. Done (2026-11-12): capture take lifecycle, B-049 in
     [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md). Two of three
     suspected defects reproduced and are fixed; the third did not.
  2. Done (2026-11-12): default AR shell anchor adoption, fixed with the
     fallback shell under B-048.
  3. Done (2026-11-12): place gate, B-053. Neither suspect reproduced as
     framed (a late scan never shows; the gate's `timeout` is never
     overwritten). The replay found the real defect: a card that becomes
     first after its dome is fitted took the place late. Fixed on `main`; B-053
     is closed (green hosted CI, all three deploys).
  4. Done (2026-11-12): portal tilt permission, B-056. All three orders
     reproduced under a held `requestPermission` shim (answer after the card was
     left, denial after leaving, older denial after a newer grant) and are fixed
     with a request epoch in the portal store; unmount while pending is not
     observable.
  5. Done (2026-11-12): upload panel, B-058. The suspected picker race did not
     reproduce (the picker, name, switch and drops are shut mid-upload). The replay
     found a real one: closing the sheet mid-upload and reopening it gave a live
     panel that could start a second upload; fixed by passing the feed's
     "uploading" status to the panel.
  6. Done (2026-11-12): XR session mode, `xrEntry.ts`. Did not reproduce, no
     defect recorded. `requestedMode` does go stale (a refused request leaves
     it set) but it is read only when the session reports no
     `environmentBlendMode`, which the WebXR spec requires and every browser
     and IWER supply. With IWER's real blend mode, four held-answer replays
     (AR refused then a browser-offered VR session, an offer while an AR request
     waits, a second press while one is pending, VR refused then AR granted)
     all kept the dock's mode equal to the live session. Only a shim that hides
     the blend mode shows `ar` over a VR session. The code comment that claimed
     the request counts only while pending was corrected; the replay was not
     kept (nothing to regress). Evidence in the shared notes folder.
  7. Done (2026-11-12): mic permission, B-059. B-049 had already made one UI
     writer; two answer orders still reproduced under held `getUserMedia`
     answers (a take's refusal then the older probe's grant; a take's grant and
     stop then the older probe's refusal) and are fixed by numbering each
     request and dropping an answer older than one already heard. The union
     mismatch (`unsupported`) is naming only: the shared type had no reader and
     was deleted.
  8. Voice input (`apps/capture/src/objects/voiceInput.ts`), locomotion,
     desktop reach and held modes (`packages/xr-ui-core/src/heldMode.ts`,
     `apps/capture/src/xr/HeadsetHolds.ts`): not yet modeled.
  The skill and its rules live in
  [`.agents/skills/find-implicit-state-machines/SKILL.md`](.agents/skills/find-implicit-state-machines/SKILL.md).

## Later

- [ ] Capture drops scene triangles the hologram never shows: geometry
  hidden below the ground's top surface and outside the bubble, at export.
  Parked (user, 2026-10-29): on `scene.glb` it saves at most ~13% of the
  set's triangles and under 0.3% of the file, and the buried pass would
  change what the cut edge and Quick Look show. Revisit only if sets grow
  large enough to matter. Measurements, review and code (branch
  `feature/export-trim-hidden`) in
  [`docs/features/archive/export-trim-hidden.md`](docs/features/archive/export-trim-hidden.md).
- [x] Dismiss a placed object and remove a tray item (raised building the
  tray everywhere, 2026-10-28). Nothing clears between takes now, so a
  carried object stays in every later take and the tray only grows to its
  five slots; the author needs a way to take one out of the scene or the
  tray. See [`docs/features/archive/tray-everywhere.md`](docs/features/archive/tray-everywhere.md); brief [`docs/features/archive/tray-remove.md`](docs/features/archive/tray-remove.md).
- [x] Typecheck the viewer's e2e specs. `@holoim/web`'s `typecheck` covers
  `tsconfig.app.json` (src, functions, configs) only, so a spec's missing
  import shows only when Playwright runs it (found in the slice 0 review,
  2026-10-26, on `feature/xr-shared-screen-input`). A probe
  `tsconfig.e2e.json` (extending `tsconfig.app.json`, `types: ["node"]`,
  `allowImportingTsExtensions`, including `e2e` and `playwright.config.ts`)
  reports 12 errors in seven specs: `exactOptionalPropertyTypes` in
  `bootstrap.ts`, `portal-helpers.ts`, `xr-viewer.spec.ts`; in-page imports of
  `/node_modules/.vite/deps/three.js` in `ar-bubble.spec.ts` and
  `redesign.spec.ts`; `never`/`HTMLElement | SVGElement` narrowing in
  `xr-viewer.spec.ts` and `portal.spec.ts`; and `import.meta.env` in capture
  sources the pipeline specs import. Done: `apps/viewer-web/tsconfig.e2e.json`
  is part of `typecheck`, and the errors are fixed (the in-page `three.js`
  imports no longer exist).

- [x] Evaluate IWSDK-native ECS. Capture now runs on IWSDK World with ordered
  ECS systems, keeping Rapier and its algorithms
  ([brief](docs/features/archive/iwsdk-runtime-refactor.md)). Native scene composition
  remains unused until a concrete authoring workflow requires it.
- [x] Evaluate MetaVR as an explicit opt-in for physical Quest automation after
  reviewing its device access, native dependencies, and install-script requirements.
  Set up as the opt-in `metavr` MCP server in
  [`docs/features/archive/metavr-setup.md`](docs/features/archive/metavr-setup.md); host install
  and the one-time on-headset USB-debugging accept remain operator steps.
- [x] Migrate the capture TypeScript config to the shared config chain and run
  the whole workspace on stable TypeScript 7. The stated blocker was stale:
  `tsgo` resolves package `extends`; the real fixes were dropping `baseUrl`
  (removed in TypeScript 7) and declaring `@holoim/config-ts` in capture.
  Delivered in
  [`docs/features/archive/tsgo-typescript7-migration.md`](docs/features/archive/tsgo-typescript7-migration.md):
  catalog `typescript@^7.0.2` everywhere, `typescript-eslint` 8.71.2 bridged
  on the `@typescript/typescript6` sidecar until it supports the TS7 API.
- [x] Decide whether the capture app needs a user-visible AR recenter control for
  device-specific placement recovery. Delivered as a "Recenter AR" overlay
  button shown only in AR mode in
  [`docs/features/archive/ar-recenter-control.md`](docs/features/archive/ar-recenter-control.md).
- [x] AR recording (phone as a camera-only author): on `main` since
  2026-10-27, brief
  [`docs/features/archive/ar-recording.md`](docs/features/archive/ar-recording.md);
  its device checks are listed in `HANDOFF.md` under "Unverified / device-only".
- [ ] AR recording follow-ups, waiting on the user: whether capture should
  skip the microphone request at AR entry on a headset (today every AR entry
  asks, and a Quest in passthrough releases it once the session is not
  handheld), and whether the phone's ink line should be wider (the
  cross-vendor review suggested a 1.5 px stroke; it is faint in the proof video).
- [ ] The Halo in phone AR capture (stop, undo and redo of a held mark there),
  after AR recording lands: cut from
  [`docs/features/archive/ar-recording.md`](docs/features/archive/ar-recording.md) by its
  design review on 2026-10-25; the idiom is the phone's (press and hold the
  dock's Halo glyph, drag) through the shared screen-input bridge.
- [ ] Props in AR capture, with real-floor and WebXR `plane-detection`
  colliders: cut from
  [`docs/features/archive/object-physics.md`](docs/features/archive/object-physics.md) by its
  design review on 2026-10-27, because a headset in passthrough and a phone AR
  camera take are spectators that never handle props. Start once AR recording
  carries objects.
- [ ] Select one `IDEA-###` from [`docs/product/IDEAS.md`](docs/product/IDEAS.md) for a bounded PRD;
  do not begin implementation until the user outcome
  and success signal are explicit. The lens points to IDEA-045 (portal view)
  or IDEA-032 (self-resolving pointing) first; PRD-001 is parked.

## Maintenance

- Check off finished items in the same change that implements them.
- Add newly discovered, reproducible defects to `BUGS.md`; do not add speculative
  risks as bugs.
- Before pausing work, refresh `HANDOFF.md` with only the exact next action and
  the validation that remains; keep feature status in its brief.
