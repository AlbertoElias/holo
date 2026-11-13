# Feature brief: A hologram of yourself from a phone in under 2 minutes

**Lead:** Claude (Opus)  
**Status:** Draft (awaiting the user's approval, 2026-11-13)
**Layer:** event (the author's head, face, arms, hands and voice over time),
plus the path that turns it into a shareable link. See
`docs/product/concepts/what-a-hologram-is.md`.

Source: the ambition retrospective (2026-11-13): HoloIM is pre-public, the
owner is the only user, nothing in-house is "wow" yet, and most people own a
phone, not a headset, so phone capture is the gate. Builds on the
camera-driven avatar spike (`docs/features/camera-avatar-spike.md` on
branch `feature/camera-avatar`, unmerged, idle since 2026-11-11) and the `TODOS.md` item "Capture yourself
with a phone while your body controls an avatar" (IDEA-078).

## User outcome

Someone holding only a phone opens HoloIM, records a hologram of themselves,
and has a shareable link **in under 2 minutes, with no help**, and the result
looks good enough to want to send.

"Of themselves" here means: their own voice, and their face, head, arms and
hands driving the avatar, read from the phone's front camera. A personal
avatar that looks like them is out of scope (see Excluded).

## Measured today (2026-11-13, production, `3d383ce4fba7`)

Desktop Chromium with Playwright's Pixel 7 profile (phone viewport, touch,
Android UA), fake camera and microphone granted, M1 Max CPU. A phone CPU and
network will be slower; the device numbers are **pending** (see
Physical-device limits). Scripts: `output/phone-capture/boot-timing.mjs`,
`output/phone-capture/journey.mjs` (ignored).

| # | Step | What happens today | Machine time | Human time (estimate) | Failure |
|---|---|---|---|---|---|
| 1 | Find where to record | The viewer feed (`holoim-viewer.pages.dev`) has Search, Settings and "Upload a hologram" (a file). Nothing links to capture. | - | - | **Dead end without help**: you must know `holoim-capture.pages.dev` |
| 2 | Open capture | Code 1.9 MB by 1.5 s; scene and avatar GLBs (2.3 MB) by 0.9 s after start in headless; "Loaded" at 5.8 s after `goto` (4.1 s on a second run). Microphone prompt at load. | 4 to 6 s | 3 s (mic prompt) | The in-app browser pane once showed 12 s before the GLBs started; not reproduced headless, so treated as a pane artifact |
| 3 | Understand what to do | A stock avatar seen **from behind** on a rock. The status line is desktop keyboard help ("WASD + Space, hold C to crouch, V toggles…"). The face camera is off until turned on in Settings. Body moves only by touch joystick. | - | 20 to 40 s | Nothing tells a phone user what to do; the avatar is not them |
| 4 | Record | Tap Record; recording UI 3 s later in headless. 15 s take. | ~3 s | 15 to 30 s | - |
| 5 | Stop | Tap Stop; the GLB is exported and **downloaded as a file** 3.7 s later (15 s take = 2.9 MB). Nothing else happens. | 3.7 s | - | The take is a file in Downloads; no next step |
| 6 | Get to the viewer | No link back. Type the viewer's address. | - | 10 to 20 s | Dead end without help |
| 7 | Sign in | "Upload a hologram" → email, name → "Email me a sign-in link" → switch to mail, wait, tap the link (opens a new tab or browser). | delivery 5 to 30 s | 30 to 60 s | A first-timer leaves the app mid-journey |
| 8 | Upload | Upload sheet → file picker → find the GLB in Files/Downloads → upload 2.9 MB. | ~3 to 5 s on 4G (not measured) | 15 to 20 s | Picking a file from Downloads on a phone is fiddly |
| 9 | Share | The new card goes to the top of the feed. No Share button: tap the title to open `/h/<id>` and copy the address bar. | - | 10 to 15 s | No share action |

**Total:** fails at step 1 (and again at 6) for anyone without help. With
both addresses known and already signed in: about 1.5 to 2.5 min. First time,
with the email round trip: about 2.5 to 4 min. And the result is a stock
avatar standing still with a generic idle face, so it fails "want to send"
even when the time is met.

## Blockers, ranked

Ranked by how much each costs the mandate (dead end > minutes > seconds),
then by how cheap it is to remove.

1. **The take never becomes a link (steps 5, 6, 8, 9).** Capture ends in a
   file download; posting means a second app, a file picker and a manual URL
   copy. This alone breaks "no help" and costs about a minute.
2. **Nothing leads from the viewer to recording (step 1).** A dead end.
3. **It is not you (step 3).** Stock avatar, seen from behind, face camera
   off by default, body by joystick. Fails "want to send" regardless of time.
   The spike already drives head, face, arms and fingers from the front
   camera, measured on the owner's own clip (head and hands meet their bars;
   only pointing *aim* is unresolved, which this brief does not need).
4. **A phone gets desktop instructions (step 3).** Keyboard help, no phone
   guidance.
5. **Sign-in by emailed link (step 7).** About 30 to 60 s and an app switch
   for a first-timer. Zero for the owner, who stays signed in. Today it sits
   after the take, where a lost tab would also lose the take.
6. **Waits (steps 2, 4, 5).** About 10 s of machine time on a desktop CPU;
   a phone may double it. Unknown until measured on a device.

## Slices (smallest that remove the blockers)

Each slice is shippable on its own and ends with the journey script re-timed.

### Slice 1: Record → Post → Share link (blockers 1 and 2)

- The viewer feed gets a **Record** action beside Upload. Signed out, it asks
  for sign-in first (the existing email link), so the round trip happens
  before a take exists, never after. Signed in, it opens capture.
- The handoff: the viewer asks the API for a **post grant**, a new endpoint
  that returns a short-lived (15 min), upload-only, single-use token tied to
  the signed-in creator, and opens capture with it in the URL **fragment**
  (`#post=<grant>&return=<viewer origin>`). The fragment never reaches a
  server; capture reads it, removes it from the address bar at once, and
  keeps it in memory only. The session token itself never leaves the viewer.
  Backward compatible: a new route; existing upload and auth are unchanged.
- After Stop, capture shows **Post** (primary) and Save file (the old
  download). Post uploads the take to `POST /api/holograms` with the grant,
  then goes to the viewer's `/h/<id>` with a **Share** sheet open:
  `navigator.share` where it exists, Copy link otherwise.
- Capture opened without a grant (the direct address, the headset) behaves
  exactly as today.

### Slice 2: Selfie flow on phones (blockers 3 and 4, the journey part)

**Boundary (2026-11-13):** how the avatar is driven belongs to the motion
owner session ("Own natural avatar motion from every input source"), which
owns `feature/camera-avatar` (IDEA-078), IK, retargeting, smoothing, jitter
and aim. This brief does not edit `apps/capture/src/bodycam/*`,
`XrTracking.ts`, `TrackedHandsSystem.ts`, `HandEmbodiment.ts` or
`FaceDriver.ts`, and does not touch the spike branch. It uses whatever
camera driving is on `main` through existing calls only.

- On a phone opened through Record, **selfie mode is the default**: the
  front camera starts through the existing face toggle (today: face and
  expression only), and the view frames the avatar from the front, waist
  up, like a mirror, standing still (no joystick needed). Camera and view
  code only.
- One short phone hint replaces the keyboard help: "Prop your phone up, face
  it, tap Record."
- A 3-2-1 countdown after Record so the author can get into frame.
- When the motion owner lands camera-driven head, arms and fingers on
  `main`, selfie mode turns it on with the same flag (`?input=camera`) and
  nothing else in this brief changes. Until then "it is you" is face and
  voice only, which likely still fails "want to send"; that gap is the
  motion owner's, recorded below.
- Desktop and headset paths unchanged.

### Inputs for the motion owner

From the spike's own results on the owner's clip (2026-11-11) and this
journey, in the order the phone journey needs them:

1. **Camera upper body is not on `main`.** Selfie mode can drive only the
   face today; head, arms and fingers from the camera are the difference
   between "a stock avatar" and "you". The journey needs head, arms and hands
   to look natural; it does **not** need pointing aim (no traces or links
   from camera hands).
2. Head: the face model loses a full profile turn and a hand crossing the
   face (the spike falls back to pose yaw); a selfie take has both.
3. Index-ray jitter while pointing (p95 5.7 to 20 deg) shows as trembling
   fingers even when nobody reads the aim.
4. Rate on a phone: unmeasured; the journey needs the face, pose and hand
   models together at a rate that looks smooth (spike bar: 20 fps).
5. Files this brief would want touched, for the two sessions to agree on:
   none, if `?input=camera` stays the switch and the models still load only
   on camera start.

### Slice 3: Waits (blocker 6), only if the device numbers say so

Measure boot, record start and export on a real phone first. Candidate cuts,
none built until a number points at it: start the pose and hand models while
the scene loads; start the upload while the export finishes; skip the 2.9 MB
download copy when posting.

### Not sliced: sign-in (blocker 5)

Kept as the email link, moved before the take by slice 1. Removing it
(anonymous posting with a claim later) is a product decision for launch, not
for a pre-public app with one user; see Open decisions.

## Scope

**Included:** slices 1 and 2; slice 3 only after a device measurement.  
**Excluded:** how the avatar is driven from the camera (the motion owner's); a personal avatar that looks like the author (photo or scan to
avatar); legs and walking from the camera; the back camera; pointing
meaning (traces, links) from camera hands; the headset journey; iPhone
performance tuning beyond what slice 3 measures; changing sign-in.

## Undo

No new authoring action inside a take. Post is not undoable in capture; a
posted hologram is deleted from the viewer as today. Save file stays.

## Acceptance criteria

- [ ] **The mandate (automated, emulated):** one Playwright journey on a phone
  profile, from the viewer feed (signed in) → Record → capture in selfie mode
  → a 20 s take with a fake camera stream of a person → Post → the hologram
  page with Share, finishes with no step that needs typing an address,
  picking a file or copying a URL. Its machine time (everything except the
  take and scripted taps) is reported, and the journey's modeled total
  (machine time + the take + one tap per step at 2 s) is under 2 minutes.
- [ ] Signed out, Record asks for sign-in before opening capture; after the
  link, it continues to capture without a second tap on Record.
- [ ] The post grant: expires after 15 min, is upload-only, works once; a
  replayed, expired or forged grant fails with a message in capture and the
  take stays available as Save file. The grant never appears in the address
  bar after capture reads it, and the session token is never sent to
  capture.
- [ ] Capture without a grant behaves as today (no Post; download only).
- [ ] Selfie mode: on a phone through Record, the front camera is on, the
  view faces the avatar, the countdown runs, and the exported GLB's face
  tracks move and play in `viewer-web`. (Head, arms and fingers from the
  camera are the motion owner's acceptance, not this brief's.)
- [ ] A phone never shows the keyboard help.
- [ ] Desktop and headset unchanged: `pnpm run verify:agent`, the face check
  and the hand replay pass.
- [ ] Proof video: the timed journey, real time, with a running clock.
- [ ] **Pending device (the user, after travel):** the same journey on an
  iPhone and an Android phone, timed with a stopwatch, under 2 minutes, by
  the owner with no help; the owner judges whether the result is worth
  sending.

## Failure cases considered

- The grant leaks through history, logs or a referrer: fragment only,
  stripped on read, single use, 15 min, upload-only.
- The grant expires during a long session: Post fails clearly and Save file
  still works; Post offers to sign in again (opens the viewer) without losing
  the take, which stays in memory until the page closes.
- Upload fails mid-way on a weak network: retry keeps the same take; the take
  is never dropped before the server confirms.
- A take over the size cap (existing notice) cannot Post; Save file works.
- Camera denied: selfie mode falls back to today's avatar with a one-line
  notice; Post still works.
- The pose and hand models are slow to load on a phone: the countdown starts
  only once the camera drives the avatar, with a visible "Starting camera".
- The author is too close for hands to show: the hint says to step back; a
  lost hand eases to rest (spike behaviour).
- `navigator.share` missing (desktop Firefox) or cancelled: Copy link.
- Cross-origin: capture calls the API with a bearer grant; the API's CORS
  for `POST /api/holograms` must allow the capture origins with an
  `authorization` header (today credentialed routes allow only web origins).

## Ownership

One lead (this session) owns all files; no parallel implementers. API route
and auth service: `apps/viewer-api/src/routes/auth.ts`,
`services/auth.ts`, `app.ts` (CORS). Viewer: `features/feed/FeedPage.tsx`,
`features/auth/`, a share sheet on the hologram page. Capture: the post step
in `recording/RecordingSession.ts` and its UI; selfie mode in
`runtime/`, `camera/` and `ui/`. Not owned here: avatar driving (see the
slice 2 boundary). Shared contract (the grant response) in
`packages/` with the other API contracts.

## Design decision

Recommended: the post grant (above). Rejected: capture keeps its own sign-in
(a second email round trip, two sessions to manage); serving capture under
the viewer's origin (deploy and routing change across two Pages projects, too
big for the gain); passing the session token itself (a full credential in a
URL).

## Open decisions for the user

1. **Handoff:** post grant in the URL fragment (recommended), or capture's own
   sign-in.
2. **Selfie flow before camera body lands:** build slice 2 now with
   face-only driving (recommended; the flow is ready the day the motion owner
   lands upper body), or hold slice 2 until then.
3. **Sign-in stays an email link** before recording (recommended while you
   are the only user), or anonymous posting now.

## Test plan and evidence

- One phone-profile Playwright journey (slice 1, extended by slice 2), the
  lean e2e for this brief; no regression corpus.
- API route tests for the grant's failure cases above (expiry, reuse, scope,
  forged), chosen from the list, not added after the fact.
- The existing face check and hand replay for the unchanged paths.
- Proof video: the timed journey, under ignored `output/phone-capture/`.

## Physical-device limits

All pending until the user is back from travelling: the journey time on an
iPhone (Safari) and an Android phone (Chrome); the pose and hand model rate
on each; boot, record-start and export times; `navigator.share` on each; the
owner's judgment of whether the result is worth sending.
