# Feature brief: Author-marked hand traces (PRD-023 v1)

**Lead:** Claude Code (Opus)  
**Status:** Complete (2026-11-10); device checks in "Physical-device limits"
**Layer:** Meaning (the author marks the span; the recorded body draws the path)

Product decision and trial plan: [PRD-023](../../product/prds/PRD-023-hand-path-ribbons.md),
v1 amendment approved 2026-11-09. Builds on v0, shipped 2026-10-29:
[hand traces](hand-traces.md).

## User outcome

While recording in a headset with tracked hands, the author turns on the
Halo's Ink (NW), demonstrates a motion, and turns it off. The status line says
"Tracing" with its time, and a trace draws live behind each moving fingertip.
Undo removes the last trace and Redo restores it. In the feed portal on a phone
or desktop, the trace draws itself in the air as the author's hand moves, with
its original timing, and stays drawn after the span and while paused, so the
recipient can orbit it and read its size, depth and direction. Nothing the
author did not trace is drawn, and the viewer has no traces control.

## Scope

**Included** (the PRD's v1 "In Scope"):
- Headset capture: Ink (Halo NW) toggles tracing while recording; Ink again,
  or stopping the take, ends it. Undo and Redo apply to traces in the same
  history as held marks. "Tracing 0:03" on the periphery status line and a
  live trace behind each moving tracked fingertip.
- `HOLOIM_meaning` version 2: a `trace` mark (fingertip anchor as a humanoid
  bone, span, `recorded` provenance), written only when a take has a trace;
  `encodeHoloimMeaning` still picks the lowest version that fits.
- Viewer playback in the feed portal (`HologramCardCanvas`): each trace mark
  draws in with its original timing and stays until the take loops; paused,
  everything drawn so far stays. Only inside recorded `xr-hand` spans; still
  hands, travel and root jumps suppressed as in v0.
- Removal of v0's viewer control: the Traces control, `traces`/`hasTraces`
  and `toggleTraces` in the portal store, `VIEWER_CONTROL_NAMES.traces`, the
  paused 3 s window and the 1 s playing tail, and the styleguide's Traces row
  and mentions.
- End-to-end checks and the replacement of the two live v0 test takes.

**Excluded** (the PRD's "Out Of Scope"): trimming or choosing a trace after
the take; voice triggers; automatic detection (v0 slice 2, dropped); desktop,
phone and controller traces (flat capture's Halo gets no Ink); traces in the
headset viewer, immersive AR, stills and Quick Look; cleaned shapes
(IDEA-004); speed encoding; the recipient and author trials (PRD "Comparison
And Learning"), which need people and devices.

## Acceptance criteria

- [x] **Ink in the ring.** The headset Halo (hands and controllers) draws Ink
  at NW; flat capture's Halo does not. Committed while recording, Ink starts a
  trace at the commit; committed again, it ends the trace at the moment that
  Halo was summoned (its press), so the off gesture is not traced. Committed
  while not recording, it changes nothing and says so on the status line.
- [x] **Ends.** Stopping the take ends an open trace: at the Halo's press when
  stopped through the Halo's S, else at the stop. A trace never outlives its
  take, and the next take starts with tracing off.
- [x] **Status line.** While tracing, the periphery status line reads
  "Recording 0:12 · Tracing 0:03", the trace time counting from the Ink
  commit; it returns to "Recording 0:12" when tracing ends.
- [x] **Live trace.** While tracing, each hand whose avatar index fingertip
  has moved more than 5 cm (spatial extent) since the trace began draws a
  trace behind that fingertip in the headset, in the trace style; it is
  chrome (never exported, never a referent or scene content), and it clears
  when the trace ends or is undone, or the take stops.
- [x] **Marks stored.** On export, each ended trace becomes one `trace` mark
  per hand that moved more than 5 cm across its `xr-hand` frames within the
  span; a hand that stayed still, or had no tracked frames, gets none. Each
  mark's span is within one frame of the Ink toggles. The anchor is
  `{ bone: "<side>IndexDistal", node }`, the exported distal bone's node.
  Provenance is `recorded`.
- [x] **Undo and Redo.** The Halo's Undo removes the most recent trace or
  held mark, whichever began last; Redo restores the most recently undone
  one. Undo while tracing always ends that trace at the Halo's press and
  removes it, even when a hold began inside it.
  A new trace or hold clears what can be redone. A trace counts as one undo
  step even when it holds marks for both hands.
- [x] **Version.** A take with a trace mark writes `HOLOIM_meaning` version 2;
  a take with none writes exactly what it wrote before (v0 for headset and
  desktop performer takes, v1 for camera takes with links), byte-identical
  meaning JSON on the same input.
- [x] **Replay timing.** Playing in the portal, a trace draws nothing before
  its span starts; during the span its drawn end is at the fingertip at every
  frame; after the span it stays whole until the take loops, where it clears.
  Paused or scrubbed, it shows exactly what playing to that moment shows.
- [x] **Recorded only.** A drawn segment's two ends both lie inside the mark's
  span and inside a recorded motion span over that side's hand. A switch to
  controllers or a dropout leaves a gap.
- [x] **Fidelity.** Every drawn trace point is within 2 mm of the fingertip
  node's world position at the same recording time, and the circle's fitted
  radius matches the avatar fingertip's own circle within 1 cm.
- [x] **Untraced motion.** The figure-eight drawn with Ink off leaves no mark
  and draws nothing, and nothing outside any trace span is ever drawn.
- [x] **No viewer control.** No card shows a Traces control, the portal store
  carries no traces state, and the styleguide has no Traces row.
- [x] **Older and other takes.** v0 headset takes (recorded spans, no trace
  marks), desktop takes and files without `HOLOIM_meaning` draw no traces and
  play unchanged. A v2 take loads in a viewer built from `main` before this
  change: the record is ignored and the event plays.
- [x] **Style.** The live and replayed traces use v0's ribbon (styleguide 1.1
  and 4): thin, tapering toward the oldest end, never gold, never hollow,
  never under 3 CSS px on a phone card. The Ink slot's glyph follows the
  glyph rules (section 6) and is added to the glyph table and `tokens.json`.
- [x] **Cost.** Measured in the card probe: p95 under 0.5 ms per frame while
  a card with traces plays, under 5 ms per pause or scrub (dev machine; CI
  records the costs without failing on them, as in v0).

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| The Ink-off gesture (dominant pinch and drag) is traced | The span ends at the press of the Halo that commits off; scripted take checks the stored end against the summon time |
| The Ink-on gesture is traced | The span starts at the commit (release) |
| Author forgets to turn Ink off, or stops the take mid-trace | Stop ends the trace (at the Halo press when stopped through S); the next take starts off |
| Undo while tracing | Ends and removes the open trace; live trace clears; status line drops "Tracing" |
| Undo order between held marks and traces | One history ordered by start; scripted take interleaves both |
| Hands switch to controllers or tracking drops mid-trace | Only `xr-hand` frames count for stillness and drawing; viewer intersects with recorded spans |
| The non-tracing hand hangs still, or jitters | Spatial-extent rule (5 cm), at capture (no mark) and in the viewer |
| A take with no trace changes record version or bytes | `encodeHoloimMeaning` tries v0, v1, v2 in order; compatibility check compares the meaning JSON of a no-trace take before and after |
| Older viewer meets v2 | `validateHoloimMeaning` rejects an unknown version; readers ignore the record. One-off check on a viewer built from `main` |
| v2 accidentally admits a v1-invalid link, or v0/v1 admit a trace | Each version's schema stays exact; `packages/meaning` tests cover the version table |
| Readers that expect every mark to be a link (`meaningLinks.ts`) break on a trace | Readers filter by `kind`; pointing highlights on a v2 take still draw |
| Anchor node not exported, or rig has no index tip end site | Mark dropped when the node is missing (as links are); viewer follows the anchor's end-site child, else the bone (v0's rule) |
| Walking, teleport, snap turn during a trace | v0's travel and jump suppression kept |
| A long trace makes every frame resample the whole span | Each mark's points are sampled once (warmed ahead of its span); per frame only the draw range and the head point change |
| The take loops: traces from the end still drawn at the start | Draw state is a pure function of the clip time; time before a span draws nothing |
| The live trace is exported, sampled as scene content, or a pointing referent | It lives under capture's chrome root and is flagged chrome; export check lists no trace node |
| A pre-existing card's control row shifts when Traces is removed | Portal e2e and screenshots of the reach row |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude Code (Opus) | Brief, `packages/meaning` (the shared contract), integration, final handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only review before implementation |
| Implementer, capture | To assign (Claude) | `packages/xr-ui-core/src/halo.ts` and its glyph, `apps/capture/src/runtime/haloActions.ts`, `PointSampleStore.ts` (or a trace store beside it), `GltfExportComposer.ts`, `GLTFMeaningPlugin.ts`, `HeadsetHolds.ts`, `VrChrome.ts`, a new live-trace module in `apps/capture/src/ui` |
| Implementer, viewer | To assign (Claude) | `apps/viewer-web/src/features/meaning/HandTraces.tsx`, `handTraceSampler.ts`, `meaningLinks.ts`, `portal/portalStore.ts`, `PortalControls.tsx`, `chrome/controlNames.ts`, styleguide and tokens |
| Implementer, e2e | To assign (Claude) | `apps/capture/scripts/lib/hand-trace-takes.ts`, `apps/viewer-web/e2e/hand-traces.pipeline.spec.ts` |
| Independent verifier | Codex (`-p standard`) or Muse: a different vendor from the implementers | Read-only verification; artifacts and proof video under `output/` |

## Design decision

Reviewed 2026-11-09 by the `design-reviewer` subagent (Opus). Its changes are
folded in below. One finding went back to the user as a product question
(the summoning hand, last bullet of "Capture"); the user decided it on
2026-11-10.

**Schema (`packages/meaning`, lead-owned contract).**
- `meaningTraceMarkSchema`: strict `{ kind: "trace", anchor, span,
  provenance: { value: "recorded" } }`. `anchor` reuses
  `meaningLinkBoneFromSchema` (`{ bone, node }`).
- `holoimMeaningV2Schema` is v1 with `marks: (v1 link | trace)[]`, as a
  plain union, because the link schema carries a refine.
- The v0 and v1 schemas stay untouched. Zod emits keys in schema order, so
  editing them would change existing bytes; golden `JSON.stringify` tests
  lock them.
- Versions become `[0, 1, 2]` and the latest is 2. `encodeHoloimMeaning`
  takes `MeaningMark[]` and tries v0, v1, then v2.
- New `isTraceMark` and `isLinkMark` guards. Every reader that assumed marks
  are links now filters by kind: `meaningLinks.ts`, `held-mark-takes.ts`,
  `pointing-score.ts`, `pointing-desktop-take.ts`, `camera-take-glb.ts`, and
  the `pointing` and `avatar-formats` pipeline specs.
- `STILL_EXTENT_METERS` and the spatial-extent function move into
  `packages/meaning`, so capture and viewer share one rule.

**Anchor.** Same convention as a link's `from`: `bone: "<side>IndexDistal"`,
and `node` is whatever `PointResolver.fromAnchor` resolves. That is the
fingertip end site when the rig has one, else the distal bone, else the
hand, where the bone is `<side>Hand`. The viewer draws the mapped node
itself and searches for no child.

**Capture.**
- *Store.* Traces live in `PointSampleStore`, in one LIFO history with holds,
  in push order. New methods: `startTrace(sec)`, `endTrace(sec)`,
  `openTrace()`, `undoLast(pressSec)` and `redoLast()`.
  - While a trace is open, Undo always ends and removes it, even if a hold
    began inside it.
  - Any new hold or trace clears the redo list.
  - `setEnabled(false)` and `clear()` close an open trace.
  - `holdCounts()` stays holds-only. `traceCounts()` is added, and the
    automation `HoldsSnapshot` gains an additive `traces` field.
- *Press time.* `HeadsetHolds.stepHalo` passes the summon's press
  (`summon.atMs / 1000`, the recorder's simulation clock) to `onHaloAction`,
  and `haloActions.run` takes it as an optional `pressSec`. Flat callers
  default to now.
  - Ink-off ends the trace at the press.
  - Undo while tracing ends and removes it at the press.
  - `record` ends an open trace at the press *before* `toggle()`.
  - The wrist Stop poke ends it at the stop.
- *Notices.* "Tracing" (on), "Trace kept" or "Nothing traced" (off), "Trace
  undone" and "Trace restored", and "Ink traces while recording" when not
  recording.
- *Halo actions.* `CAPTURE_HALO_ACTIONS` gains `ink` (hands and controllers
  rings). `FLAT_CAPTURE_HALO_ACTIONS` does not. With controllers the trace
  still runs, but only `xr-hand` frames can draw or store anything.
- *The summoning hand.* After Ink-on it travels back from the NW slot, and
  before Ink-off it lifts to pinch. Both stretches fall inside the span and
  can exceed 5 cm. **Decided by the user on 2026-11-10 (option A):** trim
  only the summoning hand's trace, by a 0.4 s settle at each end
  (`SUMMONING_HAND_SETTLE_SEC` in `PointResolver.ts`); the other hand keeps
  the exact span. The live trace waits out the same settle. Rejected: exact
  spans for both hands (B), and an adaptive trim (C). The e2e reports what
  was trimmed in `report.json` → `authoredCapture.marks.summoningHand`:
  per trace, the lead-in and tail cut and the motion kept.

**Export.**
- `PointResolver.resolve` emits trace drafts using its existing
  `exportBones`. `MeaningDraft` gains `traces`, and `hasSamples()` counts
  traces.
- Stillness is decided once, here. The resolver poses the export avatar per
  frame and measures the avatar fingertip over the frames in the span that
  `buildRecordedHandSpans` counts as recorded. A hand under 5 cm gets no
  mark.
- `GLTFMeaningPlugin` maps the anchor node and merges the marks sorted by
  start. A mark whose node was not exported is dropped.

**Live trace.** A new `apps/capture/src/ui/LiveTrace.ts`, under
`vrChrome.root`.
- It follows the capture avatar's fingertip (the anchor bone's world
  position): in VR the author sees the avatar, so this is the finger they see
  and the point that is stored.
- It uses a preallocated, growable buffer, adds one point per step and draws
  only the filled range. The taper comes from a per-vertex time and a
  head-time uniform.
- `raycast` is a no-op, it casts no shadows, and its width is in world units.
- A hand draws once it passes 5 cm of extent.
- `UiViewModel.tracingElapsedMs` feeds the status text, formatted with
  `recordingText`.

**Viewer.**
- `useHandTraceSource` returns null unless the take has trace marks, so
  headset cards without traces build no sampler.
- Each mark is one ribbon, built from its span's keyframe positions and
  usability flags. Usable means inside the span, inside a recorded hand span
  and not travelling, with a break at root or tip jumps. There is no
  per-frame stillness check, because capture decided it.
- Each vertex carries a `time` attribute. Uniforms `uHead = min(t, end)` and
  `uStart` make the taper over the drawn part O(1) per frame.
- Per frame, `setDrawRange` covers the segments before the head, and only
  the head segment's 2 vertices are rewritten. Before the span nothing is
  drawn; after it the whole trace is drawn; at the loop restart it clears.
- Warming covers `[start − 0.25 s, end]` of each mark, in time order, inside
  the per-frame budget. Playing catches up synchronously to the head if
  needed. A pause or scrub warms the rest of the span and records its cost.
- v0's windows (`PAUSED_WINDOW_SEC`, `TAIL_WINDOW_SEC`) and the tail
  material go. The probe keeps `hasTraces`, now meaning "has trace marks",
  and adds `marks`.

**Removal.**
- `portalStore.ts`: `traces`, `hasTraces`, `toggleTraces`, `setHasTraces`
  and their reset.
- The Traces control in `PortalControls.tsx`, and
  `VIEWER_CONTROL_NAMES.traces`.
- The v0 spec's control assertions.
- In the styleguide: the Traces row and the "traces" mentions in the reach
  row text. Sections 6.2 and 8.5 also gain Ink.
- The Ink glyph is v0's drawing, solid, as `glyph.path.ink` in `tokens.json`
  (the fingertip dot drawn as arcs in the same `d`), regenerated into
  `packages/design-tokens`. `haloSlotGlyph("ink")` returns it.

**E2E.**
- `pinchHalo` moves from `held-mark-takes.ts` into a shared IWER Halo
  helper. Hand-trace takes switch to the middle-pinch pose for each summon.
- `authored`, the main take:
  - Ink on (right), then a 30 cm right-index circle, Ink off, and an
    untraced left figure-eight.
  - Ink on (right), then a left-hand circle with the right resting, and Ink
    off. This expects no right-hand mark.
  - A short traced line, Undo, then Redo. Then another line, Undo while
    tracing.
  - Ink on, then stop through the Halo's S.
- `travel` and `real-fixture` are kept, with Ink toggled through the
  automation hook at scripted times.
- Compatibility:
  - A headset take with no Ink must still write `version: 0`, with its spans
    unchanged and no `extensionsRequired`.
  - `main`'s `meaning.ts` (from `git show origin/main:…`) must reject the v2
    record as unsupported.
  - A one-off load of the v2 take in a viewer built from `main` belongs to
    the proof video only.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Ink, ends, status line, live trace, marks stored, undo and redo, version | Scripted IWER headset take (`hand-trace-takes.ts`): Ink on by a hands Halo, a 30 cm circle with the right index, Ink off, an untraced figure-eight, then traces exercising undo, redo and stop; export read back | `output/authored-traces/report.json`, capture screenshots of the live trace and status line. 2026-11-10, shard 7 pass: the 12 Halo actions fire as scripted; four marks (right circle, left circle, redone right line, stop-ended left line), each `<side>IndexDistal` anchored, `recorded`, and within one frame of its toggle (`authoredCapture.marks`); stored ends equal commit and press steps (`store`, 0 steps off); 158 "Recording · Tracing" rows and no status failures (`statusLine`); live trace on the tracing hand only, cleared on Ink off, undo and stop (`liveTrace`); the summoning hand's settle cuts 17.2 cm of lead-in and 5.8–7.3 cm of tail per trace (`marks.summoningHand`); version 2, `extensionsUsed` only (`signal`) |
| Replay timing, recorded only, fidelity, untraced motion | `hand-traces.pipeline.spec.ts`: the take uploaded and played in the feed, sampled every frame and paused | Report and `authored-*.png`. Nothing drawn in the 30 frames before a span, the head on the clip time in every frame of it (`headTimeErrorMax` 0), and the trace held after it; pause and scrub-back match playback, and the loop clears (`authoredViewer.playing`, `paused`, `scrubBackSame`). Every drawn point in its span and recorded `xr-hand` spans; 0 m from the mixer-posed fingertip (`fidelity`); circle radius drawn 0.150 m vs scripted 0.150 m (`shape`). The figure-eight draws no new mark (`untraced`). Travel, teleport and snap turn suppressed, and the controller second leaves a gap (`travel`). The real-gesture fixture marks only the wave and reach (`realFixture`) |
| No viewer control, older and other takes | Same spec on a v0-style take, a desktop take and a file without the extension; one-off load of the v2 take in a viewer built from `main` | Report and `older-*.png`: no Traces control, no portal-store trace keys and no trace layer mounted on v0 headset, desktop and no-meaning takes, all of which play (`olderAndOther`); a viewer built from `main` plays the v2 take without traces (proof video) |
| Version compatibility | Same spec: a no-trace headset take's meaning JSON against the v0 encoding; `packages/meaning` tests | `olderAndOther.v0Headset` is version 0 with the v0 encoder's identical JSON (`preV2Reader.v0EncoderSameJson`); the pre-v2 reader (commit `6e264a3`) reads v0 and rejects v2 by version only; golden byte tests and 70 `@holoim/meaning` tests pass |
| Style | Cross-vendor screenshot review against the styleguide | Muse verdict (`output/authored-traces/verify/verdict.md`): the replayed ribbon is thin, solid cyan and tapering, legible on the phone card, never gold or hollow, and stronger than v0's inferred style (`authored-1/3/6*.png`); the live arc matches; the Ink glyph is line-drawn with round joins |
| Cost | Card probe timings in the spec | `authoredViewer.cost`: frame p95 0.1 ms (max 0.2 ms) over 600 frames, pause 0.1 ms, one 0.9 ms warm-up |
| Undo and Redo across holds and traces | `apps/capture/src/recording/PointSampleStore.test.ts`: nine failure modes of the one history, listed in the file; no scripted take interleaves a hold with a trace | 9 pass; caught the defect fixed below |
| Whole pipeline | `pnpm run verify:pr` on the branch merged with `main` | 2026-11-10: doctor, checks, unit tests, builds, shard and knowledge checks pass; the pipeline smoke (28 passed, the five hand-traces tests among them), portal (10) and XR smoke (30) pass with the Poly Pizza fixture on port 3598, since another worktree's dev server held 3198 |
| Proof video | Real-time recording: Ink on, circle, Ink off, figure-eight, then feed playback and orbit | `output/authored-traces/proof/authored-traces-proof.mp4`: 88 s, H.264 1280×720, watched via its contact sheet (Halo and Ink, live circle with "Tracing 0:03", untraced figure-eight, feed playback, orbit, phone card, viewer from `main`) |

## Physical-device limits

IWER proves the Halo flow, the stored marks and the drawn geometry against
recorded data. It does not prove how summoning the Halo before and after a
demonstration feels, whether the live trace reads as feedback rather than
clutter, real Quest hand jitter in a trace, or the PRD's author and recipient
trials. Those are Unverified until run on a Quest and phones.

## Implementation notes

- *Automation hooks.* `__runHaloAction(action, input)` and `simSec` in
  `__sampleHolds()` let the e2e drive and time the Halo; the IWER take still
  summons it with a real pinch and drag (`scripts/lib/iwer-halo.ts`).
- *Mark cap.* The viewer draws at most 64 trace marks per take, one per
  fingertip node and span, and warns past that: a GLB from the feed is
  untrusted input. The schema stays unbounded.
- *Live-trace settle.* The live trace waits out the summoning hand's 0.4 s
  settle too, so it never shows the summon movement the export trims.
- *Undo while tracing.* Independent verification (Muse, 2026-11-10) found no
  product defect but no evidence for Undo across holds and traces. The store
  test it prompted found one: Undo while tracing, with a hold begun inside the
  trace, dropped the hold's history entry instead of the trace's, so that hold
  could no longer be undone. Fixed in `PointSampleStore.undoLast`.
- *Source swap on CI.* The first `main` CI run (42755796134) failed shard 7
  with `Cannot set properties of undefined (setting 'drawn')`: when a card's
  trace source changed, the frame loop ran on the new marks before the
  effect had installed their probe entries. Frames now wait for the
  installed source; shard 7 was re-verified in `scripts/ci-emulate.sh`.
- *Verifier's run.* Muse's sandbox cannot open ports, so the lead re-ran shard
  7 outside it with freshly recorded takes (`5 passed`,
  `output/authored-traces/verify/shard7-lead.txt`) and Muse judged that output.

## Rollout

After the merge, the two v0 test takes on the live feed ("Test take: hand
traces (circle and figure-eight)" and "(real headset gestures)") are replaced
by Ink-marked takes; the old ones are deleted only with the user's OK.

## Not covered by automation

- A viewer built from `main` playing the v2 take is shown in the proof video
  only; the e2e proves it through the pre-v2 reader rejecting v2 by version.
- The wrist-poke stop ending a trace, Ink from the controllers ring, and the
  64-mark cap are reviewed in code, not exercised.
