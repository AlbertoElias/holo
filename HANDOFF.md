# Project Handoff

Pointer only — do not duplicate state tracked elsewhere. The queue is
[`TODOS.md`](TODOS.md), in-flight work is the feature brief (see
[`docs/features/README.md`](docs/features/README.md)), open defects are in
[`BUGS.md`](BUGS.md), and history is `git log`.

**Updated:** 2026-10-28
**Baseline:** `main` after the IWSDK runtime refactor merge (`971b076065e2`) — check `git log --oneline -10` before trusting it.
**Working tree when updated:** clean on `main`. The shared checkout's
uncommitted Oct 18 device-session edits are superseded by that merge
(ported as B-015/B-016 and the shoulder IK) and can be discarded there.

## Next action

Resize and move props on every device
([`docs/features/archive/object-resize-and-move.md`](docs/features/archive/object-resize-and-move.md))
and the cloche's rim follows the ground
([`docs/features/archive/cloche-rim-follows-ground.md`](docs/features/archive/cloche-rim-follows-ground.md))
are complete and on `main`;
their device checks are in each brief's "Physical-device limits". Pick the next
queue item in [`TODOS.md`](TODOS.md).

## Ready to merge (grouped)

- B-039 fix (a test server must announce its own bind before a check trusts the port):
  branch `claude/b039-face-gaze-84de5a`, verified locally, not merged.

- UI redesign slices 0 to 6 (brief
  [`docs/features/ui-redesign.md`](docs/features/ui-redesign.md)) are on
  `main`: slices 5 (hold to mark "this" and the Halo) and 6 (the burnt globe
  baked into Quick Look previews, with the one-off `rebuild:usdz`) were
  merged together on 2026-10-25 after `verify:pr` on the combined tree
  (evidence in the brief). Phone AR marks are deferred to AR recording in
  [`TODOS.md`](TODOS.md). The fixes from the
  cross-vendor review of slices 2 to 4 and the second round (the brief's
  "Independent verification" rows), with the globe's own colours, landed on
  `main` on 2026-10-25 with Codex's verdict and its three must-fixes. Slice 7 closed on 2026-10-26: desktop and an iPhone passed; the
  Android and Quest checks are Unverified by the user's choice (the brief's
  "Physical-device limits"). Open: real wrist drawings for Exit and Recenter.
- The production Quick Look rebuild to ql3 is done: both stored previews are
  ql3, with the ql2 files and the database backup kept (B-030, evidence in
  the brief).

## Unverified / device-only

- AR recording (brief
  [`docs/features/archive/ar-recording.md`](docs/features/archive/ar-recording.md)):
  IWER phone emulation only, no Android phone. On a phone, check that Chrome
  reports `interactionMode` "screen-space", sends `screen` input sources
  without dom-overlay, and that the 300 ms / 22 px hold boundary feels right.
  Also check the microphone prompt at AR entry (a Quest in passthrough is
  asked too, then released), local-floor, the frame rate while recording, and
  the world-space phone case. B-028 is closed.

- Shared XR interface and viewer VR/AR (brief
  [`docs/features/archive/viewer-xr-interface.md`](docs/features/archive/viewer-xr-interface.md),
  on `main` with B-022): IWER only so far. On devices, check Quest 3 VR
  comfort, including slide, snap turn and teleport. Check foot-control and
  hand-dock reach and readability, the feel of grab, pinch and poke (and that
  one pinch never fires a foot control twice), and the frame rate with four
  holograms placed. Check audio by ear, Quest passthrough AR, Android phone
  AR tap and two-finger pinch, and the feel of capture's chrome (hand-dock
  Record, status line). Check that a single trigger press or phone tap
  always acts once, including while the frame rate drops (B-026: IWSDK
  drops a press that spans more than 800 ms of frame time).

- Object search (PRD-060, brief
  [`docs/features/object-search.md`](docs/features/object-search.md)): IWER
  only. On a Quest, check the system keyboard, speech recognition and the mic
  prompt, voice recording format, hand-ray Speak holds and passthrough AR
  hands (`?debug` on the capture URL lists what the browser supports).

- `scripts/ci-emulate.sh` runs amd64 on this arm64 Mac, about 1.4 s an XR
  frame: the immersive viewer spec passes there in about 17 minutes, since
  its input waits on frames, not wall time (B-026, closed). Its web
  Chromium needs `pnpm --filter @holoim/web exec playwright install
  chromium-headless-shell` inside the container.

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
