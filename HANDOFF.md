# Project Handoff

Pointer only — do not duplicate state tracked elsewhere. The queue is
[`TODOS.md`](TODOS.md), in-flight work is the feature brief (see
[`docs/features/README.md`](docs/features/README.md)), open defects are in
[`BUGS.md`](BUGS.md), and history is `git log`.

**Updated:** 2026-10-26
**Baseline:** `main` after the IWSDK runtime refactor merge (`971b076065e2`) — check `git log --oneline -10` before trusting it.
**Working tree when updated:** clean on `main`. The shared checkout's
uncommitted Oct 18 device-session edits are superseded by that merge
(ported as B-015/B-016 and the shoulder IK) and can be discarded there.

## Next action

The shared XR interface and viewer VR/AR is complete and on `main` (brief
[`docs/features/archive/viewer-xr-interface.md`](docs/features/archive/viewer-xr-interface.md)).
Next: AR recording (camera-only takes, meaning v1) is built and verified on
`feature/ar-recording`. The `?arCamera=1` flag is removed by the user's
decision: phone AR records camera takes by default. It waits for `main` to be
green, then merges with slice 0's branch. Its device checks stay unverified
(no Android phone). Otherwise pick the next queue item in
[`TODOS.md`](TODOS.md).

## Ready to merge (grouped)

- `feature/ar-recording` (rides along with the next merge): the approved
  brief [`docs/features/ar-recording.md`](docs/features/ar-recording.md), the
  no-performer decision in `what-a-hologram-is.md`, its `TODOS.md` entries,
  and slices 1 and 2a, verified: `HOLOIM_meaning` v1 (camera `from`, version
  as a feature level; performer takes still write v0) and phone camera takes
  in capture (the `?arCamera=1` flag was removed by the user's decision,
  2026-10-26: phone AR records camera takes by default). `verify:pr` and
  `test:xr:ar-record` (12 phases) pass; the cross-vendor verifier's verdict is
  "ship behind the flag". Slices 0, 2b, 3 and 4 followed (shared screen
  input, viewer framing of camera takes, the phone dock, hold to mark from
  the camera with the identity-hue presence mark): `verify:pr` passed on
  `14b5738` after merging `origin/main`, and the verifier's re-check of the
  last fix is again "ship behind the flag". Slice 0 is also on
  `feature/xr-shared-screen-input`, approved by the viewer XR lead, and
  merges with this branch. Evidence is in the brief; B-027 is open.
- UI redesign slices 0 to 6 (brief
  [`docs/features/ui-redesign.md`](docs/features/ui-redesign.md)) are on
  `main`: slices 5 (hold to mark "this" and the Halo) and 6 (the burnt globe
  baked into Quick Look previews, with the one-off `rebuild:usdz`) were
  merged together on 2026-10-25 after `verify:pr` on the combined tree
  (evidence in the brief). Phone AR marks are deferred to AR recording in
  [`TODOS.md`](TODOS.md). The fixes from the
  cross-vendor review of slices 2 to 4 and the second round (the brief's
  "Independent verification" rows), with the globe's own colours, landed on
  `main` on 2026-10-25 with Codex's verdict and its three must-fixes. Next there: slice 7 (cross-device task test and device checks).
  Open: real wrist drawings for Exit and Recenter; the physical device checks
  in the brief.
- The production Quick Look rebuild to ql3 is done: both stored previews are
  ql3, with the ql2 files and the database backup kept (B-022, evidence in
  the brief).

## Unverified / device-only

- Shared XR interface and viewer VR/AR (brief
  [`docs/features/archive/viewer-xr-interface.md`](docs/features/archive/viewer-xr-interface.md),
  on `main` with B-022): IWER only so far. On devices, check Quest 3 VR
  comfort, including slide, snap turn and teleport. Check foot-control and
  hand-dock reach and readability, the feel of grab, pinch and poke (and that
  one pinch never fires a foot control twice), and the frame rate with four
  holograms placed. Check audio by ear, Quest passthrough AR, Android phone
  AR tap and two-finger pinch, and the feel of capture's chrome (hand-dock
  Record, status line). Check that a single trigger press or phone tap
  always acts once, including while the frame rate drops (B-026: emulated
  presses are sometimes lost under IWER).

- CI emulation is not a gate for the XR viewer shards: `scripts/ci-emulate.sh`
  runs amd64 on this arm64 Mac and rendered about 1 frame a second under
  load (2026-10-26), so its XR viewer failures are timing, not behaviour. The
  viewer specs retry a lost emulated click or tap, keyed on the target state
  and reported as `clickRetries` per test (B-026).

- Self-resolving pointing on a Quest and a phone: score at least three new
  headset takes with 20 or more author-labelled points against PRD-022's
  precision and recall targets, view the feed highlight on a real phone, and
  run the recipient trial (brief
  [`docs/features/self-resolving-pointing.md`](docs/features/self-resolving-pointing.md)).
- Validate the room-scale body solver on a headset (walking, turning,
  crouching, leaning feel; world lock; comfort). The body check is IWER only.
- Validate capture VR embodiment, hand/finger retargeting, pinch/release
  transitions, and VR enter/exit on a physical headset. IWER covers
  deterministic browser flows only; it does not prove tracking feel, comfort,
  performance, or device session behavior.
- Perform real-device viewer AR placement validation.
- Face on devices: WebXR eye gaze and its permission prompt on a Quest Pro,
  and webcam tracking in a phone browser. The desktop webcam (including
  left/right on a real wink) and the voice-driven jaw passed on a laptop on
  2026-10-24 (brief
  [`docs/features/archive/avatar-face.md`](docs/features/archive/avatar-face.md)).

## How to resume

1. Read this file, then [`TODOS.md`](TODOS.md) and [`BUGS.md`](BUGS.md).
2. Check `git status --short` and `git log --oneline -10`.
3. Use the command policy in [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md); start
   with an app-scoped check.
4. Before ending, update only the tracker that owns the state you changed
   (queue → `TODOS.md`, feature → its brief, bug → `BUGS.md`) and refresh the
   next action above.
