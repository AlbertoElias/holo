# TODOs

Use this for planned work that has not yet been started. Record verified defects in
[`BUGS.md`](BUGS.md), and leave the next-session context in
[`HANDOFF.md`](HANDOFF.md). Once work starts, its feature brief (indexed in
[`docs/features/README.md`](docs/features/README.md)) is the authority; link to
it from the item below instead of duplicating its status here.

## Now

- [ ] Validate capture VR embodiment, hand/finger retargeting, pinch/release
  transitions, and VR enter/exit behavior on a physical headset. The automated
  IWER checks cover deterministic browser flows but cannot replace device testing.
  (Automated pinch fix: closed B-002 in [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).)
- [x] Make the XR locomotion command report a reliable final completion status and
  clean up all child processes locally. Delivered in
  [`docs/features/archive/reliability-foundation.md`](docs/features/archive/reliability-foundation.md).

## Next

- [ ] Add VR thumbstick locomotion and snap turn to capture. Today VR moves the
  avatar only through physical room-scale motion and keyboard/mock input. Move
  the world-locked camera rig with the stick (smooth move relative to head
  yaw, optional snap/smooth turn about the user's head), keep the body solver
  stepping from the resulting root motion, and add a replay check from
  recorded controller input. Builds on
  [`docs/features/room-scale-body-motion.md`](docs/features/room-scale-body-motion.md).
- [ ] Replace the procedural walk/jump/fall clips with realistic walking,
  crouching, and jumping animation that works in both XR and the 2D (desktop)
  view and adapts to the environment: feet and pelvis follow inclines and
  steps, the body slows and turns against walls, crouch-walk and landing
  absorb on uneven ground. Share foot planting with the VR body solver rather
  than running two systems; prove it with replay metrics like the body check.
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
- [ ] In XR, adapt the avatar to the person's height: measure standing eye
  height (and optionally arm span) at session start or on request, then scale
  or re-proportion the avatar so its eyes, hands, and floor contact match the
  user without changing the world scale. Handle recalibration, seated users,
  and how the scaled avatar is recorded and exported.
- [ ] Decide the production persistence model for uploads: authentication,
  authorization, durable object storage, and a production database. The current API
  intentionally uses local filesystem storage and SQLite.
- [x] Move the generated development SQLite databases out of version control. Local
  setup now runs committed Prisma migrations; route tests own temporary database and
  upload fixtures; generated database files are ignored.
- [x] Add isolated API route tests for upload/static serving, pagination, deletion,
  and USDZ-conversion failure handling.
- [ ] Expand contract-focused tests for capture orchestration and the `ui-dom`,
  `xr-ui-r3f`, and `xr-ui-three` packages, which currently use `--passWithNoTests`.
  Start with public behavior and state-transition contracts, and run them in the
  appropriate `verify:agent` or `verify:pr` tier.

## Later

- [ ] Port the capture XR check scripts to TypeScript scenario groups. Browser
  reuse and stage timing are done (one VR and one desktop page, respawn between
  trials) in [`docs/features/archive/deterministic-lean-ci.md`](docs/features/archive/deterministic-lean-ci.md);
  sharding is unnecessary at current runtimes.
- [ ] Evaluate IWSDK-native ECS/scene composition only when a concrete authoring
  workflow requires it; the current tooling integration intentionally preserves
  HoloIM's custom Three/Rapier runtime.
- [ ] Evaluate MetaVR as an explicit opt-in for physical Quest automation after
  reviewing its device access, native dependencies, and install-script requirements.
- [ ] Migrate the capture TypeScript config to the shared config chain once `tsgo`
  supports the needed `baseUrl` and non-relative `extends` behavior.
- [ ] Decide whether the capture app needs a user-visible AR recenter control for
  device-specific placement recovery.
- [ ] Select one `IDEA-###` from [`docs/product/IDEAS.md`](docs/product/IDEAS.md) for a bounded PRD;
  do not begin implementation until the user outcome
  and success signal are explicit.

## Maintenance

- Check off finished items in the same change that implements them.
- Add newly discovered, reproducible defects to `BUGS.md`; do not add speculative
  risks as bugs.
- Before pausing work, refresh `HANDOFF.md` with only the exact next action and
  the validation that remains; keep feature status in its brief.
