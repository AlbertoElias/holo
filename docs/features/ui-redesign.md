# Feature brief: Redesign UI and interaction across capture and viewer

**Lead:** Claude Code (Opus)  
**Status:** Reviewed (design review 2026-10-24); awaiting the user's answers
to the questions below
**Layer:** View (the edge, shade, chip, glyphs, ground, portal and
Follow/Free). The one held action writes to the Meaning layer. See
`docs/product/concepts/what-a-hologram-is.md`.

Sources: the [styleguide](../product/design/styleguide.md) and its
[token file](../product/design/tokens.json) (decided 2026-10-24; the
styleguide wins where the two differ), and the interaction grammar that still
stands in [PRD-021](../product/prds/PRD-021-design-language.md) (held modes,
"this" and "here"). PRD-021 is Draft: this brief is the build plan for its two
unchecked In Scope items, and it is not approval to build. The `TODOS.md`
item "Redesign all UI (2D and 3D) and interaction systems" links here.

The styleguide states decided rules only. This brief is the one place that
tracks what the design rounds left undecided and which decided values still
lack a device check. When a question is answered or a check changes a value,
the result goes into the styleguide and `tokens.json` as a plain rule.

## User outcome

Capture and the viewer look and behave like one product. On every device a
hologram is the same object: a portal in one burnt golden edge, its few gold
glyphs at its foot in a soft shade (flat screens) or on its stage (headsets),
nothing locked to the head. A person who does the held action once in a
headset can do it on another device without instruction, and recognises its
result in the phone portal. Which action, and what "on a phone" means, is
question Q1.

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
4. **Materials in the viewer** (`apps/viewer-web`): the flat ground, the
   burnt edge on every card, the shade, the chip, Play/Free/Return as glyphs,
   "View in AR", type, motion, and the WebXR AR route rebuilt to the AR rules.
   The portal viewer and Follow/Free keep their behaviour from the
   [portal view brief](portal-view.md) and take the new look (slice 3).
5. **Materials in capture** (`apps/capture`): the desktop and phone overlay
   in the shade and dock, and the headset rules (slice 4).
6. **One held-mode action across devices**, chosen by Q1 (slice 5). Letting
   go always ends it.
7. **A cross-device task test**, as PRD-021 describes, plus end-to-end runs
   of the same action on every input (slice 7).
8. **Device checks.** Every decided value that still lacks a device check,
   as validation steps ("Physical-device limits"), with emulation and
   physical results kept apart.

How much of each app is restyled is Q6: every screen, or only the
record → view loop that PRD-021 names.

**Excluded**

- The items the design rounds left undecided (Q12 to Q18). Nothing in this
  brief picks a value for them.
- The Halo radial menu, ink drawing, speech commands and the other verbs of
  the concept's verb table, beyond what the held action needs (Q2).
- A VR viewing mode in `viewer-web`. It has none today.
- The Follow camera driven by pointing (PRD-030), the time ribbon, layers and
  scrubbing.
- Any chrome in the exported GLB. The edge, sparks, shade, light, ground,
  chip, labels and fingertip shade stay in the view layer (styleguide
  section 1).
- The Quick Look baked halo, unless Q3 puts it in.

## Questions for the user

Nothing below is decided. Each answer is recorded here before the slice it
blocks starts.

### Scope and product

- **Q1. Which held-mode action, and what is the phone step?** PRD-021's
  outcome, success signal and trial all name the *phone portal*, and the
  concept gives the phone the role "watch and reply". Three options:
  - **A. Hold to mark "this" while recording, on every capture input,
    including Android phone AR.** Extends today's desktop held point. Costs:
    controllers were left out of the pointing feature by its design review,
    so this reopens that; the phone AR tap ray comes from the camera, not a
    bone, and v0's required `from: {bone, node}` cannot say that truthfully,
    so the meaning record changes; capture has no touch input; there is no
    Android device to build or test on; and the phone dock's mark glyph
    conflicts with the rule that all chrome but stop and the running time
    hides while recording. PRD-021's phone outcome is not delivered, and the
    trial's phone step may never run.
  - **B. Hold to mark "this" while watching, in the phone and desktop
    portal** (and later in a headset viewer). Matches PRD-021 literally.
    Costs: a viewer's mark is "added", which v0 cannot hold, so the meaning
    record goes to v1, and viewer marks need storage and a conversation
    layer.
  - **C. Hold to mark "this" while recording, on Quest hands and desktop
    only;** the phone portal is where the mark is recognised. Smallest.
    The transfer test becomes headset to desktop.

  Under A and C, a held hand mark raises two rules the meaning-package owner
  must write: how a recorded link suppresses the inferred link the point
  detector writes for the same span, and whether a mark resolved from a
  noisy ray, with no live feedback, may be labelled `recorded`
  (principle 7). Blocks slice 5 and the trial.
- **Q2. Is the Halo in this brief?** PRD-021 says to validate one slice of
  the grammar; the brief assumes no.
- **Q3. Is the Quick Look baked halo (styleguide 9.5) in this brief?** It is
  built in `apps/viewer-api` (`tools/glb_to_usdz.py`, run by
  `src/services/usdz-worker.ts`), not in the two apps PRD-021 names.
  Styleguide 9.5 names `src/worker.ts` and `tools/preview_usdz.swift`; the
  second is only a macOS preview tool. If yes: do holograms whose USDZ is
  already built get the halo (re-converting stored files), or only new
  ones? Blocks slice 6.
- **Q4. Where does a person's identity hue and initial come from?** Ink is
  in the author's hue with their initial (styleguide 1.1, 2.4), but the
  contracts have no author yet (auth is deferred in
  [live deployment](live-deployment.md)). Blocks the highlight restyle in
  slice 3.
- **Q5. One brief, delivered in slices, or one brief per slice?** The brief
  assumes one brief, each slice merged on its own after local verification.
- **Q6. Every screen, or the record → view loop only?** PRD-021 keeps
  "restyling every screen" out of scope; the `TODOS.md` item says "redesign
  all UI". Which governs?
- **Q7. Is "here" in scope?** PRD-021 and the `TODOS.md` item name "this"
  and "here"; v0 links can point at the floor (`radius`), but no action
  marks a place.
- **Q8. How is the dominant hand chosen?** The held grammar has the
  non-dominant hand hold the mode and carry the record glyph. No handedness
  setting exists.
- **Q9. Are the portal's three trial variants kept?** `?portal=freeze`,
  `drag` and `tilt` are still in PRD-002's trial. Restyle all three, or wait
  for the trial to pick one?
- **Q10. What seeds a hologram's edge?** The tears must be the same wherever
  one hologram appears. The viewer has an upload id; capture's flat preview
  has none before upload, and writing a seed into the GLB would change the
  export. Blocks the edge in slice 4.
- **Q11. Where do Exit and the AR controls live before a hologram is
  placed, or when it is out of view?** The rules put controls at the
  hologram's foot, which does not exist then. Blocks the AR route in
  slice 3.

### Left undecided by the design rounds

- **Q12. Viewpoint portals** (styleguide section 4): how another angle
  looks, given that a small golden portal's edge reads as a smooth line.
  Nothing in this brief draws one.
- **Q13. The rescale indicator** (section 4): rescaling must be visible,
  labelled and reversible. The portal zoom does not rescale, so nothing in
  this brief needs one.
- **Q14. Provenance looks** (section 4): how recorded, inferred and added
  marks look apart without colliding with hollow (unresolved). Today's
  pointing highlights tell recorded from inferred; moving them into the
  author's hue makes a new provenance look, and a lighter inferred style may
  read as hollow. Blocks the highlight restyle in slice 3.
- **Q15. Soot in VR** (section 3.2). Capture draws no edge while recording
  and the viewer has no VR mode, so this blocks nothing known; slice 4
  checks whether capture shows a hologram in VR when idle.
- **Q16. The AR brightness threshold for soot** (section 3.2), to be set on
  an Android device. Android soot itself is decided; until the threshold is
  set, soot in the Android AR route stays unbuilt and is listed as pending.
- **Q17. The gaze-and-pinch hit size** (section 6.1). The concept proposed
  72 apx, rays have 56. visionOS sends gaze and pinch as `transient-pointer`
  input; which size applies there, or is visionOS out of scope for now?
- **Q18. The chip on an AR target not listed** (section 2.3). Round 3 gave a
  value only for known blending, so 92% (the linear-light value) is the
  cautious reading until one is measured. Use 92% for an unknown AR target,
  or refuse to start AR there?

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

Each slice leaves `pnpm run verify:pr` green and is merged on its own (Q5).
Slices 0 to 2 change nothing a person can see.

| Slice | What | Blocked by |
| --- | --- | --- |
| 0 | Port the capture XR checks to TypeScript | Nothing |
| 1 | `@holoim/design-tokens` | Nothing |
| 2 | Component contracts and their tests | Slice 1 |
| 3 | Viewer materials, portal and Follow/Free | Slices 0 and 2; Q6, Q9; Q4 and Q14 for highlights; Q11 for the AR route |
| 4 | Capture materials | Slices 0 and 2; Q6, Q8, Q10 |
| 5 | The held-mode action | Slice 4; Q1, Q7, Q8 |
| 6 | Quick Look baked halo | Q3 |
| 7 | Cross-device task test and device checks | Slices 3 to 5 (6 for check 8) |

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
- Only tokens with a `$value` are generated. Free text and `$extensions`
  are not exported, so an undecided item (Q12 to Q18) has no value code can
  read.
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
  view, which may be exempted by path).
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
- Fraunces and Figtree are self-hosted as WOFF2 for the DOM, and baked to
  MSDF at the styleguide's weights for 3D. Today `global.css` names Space
  Grotesk and never loads it.

### Slice 2: component contracts

`xr-ui-core` gains the redesigned parts as pure functions and types, so each
rule and formula is written and tested once, with tests citing the
styleguide section they come from. The existing exports
(`createRecordingUiState`, `resolveArShellNoticeState`,
`createArImmersiveActions` and the state types) keep their behaviour and
their tests.

| Contract | What it decides |
| --- | --- |
| Edge outline | Burnt outline from a seed (Q10): 280 points, waves, tears, jitter, inset, as shares of the short side; the same points for SVG, canvas and three.js |
| Edge strokes | Halo, core, highlight and soot widths and levels; the 3D halo opacity `min(1, 0.9 × level / 0.5)`; the soot crossfade `t(L)` on flat screens; AR soot from the lighting estimate (threshold: Q16) |
| Recording edge | Flat screens: halo at level 0.08, core and highlight at 0.55, no sparks. Headsets: no edge |
| Chip | Opacity per target and blend mode (2.3); where it is mandatory (5.2); the VR fade-in of 0.3 s and hold of at least 2 s |
| Shade | The radial gradient, width 120% of the hologram, and the label rim |
| Glyph | Drawings, ring, stroke, states (rest, cream lift on hover, focus ring, pressed at 55%), the always-there set dimming to 40% after 4 s idle |
| Hit area | The larger of the drawn size and the input's minimum: mouse 24, touch 44, ray 56, poke 72 and at least 20 mm, with 30 apx gaps; gaze and pinch per Q17 |
| Placement | Which slot each control lives in (stage base or shade, non-dominant hand or dock, point of action, referent, periphery, world); only the periphery status line follows the head |
| Headset text | No text within arm's reach; labels, timecode and caption fade within 1 m of a hologram and return beyond it; notes fold to their mark |
| Motion | Flicker per target (the round 1 levels, the stage-light sine, the VR swing), sparks on the hologram in focus only, reduced motion, chrome unfolding (240 ms in, 400 ms out) |
| Recording chrome | Everything but stop and the running time hides until the take ends |
| Chrome flag | A structural flag on every chrome object, so recording, export and point resolution skip it |

The renderers then implement the contracts:

- `ui-dom` replaces its nine generic components (UiPanel, UiButton, UiPill
  and the rest) with the glyph control, the chip, the shade, the dock, the
  edge (SVG) and the type roles.
- `xr-ui-r3f` replaces `HeadLockedActionBar` with controls at the
  hologram's foot on the chip, and draws the edge in the AR route.
- `xr-ui-three` replaces `ThreeLabelPill` and `ThreeRecordingActionPanel`
  with the wrist glyph, the periphery status line, the chip with hysteresis,
  and MSDF labels.

Contract tests for `ui-dom`, `xr-ui-r3f` and `xr-ui-three` check that each
renderer carries out the core contract: the same edge points from the same
seed; hit areas at the input minimum; the chip opacity for the target;
material colours read back with `getHexString(SRGBColorSpace)` equal to the
token, with `toneMapped` off; the chrome flag on every chrome object. They
are chosen from the failure list below, not written to ratify code. Their
`--passWithNoTests` flags are removed.

### Slice 3: viewer materials, portal and Follow/Free

- The ground gradient pinned to the screen; nothing bare from 75% down.
- Every card: the burnt edge, the shade at its foot, Play, Free and Return
  as glyphs in the shade, the timecode "Paused · 0:08". The highlights and
  tilt toggles in `PortalControls.tsx` appear from the cursor or touch and
  leave, since only Play, Free and Return are always there.
- Follow and Free keep the portal store's behaviour (`portalStore.ts`,
  `PortalMode`), for the variants Q9 keeps. Free is the four-way glyph and
  Return the arc glyph. The portal e2e checks keep passing.
- Feed-wide notices (empty feed, offline, server error, upload status) on the
  chip, never under the upload panel.
- "View in AR" as the cube in brackets on the card, in its shade.
- Sparks on the card nearest the middle only; the others hold and do not
  redraw. Flicker and reduced motion per the styleguide.
- Pointing highlights in the author's hue with their initial, once Q4 and
  Q14 are answered.
- The WebXR AR route: controls at the hologram's foot, every row on the chip
  (97% Quest passthrough, 88% Android Chrome), no head-locked bar, steady
  stage light, Exit per Q11. Quest AR uses headset sizes (2.5×, rays 56,
  poke 72, labels fade within 1 m); Android uses flat sizes and touch 44.
  Android soot waits for Q16.

### Slice 4: capture materials

- Desktop and phone: the overlay as glyphs in a shade and a bottom dock on
  the bottom shade, touch words on touch devices (no keyboard help on a
  phone), glyphs as SVG, never emoji.
- Headsets: the record glyph on the non-dominant wrist (Q8; no head-locked
  panel or pill, as `VrHud.ts` and `VrRecordingPanel.ts` draw today),
  "Recording 0:12" on the periphery status line, labels only 1 m or more
  away, 2.5× type and glyphs, hit sizes per input, the fingertip shade
  before a poke, a soft tick on commit, controller pulses. System sounds
  stay out of the capture mix.
- The record control: rose circle when idle, rose rounded square while
  recording, inside the gold ring; the state carried by shape and word.
- Recording chrome per the styleguide on every target.
- Every chrome object carries the chrome flag, so the scene sampler
  (`collectSceneBubbleGroup`, which exports every visible non-skinned mesh)
  and the point resolver skip it.
- Check whether capture shows a hologram in VR when not recording (Q15).

### Slice 5: the held-mode action (pending Q1)

The inputs, as option A would have them; B and C take a subset or the
viewer side.

| Input | Hold | Point | Today |
| --- | --- | --- | --- |
| Desktop | Right mouse button while pointer-locked, F as fallback | Mouse aim | Exists (self-resolving pointing) |
| Quest hands | Non-dominant thumb–middle pinch | Dominant index | New; today a point is only read, never held |
| Quest controllers | Non-dominant trigger | Dominant ray | New; reopens the pointing brief's choice to leave controllers out |
| Android phone AR | Hold the dock's mark glyph | Touch the referent | New; capture has no touch input today, and v0 cannot say "from the camera" |

Letting go, losing tracking, or the window losing focus ends the mode. No
mark appears live in the headset (concept, "This and here"); it shows in the
viewer's portal on phone and desktop. Any change to the meaning record goes
through the `@holoim/meaning` owner as its own reviewed change.

### Slice 6: Quick Look baked halo (pending Q3)

`tools/glb_to_usdz.py` adds the gold core, the cream highlight and a static
soft halo when it builds the USDZ. The outline must match the TypeScript
edge for the same seed: the worker passes the computed points to the Python
tool, or a golden-vector test holds the two implementations together. The
exported GLB is unchanged.

### Slice 7: cross-device task test and device checks

See "Test plan and evidence" and "Physical-device limits".

## Acceptance criteria

- [ ] Slice 0: every capture XR check runs from TypeScript under its old
  script name and environment, the viewer pointing pipeline and `doctor`
  still pass, and the report comparator finds no unexplained difference.
- [ ] No design value is hand-copied: the lint rule and the CSS check pass,
  and `ui-dom`, `xr-ui-r3f`, `xr-ui-three`, `viewer-web` and `capture` read
  colours, sizes and timings from `@holoim/design-tokens`.
- [ ] Editing `tokens.json` makes `verify:agent` run the token package and
  its dependents; regenerating changes the value in the DOM and the 3D
  scene; not regenerating fails the drift check.
- [ ] Every formula (soot, halo opacity, flicker, stage light, sizes) is
  written once in `xr-ui-core`, with tests that cite the styleguide.
- [ ] The `xr-ui-core` state contracts are unchanged and their tests pass;
  the new contracts have tests; `ui-dom`, `xr-ui-r3f` and `xr-ui-three` have
  contract tests and no `--passWithNoTests`.
- [ ] Viewer, phone and desktop: each card shows one burnt edge, the shade,
  and Play, Free and Return in it; nothing bare from 75% down; notices on the
  chip; only the card nearest the middle sparks.
- [ ] Follow and Free behave as the portal brief requires, and every portal
  e2e check passes.
- [ ] AR (WebXR): no control is head-locked; every row is on the chip at the
  target's opacity; Exit is reachable before placement and with the
  hologram out of view; the stage light never flickers.
- [ ] Capture headset: no head-locked panel; the record glyph is on the
  non-dominant wrist; "Recording 0:12" is on the periphery status line; no
  text within arm's reach; while recording, only stop and the running time
  show.
- [ ] Hit areas meet the input minimum on every glyph (mouse 24, touch 44,
  ray 56, poke 72 and 20 mm).
- [ ] Reduced motion: no sparks, the 8 s halo fade, chrome crossfades in
  place.
- [ ] The held action (per Q1) produces the expected mark from each of its
  inputs in end-to-end runs, and the viewer shows it on phone and desktop.
- [ ] The export → upload → render pipeline e2e passes, and a take without
  marks exports byte-identical to before, with all chrome visible during
  the take.
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
| Chrome (stage controls, chip, MSDF text, fingertip shade, edge) is exported in the GLB or becomes a pointing referent | Chrome flag skipped by the sampler and resolver; byte-identical export with chrome visible |
| A glyph's hit area shrinks to its drawing on touch or rays | Hit-area contract, never scaled; renderer tests per input |
| Phone controls reach into gesture zones or safe-area insets | e2e on a 390 × 844 touch viewport measures control boxes against the zones |
| A control is head-locked in a headset | IWER check walks the head; every control but the status line stays in world or hand space |
| Text appears within arm's reach | IWER check measures label distance from the head; under 1 m fails |
| AR controls or Exit are unreachable before placement or with the hologram out of view | Q11's answer; IWER check before placement and looking away |
| The VR chip flickers on and off at a boundary | 0.3 s fade, 2 s minimum hold; contract test steps a background across the threshold |
| The chip is opaque in AR, hiding the room | Contract: never 100% in AR |
| Red alone carries the recording state | Shape and word change with it; check asserts the stop shape and "Recording" text |
| The idle dim hides a control someone is reaching for | Approach of hand, cursor or gaze restores it; test with a cursor near the glyph |
| Sparks on every card drop frames on a phone | Focus-only rule; e2e asserts one card animates; device check 4 |
| Flicker exceeds three flashes a second | Contract test samples the flicker curve; reduced-motion path tested |
| A label rename breaks a check that finds a button by name | Names exported from one module, used by capture checks and viewer e2e |
| The TS port changes what a check proves | Report comparator with declared tolerances |
| The port breaks a dependant (viewer pointing pipeline, `doctor`, CI sharding) | Those three run in slice 0's evidence |
| The held mode gets stuck on (release lost on tracking loss or blur) | Mode ends on release, tracking loss and blur; IWER check drops the hand mid-hold |
| A held mark on hands is confused with an ordinary pinch | Mode uses the non-dominant thumb–middle pinch; IWER check performs both |
| Releasing a held trigger fires `select` at whatever its ray hits (`VrHud.ts` listens on every controller) | A held mode consumes its own release; IWER check releases over a control |
| A poke on the wrist record glyph is read as a point at `leftHand`, adding an inferred link at the end of every take | Points at chrome or during a chrome poke are dropped; replay check over a take's stop |
| A recorded and an inferred link cover the same point | Suppression rule from the meaning owner (Q1); export check |
| The poke tick is picked up by the headset microphone through the air | Listen to a recorded take on a device; if audible, back to the user |
| Marks change the GLB for takes without marks | Extension written only when there are marks; byte-identical export check |
| The viewer hides an old GLB without the meaning extension | Extension is optional; feed e2e includes an older export |
| Fonts fail to load and text falls back to a different face | Self-hosted WOFF2; e2e checks the computed font family |
| Old and new UI coexist on one screen mid-redesign | Each slice converts whole screens; merged only when its screens are complete |

## Ownership

| Role | Owner | Files or modules |
| --- | --- | --- |
| Lead | Claude Code (Opus) | This brief, contract decisions, integration, final handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only review before implementation |
| Implementer, slice 0 | Assigned at start (Standard tier) | `apps/capture/scripts/**`, the automation-hook declaration, `.github/workflows/ci.yml` (XR sharding only), the import lines of `apps/viewer-web/e2e/pointing.pipeline.spec.ts`; lands before slice 3 starts |
| Implementer, slices 1 and 2 | One integrator (contracts are shared) | `packages/design-tokens/**`, `packages/xr-ui-core/**`, `packages/ui-dom/**`, `packages/xr-ui-r3f/**`, `packages/xr-ui-three/**`, the lint rule in `packages/config-eslint/**`, `scripts/verify-changed-core.ts`, `scripts/ci-changed-areas.sh` |
| Implementer, slice 3 | Assigned at start | `apps/viewer-web/src/**`, `apps/viewer-web/e2e/**` |
| Implementer, slices 4 and 5 | Assigned at start | `apps/capture/src/**`, capture checks for the held action |
| Meaning owner | Assigned if Q1 changes the record | `packages/meaning/**`, as its own reviewed change |
| Implementer, slice 6 | Assigned at start | `apps/viewer-api/tools/glb_to_usdz.py`, `apps/viewer-api/src/services/usdz-worker.ts` |
| Independent verifier | A different vendor from the implementer (for example Codex) | Read-only; test artifacts only |

Slices 3 and 4 may run in parallel once slices 0 and 2 are merged; they
share no files.

## Design decision

Proposed, and changed by the design review of 2026-10-24:

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
- **Review changes:** Q1 now sets out three options with their costs rather
  than recommending one; added the chrome-export failure case and chrome
  flag; the drift check is wired into both classifiers; the port keeps its
  dependants and full environment; three.js colours stay sRGB with an
  explicit helper and no tone mapping; the headset factor follows the
  styleguide's tables; slice 3 no longer settles Android soot, the
  provenance look or gaze-and-pinch; the USDZ path is corrected; new
  questions Q6 to Q11; held-mode input collisions added.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Emulation or physical | Inspectable artifact/result |
| --- | --- | --- | --- |
| Port equivalence | `pnpm run test:xr:capture`, `test:xr:pointing`, `pnpm run doctor`, `pnpm run test:smoke:pipeline` on `main` and on the branch | Emulation (IWER) | Comparator output over `*-report.json`; pending |
| Tokens and literals | `pnpm run verify:agent` after a token edit | Neither (tooling) | Check output; pending |
| Contracts | `pnpm --filter @holoim/xr-ui-core test`, and the same for `ui-dom`, `xr-ui-r3f`, `xr-ui-three`, `design-tokens` | Neither (unit) | Test report; pending |
| Viewer look, phone and desktop | `pnpm run test:portal`, `pnpm --filter @holoim/web run test:e2e:mocked`, extended with box, colour and font assertions | Emulation (Playwright viewports) | Screenshots at desktop and 390 × 844, previewed with `packages/tooling-testing/src/preview.mjs`; pending |
| AR route | `pnpm run test:xr:viewer` | Emulation (IWER) | Screenshots and placement report; pending |
| Capture headset rules | `pnpm --filter @holoim/capture run test:xr:mock` and a new placement scenario | Emulation (IWER) | Placement and label-distance report; pending |
| Held action on every input | IWER scenarios (hands, controllers), the desktop pointing take, a touch scenario on the phone viewport, per Q1 | Emulation | Exported GLBs with the expected marks; pending |
| Pipeline | `pnpm run test:smoke:pipeline` | Emulation | Pipeline result and byte-identical export with chrome visible; pending |
| Cross-device task test | The PRD-021 trial (below) | Physical | Recorded results; pending |

### Cross-device task test

From PRD-021: after doing the held action once in a headset, each
participant does it on a second device without instruction, and recognises
a mark in the phone portal. Compare the new grammar with today's UI.
Measures: unaided success and time to mark. Continue if transfer works;
revise any idiom that fails on one device. The second device depends on Q1:
the phone portal (B), desktop capture (C), or desktop capture and an Android
phone if one is available (A).

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
| 2 | Soot in bright AR rooms | Android phone | Place a hologram against a white and a beige wall in daylight; screenshot | Soot replaces the glow, with contrast near 3.3:1 and 4.3:1; the threshold is recorded for Q16 | That the code path switches on a mocked lighting estimate | Pending |
| 3 | Headset flicker | Quest 3, VR and AR | One-minute look at a hologram on a table in AR, and in VR | The rating is recorded for the user to judge (the 4 to 8 s looks gave "noticeable") | Nothing | Pending |
| 4 | Sparks on Android phones | A mid-range Android phone | Scroll the feed for a minute; record the long-frame share | Recorded beside the Quest 2D page's 0.04% (focus only), for the user to judge | That one card animates | Pending |
| 5 | sRGB blending in Quest VR | Quest 3 | Probe blend pairs in VR | Measured; 72% kept or replaced | Nothing | Pending |
| 6 | Glyph stroke in a headset | Quest 3 | Look at the glyph row at 1.75 m and at 1 m | 3.75 apx strokes do not shimmer | Nothing | Pending |
| 7 | Legibility from 1 m to 1.75 m, and the 25 apx initial | Quest 3 | Probe type ratings at 1 m, 1.25 m and 1.5 m, and an author initial | The ratings are recorded; "easy" at each distance keeps the 2.5× rule | Nothing | Pending |
| 8 | Baked halo in Quick Look (if Q3 is yes) | iPhone | Open a hologram's USDZ in Quick Look on a table; screenshot | The halo reads as a halo, not washed out | Nothing | Pending |

Also physical, from PRD-021's technical signal: the held action on each of
its headset inputs (feel, false starts, stuck modes), the fingertip shade
and tick on a real poke (and whether the microphone hears the tick), and the
record glyph on a real wrist.
