# Feature brief: A scanned place around a take (split capture, first attempt)

**Lead:** Claude (Opus)  
**Status:** Implementing
**Layer:** event (the place, recorded by a scan) and view (how the portal
shows it); see `docs/product/concepts/what-a-hologram-is.md`

Source idea: IDEA-077, [phone reality capture](../product/concepts/phone-reality-capture.md).
This is slice 1 of "split capture": the place is a Gaussian splat scanned
once, and the person stays the recorded skeleton on today's avatar. A
photoreal look for the person comes later and is not part of this brief.

## User outcome

The user scans a real room on an iPhone with Scaniverse, exports the splat
(SPZ or PLY), and sees an existing performer take play inside that real place
in the feed's portal card: the avatar stands on the scanned floor at true
scale, the scan is cut by the cloche like the recorded set it replaces, and
Follow, Free, pause and zoom work as they do today.

A look test, not yet a hologram format: the scan is of a different place
than the take was recorded in, so the composite is *added* (principle 7).
Slice 2, which stores a place with a hologram, decides how that is shown.

## Scope

**Included:**

- The viewer's feed card (`HologramCardCanvas`) loads one splat with Spark
  (`@sparkjsdev/spark@2.3.1`, exact pin, resolved to the workspace's
  `super-three`) when the page URL has `?place=<url>`. The first card in the
  feed loads it; `placeFor=<id>` picks another. Spark is loaded by a dynamic
  `import()` inside the `testHooks` branch, so dev and e2e builds have it
  and production has no Spark code at all.
- Placement: Scaniverse scans are gravity-aligned and metric, so the only
  orientation question is which way is up (y up, or the trainers' y down: a
  half turn about x). As built, the scan says: each way up has a floor (the
  lowest strong peak below), and the right way is the one with clearly more
  of the scan (1.25 times) standing in the 1.2 m above its floor, where
  furniture and the foot of the walls are; the wrong way, the floor found is
  the floor seen from under it or the ceiling. When neither way is clearly
  ahead, the format's convention decides (PLY, SPLAT and KSPLAT y down, SPZ y
  up). `placeFlip=0|1` overrides it. The floor height is found from an opacity-weighted
  histogram of splat heights (2 cm bins, the lowest peak above a density
  threshold, ignoring the bottom tail of floaters) and put on the take's
  floor. x and z default to the median of the floor band; `placeX`,
  `placeZ`, `placeY` and `placeYaw` nudge by hand. Scale is never changed
  (principle 6).
- Clipping: the dome is applied in Spark's shader (a `SplatMesh` modifier)
  from the same uniforms the set's clip gets each frame (base plus
  `clocheShift`, radii, exponent), so the place's edge follows a walk take's
  moving dome. Splats are tested by extent (centre plus about twice their
  largest scale), with an alpha fade at the glass. An optional coarse CPU
  box crop at load (the dome swept over the take's shift range, plus a
  margin) only lowers the splat count; it is never the visible edge.
- Load order: the cloche fit waits for the place (with a timeout). The dome
  is fitted as today, set included, and the set is then hidden, so the slice
  of place matches the author's set and a place never changes the cloche.
  If the place fails, today's path runs unchanged.
- With a place, the recorded set (`RecordedSceneBubble`) is hidden and the
  rim is off (`rimProbe.gated = false`, today's flat dome). The avatar,
  recorded objects, marks, traces and the cloche stay.
- Rendering in the demand frameloop: `invalidate()` when a sort finishes and
  when the clip uniforms change; splats are not tone mapped (their colours
  are display-ready; decided as built: Spark's default premultiplied alpha is kept, and edge haloes are unchecked until the real scan); the cloche glass, traces and highlights draw after the
  splats. A ready probe says when the first sort has landed.
- Zoom: with the set hidden, a wheel or touch inside the cloche counts as a
  hit on the hologram, so the zoom continuum works over the scan.
- Memory: a splat cap (default 1.5 M after the crop); the decoded CPU buffer
  is cached across remounts, GPU resources are disposed on unmount.
- A git-ignored folder for scans, `apps/viewer-web/public/local-places/`, so
  `?place=/local-places/room.spz` works on the dev server.

**Excluded (later slices):**

- Storing a splat with a hologram: upload, the API record, the DTO, and
  `KHR_gaussian_splatting` in the GLB (contract change; slice 2).
- Camera takes (no performer, a different floor rule), tabletop scans (no
  room floor, so a true-scale avatar would stand on the table).
- The AR and VR viewers (IWSDK `hologramSpace.ts`), Quick Look (no splats in
  USDZ), capture.
- Aligning a take to the place in a UI, recording a take inside a scanned
  place, a photoreal person, moving people in the scan, relighting, shadows,
  privacy review of scans.

## Acceptance criteria

- [ ] With `?place=` pointing at a PLY or SPZ, the first feed card shows the
  splat around the take; without it, the card is unchanged (pixel check
  against today's render).
- [ ] The scan's floor is within 2 cm of the take's floor and the avatar's
  feet stand on it, with a table band and floaters in the scan (numeric
  report, plus a screenshot).
- [ ] No splat's extent is drawn outside the cloche, and in a walk take the
  place's edge follows the moving dome (numeric at two playback times;
  screenshot shows the edge cutting the scan).
- [ ] A place does not change the cloche: the same shape with and without.
- [ ] The recorded set is hidden and the rim is off while a place shows; both
  return without one.
- [ ] Follow, Free, pause, orbit and the zoom continuum still work with a
  place, zoom included over the scan.
- [ ] A missing or broken splat URL leaves today's card, with one console
  warning and no error state.
- [ ] The production bundle has no Spark code.
- [ ] The user's own Scaniverse scan (SPZ) plays around a real take in a
  proof video; load time, splat count and frame rate on the Mac and on the
  iPhone are recorded here.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Scan axes differ from the assumed convention | The scan says which way is up (more of it standing just above its floor), so a producer's convention does not matter; the format's convention only when the scan cannot tell; `placeFlip`; e2e: fixtures written y up and y down, with and without a ceiling as dense as the floor, and `placeFlip` against the scan; Spark's y-down `fireplace.spz` comes in upright with no flag |
| A ceiling is taken for the floor | The wrong way up the ceiling is the lowest strong peak, but only the tops of the walls stand on it; e2e: a ceiling as dense as the floor |
| Floor found at a table top or on floaters | Lowest density peak above a threshold, bottom tail ignored; fixture has a table band and floaters; report the found floor; `placeY`; no floor found means the place fails (one warning naming `placeY`) unless `placeY` is given, never a silent guess |
| The dome moves (walk takes) and a load-time crop goes stale | Clip in the shader from per-frame uniforms; CPU crop is coarse only |
| While a walk take plays, the clip can lag the dome by a frame (Spark regenerates asynchronously) | Accepted for slice 1; the e2e seeks and waits for `clipStale: false`, so it does not see it |
| A scan that decodes after the fit's 5 s wait is never shown on that mount | Accepted for slice 1 (the brief's timeout rule); the happy-path checks pass `placeWait=30000` so a loaded test machine does not time out, and only the slow-failure check uses the default; the real scan's load time on the Mac and iPhone is recorded below |
| A malformed `placeY` or `placeWait` | `placeY` counts as a given floor only when it is a finite number; `placeWait` is clamped to 1 ms–120 s, else 5 s |
| Large splats drawn past the glass | Extent test (with the per-axis diagonal factor `3^(1/n)`, in the shader and its TS twin) plus edge fade; the crop counts each splat's reach; e2e: a large splat just inside the dome is not drawn |
| Hiding the set before the fit shrinks the dome by load timing | Fit waits for the place; fit with the set, then hide it |
| The rim lifts to hidden recorded ground | Rim off when a place shows |
| Demand frameloop leaves an unsorted frame | `invalidate()` on sort and uniform change; ready probe before screenshots |
| Tone mapping or premultiplied alpha shifts colours or haloes edges | Splats not tone mapped; colours compared with Scaniverse's view; edge checked on the card background |
| A 1–3 M splat scan kills the iOS tab | Coarse crop, splat cap, GPU disposal on unmount; memory noted on the iPhone |
| Two copies of three break Spark silently | Spark resolves to the workspace `three`; checked in the lockfile and at runtime |
| Headless Chromium lacks the WebGL2 features Spark needs | Spike `place.spec` in `scripts/ci-emulate.sh` early |
| `?place=` loads third-party URLs in production | No Spark code in production; the value is never read there |
| A personal scan gets committed | Folder git-ignored; scans and the proof video stay out of git |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude (Opus) | Brief, integration, final handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only review before implementation (done) |
| Implementer | Claude (lead, this worktree) | `apps/viewer-web/src/features/place/` (new), `HologramCardCanvas.tsx` (mount, fit order, rim gate, zoom hit), `apps/viewer-web/package.json`, `.gitignore`, new `apps/viewer-web/e2e/place.spec.ts` |
| Independent verifier | Codex (`-p standard`, read-only) | Read-only verification; test artifacts only |

## Design decision

Chosen: render the place in the feed card only, from a dev-only URL value,
with Spark, clipped by the cloche in Spark's shader. It proves the look, the
scale and the frame rate with no contract change, so the export → upload →
render path is untouched.

Alternatives: a full upload path first (contract change before the look is
proven); a one-time CPU crop to the dome (rejected in review: the dome moves
with walk takes, and a centre test lets large splats spill past the glass);
fitting the dome without the set so it hugs the person (rejected: little of
the place would show, and the slice would no longer match the author's set).

Design review (2026-10-29, `design-reviewer`): shader clip instead of a load
crop; a fixed load-then-fit order; rim off with a place; extent culling;
floor measured against the take's floor; dynamic import so production has no
Spark; a real pipeline take in e2e; demand-frameloop, tone mapping, memory
and zoom details; tabletops and camera takes out of scope. All taken.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Splat shows; no place = unchanged | `place.spec.ts`: a PLY written by the spec (floor, table band, floaters, coloured boxes; nothing committed) on a real walk take from `recordWalkTake` | Screenshots with and without; place report JSON: Pass (2026-11-09, local, `RUN_E2E_PIPELINE=1 playwright test e2e/place.spec.ts`): card differs from baseline by the scan; baseline render noise 0; screenshots and `place-report.json` under ignored `output/place/`. Loaded 81933 splats, kept 51872, 24289 drawn |
| Floor and feet | Same check reads the place report through test hooks | `floorFound`, `takeFloor`, `feetY`: Pass: scan floor 21.25993 vs take floor 21.25993 (within 2 cm); feet (ankle bone) 21.375, 0.115 above the floor |
| Clipped by extent, follows the dome | Same check at two playback times | `outside: 0` at both times: Pass: `outside` 0 at t=0 and t=0.5 s (dome moved 1.73 m); magenta ring past the glass drawn at t=0 (410 px) and gone at t=0.5 s. Caveat: the mock take walks down a hillside, so the dome leaves the flat scan floor after about 1 s; checked earlier in the walk |
| Cloche unchanged | Same check: shape with and without | Equal radii, base, exponent: Pass: base, radii and exponent equal to a millimetre, with and without, and at both times |
| Set hidden, rim off | Same check | Visibility and `rimProbe.gated`: Pass: set visible and rim gated without a place; set hidden and rim off with one |
| Portal still works | Follow/Free/orbit/zoom case from `portal.spec.ts`, parameterised with `?place=` | Existing assertions pass: Pass: orbit drag to Free, zoom with the cursor over the glass above the scan, Return, Play (in the real-take case of `place.spec.ts`) |
| Broken URL | `place.spec.ts` with a 404 | One warning, card unchanged: Pass: one warning, no error text, pixel difference within render noise, same dome and rim |
| No Spark in production | Build, then search `dist` for Spark | No match: Pass: `pnpm --filter @holoim/web build`, then `grep -rlE "SparkRenderer\|sparkjs\|place_clip_fade\|__HOLOIM_PLACE__\|local-places" apps/viewer-web/dist` found nothing; `node scripts/check-prod-bundle.mjs` passes |
| Exactly one warning on every failure path | `place.spec.ts`: a 404 that arrives after the fit's 5 s wait | Warnings counted: Pass: one (the timeout's), card rendered, no error text |
| No floor is never guessed | `place.spec.ts`: a scan whose splat heights are not numbers | Status and warning text: Pass: status `failed`, one warning naming `placeY`, the way up left to the format (`upright: "format"`); with `placeY` in the URL the place is `ready` with no warning |
| Which way is up (2026-11-10) | `place.spec.ts`: the fixture written y up (against the PLY convention), y down with a ceiling 2.7 m up as dense as the floor, and y up with that ceiling; then the y-up one with `placeFlip=1` | Report `upright`, `flipped`, `floorFoundY`; magenta ring pixels: Pass: each read by the scan (`read`) and turned only when y down; the floor found is the floor, not the ceiling, and lies on the take's floor; `outside` 0, ring 0 px; with `placeFlip=1` the turn is the URL's (`given`) and the floor found is the floor seen from under it |
| First card, and `placeFor` | `place.spec.ts`: a faked two-card feed, pixels of each card with and without the place | Pass: `?place=` changes the first card only; `placeFor=<id>` changes the second only |
| A large splat's extent never spills | `place.spec.ts`: one large splat just inside the dome on its upper front diagonal, whose extent (checked) reaches past the glass, against a control of small splats at the same point | Pass: control drawn (magenta pixels), large splat 0 magenta pixels, `outside` 0 |
| Real scan, downloaded (SPZ, 2026-11-10) | Spark's example `fireplace.spz` (a captured room, 301,000 splats, 4.4 MB), git-ignored under `public/local-places/`, around capture's avatar; headed Chromium on the Mac (Metal) | Decoded 0.39 s, ready 0.9 s, sorted 1.1 s after load; 120 fps; 28,179 splats kept by the crop, 5,047 drawn inside the dome, 0 outside. First run needed `placeFlip=1`; since the way up is read, no flag (decode 0.48 s). Placed by hand at the hearth with `placeX=2.37&placeZ=0.95&placeYaw=90`; proof video seen by the lead (not committed). `snow-street.spz`, a street scan whose content sits 8–28 m from its origin, shows only a patch of its ground around the take: not a usable place without hand placement |
| Real scan (SPZ), the user's | User's Scaniverse export on the dev server, Mac and iPhone | Not done: needs the user's scan and iPhone |
| Real GPU, generated scan (2026-11-09) | Headed Chromium on the Mac (Metal), real walk take, the spec's PLY | About 120 fps while playing; ready 1.8 s, first drawn 2.5 s after load (nothing draws before Spark's first sort); the scan draws in every sample while the dome is on its floor; proof video seen by the lead (not committed) |

SPZ is covered only by the real scan; the spec writes PLY.

## Findings

- **A take must stand on ground as flat as the scan.** The pipeline's walk
  take descends about 2.8 m over its loop on capture's set, so its dome sinks
  below a flat scan's floor and the scan leaves the cloche for most of the
  loop. A real room is flat; takes recorded on capture's hilly set do not fit
  one. Recording a take inside a scanned place (a later slice) removes this;
  until then, a take on flat ground is the right pairing.
- **SPZ orientation is the producer's, not the format's.** Spark's example
  `fireplace.spz` is y down (its floor is the top of its height range and the
  hearth hangs under it), so a per-format default of no flip for SPZ put it
  upside down, and the floor finder did not notice: the floor is the scan's
  only strong height peak either way up, so the take stood on the floor's
  underside with the room cut away below the dome. Built since: the scan says
  which way is up (see Placement). With no flag, `fireplace.spz` is now turned
  (`upright: "read"`), at about 90 ms more decode; `snow-street.spz` is turned
  too, and its snow-covered ground is then underfoot.
- **The dome shows about a metre of the place.** Around a standing take the
  cloche cuts a room to the floor under the feet; furniture shows only where
  the take stands next to it. Finding that spot took a search of the scan and
  `placeX`/`placeZ`/`placeYaw` by hand.
- In software WebGL (headless checks under load) Spark rarely finishes a
  sort while a walk take moves the clip every frame; on the Mac's GPU it
  keeps up. The checks pause or seek before reading pixels.
- **The place belongs to capture, on every capture device (the user,
  2026-11-10).** Slice 1 adds a scan of a different place in the viewer; the
  next slice records the take inside the scan and stores it with the
  hologram. It must work wherever capture runs: Quest VR, Quest passthrough
  AR, phone AR and the desktop capture page. This slice's loader, crop,
  floor and way-up reading are that flow's render end. Queued in
  [`TODOS.md`](../../TODOS.md).

## Physical-device limits

The user's iPhone is the device for the real scan and the phone portal check.
Android and Quest are not covered: the AR and VR viewers are out of scope.
