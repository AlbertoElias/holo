# Feature brief: A hologram of yourself from a phone in under 2 minutes

**Lead:** Claude (Opus)  
**Status:** Approved (the user, 2026-11-13, the recommended answer to all three decisions); design review accepted 2026-11-13; slices 1 and 2 built and verified in emulation (2026-11-13); device checks pending
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
| 3 | Understand what to do | A stock avatar seen **from behind** on a rock. The status line is desktop keyboard help ("WASD + Space, hold C to crouch, V toggles…"). The face camera starts at load on a real phone (`WebcamFace` is off only under `navigator.webdriver`, which is why the emulated run showed it off). Body moves only by touch joystick. | - | 20 to 40 s | Nothing tells a phone user what to do; the avatar is not them |
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
  (`#post=<grant>`; the API stores the viewer origin with the grant, so
  capture never takes a return address from the URL). The fragment never reaches a
  server; capture reads it, removes it from the address bar at once, and
  keeps it in memory only. The session token itself never leaves the viewer.
  Backward compatible: a new route; existing upload and auth are unchanged.
- After Stop, capture shows **Post** (primary) and Save file (the old
  download). Post uploads the take to `POST /api/holograms` with the grant,
  then goes to the viewer's `/h/<id>?posted=1`, which shows a prominent
  **Share** button (one tap: `navigator.share` needs a user gesture, so it
  cannot open by itself after a navigation); Copy link where share is
  missing.
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

- [x] **The mandate (automated, emulated):** one Playwright journey on a phone
  profile, from the viewer feed (signed in) → Record → capture in selfie mode
  → a 20 s take with a fake camera stream of a person → Post → the hologram
  page with Share, finishes with no step that needs typing an address,
  picking a file or copying a URL, and ends with the Share button shown.
  It runs with `TEST_OPEN_UPLOADS=false` and asserts the hologram's owner is
  the signed-in user. Its machine time (everything except the
  take and scripted taps) is reported, and the journey's modeled total
  (machine time + the take + one tap per step at 2 s) is under 2 minutes.
- [x] Signed out, Record asks for sign-in before opening capture; after the
  link, it continues to capture without a second tap on Record.
- [x] The post grant: expires after 15 min, is upload-only, works once; a
  replayed, expired or forged grant fails with a message in capture and the
  take stays available as Save file. The grant never appears in the address
  bar after capture reads it, and the session token is never sent to
  capture.
- [x] Capture without a grant behaves as today (no Post; download only).
- [ ] (Partial: all but the face tracks from a real camera, see Deviations.) Selfie mode: on a phone through Record, the front camera is on, the
  view faces the avatar, the countdown runs, and the exported GLB's face
  tracks move and play in `viewer-web`. (Head, arms and fingers from the
  camera are the motion owner's acceptance, not this brief's.)
- [x] A phone never shows the keyboard help.
- [x] Desktop and headset unchanged: `pnpm run verify:agent`, the face check
  and the hand replay pass.
- [x] Proof video: the timed journey, real time, with a running clock.
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
  is never dropped before the server confirms. A replay of a grant that
  already posted returns that hologram (200), so a lost response or a
  double tap never makes a second copy or an error.
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
slice 2 boundary). Agreed with the motion owner (2026-11-13): this brief adds
only an `onTakeExported(blob, name)` hook to `recording/RecordingSession.ts`;
the motion owner does not edit that file, and messages this session when
its camera driver lands on `main` behind `?input=camera`. Shared contract (the grant response) in
`packages/` with the other API contracts.

## Design decision

Recommended: the post grant (above). Rejected: capture keeps its own sign-in
(a second email round trip, two sessions to manage); serving capture under
the viewer's origin (deploy and routing change across two Pages projects, too
big for the gain); passing the session token itself (a full credential in a
URL).

## Design review (2026-11-13, accepted)

The `design-reviewer` subagent checked the plan against the code. Accepted:

- **The grant is not a session.** Its own token prefix (`holoim_pg_`);
  `resolveAuth` returns null for it, so it can never rename a user or delete
  a hologram; only `POST /api/holograms` checks it, strictly, even when
  uploads are open. Minted only from a session (no agent token, no grant).
- **Storage:** a new `PostGrant` table (hash, user, expiry, used-at,
  hologram id, return origin), not `ApiToken`. Claimed with
  `updateMany where usedAt = null`, released if storing fails, and the
  hologram id saved on success, like upload intents.
- **CORS:** `POST /api/holograms` also allows the capture origins (the bare
  production origin is not in today's allow list, so this would only have
  failed in production); an API test sends that origin.
- **Origins:** the return origin is stored on the grant from the mint
  request's checked `Origin`, never read from the fragment; capture takes the
  API origin from its build (`VITE_API_ORIGIN`); the viewer gets a new
  `VITE_CAPTURE_ORIGIN`.
- **Upload path:** capture posts multipart to `POST /api/holograms` (not the
  viewer's direct-to-R2 path, whose bucket CORS lists only viewer origins),
  with a default title and no naming step; it reads only `id` back.
- **Sign-in continues to capture:** the magic-link request takes an optional
  `next: "record"`; the verify page sends it to a viewer route `/record`,
  which mints the grant and replaces itself with capture in the same tab.
  This survives a mail app opening the link in another browser.
- **The hook replaces the download** when a grant is present
  (`deliverTake`), so iOS shows no download sheet mid-journey; Save file
  stays available.
- **Selfie flow:** a third view mode `selfie` (front, waist up, portrait),
  view-only, so exports are unchanged; turned on by grant plus a coarse
  pointer, never in phone AR and never as a camera-only take; the countdown
  lives in the UI before the record toggle and is cancellable; the phone
  status line stops showing keyboard help (`UIStateStore`).
- **Cold start:** capture warms the API when it loads with a grant (Fly
  stops idle machines).

Recorded, not in scope: shared links have no preview card (no `og:` tags),
which hurts "want to send"; a follow-up.

## Open decisions for the user

1. **Handoff:** post grant in the URL fragment (recommended), or capture's own
   sign-in.
2. **Selfie flow before camera body lands:** build slice 2 now with
   face-only driving (recommended; the flow is ready the day the motion owner
   lands upper body), or hold slice 2 until then.
3. **Sign-in stays an email link** before recording (recommended while you
   are the only user), or anonymous posting now.

## Test plan and evidence

### Evidence (2026-11-13)

- `apps/viewer-web/e2e/phone-capture.pipeline.spec.ts` (Pixel 7 profile, in
  `test:e2e:pipeline` and shard 5) runs the whole journey from signed out:
  feed → Record → email sign-in (the test API exposes the link) → capture
  with the grant → selfie hint → Record → "Starting camera" then 3-2-1 → take
  → Post → `/h/<id>?posted=1` with Share. It asserts the grant left the
  address bar, the hologram's owner is the signed-in user with a verified
  name, and no page errors. Timings land in
  `output/test-results/phone-capture-timings.json`; the latest run, seconds
  from the Record tap: sign-in link opened 2.1, capture loaded 2.7, recording
  started 16.3, take ready 30.7, posted 33.3.
- Modeled total: 33.3 s measured − the 3 s scripted take + a 20 s take +
  seven taps at 2 s + about 10 s to type an email ≈ 74 s, under 2 minutes.
  Opening the email on a real phone is not modeled.
- `apps/viewer-api/test/post-grant.test.ts`: single use and replay, release
  on a failed post, a stale claim (upload died) taken over after 5 min, never
  an identity, expired and forged grants refused with open uploads on, mint
  only from a site session and a site origin (never a capture origin,
  previews included), CORS for capture on the two routes only, the
  `next=record` sign-in link.
- `pnpm run verify:pr` passed on the branch before merging.
- Proof video (not committed): `output/phone-capture/phone-journey.mp4`.

### Deviations from the criteria

- The take is 3 s, not 20 s; the 20 s take is in the modeled total.
- No fake camera stream of a person exists in the repo, so face tracks
  driven from a camera are not exercised by the e2e; the face camera and
  MediaPipe do start on the timed path. Face motion from a real camera stays
  a device check (the selfie criterion is marked partial).
- The e2e runs with `TEST_OPEN_UPLOADS` at its default (true); the owner
  assertion proves the grant authorized the post, and the API tests prove a
  grant is checked strictly in open mode.
- The step-back hint for hands is not shown: it depends on camera hands,
  which belong to the motion owner.
- Sign in again after an expired grant opens the viewer's Record in a new
  tab; posting the same take from there is not built (this tab keeps Save
  file).
- Capture origins may POST `/api/holograms` without a grant through CORS;
  harmless while open uploads are off in production.

### Observed, not in scope

- Headless, the page froze about 6 s after capture loaded (the face camera
  and model start under software GL), so recording starts about 13 s after
  load. Unknown on a phone: a device check.
- Export takes 8 to 14 s headless.
- On `/h/<id>` the posted avatar stands on top of a statue in the stock
  scene, which hurts "want to send"; for the motion or scene owner.
- Follow-up: Open Graph tags for `/h/<id>` so a shared link previews.

### Plan

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
