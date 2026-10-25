# TODOs

Use this for planned work that has not yet been started. Record verified defects in
[`BUGS.md`](BUGS.md), and leave the next-session context in
[`HANDOFF.md`](HANDOFF.md). Once work starts, its feature brief (indexed in
[`docs/features/README.md`](docs/features/README.md)) is the authority; link to
it from the item below instead of duplicating its status here.

## Now

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

- [ ] Decide the production persistence model for uploads: authentication,
  authorization, durable object storage, and a production database. The current API
  intentionally uses local filesystem storage and SQLite. Host, object storage,
  and conversion decisions are made and implementing in
  [`docs/features/live-deployment.md`](docs/features/live-deployment.md)
  (Fly + R2 + async USDZ; auth and Postgres deliberately deferred there).
  When identities land, that project also gives each person their identity
  hue and initial for marks (styleguide 1.1 and 2.4); the UI redesign leaves
  pointing highlights in today's colour until then.
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
- [ ] Redesign all UI (2D and 3D) and interaction systems (2D and XR) in a
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
- [ ] Add a VR viewing mode to `apps/viewer-web`: holograms on their stages
  in the blue-hour room, lit by their own gold light (styleguide 9.1), using
  the redesign's components. Split out of the UI redesign brief on
  2026-10-24 as a separate feature; it needs its own brief.

- [ ] Support the standard avatar formats, not one hardcoded skeleton. Today the
  rig finds bones by exact names in about five places
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
  In flight in [`docs/features/avatar-formats.md`](docs/features/avatar-formats.md).
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

## Later

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
