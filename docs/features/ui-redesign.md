# Feature brief: Redesign UI and interaction across capture and viewer

**Lead:** Claude Code (Opus)  
**Status:** Implementing (approved by the user 2026-10-24). Slices 0, 1 and
2 built and verified locally (slice 2 on `claude/redesign-slice-2-0eb742`);
slices 3 and 4 are next
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
  per Q13. Quest AR uses headset sizes (2.5×, rays 56, poke 72, labels fade
  within 1 m); Android uses flat sizes and touch 44.

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

### Slice 6: Quick Look baked halo

`tools/glb_to_usdz.py` adds the gold core, the cream highlight and a static
soft halo when it builds a USDZ. The outline matches the TypeScript edge for
the same seed (Q10): the worker passes the computed points to the Python
tool, or a golden-vector test holds the two together. The exported GLB is
unchanged.

Existing files are rebuilt by a one-off script: in production, every stored
hologram's USDZ; locally, only the three most recent. The script writes each
new USDZ beside the old one and switches the hologram to it only after the
new file validates, so a failed rebuild leaves the old preview in place, and
it can resume after an interruption. It runs on production once the slice is
verified locally against the three local files.

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
  overlaps it, and the viewer shows it on phone and desktop.
- [ ] The Halo opens with the same directions on every device, and a flick
  commits without the ring drawing.
- [ ] The export → upload → render pipeline e2e passes; a take without marks
  exports byte-identical to before, with all chrome visible during the
  take; v0 files still load after the meaning change.
- [ ] New USDZ files carry the baked edge, matching the viewer's outline for
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
| Independent verification, slice 2 | Codex (a different vendor) given the brief and tree | Neither (review and probes) | 2026-10-24: Codex's probes found two defects, both fixed with tests: the timecode's figures were proportional (0:11 and 0:12 differed by 2.9 mm at 1 m), and labels took the font's 1.2 line height, not the role's 1.35. They confirmed text hides within 1 m, the soft edge reaches 0 at the rim, and the thumbnail halo stays inside its bounds. Codex hit its usage limit before writing a verdict, so slice 2 has no complete independent pass |
| `verify:pr`, slices 0 and 1 | `pnpm run verify:pr` | Emulation and tooling | 2026-10-24 on the branch: doctor, lint, typecheck, unit tests (all packages and tooling) and builds pass. `test:smoke:pipeline` 6/6 (the viewer pointing pipeline imports the ported `pointing-desktop-take.ts` and `pointing-iwer-replay.ts`), `test:portal` 6/6, `test:xr:capture` passes. `test:knowledge` 7/7 once run against its own server: Playwright reuses whatever answers on port 4176, and a knowledge dev server from the main checkout was running there, so its first run failed 3 tests (2 also fail that way on `main`). `test:xr:viewer` 9/9 on rerun; its first run hit B-021, a flake that also fails on `main` |
| `verify:pr`, slice 2 | `pnpm run verify:pr`; `test:knowledge` in `scripts/ci-emulate.sh` | Emulation and tooling | 2026-10-24 on the branch: doctor, lint, typecheck, unit tests (all packages and tooling), builds, `test:smoke:pipeline` 6/6, `test:portal` 6/6 and `test:xr:smoke` 9/9 pass; no app changed. `test:knowledge` 7/7 in Docker (port 4176 was held by the main checkout's server) once its bug-list check counted template cards instead of asserting on one: with B-020 and B-021 open there are two cards, and the old assertion failed Playwright's strict mode |
| Viewer pages, phone and desktop | `pnpm run test:portal`, `pnpm --filter @holoim/web run test:e2e:mocked`, extended with box, colour, font and scale assertions | Emulation (Playwright viewports) | Screenshots at desktop and 390 × 844, previewed with `packages/tooling-testing/src/preview.mjs`; pending |
| AR route | `pnpm run test:xr:viewer` | Emulation (IWER) | Screenshots and placement report; pending |
| Capture pages and headset rules | `pnpm --filter @holoim/capture run test:xr:mock`, a new placement scenario, and a touch scenario on the phone viewport | Emulation (IWER, Playwright) | Placement, label-distance and handedness report; pending |
| Hold to mark on every input | IWER scenarios (hands, controllers), the desktop pointing take, touch scenarios for phone and phone AR | Emulation | Exported GLBs with the expected `recorded` links and no overlapping inferred link; pending |
| The Halo on every input | Flick and hold scenarios with mouse, touch and IWER (hands, controllers, `transient-pointer` if IWER emulates it) | Emulation | Report of directions committed; pending |
| Pipeline and USDZ | `pnpm run test:smoke:pipeline` | Emulation | Pipeline result; byte-identical export with chrome visible; v0 and v1 files load; USDZ outline matches; pending |
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
