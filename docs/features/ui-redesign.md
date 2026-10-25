# Feature brief: Redesign UI and interaction across capture and viewer

**Lead:** Claude Code (Opus)  
**Status:** Implementing (approved by the user 2026-10-24). Slices 0 to 4
are on `main` (3 and 4 merged together after `verify:pr` on the combined
tree); the user's second round (dock, controls, upload sheet, soot, the 3D
cloche) is on `main` at `02d0282` and deployed. The halo's third pass (the
burnt globe) replaces the cloche's rim-lit glass; slices 5 and 6 are on
`main` at `b3b4365`. The cross-vendor review of slices 2 to 4 and the second
round ran on 2026-10-25 and its fixes are in the verification rows below.
Next: slice 7
**Layer:** View (the edge, shade, chip, glyphs, ground, portal, Follow/Free
and the Halo). The held mark writes to the Meaning layer. See
`docs/product/concepts/what-a-hologram-is.md`.

Sources: the [styleguide](../product/design/styleguide.md) and its
[token file](../product/design/tokens.json) (decided 2026-10-24; the
styleguide wins where the two differ), and the interaction grammar that still
stands in [PRD-021](../product/prds/PRD-021-design-language.md) (held modes,
the Halo, "this"). PRD-021 is Draft: this brief is the build plan for its
unchecked In Scope items, widened by the user on 2026-10-24 to every page and
the Halo. It is not approval to build. The `TODOS.md` item "Redesign all UI
(2D and 3D) and interaction systems" links here.

The styleguide states decided rules only. This brief is the one place that
tracks what is still undecided and which decided values still lack a device
check. When a question is answered or a check changes a value, the result
goes into the styleguide and `tokens.json` as a plain rule.

## User outcome

Capture and the viewer look and behave like one product, on every page. On
every device a hologram is the same object: a portal in one burnt golden
edge, its few gold glyphs at its foot in a soft shade (flat screens) or on
its stage (headsets), nothing locked to the head.

Capturing and viewing are two flows with their own actions, and each action
works on every device each flow runs on: VR, AR, phone and desktop. The
first capture action is **hold to mark "this"**: a person who does it once
in a headset can do it on a desktop or a phone without instruction, and sees
what they marked in the portal.

## Scope

**Included**

1. **Safety net first.** Port the capture XR check scripts to TypeScript
   scenario groups, with the same checks, artifacts and `test:xr:*` names,
   before any UI changes (slice 0).
2. **A token package.** `@holoim/design-tokens` generates typed values and
   CSS custom properties from `docs/product/design/tokens.json`. No app or UI
   package hand-copies a design value (slice 1).
3. **Component contracts.** The redesigned parts specified once, as pure
   functions and types in `@holoim/xr-ui-core`, rendered by `@holoim/ui-dom`
   (DOM), `@holoim/xr-ui-r3f` (viewer 3D) and `@holoim/xr-ui-three`
   (capture 3D). Contract tests for all four, written from the failure list
   below. The existing `xr-ui-core` state contracts are kept (slice 2).
4. **Every page of the viewer** (`apps/viewer-web`) in the new look: the
   feed, the portal and Follow/Free (all three trial variants), upload, the
   WebXR AR route, and the empty, offline and error states (slice 3).
5. **Every page of capture** (`apps/capture`) in the new look, on desktop,
   phone, VR and AR, with touch input added for phones (capture has none
   today) (slice 4).
6. **A handedness setting** in both apps, which swaps the hands of the held
   grammar (slice 4).
7. **Hold to mark "this"** while recording, on every capture input:
   desktop, Quest hands, Quest controllers, phone and phone AR. An
   explicitly held mark overrides the mark inferred from pointing (slice 5).
8. **The Halo**, the radial menu with fixed directions, on every device
   (slice 5; its contents are Q20).
9. **The Quick Look baked halo** in the server-built USDZ (slice 6).
10. **A cross-device task test**, as PRD-021 describes, plus end-to-end runs
    of every action on every input (slice 7).
11. **Device checks.** Every decided value that still lacks a device check,
    as validation steps ("Physical-device limits"), with emulation and
    physical results kept apart.

**Excluded**

- Identity hues and author initials on marks. They come with the project
  that adds identities; until then pointing highlights keep today's colour
  and today's recorded/inferred look.
- "Here" (marking a place). Only "this" is in this brief.
- Ink drawing, speech commands and the verbs of the concept's verb table that
  no action here needs.
- Viewpoint portals (Q12). Their look is tracked with suggested viewpoints
  in [PRD-025](../product/prds/PRD-025-stand-here-markers.md) (IDEA-035).
- A VR viewing mode in `viewer-web` (Q19): a separate feature, queued in
  `TODOS.md`.
- The Follow camera driven by pointing (PRD-030), the time ribbon, layers and
  scrubbing.
- Any chrome in the exported GLB. The edge, sparks, shade, light, ground,
  chip, labels, Halo and fingertip shade stay in the view layer (styleguide
  section 1).

## Decisions and questions

### Answered by the user, 2026-10-24

| # | Question | Answer |
| --- | --- | --- |
| Q1 | Which held action? | Capturing and viewing are separate flows with their own actions; each action works on every device. Hold to mark "this" is a capture action, so it runs on every capture input (option A). An explicitly held mark overrides an inferred one |
| Q2 | Is the Halo in? | Yes |
| Q3 | Is the Quick Look baked halo in? | Yes |
| Q4 | Identity hue and initial | Part of the identity project, not this one |
| Q5 | One brief or one per slice? | Whichever is more efficient: one brief, each slice merged on its own after local verification |
| Q6 | Every page, or the record → view loop? | Every page |
| Q7 | Is "here" in? | No |
| Q8 | Dominant hand | A setting changes it |
| Q9 | Keep the portal's trial variants? | Yes, all three |
| Q14 | Provenance looks | Start with today's recorded/inferred distinction |
| Q15 | Soot in VR | Soot exists everywhere it is needed |
| Q16 | AR brightness threshold | Set by the lead from known data (below) |
| Q17 | Gaze-and-pinch | In scope; size set by the lead (below) |
| Q18 | Chip on an unlisted AR target | 92% |
| AR edge (slice 3) | How does the golden edge show in WebXR AR? | "Draw the burnt golden edge as an outline around the bubble, following its shape, and keep the bubble rendering." Built as a ring on the bubble's silhouette, facing the viewer (styleguide 9.2). Then: "Remove the aura's cyan equator ring; keep the rest of the bubble rendering." |

What follows from those answers:

- **The held mark is `recorded`** and suppresses any inferred link the point
  detector writes for an overlapping span (Q1). Controllers are back in,
  which reverses the pointing brief's choice to leave them out.
- **Phone capture needs touch input** (look, move, record, hold to mark) and
  phone AR capture needs a mark whose ray starts at the camera, not a bone.
  The v0 meaning record requires `from: {bone, node}` and cannot say that
  truthfully, so phone AR marks need a meaning record change (v1). That goes
  to the `@holoim/meaning` owner as its own reviewed change, and older
  readers must keep loading v0 files.
- **Handedness defaults to right-handed**, stored per device, and changed in
  each app's settings (Q8).
- **The Quick Look halo reaches existing files too** (answered 2026-10-24):
  in production every stored hologram's USDZ is rebuilt with the halo; in a
  local database only the three most recent are.
  Styleguide 9.5 names the wrong files: the USDZ is built by
  `apps/viewer-api/tools/glb_to_usdz.py`, run by
  `src/services/usdz-worker.ts` (`tools/preview_usdz.swift` is only a macOS
  preview tool).

### Set by the lead, on the user's delegation (Q15 to Q17)

These are starting values, built to and listed as device checks; a check
that changes one updates the styleguide and `tokens.json`.

- **Soot everywhere it is needed (Q15).**
  - VR: the flat-screen rule. The renderer knows the luminance of the VR
    room behind the edge, as it does on a flat screen, so `t(L)` applies with
    soot 0.6.
  - AR with a lighting estimate (Android Chrome): soot replaces the glow
    outright when the room is bright (threshold below).
  - AR with no lighting estimate (Quest passthrough today): soot stays on at
    full strength, because legibility against a bright wall matters more
    than warmth in a dim room. Device check 9 looks at it in a dim room.
- **The AR brightness threshold (Q16).** WebXR lighting estimation gives
  spherical-harmonic coefficients in linear light. Take the ambient (first)
  coefficient's relative luminance, `Y = 0.2126 R + 0.7152 G + 0.0722 B`,
  and switch soot on at `Y ≥ 0.16` and off below `0.095`. Those are the two
  luminance points where the flat rule is all soot and all glow, measured in
  round 3; the gap between them is the hysteresis, so soot does not flicker
  at the boundary. Device check 2 confirms or replaces them, since the scale
  of the estimate against camera exposure is not documented the same way on
  every device.
- **Gaze and pinch (Q17): 72 apx**, about 1.5° of view. That is the size
  the concept proposed, and it sits above eye-tracking accuracy (about 1° to
  1.5°) and in line with Apple's 60 pt minimum for visionOS targets.
  visionOS sends gaze and pinch as `transient-pointer` input; the hit
  resolver maps that input to 72 apx. There is no Vision Pro to check it on
  (device check 10).

### Answered by the user on a second pass, 2026-10-24

The user asked what Q10, Q12 and Q13 meant and for a suggestion on Q11;
the lead's proposals below were accepted as written, except where noted.
Nothing in this brief is still open.

- **Q10. What makes a hologram's edge the same everywhere?** The tears
  along the edge are random, drawn from a seed. To look the same in the
  feed, in AR and in Quick Look, a hologram needs one fixed seed. *Decided:*
  the seed is the hologram's id, which the viewer and the USDZ builder both
  know. Capture's own preview, before upload, uses a seed picked per take:
  until it is uploaded it is not yet a hologram anyone else sees. Nothing is
  written into the GLB.
- **Q11. Where do general controls go?** Hologram controls go at its foot;
  general ones (Exit AR, upload, settings, sign-in later, the Halo, Record
  before a take) need a home. *Decided,* from the styleguide's placement
  table: on phone and desktop, actions go in the **bottom dock** (on its
  shade, thumb zone on a phone) and lists and settings in a **side sheet**;
  in a headset, actions go on the **non-dominant wrist** and lists and
  settings on a **world panel 1 m or more away**. In AR before placement, or
  with the hologram out of view, Exit and the placing hint are on the wrist
  (Quest) or in the dock (Android). The top status line shows state only.
- **Q12. Viewpoint portals.** An author could suggest other angles to watch
  from ("see it from behind"). The styleguide says each would be a small
  golden portal floating in the scene that you step or click into; the open
  part is its look, because at that size the burnt edge becomes a plain
  line. No feature suggests viewpoints yet. *Decided:* out of this brief.
  The open look is recorded with suggested viewpoints in
  [PRD-025](../product/prds/PRD-025-stand-here-markers.md) (IDEA-035).
- **Q13. The rescale indicator.** Rescaling means showing a hologram bigger
  or smaller than it was recorded, such as a person shrunk onto a table.
  True scale is a fact (principle 6), so any rescale must be visible,
  labelled and reversible. Today the AR route silently resizes every
  hologram so the recording is 1.85 m tall (`AR_MODEL_TARGET_HEIGHT_METERS`,
  clamped between 0.12× and 2.5×), so a 1.6 m person shows taller than they
  are, with no label. *Decided:* AR opens at true scale; if the viewer
  pinches to resize, a label on the chip shows the scale (for example
  "1:4" or "½ size") with a glyph that returns to true size. The label's look
  is new and goes to the user with slice 3's screenshots for a check.
- **Q19. Viewing in VR.** Viewing happens in VR too, but `viewer-web` has
  no VR mode today. *Decided:* a separate feature (holograms on stages in
  the blue-hour room, styleguide 9.1), queued in `TODOS.md`.
- **Q20. What does the first Halo hold?** The concept's directions are
  fixed (N note, NE symbols, E redo, SE mark moment, S record/stop, SW
  retake, W undo, NW ink), but most of those actions do not exist yet.
  *Decided:* capture's Halo carries S record/stop, W undo the last held
  mark and E redo it; empty directions draw nothing, and their places stay
  reserved. The viewer's Halo waits for viewing actions beyond Play, Free and
  Return.
- **Q21. Input collisions.** The concept summons the Halo with a
  right-button hold on desktop and a long-press on a phone, but the held
  mark already uses the right button on desktop, and the natural phone mark
  is touch-and-hold on the thing itself. The rule that all chrome but stop
  hides while recording also leaves no mark button on a phone. *Decided:*
  the mark keeps the right button (desktop) and becomes touch-and-hold on the
  referent (phone and phone AR, no button needed); the Halo moves to a held
  key on desktop, chosen against capture's key map (Space is taken), and to
  a long-press on the dock's Halo glyph on a phone.

### Built to the rule, open to revisit

Not questions: the build follows the styleguide for these. They were drawn
in the Direction Studio and never compared against alternatives, or carried
from the design-language concept without a studio comparison, so a slice's
evidence may send one back to the user.

- Drawn, never compared: the flat chip at 72%, sparks on the desktop card
  nearest the middle, reduced motion in headsets (the same 8 s fade), the
  glyph drawings, chip radius and padding, glyph gaps, line heights, the
  record shapes, the tinted note slip, and the shade's height.
- Carried from the concept: the three materials, the placement model, hand
  feedback (proximity cue, tick, controller pulse), and the chrome motion
  rules (from the source, back to the source; crossfade under reduced
  motion; the world never moves without the user's action).

### The user's second round, 2026-10-25 (lead and Codex decide)

The user, after slices 3 and 4: "dont treat the styleguide as definitive
objective… finish the project with your's and codex best design decisions
and we'll keep iterating." Taste calls in this round are the lead's with
Codex; each is recorded here with its alternatives, and the styleguide and
`tokens.json` now state the result.

- **No dock shadow.** The dock's band (slice 3) is gone on both apps. The
  row sits on the chip, sized to its contents: the bottom of the ground is
  amber, where gold fails (2.1:1). Alternatives: bare glyphs (fail contrast
  on amber), a lighter band (still a shadow). Only a hologram casts a shade.
- **Fewer controls, spaced, off the edge line.** At rest a card shows Play
  (or Pause, now drawn) alone; Return joins it beside Play while driving.
  On reach the timecode unfolds left and Free, highlights, tilt, View in AR
  and sound unfold right, two glyph gaps apart. Play never moves. Icons
  only on the card (new drawings: Pause, Sound on/off, Upload, Close); the
  word stays the accessible name. Alternatives: a single "more" glyph that
  opens a tray (one more press for every action), labels beside every glyph
  (crowds a phone row).
- **Upload sheet.** Two glyph gaps of padding and between fields, a Close
  glyph, a dashed drop zone as the file picker (drag and drop; the native
  input stays as `#glb-upload`), fields as soft wells that turn gold on
  focus, a switch for Quick Look (`#quicklook-enabled`, `role=switch`), and
  Upload as glyph and word, right-aligned. The empty-feed notice steps aside
  while the sheet is open, since it sat on the sheet's title on a phone.
- **No soot.** The edge's dark halo read as a drop shadow. The cloche keeps
  the soot rule's input as char: a narrow dark line beside the gold.
- **The 3D halo: the cloche.** Four candidates rendered in the real viewer
  (both live GLBs; rest, orbit, side, zoom, inside): a case, three rings, a
  floating bubble and a dome. Codex (deep) picked the dome, with revisions
  that are all built: one shoulder curvature for every hologram, a single
  quiet foot line, burns over the whole shell, a narrow rim with little glow,
  the dome framed at about 70 to 80% of the viewing box clear of title and
  controls, the shade from the content's footprint, a fade to nothing inside
  with no back wall, and one object on every device. The card's canvas now
  fills the card, so the scene is never cut square; the viewing box between
  title and controls only frames Follow (`setViewOffset`). After the first
  render the rim was a rope on zoom, so its widths are now shares of the
  on-screen radius held between 120 and 200 device pixels (a 2 to 4 px line), the glow is
  halved, and the inside fade completes before the glass. Rejected: the case
  (an editor's bounding box), the rings (an atom; they compete with people),
  the bubble (weightless, sealed).
- **Per device.** WebXR AR (Quest passthrough, Android) draws the same
  cloche, fitted in the placed hologram's own space so placement and the
  viewer's rescale carry it, replacing the flat ring and the bubble's blue
  glass; the aura stays for now. Capture draws no halo during a take and has
  no playback review yet; when it gets one, it mounts `ThreeCloche`. Quick
  Look (slice 6) cannot draw a view-dependent rim; after the third pass
  (below) it bakes the burnt globe instead.

### The halo, third pass: the burnt globe (2026-10-25)

The user, on the deployed cloche: "we need to figure out the halo effect
better so it's more ragged and it has the sparks coming out and so that it
really feels like it wraps the whole 3d object, it looks very much 2d". The
cloche's line sat at the silhouette in screen space, so it read as an
outline: it did not change as the view turned, and nothing showed the far
side.

Five forms were prototyped in the real viewer on the same fitted dome, each
with 3D sparks, a warm light and depth falloff, and rendered front-on,
orbited, zoomed, from inside and on a phone, then recorded in motion:

- a burnt shell (seeded 3D noise burns the dome away; only the fronts stay),
- a cage of torn gold filaments,
- an ember field on the dome,
- a burning lip at the foot,
- ash, the burnt shell with embers.

Codex was at its usage limit, so an Opus design reviewer stood in. It
ranked ash first (silhouette, far-side lines and embers in depth), then the
burnt shell, the embers, the cage (a birdcage), and the lip (a flat
ellipse, so 2D from the side). It picked ash on one condition: the front
must be quiet over the event. Its tuning is built in:

- the fronts fade where the shell faces the viewer and are whole at the
  silhouette and on the far side;
- widths are in screen pixels (a 1.5 px cream core, gold to 3.2 px, a pixel
  of char);
- the fronts are torn into dashes with a second noise and have about 40%
  fewer holes, so the burn reads as burning, not contours;
- embers are capped at 3.5 px and fade near the eye (no bokeh), mostly gold;
- out of focus only the silhouette band burns and 45% of the embers drift;
- focus brings full embers and sparks, eased over about 400 ms.

The first pass at that tuning made the globe vanish, so the gating was
relaxed until the silhouette carried it again. Sparks rise from 26 to 120 on
flat screens (70 to 160 in a room) and live 1.1 to 2.6 s: a few sparks read
on a 2D outline, but on a volume they are dust. The globe sheds no light of
its own; the portal's stage light already does that.

The burn noise is in `@holoim/xr-ui-core` (`clocheBurn.ts`), with the same
noise as GLSL, so Quick Look (slice 6) can bake tubes along the same fronts
for the same seed. Codex, on the built globe beside the old dome and all five
prototypes: ragged, sparks and wrapping in 3D each answered, the event
still dominates, no other prototype better ("the cage encloses too
aggressively, embers alone lose the boundary, and the lip reads as a
burning pedestal"), "Verdict: ship". Its two taste notes are built: zoomed
in, the near side steps back to 75%, and fronts close to the eye fade.

## Delivery slices

Each slice leaves `pnpm run verify:pr` green and is merged on its own.
Slices 0 to 2 change nothing a person can see.

| Slice | What | Blocked by |
| --- | --- | --- |
| 0 | Port the capture XR checks to TypeScript | Nothing |
| 1 | `@holoim/design-tokens` | Nothing |
| 2 | Component contracts and their tests | Slice 1 |
| 3 | Every viewer page | Slices 0 and 2 |
| 4 | Every capture page, touch input, handedness | Slices 0 and 2 |
| 5 | Hold to mark "this" and the Halo | Slice 4; the meaning v1 change for phone AR |
| 6 | Quick Look baked halo | Slice 2 (the seeded outline) |
| 7 | Cross-device task test and device checks | Slices 3 to 6 |

### Slice 0: port the capture XR checks

The checks drive the app through hooks the redesign will change: DOM buttons
found by role name ("Start Recording", "Stop Recording" from
`createRecordingUiState`), `canvas` lookups, and about twenty `window.__*`
automation hooks defined in `apps/capture/src/runtime/createCaptureRuntime.ts`
and `automationHooks.ts`. Porting first, with types for those hooks, turns a
silently broken selector into a type error.

- Port `apps/capture/scripts/ci-*-playwright.mjs`, `run-xr-checks.mjs` and
  `scripts/lib/*.mjs` (about 3,900 lines today, more than the `TODOS.md`
  estimate) to TypeScript scenario groups run by `tsx`, like the two checks
  already in TypeScript (`ci-terrain-locomotion.ts`,
  `ci-xr-height-playwright.ts`). Fixture generators stay `.mjs` unless they
  import from `scripts/lib/`.
- Keep everything that depends on the scripts working:
  `apps/viewer-web/e2e/pointing.pipeline.spec.ts` imports
  `scripts/lib/pointing-desktop-take` and `pointing-iwer-replay`;
  `apps/capture/scripts/doctor.mjs` checks script paths (and `verify:pr`
  runs it); `.github/workflows/ci.yml` shards with `XR_SHARD`.
- Keep every environment variable the scripts read, including `XR_SHARD`,
  `XR_CHECK_CONCURRENCY` and the other `*_CONCURRENCY` variables,
  `XR_TEST_ARTIFACT_DIR`, `BASE_URL`, `DEV_PORT`, `REUSE_DEV_SERVER`,
  `POINTING_LABELS`, `POSE_FIXTURE`, `XR_REPLAY_ONLY`,
  `HAND_REPLAY_FIXTURES`, `BODY_REPLAY_FIXTURES`, `BODY_REPLAY_FAULTS` and
  `VR_LOCO_VIDEO`, with the same script names, report paths and artifacts.
- One typed module declares every `window.__*` hook the checks call; the app
  and the checks import the same declaration.
- Controls are found through accessible names exported from one module
  (`xr-ui-core`), used by the capture checks and by the viewer e2e specs
  that click them ("Start Recording" in the capture-to-viewer spec, "Play"
  and "Return to the author's view" in the portal spec). A later label
  change then cannot silently break a check.
- **Equivalence evidence:** run every check on `main` and on the branch, and
  compare each `*-report.json` with a comparator that drops timings and
  paths and compares numeric fields within tolerances declared in the
  comparator. A difference is a port defect unless explained in this brief.
- **As built (2026-10-24).** Every `ci-*` check, the runner
  (`run-xr-checks.ts`), `scripts/lib/*` and the two fixture generators that
  import from it (`generate-pointing-test-scene.ts`,
  `generate-iwer-pose-fixture.ts`) are TypeScript run by `tsx`, under the
  same `test:xr:*` names. `generate-iwer-body-fixtures.mjs` imports nothing
  from `scripts/lib/`, so it stays `.mjs` and keeps its literal button text.
  The hooks are declared once in `src/runtime/automationHooks.ts` as the
  global `Window` (the app's `AutomationHooks` plus `IWER_DEVICE`, now typed
  as IWER's own `XRDevice`); hooks a check installs itself are declared next
  to the code that installs them. `CONTROL_NAMES` in `xr-ui-core` labels
  capture's record button and the viewer's Play, Pause and Return, and the
  capture checks and viewer e2e specs find them by it.
  `@holoim/tooling-testing` now has `@playwright/test` for its declarations,
  so `page` is a real Playwright `Page` in the checks rather than `any`.
  Explained differences: tsx compiles with esbuild's `keepNames`, which
  wraps named inner functions of `page.evaluate` callbacks in an `__name`
  helper the page lacks, so three scripts add a one-line identity `__name`
  init script (the callbacks themselves are unchanged); and two reports are
  assembled by spreading rather than mutating, with the same key order.
  The comparator is `apps/capture/scripts/compare-xr-reports.ts` (see
  `AGENT_CONTRACT.md`).

### Slice 1: `@holoim/design-tokens`

A new workspace package. The token file stays where it is
(`docs/product/design/tokens.json`), next to the styleguide that wins over
it, so design rounds edit one place.

- A generator (`tsx`) reads the W3C DTCG file, resolves aliases, and writes
  two committed outputs: `src/generated/tokens.ts` (sRGB hex colours, apx
  sizes, ms durations, shares of the short side) and
  `src/generated/tokens.css` (custom properties for the DOM). Committed
  output, because the packages here are consumed as TypeScript source with
  no build step, the CSS and the Python USDZ tool can read plain files, and
  a token change then shows in review as a diff of real values.
- Only tokens with a `$value` are generated; free text and `$extensions`
  are not exported, so an undecided item has no value code can read.
- **The drift check runs when tokens change.** Today
  `isDocumentationFile` in `scripts/verify-changed-core.ts` and the `docs/*`
  rule in `scripts/ci-changed-areas.sh` treat a `tokens.json` edit as
  docs-only and skip package checks. Both classifiers map
  `docs/product/design/tokens.json` to `@holoim/design-tokens` and its
  dependents, with a tooling test for the mapping. The drift check is the
  package's `test`: regenerate and fail on any difference.
- **The literal check.** A rule in `@holoim/config-eslint` fails on a
  string or number literal equal to a token colour (`'#ffc872'`,
  `0xffc872`, `rgba(8,26,30,…)` and the like) outside the token package, so
  every package's existing `lint` runs it. CSS files are checked by a small
  script added to the `lint` of each app that has them. Today `ui-dom`
  hand-writes `uiDomTokens`, `viewer-web`'s `global.css` has 34 hex
  literals and a few components 12 more, and capture has 20 (12 in a debug
  view, which may be exempted by path). Today's pointing highlight colour
  is not a token colour, so it stays until the identity project.
- **Colour in three.js.** The apps use three with colour management on, so
  `new Color('#ffc872')` already converts to linear. The package exports
  sRGB hex and one helper that sets the colour space explicitly; chrome
  materials set `toneMapped: false`, since the AR route uses ACES filmic
  tone mapping, which would shift gold and cream.
- **Sizes.** `apxToMeters(apx, distanceM, { headset })` is exported once.
  The 2.5 headset factor applies to type, icons, glyph strokes, rings, glyph
  gaps and the chip's shape, as the styleguide's tables give; hit areas come
  from a separate per-input table and are never scaled. Where `tokens.json`
  says less (`appliesTo`), the styleguide wins and the token file is fixed.
- The values set in this brief (Q15 to Q18) are added to the styleguide and
  `tokens.json` as plain rules before this slice generates from them.
- Fraunces and Figtree are self-hosted as WOFF2 for the DOM, and baked to
  MSDF at the styleguide's weights for 3D. Today `global.css` names Space
  Grotesk and never loads it.
- **As built (2026-10-24).**
  - `scripts/generate.ts` writes three committed files: `tokens.ts`,
    `tokens.css` (each colour also as an `-rgb` triplet for
    `rgb(var(…) / a)`; the gradient as its stop list) and a flat
    `tokens.json` that the lint rule, and later the Python USDZ tool, read
    without TypeScript. It fails on an unresolved or circular alias, a hex
    that disagrees with its components, and any `$type` it does not know.
  - `$extensions` are never exported, so the size rule moved into plain
    tokens: `size.radiansPerApx` (0.000372) and `size.headsetScale` (2.5).
    The fluid CSS sizes (`clamp(…)`) are still `$extensions` and so not
    generated; slice 3 adds them as tokens if its pages need them.
  - `apxToMeters(apx, distanceM, { headset })` scales every drawn size;
    `hitAreaMeters(input, drawnApx, distanceM, { headset })` takes the
    larger of the drawn size and the input's unscaled minimum (and 20 mm for
    a poke). `@holoim/design-tokens/three` exports `tokenColor(hex)`
    (`setStyle(hex, SRGBColorSpace)`) and `chromeMaterial`
    (`toneMapped: false`).
  - **Literal check: at error level from the start, with nothing to
    migrate.** None of today's literals equals a token colour: `uiDomTokens`
    and the viewer's and capture's hex values are the old palette. So the
    rule (`holoim/no-token-colour-literal`, in every package's lint through
    `createWorkspaceTsEslintConfig`) and the CSS check
    (`check-css-literals.mjs`, in the `lint` of `viewer-web` and
    `knowledge`, the apps with CSS files) pass today and fail as soon as a
    token colour is copied. Replacing the old-palette literals with tokens
    is the restyle itself, so slices 2 to 4 do it page by page; the rule
    cannot see them because they are not token values.
  - Fraunces (opsz and wght axes, for optical sizing) and Figtree (wght)
    are self-hosted as variable WOFF2, latin and latin-ext, from Fontsource
    5.3.0 under the OFL, in `@holoim/design-tokens/fonts.css`. No app
    imports it yet: the pages that switch to the new faces do (slices 3 and
    4), with the computed-font e2e check. The MSDF bake for 3D is left to
    the slice that first draws 3D text in the new faces (slice 2's
    `xr-ui-three` and `xr-ui-r3f` renderers), since nothing reads it before.

### Slice 2: component contracts

`xr-ui-core` gains the redesigned parts as pure functions and types, so each
rule and formula is written and tested once, with tests citing the
styleguide section they come from. The existing exports
(`createRecordingUiState`, `resolveArShellNoticeState`,
`createArImmersiveActions` and the state types) keep their behaviour and
their tests.

| Contract | What it decides |
| --- | --- |
| Edge outline | Burnt outline from a seed (Q10): 280 points, waves, tears, jitter, inset, as shares of the short side; the same points for SVG, canvas, three.js and the USDZ |
| Edge strokes | Halo, core, highlight and soot widths and levels; the 3D halo opacity `min(1, 0.9 × level / 0.5)`; the soot rule per target (flat and VR `t(L)`, AR on the estimate with hysteresis, AR without an estimate always on) |
| Recording edge | Flat screens: halo at level 0.08, core and highlight at 0.55, no sparks. Headsets: no edge |
| Chip | Opacity per target and blend mode (2.3), 92% on an unlisted AR target; where it is mandatory (5.2); the VR fade-in of 0.3 s and hold of at least 2 s |
| Shade | The radial gradient, width 120% of the hologram, and the label rim |
| Glyph | Drawings, ring, stroke, states (rest, cream lift on hover, focus ring, pressed at 55%), the always-there set dimming to 40% after 4 s idle |
| Hit area | The larger of the drawn size and the input's minimum: mouse 24, touch 44, ray 56, poke 72 and at least 20 mm with 30 apx gaps, gaze and pinch 72 |
| Placement | Which slot each control lives in (stage base or shade, non-dominant hand or dock, point of action, referent, periphery, world or side sheet; Q11); only the periphery status line follows the head |
| Handedness | Which hand is dominant, from the setting; every slot and held mode reads it |
| Headset text | No text within arm's reach; labels, timecode and caption fade within 1 m of a hologram and return beyond it; notes fold to their mark |
| Motion | Flicker per target (the round 1 levels, the stage-light sine, the VR swing), sparks on the hologram in focus only, reduced motion, chrome unfolding (240 ms in, 400 ms out) |
| Recording chrome | Everything but stop and the running time hides until the take ends |
| Halo | Eight fixed directions; ring after about 300 ms; a flick commits without drawing; empty directions reserved (Q20) |
| Held mode | Starts on hold; ends on release, on tracking loss and on blur; consumes its own release |
| Scale | True scale by default; a rescale is labelled and reversible (Q13) |
| Chrome flag | A structural flag on every chrome object, so recording, export and point resolution skip it |

The renderers then implement the contracts:

- `ui-dom` replaces its nine generic components (UiPanel, UiButton, UiPill
  and the rest) with the glyph control, the chip, the shade, the dock, the
  side sheet, the Halo, the edge (SVG) and the type roles.
- `xr-ui-r3f` replaces `HeadLockedActionBar` with controls at the
  hologram's foot on the chip and on the wrist, and draws the edge and the
  Halo in the AR route.
- `xr-ui-three` replaces `ThreeLabelPill` and `ThreeRecordingActionPanel`
  with the wrist glyphs, the periphery status line, the chip with
  hysteresis, the world panel, the Halo and MSDF labels.

- **As built (2026-10-24).**
  - `xr-ui-core` gained one module per contract (`edge`, `chip`, `shade`,
    `glyph`, `hitArea`, `placement` with handedness and the status line's
    lazy follow, `headsetText`, `motion`, `recordingChrome`, `halo`,
    `heldMode`, `scale`, `chromeFlag`, `typeRoles`, `targets`, `random`),
    pure functions over `@holoim/design-tokens`; the old exports and their
    tests are unchanged. A target is `{kind: "flat" | "vr" | "ar" |
    "quickLook"}`, AR naming its compositor (`unlisted` takes 92%).
  - Tokens: the generator dropped a colour's alpha (the shade's 0.7 and 0.5
    stops); it now keeps it, and has a deliberate `svgPath` type for the
    glyph drawings. The flicker keyframes and constants, the glyph
    drawings, the shade's placement and the 3D halo's 0.9 moved from
    `$extensions` into plain tokens, so no formula constant is typed in code.
  - MSDF: Fraunces 600 and Figtree 400, 500 and 600 baked by
    `packages/design-tokens/scripts/bake-msdf.ts` (fontTools instancing,
    `@zappar/msdf-generator` in a Node worker; deterministic), loaded through
    `@holoim/design-tokens/msdf`. Latin and Latin-1 only: a caption in
    another script loses its glyphs (`missingGlyphs`) until more are baked.
  - `ui-dom`: `GlyphControl`, `Chip`, `Shade`, `Dock`, `SideSheet`, `Halo`,
    `EdgeSvg` and the type roles. `xr-ui-three`: `ThreeEdge`, `ThreeGlyph`,
    `ThreeMsdfLabel`, `ThreeChip`, `ThreeWristGlyphs`, `ThreeStatusLine`,
    `ThreeWorldPanel`, `ThreeHalo`, all materials through one chrome helper
    and every object chrome-flagged; an MSDF label takes its role's line
    height, and the timecode's figures share the widest digit's advance, so
    the running time never shifts. `xr-ui-r3f` mounts those objects:
    `HologramFootControls`, `WristControls`, `Edge`, `HaloMenu`. The old
    components stay exported, marked deprecated, until slices 3 and 4 move
    the apps over; no app changed.
- **Set by the lead in slice 2 (2026-10-24).** The contracts needed values
  the styleguide did not give. Each is now a plain rule in the styleguide and
  `tokens.json`, built to and open to revisit like those above:
  - The periphery status line sits 1.5 m away, 20° above the line of sight,
    and follows lazily: still until the head turns 20° from it, then eased
    back (240 ms time constant) to within 1°. A world panel opens 1.5 m
    ahead (never nearer than 1 m) and stays. Wrist glyphs sit 4 cm above the
    back of the non-dominant wrist, sized at 45 cm.
  - The VR chip leaves over 0.4 s, as chrome does; its 2 s hold counts from
    the last frame the background asked for it, so a wavering background
    never makes it flicker.
  - No sparks further than 30° from the head's forward ray (peripheral
    vision).
  - One hold duration, 300 ms, for the Halo ring and for touch-and-hold, with
    a touch slop of half a touch target (22 apx).
  - The Halo's layout comes from the glyph tokens: each direction is a 36 apx
    glyph ring, neighbours one 12 apx gap apart (radius about 63 apx), and
    leaving the centre's own ring (18 apx) picks a direction.
  - The edge outline's recipe: one sine of 3 to 9 waves; tears spread one per
    share of the loop, each a triangular notch inward, 0.6× to 1.4× the tear
    amplitude deep (so the phone card's tears average 2.2 apx and never pass
    3.1, as section 3.3 gives); seeded by FNV-1a and mulberry32, golden-tested
    in `packages/xr-ui-core/src/fixtures/edge-golden.json` for the Python port
    (slice 6).
  - A scale label is a ratio, "1:4" or "2.5:1", with enough digits never to
    read "1:1" off true scale.
- **Still to draw, for the user with slice 3's screenshots.** The styleguide
  has no drawing for Pause, true size (Q13), Exit, Undo, Redo, Settings,
  Upload or Close, no blur value for the gold core ("softly blurred"), and
  no width for the side sheet. Until those are decided the contracts draw
  the core sharp, a Halo direction whose action has no drawing as an empty
  glyph ring, the side sheet's close control as the word "Close", and the
  side sheet at `min(100%, 24rem)`.

Contract tests for `ui-dom`, `xr-ui-r3f` and `xr-ui-three` check that each
renderer carries out the core contract: the same edge points from the same
seed; hit areas at the input minimum; the chip opacity for the target;
material colours read back with `getHexString(SRGBColorSpace)` equal to the
token, with `toneMapped` off; the Halo's directions; the chrome flag on
every chrome object. They are chosen from the failure list below, not
written to ratify code. Their `--passWithNoTests` flags are removed.

### Slice 3: every viewer page

- The ground gradient pinned to the screen; nothing bare from 75% down.
- Every card: the burnt edge, the shade at its foot, Play, Free and Return
  as glyphs in the shade, the timecode "Paused · 0:08". The highlights and
  tilt toggles in `PortalControls.tsx` appear from the cursor or touch and
  leave, since only Play, Free and Return are always there.
- Follow and Free keep the portal store's behaviour (`portalStore.ts`,
  `PortalMode`) in all three variants (`freeze`, `drag`, `tilt`). Free is
  the four-way glyph and Return the arc glyph. The portal e2e checks keep
  passing.
- Upload in the side sheet; feed-wide notices (empty feed, offline, server
  error, upload status) on the chip, never under the upload panel; general
  controls in the dock (Q11).
- "View in AR" as the cube in brackets on the card, in its shade.
- Sparks on the card nearest the middle only; the others hold and do not
  redraw. Flicker and reduced motion per the styleguide.
- Pointing highlights keep today's colour and recorded/inferred look.
- The WebXR AR route: controls at the hologram's foot, every row on the chip
  (97% Quest passthrough, 88% Android Chrome, 92% elsewhere), no head-locked
  bar, steady stage light, soot per Q15 and Q16, Exit per Q11, true scale
  per Q13. The edge is a burnt ring round the bubble's silhouette, facing
  the viewer, with the bubble's own rendering kept (the user's AR-edge
  answer); checked by an IWER screenshot of the ring from two sides. Quest AR uses headset sizes (2.5×, rays 56, poke 72, labels fade
  within 1 m); Android uses flat sizes and touch 44.
- **As built (2026-10-24), branch `feature/ui-redesign-slice-3`.**
  - Feed: the ground gradient on `body::before`, fixed to the screen; each
    card has its title and byline, the portal cut to `edgeOutline` seeded by
    the hologram id (`EdgeSvg`), and the `Shade` with Play, the timecode
    ("Paused · 0:08"), Free and Return (`GlyphControl`; Return shows "Return"
    and keeps the core's full name). The reach row (highlights, tilt, View
    in AR, sound) unfolds on pointer or focus and leaves after the idle
    time. On touch, the first tap only reveals it. The card nearest the
    middle (`nearestToMiddle`) runs `edgeFrame` and draws its sparks on a
    canvas from core's `createSpark`, `sparkCount` and the token colours. The
    other cards hold the resting frame. The feed's stage light comes from
    core's `stageLight`.
  - The dock holds Upload, and the `SideSheet` holds the form. Notices for
    the empty feed, offline, a server error with "Try again", and the upload
    status are on the `Chip` at the top, never under the form.
  - AR: `HologramFootControls` at the hologram's foot (Play or Pause, and the
    timecode). When the viewer pinches, a second row shows the scale label
    and a true-size control. On a headset, `WristControls` puts Exit on the
    non-dominant wrist, read from the frame's grip or wrist pose. A phone's
    dock holds Recenter and Exit, with notices on the chip. Glyphs are
    selected by an XR `select` ray against their hit meshes. The silent
    1.85 m resize is gone: the hologram opens at true scale. The three bright
    point lights became one steady stage light. `HeadLockedActionBar` and
    the old `Ui*` components are no longer used by the viewer.
  - Package change, approved by the lead (commit `7b9f666be095`):
    `GlyphControl` takes `glyph: null` (the word stands in its place) and a
    `word` prop. `GlyphSpec.id`, and the wrist row's glyph list in
    `xr-ui-three`, admit null (an empty ring). Contract tests cover both.
  - **Placeholders, accepted by the user on flat screens (2026-10-24):**
    Pause, Exit AR, Recenter, Upload, true size and "Try again" are words on
    flat screens and empty rings in the room. An empty ring on the wrist cannot be told apart, and no text
    may sit within arm's reach. So Exit on the wrist needs a real drawing
    before slice 3 counts as done in a headset (Recenter is not on the wrist
    yet for the same reason).
  - **AR edge, as the user decided.** `edgeOutline` takes a `shape`; the
    rounded rectangle stays the default and a `circle` is drawn with no
    inset, waves, tears and jitter as shares of the diameter, from the same
    seed and draw order as the card. `bubbleSilhouette` gives the circle
    where the eye's lines touch the sphere; the `BubbleEdge` in `xr-ui-r3f`
    lays a unit circle `ThreeEdge` there every frame, facing the eye, scaled
    to the silhouette's diameter, and hides it from inside the bubble. The
    viewer mounts it in world space from `ARHologramModel`'s bubble, beside
    the kept aura. Soot: the AR session now asks for `light-estimation`
    (optional, through `arSessionInit`, since the XR store has no option for
    it); `useArSoot` reads the probe's ambient luminance into
    `nextArSootOn`, so Android switches at 0.16 and 0.095 and a Quest, with
    no estimate, keeps the soot on. The aura's cyan equator ring crossed the
    gold ring on both sides; the user had it removed (2026-10-24), so the
    gold ring alone outlines the bubble and the rest of the aura stays.

### Slice 4: every capture page, touch input, handedness

- Desktop and phone: the overlay as glyphs in a shade and a bottom dock on
  the bottom shade, settings in a side sheet, touch words on touch devices
  (no keyboard help on a phone), glyphs as SVG, never emoji.
- Touch input for capture on phones: look, move and record by touch, with
  44 apx targets clear of the gesture zones.
- Headsets: the record glyph on the non-dominant wrist (no head-locked panel
  or pill, as `VrHud.ts` and `VrRecordingPanel.ts` draw today), "Recording
  0:12" on the periphery status line, settings on a world panel, labels
  only 1 m or more away, 2.5× type and glyphs, hit sizes per input, the
  fingertip shade before a poke, a soft tick on commit, controller pulses.
  System sounds stay out of the capture mix.
- The record control: rose circle when idle, rose rounded square while
  recording, inside the gold ring; the state carried by shape and word.
- Recording chrome per the styleguide on every target.
- The handedness setting, right-handed by default, stored per device.
- Every chrome object carries the chrome flag, so the scene sampler
  (`collectSceneBubbleGroup`, which exports every visible non-skinned mesh)
  and the point resolver skip it.

Built (2026-10-24, branch `claude/sharp-snyder-e9566f`):

- Q15 for capture: capture shows no hologram and no edge in VR (it never
  drew the edge), so VR soot does not apply to it.
- Controls whose glyph is not drawn yet (Settings, Enter or Exit VR and AR,
  Refit height, Recenter AR, Face camera, the handedness options) are
  `GlyphControl` with `glyph: null`, which draws the word (slice 3's
  `7b9f666`). With the lead's approval, `GlyphControl` now passes
  `disabled`, `id`, `role`, `aria-*` and `data-*` to its button
  (`7e5cfd2`), so capture keeps no control of its own. The file pickers'
  words are plain gold `controlLabel` type over the native file input,
  which is the control. No wrist control is undrawn: the wrist row holds
  only Record.
- Placeholder looks for the user's screenshot check, since the styleguide
  has none: a disabled control draws at the 40% idle dim with no cream lift
  and no pressed state (Refit while the height fit runs, the pickers while
  recording). A chosen option has no selected look either, so the choice is
  said in words under the handedness pair.
- In a headset the wrist row takes `poke` hit sizes when the dominant hand
  is tracked and `ray` sizes with a controller. The world panel opens 1.5 m
  ahead when the session starts and stays there; it hides while recording.
  A ray commits only for the controller that fired, and chrome takes only
  each side's own input, so one controller never commits twice. A poke
  arms only when the fingertip is seen above the glyph's face, and a row
  whose label hides within 1 m takes no hits. With focus on a DOM control,
  Space and Enter press it; the scene does not jump.
- Handedness swaps the wrist row, the tray's holding and summoning hands in
  VR, and the desktop pointing arm (switched only at rest). Desktop carry and
  summon stay right-handed: one IK chain drives them.
- The tick plays on its own audio context, so it never enters the take's
  sound. The poking hand reads as untracked to the recorder while it pokes,
  so a poke never records as a gesture.
- Values set to the rule here, open to revisit (local constants, proposed
  for the styleguide and `tokens.json`): the fingertip shade appears within
  10 cm and grows to 3× the drawn radius; contact at 8 mm, a push 4 cm
  through still commits, rearm after 3 cm back; tick 2200 Hz, 18 ms, gain
  0.12, panned at the glyph; pulses 0.15 for 12 ms on hover and 0.5 for
  30 ms on commit; the walk stick takes touches starting in the left 40% of
  the scene, travels 44 apx, and touch look turns 0.006 rad per px.
- Limits kept: phone AR capture has no DOM overlay, so Recenter AR stays
  unreachable there, as before.

### Slice 5: hold to mark "this", and the Halo

| Input | Hold | Point | Today |
| --- | --- | --- | --- |
| Desktop | Right mouse button while pointer-locked, F as fallback | Mouse aim | Exists (self-resolving pointing) |
| Quest hands | Non-dominant thumb–middle pinch | Dominant index | New; today a point is only read, never held |
| Quest controllers | Non-dominant trigger | Dominant ray | New; reverses the pointing brief's choice to leave controllers out |
| Phone | Touch and hold on the referent (Q21) | The same finger | New; needs slice 4's touch input |
| Phone AR | Touch and hold on the referent (Q21) | Ray from the camera through the touch | New; needs the meaning v1 change |

- Letting go, losing tracking, or the window losing focus ends the mode.
- The mark is a `link` with `provenance: recorded`; it suppresses any
  inferred link for an overlapping span.
- No mark appears live in the headset (concept, "This and here"); it shows
  in the viewer's portal on phone and desktop.
- Undo and redo of the last held mark, through the Halo (Q20).
- The Halo on every device, with the summon idioms of the concept's verb
  table except where Q21 moves them.
- Any change to the meaning record goes through the `@holoim/meaning` owner
  as its own reviewed change; v0 files keep loading.

#### Slice 5 build plan (lead, 2026-10-25)

Found while planning:

- **Capture's AR is a spectator.** In WebXR AR (Quest passthrough or
  Android) every capture system returns early, recording included
  (`frame.arSpectator`), so no AR take exists to hold a mark in. Phone AR
  marks need AR recording first, a capability of its own. **Deferred** (the
  lead, 2026-10-25): phone AR marks are out of slice 5, with no meaning v1
  change; "AR recording (phone as a camera-only author)" is queued in
  `TODOS.md`. Whether a take with no performer is a hologram is a product
  question for the user, open, not decided. The Halo is built where capture
  records (desktop, phone, VR).
- **The tray already took two Halo summons.** PRD-045's tray holds on the
  non-dominant Y/B button and on the non-dominant palm turned up: the
  concept's Halo summons for controllers and hands. Taken instead (lead's
  call, open to revisit):

| Input | Mark "this" | Halo |
| --- | --- | --- |
| Desktop | Right button under pointer lock, or F (built) | Hold **B** and move the mouse; or press and hold the dock's Halo glyph |
| Phone | Touch and hold the scene (look side) 300 ms within 22 apx, then the finger aims | Press and hold the dock's Halo glyph, drag |
| Quest hands | Non-dominant thumb–middle pinch; the dominant index aims | **Dominant** thumb–middle pinch, drag the hand |
| Quest controllers | Non-dominant trigger; the dominant ray aims | Press and hold the **non-dominant thumbstick**, tilt it (that stick stops walking or turning while held) |

  Hands use the one alternate pinch on each hand: on the non-dominant hand it
  holds "this", on the dominant hand it summons the Halo. Rejected: palm-up
  and Y/B (the tray's), a long index pinch (the Grab verb), X/A (Speak's).
  B on desktop: the left hand stays on the keys while the right hand flicks
  the mouse; Space, R, F, C, V, G, T, Q, E, Z, X and 1 to 5 are taken, Tab
  moves keyboard focus.

How it is built:

1. **One aim-hold record for every input.** `PointSampleStore` aim holds
   gain the input that made them (`desktop`, `touch`, `hands`,
   `controllers`). Desktop keeps its path; a phone hold casts a camera ray
   through the finger and the arm points at what it lands on; a hand hold
   takes the dominant index's filtered ray (`PointDetector`) whatever its
   pose score; a controller hold takes the dominant target ray. Headset
   holds resolve against the scene and the body (never the pointing arm), as
   inferred points do; desktop and phone holds against the scene only, as
   today. Each becomes a `recorded` link with the dominant hand as `from`,
   which v0 already says truthfully.
2. **Suppression by the hold's span.** After resolution every inferred
   link is trimmed by the take's held spans (the hold, not its link, padded
   0.25 s each side); a piece shorter than the point dwell is dropped. The
   report says "trimmed by hold" or "suppressed by hold", so a hold that
   lands on nothing still overrides a guess made meanwhile, and a guess
   outside the hold survives. A tap (shorter than 0.2 s) or an undone hold
   suppresses nothing.
3. **Held modes through `stepHeldMode`.** Hands: the non-dominant
   thumb–middle tips within 1.5 cm enter, beyond 3 cm leave, and only while
   the thumb–index gap is wider by at least 1 cm (an ordinary pinch never
   holds); a hand that loses tracking ends the mode. Controllers: the
   non-dominant trigger above 0.5; a lost source ends it, and the trigger's
   own select is swallowed while the mark holds and on its release. Phone:
   the look-side touch waits out the hold delay inside the slop; moving out
   first makes it a look drag. Every mode ends on blur and hidden page.
   Headset modes start only while recording (no live mark in a headset).
4. **Undo and redo.** The store keeps the take's holds and a redo stack:
   W undoes the last hold (ending it if open), E restores the last undone
   one, a new hold clears the redo stack. Undoing a hold lifts its
   suppression. Only during a take; afterwards the take is exported.
5. **The Halo.** `stepHalo` drives all of them; S toggles recording through
   the Record control's own gate, W and E undo and redo. Flat screens draw
   the ring with `@holoim/ui-dom` (a presentational `HaloRing` split out of
   `Halo` so a held key can drive it; the key's ring opens at the mouse,
   moved in until the whole ring is in the window, found by the proof
   video when the mouse rested on the dock); headsets draw `ThreeHalo` where the
   summoning hand is, facing the head. The dock's Halo glyph stays during a
   take (it carries stop and undo), so `chromeVisible` keeps `halo` while
   recording; styleguide 8.5 says so. A hand summoning the Halo gives no
   point evidence meanwhile, as a poking hand does. Commits pulse a
   controller and tick for a hand; the flat status line says "Mark undone"
   or "Mark restored" for 1.5 s.
6. **Glyphs.** Undo, redo and the Halo get drawings in `tokens.json`
   (Codex reviews them with the screenshots).

Design review (Opus design-reviewer, 2026-10-25), adopted:

- The controller mark runs on the trigger's own `selectstart` and
  `selectend`, and chrome ignores a select the mark owns (`ownsSelect`),
  including one within 0.3 s of a mark's release.
- The stick Halo opens only from a stick at rest; the stick stays locked
  out of locomotion until it recentres; its release latches the last
  direction for 100 ms, since a stick springs back as the press lets go.
- Undo while a mark holds ends it and drops samples until that input
  releases, so the same press does not open a new hold.
- A hold is opened and closed by its writer; non-desktop holds bridge
  frame gaps, and a holding hand gets 0.25 s of grace before tracking loss
  ends it. A hand mark reads only that side's own hand: with it gone,
  tracking lends the side the other hand's joints, which read as a release
  (found by the marks check).
- The aim pauses while the Halo is open; the view does not turn while B
  holds.
- The hands mark needs the thumb–index gap over 4 cm and never starts on a
  hand that grabs or holds the tray; the hand Halo's drag is measured in the
  head's yaw frame, so turning does not change the choice.
- A touch hold is backdated to the touch's start; the touch input is not
  written to the export (links are built field by field, and v0 says the
  dominant hand truthfully).
- Headset notices show on the status line; W with nothing held says
  "Nothing to undo"; a handedness change ends a mark and closes the Halo.

Verification, 2026-10-25: `verify:pr` passes step by step on this branch
(the atlas e2e against this worktree's own knowledge server, since the main
checkout's server held port 4176). Codex's independent pass is open: it hit
its usage limit twice before reporting, and its one early note, whether the
key's ring reads clearly enough over a busy scene, is for that pass.

Not adopted, open to revisit: ending the take at the moment the Halo was
pressed when S stops it (the release is when the author chose it), and
requiring the drawn ring before the stick may commit S (a flick is a
commit on every input). Known limits: an undone desktop or phone hold keeps
its inferred arm-motion span; the byte-identical export check holds only
for takes with no holds.

Checks (emulation): `test:xr:pointing` adds a held-mark phase per input
(desktop with Halo undo and redo, phone touch, IWER hands, IWER
controllers) and reads the exported GLB for one `recorded` link per hold
on the right referent and no inferred link overlapping a hold; release
paths (release, tracking loss, blur) and the ordinary pinch are exercised.
A Halo phase flicks and holds every direction with mouse, the B key,
touch, IWER hands and IWER controllers, and reports what committed and
whether the ring drew. The viewer pointing pipeline shows a held mark on
phone and desktop.

### Slice 6: Quick Look baked halo

Revised on 2026-10-25 for the cloche (styleguide 3.4 and 9.5), and again
the same day for the burnt globe: the flat outline, core and soft halo of
the first plan frame no hologram any more, and the seams, lip and glass of
the first cloche bake went with the cloche's glass.

- **What is baked.** `apps/viewer-api/tools/glb_to_usdz.py` adds
  `/Root/Cloche` when it builds a USDZ, fitted by `fitCloche`'s rules:
  exponent 2.6, the foot on the lowest drawn point, a 4% margin, shoulders
  at least 40% of the wider radius. The form is the burnt globe. RealityKit
  has no shader and no view-dependent fade, so it is carried by geometry in
  diffuse and emissive materials only: the burning fronts as thin emissive
  gold tubes with a cream core on their outer face and a char strand on the
  shell's side, torn into dashes where the web tears them, and the web's
  resting embers as small emissive octahedra in three heats (ember, gold,
  cream). No sparks, no glass. The bubble's old blue shell is hidden, as on
  the web. Values are tokens (`edge.cloche.quickLook`). The exported GLB is
  unchanged. `cloche.build(shape, seed)` returns the form as named parts
  (meshes and materials), and the converter writes whatever it is given, so
  a later form plugs in without touching the converter.
- **The same burns as the web (Q10).** The seed is the hologram's id; the
  worker passes it (`--seed`). `tools/cloche.py` ports `fitCloche`,
  `clocheSeedOffset` and the burn rules of `clocheBurn.ts`
  (`clocheBurnAt`, `clocheTearAt` (added for the bake: the shell shader's
  tear), `clocheLocalPoint`, `clocheNormalAt`, `clocheRandom`,
  `clocheBurnFronts`, `clocheEmbers`). The fronts are the zero level set of
  `clocheBurnAt` over the dome, marched on a grid of directions (110 samples
  per wider radius), so they lie where the web's shell is discarded. A
  golden-vector file (`packages/xr-ui-core/src/fixtures/cloche-golden.json`)
  is checked by the TypeScript tests and by `tools/test_cloche.py` (run by
  the API's vitest suite), so the two cannot drift; four deliberate
  mutations of the port (hash, tear, ember offset, fbm octave) each fail it.
- **What is fitted.** The built stage: every visible mesh at the first frame
  (at most 3,000 points each), kept to the pinned bubble, and the author's
  joints at eight times through the take with 0.18 m head room, plus the box
  corners of meshes the take moves by their own transform. The web reads a
  walk relative to a bubble that follows its author; Quick Look pins the
  bubble, so the walk is read in place and the dome covers it.
- **Readback.** `inspect_usdz.py` refits the dome from its own GLB
  evaluation and checks the recorded foot and radii; every part on the dome
  (fronts within 2.5 tube radii, embers within their spread); the gold on
  the burn's zero level (median and 99th percentile of |`clocheBurnAt`| at
  its vertices); the embers the viewer's own for the seed; opaque matte
  materials; the seed offset; and the hidden blue shell. The framing extent
  includes the globe.
- **No shadow.** Quick Look draws one grounding shadow under the whole
  model and no USD attribute opts a mesh out; the fronts and embers are thin
  and sparse, so they add little to it. Recorded as a limit.
- **Converter version `ql3`.** New uploads store `-ql3.usdz`; deleting a
  hologram removes every version.

Existing files are rebuilt by a one-off script, `apps/viewer-api/src/rebuild-usdz.ts`
(`pnpm --filter @holoim/api rebuild:usdz`): in production, every stored
hologram's USDZ; locally, only the three most recent (`--recent 3`). For each
`ready` record on an older version it converts the GLB again, inspects the new
package (a cloche seeded by the id, and no check failed that the old preview
passed), stores it beside the old file, and only then switches the record,
so a failed rebuild leaves the old preview in place. It resumes after an
interruption (switched records are skipped, a journal keeps failures, a
first signal finishes the hologram in hand). Old files stay unless
`--delete-old`. It runs on production only with the user's go-ahead, once
the slice is verified locally against the three local files.

### Slice 7: cross-device task test and device checks

See "Test plan and evidence" and "Physical-device limits".

## Acceptance criteria

- [x] Slice 0: every capture XR check runs from TypeScript under its old
  script name and environment, the viewer pointing pipeline and `doctor`
  still pass, and the report comparator finds no unexplained difference.
- [ ] No design value is hand-copied: the lint rule and the CSS check pass,
  and `ui-dom`, `xr-ui-r3f`, `xr-ui-three`, `viewer-web` and `capture` read
  colours, sizes and timings from `@holoim/design-tokens`.
- [ ] Editing `tokens.json` makes `verify:agent` run the token package and
  its dependents; regenerating changes the value in the DOM and the 3D
  scene; not regenerating fails the drift check.
- [x] Every formula (soot, halo opacity, flicker, stage light, sizes) is
  written once in `xr-ui-core`, with tests that cite the styleguide.
- [x] The `xr-ui-core` state contracts are unchanged and their tests pass;
  the new contracts have tests; `ui-dom`, `xr-ui-r3f` and `xr-ui-three` have
  contract tests and no `--passWithNoTests`.
- [ ] Every page of both apps is in the new look on each device it runs on;
  no page mixes old and new UI.
- [ ] Viewer, phone and desktop: each card shows one burnt edge, the shade,
  and Play, Free and Return in it; nothing bare from 75% down; notices on the
  chip; only the card nearest the middle sparks.
- [ ] Follow and Free behave as the portal brief requires in all three
  variants, and every portal e2e check passes.
- [ ] AR (WebXR): no control is head-locked; every row is on the chip at the
  target's opacity; Exit is reachable before placement and with the
  hologram out of view; the hologram opens at true scale and any rescale is
  labelled and reversible; the stage light never flickers.
- [ ] Capture headset: no head-locked panel; the record glyph is on the
  non-dominant wrist; "Recording 0:12" is on the periphery status line; no
  text within arm's reach; while recording, only stop and the running time
  show.
- [ ] Capture runs on a phone by touch: look, move, record and hold to mark.
- [ ] Switching handedness swaps the wrist, the held mode and the pointing
  hand in both apps.
- [ ] Hit areas meet the input minimum on every glyph (mouse 24, touch 44,
  ray 56, poke 72 and 20 mm, gaze and pinch 72).
- [ ] Reduced motion: no sparks, the 8 s halo fade, chrome crossfades in
  place.
- [ ] Hold to mark "this" produces a `recorded` link from desktop, hands,
  controllers, phone and phone AR in end-to-end runs, no inferred link
  overlaps it, and the viewer shows it on phone and desktop. (Emulation
  passes for all but phone AR, which is deferred to AR recording in
  `TODOS.md`; device checks are open.)
- [ ] The Halo opens with the same directions on every device, and a flick
  commits without the ring drawing.
- [ ] The export → upload → render pipeline e2e passes; a take without marks
  exports byte-identical to before, with all chrome visible during the
  take; v0 files still load after the meaning change.
- [ ] New USDZ files carry the baked burnt globe, its fronts and embers the viewer's
  the same hologram; the rebuild script has updated the three most recent
  local holograms and then every production hologram, with no preview lost.
- [ ] The cross-device task test has run and its results are recorded here.
- [ ] Every device check below has a recorded physical result, or is listed
  under remaining limits with the reason.

## Failure cases considered

Listed before choosing isolated tests; contract tests come from this list.

| Failure case | Prevention or evidence |
| --- | --- |
| A design value is copied by hand and drifts from the token file | Generated package; lint rule and CSS check |
| A token edit is classed as docs-only, so the drift check never runs | Both change classifiers map `tokens.json` to the package; tooling test |
| The generated output is stale after a token edit | Drift check regenerates and diffs |
| An alias in the DTCG file is unresolved or circular | Generator fails on it; generator test with a bad alias |
| Code picks a value for an undecided item | Only `$value` tokens are generated; undecided items have none |
| Gold is converted to linear twice, or tone-mapped, in three.js | sRGB hex plus one colour helper; `toneMapped: false`; read-back test |
| The headset factor is applied to type only, leaving strokes and rings at flat size | One size function following the styleguide's tables; contract test per part |
| The edge differs between SVG, canvas, 3D and the USDZ for one hologram | One seeded outline; same-seed tests; points passed to, or golden-tested against, the Python tool |
| The edge is clipped square at small sizes | Inset is the larger of 6% and the halo width; test at the 80 px thumbnail |
| Chrome (stage controls, chip, MSDF text, Halo, fingertip shade, edge) is exported in the GLB or becomes a pointing referent | Chrome flag skipped by the sampler and resolver; byte-identical export with chrome visible |
| A glyph's hit area shrinks to its drawing on touch, rays or gaze | Hit-area contract, never scaled; renderer tests per input |
| Phone controls reach into gesture zones or safe-area insets | e2e on a 390 × 844 touch viewport measures control boxes against the zones |
| Phone touch for capture (look, move) fights the feed's or the page's scroll | `touch-action` set per surface; e2e on the touch viewport |
| A control is head-locked in a headset | IWER check walks the head; every control but the status line stays in world or hand space |
| Text appears within arm's reach | IWER check measures label distance from the head; under 1 m fails |
| AR controls or Exit are unreachable before placement or with the hologram out of view | Wrist or dock placement (Q11); IWER check before placement and looking away |
| A hologram is shown at a scale nobody chose, unlabelled | True scale by default; rescale labelled; AR e2e reads the model's scale |
| The VR chip flickers on and off at a boundary | 0.3 s fade, 2 s minimum hold; contract test steps a background across the threshold |
| AR soot flickers as the lighting estimate wavers | On at 0.16, off below 0.095; contract test feeds a noisy estimate |
| AR with no lighting estimate keeps the glow against a bright wall | Soot always on there; device check 9 |
| The chip is opaque in AR, hiding the room | Contract: never 100% in AR |
| Red alone carries the recording state | Shape and word change with it; check asserts the stop shape and "Recording" text |
| The idle dim hides a control someone is reaching for | Approach of hand, cursor or gaze restores it; test with a cursor near the glyph |
| Sparks on every card drop frames on a phone | Focus-only rule; e2e asserts one card animates; device check 4 |
| Flicker exceeds three flashes a second | Contract test samples the flicker curve; reduced-motion path tested |
| A label rename breaks a check that finds a button by name | Names exported from one module, used by capture checks and viewer e2e |
| The TS port changes what a check proves | Report comparator with declared tolerances |
| The port breaks a dependant (viewer pointing pipeline, `doctor`, CI sharding) | Those three run in slice 0's evidence |
| Handedness is read in one place and not another, so the wrist and the held hand disagree | One handedness contract every slot and mode reads; IWER check with both settings |
| The held mode gets stuck on (release lost on tracking loss or blur) | Mode ends on release, tracking loss and blur; IWER check drops the hand mid-hold |
| A held mark on hands is confused with an ordinary pinch | Mode uses the non-dominant thumb–middle pinch; IWER check performs both |
| Releasing a held trigger fires `select` at whatever its ray hits (`VrHud.ts` listens on every controller) | A held mode consumes its own release; IWER check releases over a control |
| A poke on the wrist record glyph is read as a point at `leftHand`, adding an inferred link at the end of every take | Points at chrome or during a chrome poke are dropped; replay check over a take's stop |
| A recorded and an inferred link cover the same point | The held mark suppresses overlapping inferred links; export check |
| The Halo and the held mark share a trigger (desktop right button, phone long-press) | Separate triggers (Q21); e2e performs both on each device |
| A Halo flick is read as a drag or a scroll | Flick threshold and direction snapping; e2e flicks each direction with mouse, touch and IWER |
| The poke tick is picked up by the headset microphone through the air | Listen to a recorded take on a device; if audible, back to the user |
| A v1 meaning record breaks older readers, or v0 files stop loading | Version bump through the meaning owner; viewer loads both; pipeline e2e with a v0 export |
| Marks change the GLB for takes without marks | Extension written only when there are marks; byte-identical export check |
| The viewer hides an old GLB without the meaning extension | Extension is optional; feed e2e includes an older export |
| Fonts fail to load and text falls back to a different face | Self-hosted WOFF2; e2e checks the computed font family |
| The USDZ rebuild fails partway, or replaces a working preview with a broken one | New file written beside the old; switched only after it validates; resumable; run locally on three files first |
| Old and new UI coexist on one page mid-redesign | Each slice converts whole pages; merged only when its pages are complete |

## Ownership

| Role | Owner | Files or modules |
| --- | --- | --- |
| Lead | Claude Code (Opus) | This brief, contract decisions, integration, final handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only review before implementation |
| Implementer, slice 0 | Assigned at start (Standard tier) | `apps/capture/scripts/**`, the automation-hook declaration, `.github/workflows/ci.yml` (XR sharding only), the import lines of `apps/viewer-web/e2e/pointing.pipeline.spec.ts`; lands before slice 3 starts |
| Implementer, slices 1 and 2 | One integrator (contracts are shared) | `packages/design-tokens/**`, `packages/xr-ui-core/**`, `packages/ui-dom/**`, `packages/xr-ui-r3f/**`, `packages/xr-ui-three/**`, the lint rule in `packages/config-eslint/**`, `scripts/verify-changed-core.ts`, `scripts/ci-changed-areas.sh` |
| Implementer, slice 3 | Assigned at start | `apps/viewer-web/src/**`, `apps/viewer-web/e2e/**` |
| Implementer, slices 4 and 5 | Assigned at start | `apps/capture/src/**`, capture checks for touch, handedness, the held mark and the Halo |
| Meaning owner | Assigned for the v1 change | `packages/meaning/**`, as its own reviewed change |
| Implementer, slice 6 | Assigned at start | `apps/viewer-api/tools/glb_to_usdz.py`, `apps/viewer-api/src/services/usdz-worker.ts`, the one-off rebuild script |
| Independent verifier | A different vendor from the implementer (for example Codex) | Read-only; test artifacts only |

Slices 3 and 4 may run in parallel once slices 0 and 2 are merged; they
share no files.

## Design decision

- **Order:** port the checks and build the token package and contracts
  before any visible change, so every later slice is caught by typed checks
  and generated values.
- **Tokens:** the file stays in `docs/` beside the styleguide; a generator
  writes committed TypeScript and CSS; both change classifiers treat a token
  edit as a package change; a shared lint rule catches copied values.
  Rejected: reading the JSON at runtime (CSS and the Python tool want plain
  files, and three.js colour handling wants one helper, not ad hoc
  parsing), and moving the file into the package (the styleguide and its
  tokens are edited together in design rounds).
- **Components** are specified once in `xr-ui-core` and rendered three ways.
- **Design review, 2026-10-24:** Q1 set out with its costs; the chrome
  flag and chrome-export failure case added; the drift check wired into both
  classifiers; the port keeps its dependants and full environment; three.js
  colours stay sRGB with an explicit helper and no tone mapping; the headset
  factor follows the styleguide's tables; undecided items left undecided;
  the USDZ path corrected; held-mode input collisions added.
- **User's answers, 2026-10-24:** recorded in "Decisions and questions",
  which widen the scope to every page, the Halo, touch capture on phones,
  controllers, handedness and the Quick Look halo (with a rebuild of existing
  files), and move identity hues to the identity project, viewpoint portals
  to PRD-025 and VR viewing to its own feature.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Emulation or physical | Inspectable artifact/result |
| --- | --- | --- | --- |
| Port equivalence | `pnpm run test:xr:capture`, `test:xr:pointing`, `pnpm run doctor`, `pnpm run test:smoke:pipeline` on `main` and on the branch | Emulation (IWER) | 2026-10-24: all nine checks (`mock-vr recording locomotion terrain hands height body face pointing`, `XR_CHECK_CONCURRENCY=2`) pass on `main` (`eebf013`, twice) and on the branch. `compare-xr-reports.ts` over the 31 report, sample and log files: 31/31 agree main↔main, main↔branch and main²↔branch. Declared in the comparator, from main↔main: the face check's voice jaw (Chromium's fake microphone runs in real time) and the height report's positions (up to 0.45 mm apart on `main`; B-020). Doctor, the viewer pointing pipeline and the rest: `verify:pr` row below |
| Tokens and literals | `pnpm run verify:agent` after a token edit | Neither (tooling) | 2026-10-24: with only `tokens.json` changed the selector picks `@holoim/design-tokens` and `@holoim/config-eslint` and their 13 dependents (15 packages, reason `package-changes`); an edit without regenerating fails `pnpm --filter @holoim/design-tokens test` (drift). Tooling tests for both classifiers pass, as do the literal rule's tests (`@holoim/config-eslint` `test`). The DOM and 3D read-back waits for the slices that consume the tokens |
| Contracts | `pnpm --filter @holoim/xr-ui-core test`, and the same for `ui-dom`, `xr-ui-r3f`, `xr-ui-three`, `design-tokens` | Neither (unit) | 2026-10-24: `design-tokens` 33 (drift, bad and circular alias, `$extensions` not exported, colour and alpha read-back, svg paths, sizes, fonts, MSDF atlases), `xr-ui-core` 78 (the old state tests unchanged; each new test cites its styleguide section; the edge golden file), `ui-dom` 70 (jsdom), `xr-ui-three` 77 (jsdom; colours read back with `getHexString(SRGBColorSpace)`, `toneMapped` off, chrome flag on every descendant, tabular timecode), `xr-ui-r3f` 66 (`@react-three/test-renderer`). None of the five keeps `--passWithNoTests` |
| 3D render, slice 2 | The `xr-ui-three` objects drawn in Chromium with WebGL2 and ACES tone mapping, then read back | Emulation (browser) | 2026-10-24: 7 shader programs compile with no GL error; 1264 pixels read back exactly gold (`#d3a12c`) under tone mapping, so chrome is neither tone-mapped nor converted twice. Screenshot and JSON kept outside the repo |
| Independent verification, slice 2 | Codex (a different vendor) given the brief and tree | Neither (review and probes) | 2026-10-24: Codex's probes found two defects, both fixed with tests: the timecode's figures were proportional (0:11 and 0:12 differed by 2.9 mm at 1 m), and labels took the font's 1.2 line height, not the role's 1.35. They confirmed text hides within 1 m, the soft edge reaches 0 at the rim, and the thumbnail halo stays inside its bounds. Codex hit its usage limit before writing a verdict, so slice 2 has no complete independent pass. 2026-10-25: Codex's pass, below |
| `verify:pr`, slices 0 and 1 | `pnpm run verify:pr` | Emulation and tooling | 2026-10-24 on the branch: doctor, lint, typecheck, unit tests (all packages and tooling) and builds pass. `test:smoke:pipeline` 6/6 (the viewer pointing pipeline imports the ported `pointing-desktop-take.ts` and `pointing-iwer-replay.ts`), `test:portal` 6/6, `test:xr:capture` passes. `test:knowledge` 7/7 once run against its own server: Playwright reuses whatever answers on port 4176, and a knowledge dev server from the main checkout was running there, so its first run failed 3 tests (2 also fail that way on `main`). `test:xr:viewer` 9/9 on rerun; its first run hit B-021, a flake that also fails on `main` |
| `verify:pr`, slice 2 | `pnpm run verify:pr`; `test:knowledge` in `scripts/ci-emulate.sh` | Emulation and tooling | 2026-10-24 on the branch: doctor, lint, typecheck, unit tests (all packages and tooling), builds, `test:smoke:pipeline` 6/6, `test:portal` 6/6 and `test:xr:smoke` 9/9 pass; no app changed. `test:knowledge` 7/7 in Docker (port 4176 was held by the main checkout's server) once its bug-list check counted template cards instead of asserting on one: with B-020 and B-021 open there are two cards, and the old assertion failed Playwright's strict mode |
| Viewer pages, phone and desktop | `pnpm run test:portal`, `pnpm --filter @holoim/web run test:e2e:mocked`, extended with box, colour, font and scale assertions | Emulation (Playwright viewports) | 2026-10-24, slice 3: `test:portal` 6/6. `test:xr:viewer` 14/14, which now includes `e2e/redesign.spec.ts`. At 1280 × 800 and 390 × 844 that spec checks the fixed ground gradient; Play, Free and Return in the shade (Return's word "Return", its name the core's); every glyph hit area at the input minimum; the timecode in its token font; the reach row hidden until the shade is reached; exactly one card sparking, at `sparkCount`; the side sheet at most 24rem wide, closing on "Close"; no sparks under reduced motion; and the empty, server-error ("Try again", `role=alert`) and offline notices on the phone chip. Screenshots in the ignored `output/redesign-slice-3/`, previewed with `preview.mjs` and shown to the user. Physical phones not checked |
| AR route | `pnpm run test:xr:viewer` | Emulation (IWER) | 2026-10-24, slice 3, IWER's Quest 3 (OculusBrowser UA, so the 97% passthrough chip): Exit is in the page before placement and on the left wrist; the model's scale is 1 at open; no chrome object has the camera as an ancestor; every chip mesh is at the target's opacity; the stage light holds 0.9 over 0.7 s; a controller ray selects Pause and Play; a two-finger pinch sets "1:…" and a ray at true size restores 1; Exit still works after a 180° turn. `ar-bubble.spec.ts` now gets its non-unit transform from the viewer's pinch. Not checked on a Quest or an Android phone, nor the Android dock over dom-overlay. The ring round the bubble: see the next row |
| AR edge, the ring round the bubble | `xr-ui-core` `edge.test.ts`, `xr-ui-r3f` `BubbleEdge.test.tsx`; `ar-bubble.spec.ts` in `pnpm run test:xr:viewer` | Contract tests and emulation (IWER) | 2026-10-24, slice 3: one seed gives the same circle points, with the card's waves and tears; the card's outline is unchanged (golden fixture); points and strokes scale with the diameter; `bubbleSilhouette` keeps every ring point on the sphere and tangent to the eye's line while walking round it from 1.7R to 9R, and is null from inside; the r3f ring stays on the silhouette, facing the viewer, all chrome, hidden from inside or with no bubble; soot on with no estimate, off with a dark one. Under IWER, from in front and from behind the diagnostic bubble: the ring is at the silhouette's centre (2 dp), faces the eye (dot > 0.999), its scale is the silhouette's diameter, soot at the no-estimate opacity with the glow at 0, the aura still drawn with no cyan torus; screenshots `ar-ring-front.png` and `ar-ring-back.png`. The bubble's pixel oracle still passes with the ring drawn. `test:xr:viewer` 15/15, again after the torus was removed. Not checked on a Quest or an Android phone, so the lighting-estimate path (Android) has no run |
| `verify:pr`, slice 3 | `pnpm run verify:pr`; `test:knowledge` in `scripts/ci-emulate.sh` | Emulation and tooling | 2026-10-24 on the branch: doctor, lint, typecheck, unit tests (all packages and tooling) and builds pass. `test:smoke:pipeline` 8/8, `test:portal` 6/6, `test:xr:smoke` 14/14 and `test:xr:viewer` 14/14. `test:knowledge` in Docker: 6/7, then its live-update test (atomic replacement and rename) passed 3 of 3 alone, so a timing flake under amd64 emulation; slice 3 changes no knowledge code. Docker needed `PLAYWRIGHT_BROWSERS_PATH` set to a fresh folder: the shared `holoim-ci-playwright` volume holds an arm64 Chromium 1208 marked complete, which the now amd64 image cannot run |
| User's look, slice 3 | Screenshots in `output/redesign-slice-3/` shown to the user | Neither (the user's eye) | 2026-10-24: the user answered "All the slice 3 looks are OK as they are." That covers the word placeholders (Pause, Upload, true size, Exit AR and Recenter in the Android dock); the side sheet's 24rem width and its stacking at the chip's opacity over the card; the dock padding; the "Close" word; the rescale label ("1:1.2" on the foot's second row, small and dim at Android's flat sizes); and the AR ring from two sides without the cyan ring. The disabled look (40%) is only on tilt where motion is unsupported, which no screenshot shows, so it was not judged. Android shots are IWER with an Android user agent and the dock lifted over IWER's view for the screenshot. Real wrist drawings for Exit and Recenter stay a known gap for a design pass, not a flat-screen blocker |
| Dock shade, slice 3 | `ui-dom` `Surfaces.test.tsx`; screenshots in `output/redesign-slice-3/` | Contract test and the user's eye | 2026-10-24: the user saw two shadows: the dock painted the hologram's oval shade across the screen, so it read as a second object on the floor. On a before-and-after mock they chose "make the dock's shade a band along the bottom edge, so only holograms cast an oval shadow." `Dock` now uses `dockShadeGradient()`, the shade's stops as `linear-gradient(to top, …)`; the test checks the band, its stops and colour, and that it is not radial. Styleguide 5.2 says so. Capture's dock (slice 4) gets the same band |
| Independent verification, slice 3 | Codex (a different vendor) given the brief, the tree and the slice 2 contracts | Neither (review and probes) | 2026-10-24: not run. Codex returned "You've hit your usage limit … try again at 9:20 PM" before reading anything, so slice 3 has no independent pass yet. 2026-10-25: Codex's pass, below |
| Capture pages, desktop and phone | `pnpm --filter @holoim/capture run test:xr:ui` (desktop 1280 × 800 and phone 390 × 844 with touch, Playwright) | Emulation (Playwright viewports) | 2026-10-24: desktop dock targets at least 24 apx (Record 36), Figtree loaded, the side sheet carries key words; handedness set by keyboard (Space on a radio), stored in `holoim.handedness`, kept across a reload, right by default; while recording the dock holds only Stop (a rose square) and "Recording 0:02". Phone: every dock target 44 × 44 apx, clear of the 20 apx side edges and the 34 apx home bar; touch words with no key help; the scene has `touch-action: none`; a drag on the right turns the view 0.54 rad, the walk stick shows under the finger and walks 3.2 m in 1 s, nothing starts in the edge or home-bar zone, and tap records. Report `output/ci-capture-ui/ui-report.json` (ignored) |
| Capture headset rules | `test:xr:ui` headset phase | Emulation (IWER, controllers and hands) | 2026-10-24: Record on the left wrist for the right-handed, 4 cm off the wrist, drawn at 2.5× (15.1 mm), ray hit 15.1 mm, poke hit 20 mm (the floor); in view on a controller and on a tracked hand (on a controller it was hidden inside the avatar's sleeve until the wrist row drew over the body). Settings panel 1.5 m away, rows with ray-sized hits; every label at least 1 m away, and none shows, nor takes a hit, with the head 0.8 m from the panel. The panel and wrist stay put as the head walks 36 cm and turns 30°. A ray select on Record starts a take: the panel hides, "Recording 0:01" shows on the status line, which stays through a 10° turn (0.1 mm) and follows a 40° one (0.92 m). A poke stops it: the fingertip shade shows wide at 6 cm (16.6 mm) and sharpens at 2 cm (10.5 mm); one poke, one commit, one tick, even with the finger held; a tip arriving from behind commits nothing. Handedness from the panel row moves Record to the right wrist and the left ray presses it, while the right ray rests on Refit and refits nothing; the tray takes the non-dominant palm under both settings; with one controller, one select commits once |
| Chrome stays out of the take | `test:xr:ui` export phase | Emulation (IWER) | 2026-10-24: a take without marks re-exported with every headset chrome object shown, hidden, moved visible into the scene model, or with a chrome-flagged box beside the avatar: the same canonical digest each time, and a repeat matches. A plain box in the same place changes it (the control). The canonical digest names each bufferView by its bytes' hash, because three's GLTFExporter orders texture bufferViews by when each async encode resolves, so two exports of one take can differ in raw bytes with the same content. The downloaded file differs from the re-exports because the exporter clones the live avatar's pose |
| Independent verification, slice 4 | Codex (a different vendor), then a same-vendor stand-in | Neither (review) | 2026-10-24: Codex was at its usage limit and could not run. A Claude code-reviewer stood in; it is not independent by vendor. It found one bug: one controller made a select commit twice, because both sides fell back to the same input. It found weak spots: chrome shown vs hidden could not differ, since chrome sits outside the exported model; the occlusion raycast did not skip chrome; a poke armed with no approach; the XR entry mode could go stale; the home bar was not excluded from touch; and several assertions were weak. All are fixed and covered by the check above. Slice 2's `xr-ui-three` and `ui-dom` contracts still have no cross-vendor pass. 2026-10-25: Codex's pass, below |
| `verify:pr`, slice 4 | `pnpm run verify:pr`; `test:knowledge` and `test:xr:viewer` in `scripts/ci-emulate.sh` | Emulation and tooling | 2026-10-24 on the branch: doctor, lint, typecheck, unit tests (all packages and tooling; `@holoim/ui-dom` 86/86) and builds pass. `test:smoke:pipeline` 6/6 and `test:portal` 6/6 pass. In `test:xr:smoke` every capture check passes (the full `test:xr` tier, now 12 checks with `ui`, passes too). The viewer's `ar-bubble.spec.ts:70` failed twice with B-021 while the machine was loaded (load average about 20) and passed 6/6 alone with B-021's command. In Docker, `test:knowledge` 7/7 and `test:xr:viewer` 9/9. The shared `holoim-ci-playwright` volume holds an arm64 Chromium 1208 marked complete, which an amd64 container cannot launch, so the runs set `PLAYWRIGHT_BROWSERS_PATH=/root/pw-fresh` |
| `verify:pr`, slices 3 and 4 combined | `pnpm run verify:pr` on the merged tree (`c7ea749`); `test:knowledge` in `scripts/ci-emulate.sh` | Emulation and tooling | 2026-10-24 before the merge to `main`: doctor, lint, typecheck, every unit test (`ui-dom` 87, `xr-ui-core` 84, `xr-ui-three` 77, `xr-ui-r3f` 73, `design-tokens` 33, viewer-web 33, capture 26) and builds pass; `test:smoke:pipeline` 8/8, `test:portal` 6/6, every capture XR check (`ui height terrain body face hands locomotion recording mock-vr`), `test:xr:viewer` 15/15. `test:knowledge` 7/7 in the CI emulator with a fresh `PLAYWRIGHT_BROWSERS_PATH`, since the main checkout's knowledge server holds port 4176 locally |
| Second round: the cloche, contracts | `xr-ui-core` `cloche.test.ts`, `xr-ui-three` `cloche.test.ts` | Neither (unit) | 2026-10-25, written from failure modes first: no fit for nothing drawn; every drawn point inside the glass with the margin; the foot on the lowest point; a flat take and a wide low one keep 40% shoulders; the shade is the content's footprint × 1.15; Follow keeps every point of the drawn dome inside the viewing box at 78% and fills it (phone and desktop aspects); fully drawn outside, 0 at the glass and monotonic walking out; seeds stable and in range; char at rest on dark ground and full where the soot rule is on. The three.js object: chrome throughout, not tone-mapped, no depth writes; the eye read correctly under a placed, turned and 0.25-scaled parent (AR); inside drops the glass and keeps the floor shade; nothing in a headset while recording. `xr-ui-core` 95, `xr-ui-three` 81, `ui-dom` 88, viewer-web 33 |
| Second round: viewer pages | `e2e/redesign.spec.ts`, `e2e/hologram-feed.spec.ts`, `e2e/ar-bubble.spec.ts` (IWER, 1280 × 800 and 390 × 844) | Emulation (Playwright, IWER) | 2026-10-25: 15/15. At rest only Play (or Pause) in the row and no Return in Follow; every glyph at the mouse minimum; on reach Free shows and Play neither moves (< 1 px) nor leaves the middle (< 2 px); no two controls closer than a glyph gap; no `.feed-card-edge` or `.feed-card-shade` on the page; the focused card's cloche drawn at opacity 1 with volume; under reduced motion the core steady and the glow within the slow fade (< 0.02 in 0.5 s); the sheet at most 26rem, its drop zone labelled for `#glb-upload`, the Quick Look switch toggled by its label. AR: the cloche drawn, all chrome, not head-locked, the recorded author inside it, standing within the bubble, at the same room position from in front and from behind, char at full strength on a Quest (no estimate), core 1, the old glass sphere hidden, the aura kept with no torus; `ar-cloche-front.png` and `ar-cloche-back.png`. View in AR is a reach control now, so the specs reach for the card before pressing it (`pressViewInAr`). Not checked on a Quest or an Android phone |
| Second round: Codex on the renders | `codex exec -p deep` with before and after contact sheets (desktop, phone, upload sheet) | Neither (cross-vendor review) | 2026-10-25, first pass: "ship after the must-fixes". Must-fixes, all done: the avatar's head broke through its dome (the fit now samples the author's reach through the take, bones and moving meshes, relative to a following bubble); the dome's far side still showed inside (now 0 there, read back from the shell); the phone row sat at 85% down on amber (now ends above 75%); the dock showed through the phone sheet (hidden while it is open). Taste notes taken: the rim capped at a 2 to 4 px line, the chip over the picture hugging the controls showing. Left: the floor shade's dark crescent under the avatar's terrain (it is the hologram's own shade, kept). Second pass on the fixed renders: each must-fix resolved, none new, "ship on this visual pass"; it notes stills cannot prove the 4% clearance through the whole take, which the fit's contract test and the AR check (author inside from both sides) cover |
| Third pass: the burnt globe, prototypes and pick | Five forms in the real viewer (`?halo=`, dev-only, not committed), rendered front, orbit, side, zoom, inside, phone, and a 42 s motion reel | Emulation (Chromium, SwiftShader) and review | 2026-10-25: Codex returned its usage limit before reading; an Opus design reviewer stood in (same vendor, not independent). Ranking ash, burn, embers, cage, lip; pick ash with a quiet front; its must-fixes built (see the decision above). Reel, zoom still and phone sheet in the ignored `output/halo-v2/`, sent to the user. Then Codex (cross-vendor) on the built globe, the old dome and the five prototypes: "Verdict: ship", no must-fixes; taste notes built (near side at 75% zoomed in, fronts fade near the eye) |
| `verify:pr`, the burnt globe | `pnpm run verify:pr`; `test:knowledge` in `scripts/ci-emulate.sh` | Emulation and tooling | 2026-10-25 on the branch: doctor, lint, typecheck, every unit test (`xr-ui-core` 101, `xr-ui-three` 83, `xr-ui-r3f` 73, `ui-dom` 88, `design-tokens` 33, viewer-web 33, capture 26) and builds pass; `test:smoke:pipeline` 8/8, `test:portal` 6/6, `test:xr:smoke` (every capture check and the viewer 15/15). The capture `ui` check failed once under load (the status line moved 2.4 mm on a 10° turn; the limit is 1 mm) and passed alone and in the full tier rerun; the globe touches no capture code. `test:knowledge` 7/7 in the CI emulator |
| Hosted CI, the burnt globe | CI on `31c082a`, then `test:xr:viewer` in `scripts/ci-emulate.sh` | Emulation (CI) | 2026-10-25: hosted CI failed two viewer checks that pass locally and in the emulator (they did not fail there with the original specs either, so intermittent). The AR bubble's pixel oracle hid only meshes outside the model, so the globe's embers and sparks (points) could count as geometry outside the bubble; it now hides chrome while it probes. The phone spacing check measured the reach row after a fixed 400 ms, mid-unfold on a loaded runner; it now waits for the row's transitions. `test:xr:viewer` 15/15 in the emulator; fixed on `main` at `2fb9161`. On `2fb9161` the pipeline's shard 1 then stalled past its 15-minute ceiling twice and was cancelled with no report. The same tests passed on `31c082a` in 4.7 minutes, and in the emulator with Quick Look conversion they take the same time before and after the globe (capture-to-viewer 1.7 vs 1.6 min, object 33.6 vs 35 s), so the globe adds no cost. The job's ceiling is now 20 minutes, Playwright stops itself at 16 minutes and names the test it was in, and diagnostics upload on cancel too. The next run named the cause: the pointing tests clicked the highlight toggle, a reach control, after a settle longer than the 4 s idle, so it had folded under the return button and the click retried until the 3-minute timeout. A 4.5 s pause reproduced it locally. The tests now reach for the card first, as a cursor would; with the pause, it passes, and `pointing.pipeline` passes 4/4 |
| Third pass: the burnt globe, contracts | `xr-ui-core` `clocheBurn.test.ts`, `xr-ui-three` `cloche.test.ts` | Neither (unit) | 2026-10-25, from failure modes first: the noise stays in 0 to 1 and the threshold leaves both holes and shell; spark sites lie on the fronts (\|burn\| < 0.02) and on the dome; burns and embers the same per seed on every load and different across seeds; every ember within 3% of the wider radius of the shell and above the floor; normals point out; the quiet rule is 0 face-on, whole at the silhouette, 75% on the far side and further in when focused. The object: shell, embers, sparks and shade chrome, not tone-mapped, no depth writes; inside drops the shell, embers and sparks and keeps the shade; sparks only in focus, none under reduced motion or in a take; focus eases (0.2 to 0.8 after 100 ms, over 0.95 by 600 ms) and jumps with time held at 0 under reduced motion; nothing in a headset while recording. `xr-ui-core` 101, `xr-ui-three` 83 |
| Third pass: viewer pages | `e2e/redesign.spec.ts`, `e2e/ar-bubble.spec.ts` (IWER, 1280 × 800 and 390 × 844) | Emulation (Playwright, IWER) | 2026-10-25: 9/9. The focused card's globe drawn at opacity 1 with all 2,500 embers and 120 sparks; under reduced motion no sparks and time held at 0, the line steady and the glow within the slow fade; AR: the globe drawn, all chrome, not head-locked, the author inside it from both sides, char at full strength on a Quest, line 1. Not checked on a Quest or an Android phone |
| Independent verification, slices 2 to 4 and the second round | `codex exec -p deep -s read-only` (gpt-6-astra, xhigh) given the brief, the styleguide, `tokens.json`, the five UI packages, the viewer's feed, portal, AR and upload features and capture's UI; read-only probes in Node and jsdom | Neither (review and probes) | 2026-10-25: Codex hit its usage limit twice mid-review (12:49 and 14:01), each time after about 92k tokens and before writing its report. Its interim notes and probes were the findings; the lead confirmed each from the code or with a failing test first, then fixed it. **Slice 2:** an unfocused edge still cycled 0.50, 0.32, 0.58 (8.2 says steady at 0.50; `edgeFrame` now holds it, on every target, flickering or reduced); a touch laptop kept 24 apx targets under a finger, since the input came only from `(pointer: coarse)` (now `any-pointer` too); the side sheet was `aria-modal` but let Tab out (it now keeps Tab inside, both ways and from outside). **Slice 3 and the second round:** the cloche's fit read a paused card's take at t = 0 only, because three's `setTime` zeroes every action and a paused action, or a mixer at time scale 0 (paused AR), never advances, so every unfocused feed card and paused AR missed the author's reach (`motionPoints` now plays each clip alone on its own mixer and leaves the viewer's pose, time and pause untouched); the cloche's shaders wrote linear colour to the sRGB canvas, so the core `#ffc872` drew as `#ff932b` (they now take sRGB token values and blend in the canvas's space, as CSS does; a covered pixel is the hex); on a touch phone a take with sound put Unmute at x = 380 of 390, inside the back-swipe edge, and one with highlights off the screen (the reach line now unfolds above Play when it does not fit beside it, the lead's taste call, recorded in styleguide 6); over the picture Play sat 5.5 px off the middle, from the chip's control-row padding (now alike at both ends). **Slice 4:** the viewer had no handedness setting, while scope item 6 gives slice 4 "a handedness setting in both apps" (the viewer's dock now has Settings with the same pair as capture, stored per device under the same key, and AR puts Exit on the wrist it names; the store and the pair moved to `@holoim/ui-dom`, which capture now uses). Checks: `xr-ui-core` `edge.test.ts`, `ui-dom` `Surfaces`, `GlyphControl`, `Chip` and `handedness` tests, viewer `drawnPoints.test.ts` (failure modes first); `e2e/redesign.spec.ts` gains a touch phone with a sounding take (every reach glyph at 44 apx, clear of the edges and of each other, stacked above a Play that does not move, on the chip over the picture), the cloche's gold read back from the canvas (73 deep-orange pixels before the fix), and left-handed kept across a reload with Exit on the right wrist in AR. Each new check failed before its fix. Viewer mocked e2e 18/18 (one IWER CDN fetch flake, 3/3 on rerun), capture `test:xr:ui` passes, `verify:agent` green. Verdict: pending. Codex's limit resets at 19:00 on 2026-10-25, and a compact verdict pass over the two fix commits is queued for then |
| `verify:pr`, verification fixes | `pnpm run verify:pr` steps on private ports (`E2E_BASE_URL` 3274, `E2E_API_PORT` 3101, capture 5374); `test:knowledge` in `scripts/ci-emulate.sh` with `PLAYWRIGHT_BROWSERS_PATH=/root/pw-fresh` | Emulation and tooling | 2026-10-25 on `bug/ui-redesign-verification`: doctor, lint, typecheck, every unit test, builds, `test:smoke:pipeline` 8/8, `test:portal` 6/6, `test:xr:capture` (every check, `ui` included) and `test:xr:viewer` 18/18 pass. `test:knowledge` 7/7 in the CI emulator, since another checkout's knowledge server holds port 4176 |
| Hold to mark on every input | `test:xr:marks` (`scripts/ci-held-mark-playwright.ts`): desktop F holds, a phone touch hold, IWER hands (non-dominant thumb–middle pinch, an ordinary pinch, the hand lost mid-hold), IWER controllers (non-dominant trigger); `test:xr:pointing` unchanged; the viewer pointing pipeline uploads the phone and hands takes | Emulation | Passed 2026-10-25: each GLB is valid v0 with a `recorded` link on the held target and no inferred link over it (hands: A recorded twice, B inferred after its undo); the ordinary pinch held nothing; loss ended the mark after the grace (`output/ci-marks/marks-report.json`). Phone AR deferred (`TODOS.md`, AR recording) |
| The Halo on every input | The same check: the B key (hold W, flick E, flick W, hold S), the dock glyph by touch (hold, drag S), the IWER dominant pinch (drag W, drag S), the IWER non-dominant stick (W, E, S) | Emulation | Passed 2026-10-25: every committed action and input logged as expected; the ring drew while B held and not on a flick. `transient-pointer` not emulated by IWER: not built |
| Pipeline and USDZ | `pnpm run test:smoke:pipeline` | Emulation | Pipeline result; byte-identical export with chrome visible; v0 and v1 files load; USDZ outline matches; pending |
| Quick Look globe: the port | `pnpm --filter @holoim/xr-ui-core test` (golden block) and `python3 apps/viewer-api/tools/test_cloche.py` (run by the API's vitest suite) | Neither (unit) | 2026-10-25: one golden file (`cloche-golden.json`): 4 fits, 5 seeds (empty and non-ASCII included), the noise, and 9 burnt globes (3 domes × 3 seeds: 432 dome points, normals, burns and tears, 8 seeded randoms, 12 front sites, 64 embers each). TypeScript equal; Python within 1e-9 (embers 1e-6, kept in 32-bit floats). Four deliberate mutations of the port (hash, tear, ember offset, fbm octave) each fail it |
| Quick Look globe: bake and readback | `glb_to_usdz.py --seed <id>` then `inspect_usdz.py` on the three most recent production GLBs (local copy) | Emulation (OpenUSD) | 2026-10-25: all three carry `/Root/Cloche` (form `burnt-globe`, 800 embers); the inspector's own refit matches the recorded foot and radii within 1e-6 m; the gold's vertices sit on the burn's zero level (99th percentile of the burn 0.006 to 0.008); every ember is the viewer's for the seed; no cloche failure. One file (abf8…) keeps joint and vertex tolerance failures that its old ql2 preview already had. Conversion about 2.6 s for an avatar |
| Quick Look globe: render and review | RealityKit stills (`shot`, Follow camera, dark and light ground) of the real USDZs, reviewed by Codex (a different vendor) against the feed's globe | Emulation (RealityKit on macOS) | 2026-10-25: Codex chose the thinner fronts (0.0021 of the wider radius) and 800 embers over 0.0032 and 360, and asked for a quieter cream (0.25, emissive 0.6) and an opaque char shoulder (0.65) on the shell's side for light ground; renders of that spec show a dark burnt edge on light ground and clean gold on dark. Codex: recognisably the same halo; the near side's fronts still cross the people, which no bake can quiet. The island take's dome is higher than the feed's, because Quick Look pins the bubble and covers the whole walk, so its burns differ from the feed's for walking takes |
| USDZ rebuild, local | `pnpm --filter @holoim/api rebuild:usdz` against a copy of production's database and files (the three most recent holograms) | Emulation | 2026-10-25, final design: the dry run lists three; a run stopped by SIGINT switched two and left the third on ql2; the resume switched the third; a further run had nothing to do. Earlier, a truncated GLB failed validation, stayed on ql2, was journaled, skipped on rerun and switched with `--retry-failed` once restored. Production not run: it waits for the user's go-ahead |
| Slice 6, `verify:pr` | `pnpm run verify:pr` on the slice 6 branch rebased onto `31c082a`, ports 3574/3501/5575 | Emulation | 2026-10-25: doctor, lint and typecheck, every unit suite, build, `test:knowledge` 7/7, pipeline 8/8 (capture → viewer asserts the preview's cloche is seeded by the uploaded id and has its fronts), portal 6/6, XR smoke 15/15. Two retries were environmental, not the change: `test:knowledge` reused a stale atlas server on port 4176 started from the main checkout (main fails the same way against it; both pass 7/7 on their own server), and one portal run lost a CDN fetch of an environment map |
| `verify:pr`, slices 5 and 6 combined | Every `verify:pr` step on the merged tree (slice 6 rebased onto `7462051`, slice 5 at `2896c97` merged in); `test:knowledge` against its own server (port 4176 held by a stale atlas server from the main checkout) | Emulation and tooling | 2026-10-25 before the merge to `main`: doctor, lint, typecheck, every unit suite, build, `check:docs`, knowledge 7/7, pipeline 10/10, portal 6/6, XR smoke 15/15 on its second run (the first lost a CDN fetch of the `office_small` environment map, as one portal run did earlier) |
| Cross-device task test | The PRD-021 trial (below) | Physical | Recorded results; pending |

### Cross-device task test

From PRD-021: after holding to mark "this" once in a headset, each
participant does it on desktop capture and on a phone without instruction,
then finds what they marked in the phone portal. Compare the new grammar
with today's UI. Measures: unaided success and time to mark. Continue if
transfer works; revise any idiom that fails on one device. Phone AR runs
only if an Android device is available.

## Physical-device limits

IWER proves deterministic placement, state and input logic. It does not
prove legibility, blending, flicker comfort, frame time on a phone, or how
an edge looks on a real surface. The table is the full list of decided
values that still lack a device check. When a check changes a value, the new
value goes into the styleguide and `tokens.json` as a plain rule. The design
probe (`node scripts/design-probe/server.mjs`, see
[direction.md](../product/design/direction.md), "Device results") runs the
blending and type checks.

| # | Check | Device | Steps | Passes when | Emulation can show | Physical result |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Blending in AR | Quest 3 passthrough; Android Chrome (ARCore); iPhone AR Quick Look | Run the probe's blend pairs on each | The blend mode is measured on each; the chip keeps its value, or takes round 3's value for the measured mode (88% sRGB, 92% linear) | Nothing: IWER composites in desktop Chromium | Pending |
| 2 | Soot in bright AR rooms, and its threshold | Android phone | Place a hologram against a white and a beige wall in daylight and in a dim room; log the estimate's ambient luminance; screenshot | Soot is on in daylight and off in the dim room, with contrast near 3.3:1 and 4.3:1; the logged values confirm or replace 0.16 and 0.095 | That the code path switches on a mocked estimate | Pending |
| 3 | Headset flicker | Quest 3, VR and AR | One-minute look at a hologram on a table in AR, and in VR | The rating is recorded for the user to judge (the 4 to 8 s looks gave "noticeable") | Nothing | Pending |
| 4 | Sparks on Android phones | A mid-range Android phone | Scroll the feed for a minute; record the long-frame share | Recorded beside the Quest 2D page's 0.04% (focus only), for the user to judge | That one card animates | Pending |
| 5 | sRGB blending in Quest VR | Quest 3 | Probe blend pairs in VR | Measured; 72% kept or replaced | Nothing | Pending |
| 6 | Glyph stroke in a headset | Quest 3 | Look at the glyph row at 1.75 m and at 1 m | 3.75 apx strokes do not shimmer | Nothing | Pending |
| 7 | Legibility from 1 m to 1.75 m, and the 25 apx initial | Quest 3 | Probe type ratings at 1 m, 1.25 m and 1.5 m, and an author initial | The ratings are recorded; "easy" at each distance keeps the 2.5× rule | Nothing | Pending |
| 8 | Baked halo in Quick Look | iPhone | Open a hologram's USDZ in Quick Look on a table; screenshot | The halo reads as a halo, not washed out | Nothing | Pending |
| 9 | Soot always on in Quest AR | Quest 3 passthrough | Look at a hologram in a dim room and against a bright wall | The edge reads against the wall, and the user judges the dim-room look | That soot is on without an estimate | Pending |
| 10 | Gaze-and-pinch hit size | Apple Vision Pro | Hit each glyph by gaze and pinch at 1.75 m | Hits land at 72 apx without wrong targets | Only if IWER emulates `transient-pointer` | No device: remaining limit |
| 11 | VR soot | Quest 3 | Look at an edge against a bright part of the VR room | Soot replaces the glow there and nowhere else | That `t(L)` follows the room's luminance | Pending |

Also physical, from PRD-021's technical signal: hold to mark on Quest hands
and controllers (feel, false starts, stuck modes), the Halo flick on each
headset input, touch capture and the held mark on a real phone, the
fingertip shade and tick on a real poke (and whether the microphone hears
the tick), and the record glyph on a real wrist.

Slice 4 still needs, on devices: on a real phone, look, walk and record by
touch, with no clash with the back swipe or the home bar and the stick's
40% share and 0.006 rad per px look judged; on Quest 3 with hands, the poke
distances (10 cm, 8 mm, 4 cm, 3 cm) for false starts and misses, the
fingertip shade's look, and whether the take's microphone hears the tick;
with Quest controllers, the pulse strengths and the ray landing on the wrist
glyph; the world panel's 1.5 m legibility (check 7); and a left-handed
participant through the whole capture flow.

Slice 5 is unverified on devices; emulation cannot show any of these:

- Quest 3 hands: whether the non-dominant thumb–middle pinch (1.5 cm on,
  3 cm off, index clear by 4 cm) is reliable and free of false starts while
  holding, grabbing, waving or making a fist; whether the dominant pinch
  opens the Halo when a pointing thumb rests on the middle finger (IWER's
  point pose keeps 9 cm between them; a real hand may not); the 0.25 s
  loss grace; the Halo drag distance and its tick.
- Quest controllers: the trigger hold's feel; the thumbstick press-and-tilt
  ergonomics (pressing while tilting, the rest threshold 0.2, the 100 ms
  release latch); that walking and turning stop on that stick while held.
- A real phone: the 300 ms touch hold within 22 apx against look drags; the
  arm and the ray landing under the finger; `navigator.vibrate` on Android
  (iOS Safari has none); the dock glyph's hold and drag next to the home bar.
- Desktop: B with the mouse on a real pointer lock (CDP reports no
  `movementX` on macOS, so the check moves the mouse synthetically).
- Not built: gaze-and-pinch and `transient-pointer` (Vision Pro); phone AR
  marks are deferred to AR recording (`TODOS.md`).
