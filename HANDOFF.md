# Project Handoff

Pointer only — do not duplicate state tracked elsewhere. The queue is
[`TODOS.md`](TODOS.md), in-flight work is the feature brief (see
[`docs/features/README.md`](docs/features/README.md)), open defects are in
[`BUGS.md`](BUGS.md), and history is `git log`.

**Updated:** 2026-10-29
**Baseline:** `main` after the IWSDK runtime refactor merge (`971b076065e2`) — check `git log --oneline -10` before trusting it.
**Working tree when updated:** clean on `main`. The shared checkout's
uncommitted Oct 18 device-session edits are superseded by that merge
(ported as B-015/B-016 and the shoulder IK) and can be discarded there.

## Next action

Resize and move props on every device
([`docs/features/archive/object-resize-and-move.md`](docs/features/archive/object-resize-and-move.md))
and the cloche's rim follows the ground
([`docs/features/archive/cloche-rim-follows-ground.md`](docs/features/archive/cloche-rim-follows-ground.md))
are complete and on `main`, as are hand traces v0
([`docs/features/archive/hand-traces.md`](docs/features/archive/hand-traces.md)),
locomotion clips on every avatar
([`docs/features/archive/locomotion-retarget.md`](docs/features/archive/locomotion-retarget.md)),
the B-039 port fix, tray removal and author-marked hand traces v1
([`docs/features/archive/authored-traces.md`](docs/features/archive/authored-traces.md)) (merged 2026-11-10);
their device checks are in each brief's "Physical-device limits". Pick the next
queue item in [`TODOS.md`](TODOS.md).

## Ready to merge (grouped)

- A scanned place around a take: slice 1 (brief
  [`docs/features/archive/splat-place.md`](docs/features/archive/splat-place.md)),
  split capture slice 2's brief and slice 2a, a take recorded inside a scanned
  place on the desktop page behind `?placeCapture=1` (brief
  [`docs/features/splat-capture.md`](docs/features/splat-capture.md)), merged
  to `main` together 2026-11-11. On the merged tree every `verify:pr` step
  passed except two pipeline tests: `bubble-capture` (B-043, which fails on
  `main` too) and one `place-capture` link check that read the previous link's
  fading line under load (the test now waits for one line; it passed after).
  The user's table scan leaves the author's feet 0.030 m off its floor in 2 of
  3 runs (B-044; that case runs only where the scan is on disk).
  Open: slices 2b (Quest VR) and 2c (phone AR); the viewer finds
  `RecordedPlace` by name rather than the extension's node index.
- Creator sign-in sends its email and gates uploads (B-045, branch
  `bug/creator-sign-in`). The operator steps in
  [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) "Sign-in email" are done (Resend
  domain `mail.holostud.io`, Fly secrets set 2026-11-11). Open until a real
  emailed link arrives from the live app after the deploy.
- Showcase holograms (merged to `main` 2026-11-11 together with positional
  audio; every `verify:pr` step passed on the combined tree, the viewer XR
  suite on a re-run after its AR placement test timed out once while another
  agent's tests loaded the machine): four authored GLBs built by `apps/capture/scripts/showcase/`
  (`showcase:build`, `showcase:upload`), described in
  [`docs/product/concepts/agent-authored-holograms.md`](docs/product/concepts/agent-authored-holograms.md).
  Scripts and docs only, no app code; `verify:agent` passed 2026-11-09 and
  all four were checked in the local viewer feed. Uploaded to the live feed 2026-11-10 at the user's
  go-ahead, by "Claude (agent-authored)": Blue hour
  (`cmwa4461m0007oeirc3jzftaf`), Two sides of a door
  (`cmwa443hq0005oeirkgp3b33k`), Murmuration (`cmwa4402a0003oeirbj759hxp`)
  and Walk beside light (`cmwa43uab0001oeirkv0e9bzr`). All four render at
  https://holoim-viewer.pages.dev; not yet seen in a headset or AR.
  A second set of six was added on the same branch 2026-11-10 (`words`,
  `seasons`, `hearts`, `rain`, `bath`, `strings`; see "Second set" in the
  concept page), checked in the local viewer feed, and uploaded to the live
  feed the same day at the user's go-ahead: Walk around the year
  (`cmwamqigc000boeirzhd5khet`), The shape the rain leaves
  (`cmwamqg2a0009oeir4p2qzv7j`), Who holds the strings
  (`cmwamqcla0007oeirlm49ifko`), The sea in the bathtub
  (`cmwamq8k60005oeirnjf01okb`), Three hearts (`cmwamq5wz0003oeirqqn8rwl7`)
  and From where you stand (`cmwamq2r40001oeirjgjaaau1`). All six render at
  https://holoim-viewer.pages.dev and the stored files match the local
  builds byte for byte; their sound is unheard and none has been seen in a
  headset or AR. None of the authored pieces, sixteen with the third set, has a Quick
  Look preview (`usdzStatus` is `none`; cause not looked into). The GLB writer now refuses
  non-finite values, after a NaN vertex made one piece draw as nothing in
  the viewer while its contact sheet looked right.
  A third set of six was added on the same branch 2026-11-10 (`street`,
  `orion`, `corridor`, `mirror`, `dive`, `stairs`; see "Third set" in the
  concept page), checked in the local viewer feed, and uploaded to the live
  feed the same day at the user's go-ahead: The other side of the mirror
  (`cmwbcxce0000boeirl72up7p9`), The corridor is a lie
  (`cmwbcx8130009oeir3b6yr83b`), Everyone's down is different
  (`cmwbcx0xq0007oeir69vcjs4n`), Every moment of the dive
  (`cmwbcwwcz0005oeirzfhyv6xl`), The street that turns to follow you
  (`cmwbcwqx90003oeir73lzsc4e`) and Orion isn't flat
  (`cmwbcwkv40001oeir5qh8zuv2`). All six render at
  https://holoim-viewer.pages.dev and the stored files match the local
  builds byte for byte. Three of the six (`street`,
  `orion`, `corridor`) are built for the feed's measured first view, so a
  change to how the feed frames a card would break them; their sound is
  unheard and none has been seen in a headset or AR. `verify:agent` passed
  on the branch 2026-11-10.
- Positional audio (merged to `main` 2026-11-11 together with the showcase
  holograms; brief [`docs/features/archive/positional-audio.md`](docs/features/archive/positional-audio.md),
  closed 2026-11-11). Several placed sounds per hologram in the
  feed and the XR viewer, HRTF on both; new avatar takes place the voice on
  the head; Quick Look plays every source unplaced. The retrofitted rain
  piece was uploaded to the live feed 2026-11-11 at the user's go-ahead as a
  new card (`cmwc1glil0001oeiqy1n2s45h`, 9.22 MB, stored file identical to
  the build): it is the only hologram on the live feed with placed sound
  (umbrella, splash and lamp placed, the rain bed unplaced). The earlier
  single-mix card (`cmwamqg2a0009oeir4p2qzv7j`) is still on the feed. In the
  live viewer the new card renders with no page errors and builds three HRTF
  panners that move under orbit and come closer under zoom. Listening by ear
  and a physical headset are unverified.
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

- Scanned places (slices 1 and 2a): the user's real scan ran only headless on
  the Mac; the phone portal and capture on a phone or Quest are unchecked
  (slice 2c and 2b in [`docs/features/splat-capture.md`](docs/features/splat-capture.md)).
- Hand traces (brief
  [`docs/features/archive/hand-traces.md`](docs/features/archive/hand-traces.md)):
  IWER only. On a Quest, record real demonstrations and check how hand jitter
  and `xr-hand` dropouts look as traces; view them on a real phone; then run
  PRD-023's recipient trial, which decides slice 2.
- Put back and tray removal (brief
  [`docs/features/archive/tray-remove.md`](docs/features/archive/tray-remove.md)): IWER
  only. On a Quest, check the 12 cm put-back zone and poking a Close ring
  without summoning; on an Android phone in AR, the reticle on small objects
  and the Close glyph above a slot.

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
