# Feature brief: Undo and redo for every authoring action

**Lead:** Claude (Opus)  
**Status:** Complete (2026-11-11)
**Layer:** Both event and meaning. The Halo's W and E are chrome. What they
change stays in the layer of the action being undone.

## User outcome

The author can take back a mistake while arranging the scene or recording a
take, whatever the mistake was. They can place or put back an object, resize
it, move it, make a mark or a hand trace, or change the tray. They use one
gesture: the Halo's W undoes the last thing they did, and E redoes it. Today
W and E only reach held marks and hand traces, so undo fails exactly when the
author reaches for it after a misplaced object.

New authoring actions join the same history when they are built. Nobody has
to retrofit them, and the author never has to guess what undo covers.

## The two kinds of undo

The rule comes from `what-a-hologram-is.md`. The event is what happened, and
meaning is what the author says about it.

- **Event actions are undone forward in time.** Undoing one performs the
  inverse action at the current moment, and the take records it. The original
  action stays in the recording. Example: the author puts the ball back at
  0:10 and undoes it at 0:12. A viewer sees the ball vanish at 0:10 and
  return at 0:12. This was decided by the user on 2026-11-11 ("the removal
  stays in the recording"). Nothing ever rewrites the recorded event.
- **Meaning actions are undone out of the take.** An undone mark or trace is
  dropped, as if it never happened, which is how marks and traces work today.
  Meaning is an annotation on the event, not part of it.
- **Tray actions** (removing a slot, adding from Find) change no take, so
  undoing one simply reverses it.

## Scope

**Included:**

- **One history** in capture (`CaptureHistory`, under `src/runtime/`). It
  is a single chronological stack across all action kinds plus a redo stack.
  W undoes the most recent entry of any kind, and E redoes the most recently
  undone one. Any new undoable action clears the redo stack.
- **A registration contract**, the way future features join the history.
  Every authoring action pushes an entry with:
  - its kind (event, meaning or tray);
  - a status word ("Put back", "Mark", "Size");
  - `undo()` and `redo()`.

  `haloActions.ts` stops calling `PointSampleStore` directly and calls the
  history instead. The feature brief template gains an **Undo** line, so each
  new brief says how its actions join or why they don't (already in this
  change).
- **Actions that join now:**

  | Action | Kind | Undo | Redo |
  |---|---|---|---|
  | Summon from the tray | Event | Put the object back now (released first if held) | Summon it again where it was |
  | Put back | Event | Bring the object back now, where it was put back from, at rest, at its size | Put it back again |
  | Place (one grab-to-release, a throw included) | Event | Move the object back now to its pose before the grab, at rest | Move it again to where it came to rest |
  | Resize (one stretch or drag gesture) | Event | Return to the previous size now | Apply the size again |
  | Held mark | Meaning | Drop it from the take (today's behaviour) | Restore it |
  | Hand trace (Ink) | Meaning | Drop it from the take (today's behaviour) | Restore it |
  | Remove a tray slot | Tray | Restore the slot | Remove it again |
  | Add to the tray from Find | Tray | Remove the slot | Add it again |

- **History boundaries.** Before a take, the history covers arranging the
  scene. When a take starts, the history is cleared, so undo during a take
  only reaches that take's actions. When the take stops, the history is
  cleared again, because a finished take's meaning can no longer change.
  Alternative considered: keep pre-take entries into the take, so undoing a
  pre-take placement becomes a recorded change. Rejected because a wrong
  arrangement would turn into recorded motion without the author meaning it.
- **The status line names what changed**, for example "Put back undone",
  "Size restored", "Mark undone" or "Nothing to undo".
- **The accessible names become "Undo" and "Redo".** The styleguide's Halo
  section (W and E) and its icon table row are generalized, and `captureHelp.ts`
  says undo reaches anything. The glyphs are unchanged.
- **Undo works outside recording.** Today it says "Nothing to undo" whenever
  no take is recording (`haloActions.ts`).

**Excluded:**

- **Continuous motion:** body, hands, face, voice, and carrying an object.
  Retake (the Halo's SW) is the answer for bad motion and is a separate
  feature.
- **Loading a prepared object** (a file or `?object=`).
- **Undo across takes,** and undo after export.
- **The Halo in phone AR capture,** which is already queued in `TODOS.md`.
  Phone AR authors get the history once that ships. Until then, phone AR
  actions are still pushed, so the stack stays truthful.
- **A visible history list or multi-step scrubbing.**
- **Keyboard shortcuts** (for example Ctrl/Cmd+Z). These are cheap, but they
  are a separate input decision.

## Acceptance criteria

- [x] On desktop, phone (flat), Quest hands and Quest controllers, W undoes
      and E redoes the last action of every kind in the table, during a take
      and before one.
- [x] During a take, undoing a put-back exports a GLB where the object's
      presence ends at the put-back frame and resumes at the undo frame. The
      object resumes at the put-back pose. The feed and AR viewer render the
      gap, and the USDZ conversion keeps it.
- [x] During a take, undoing a place or a resize exports the jump back as
      recorded change at the undo frame. Earlier frames are unchanged.
- [x] Undoing a mark or a trace leaves no recorded link or trace for it in
      the GLB, as today.
- [x] Interleaved actions undo in reverse order. For example, summon, mark,
      resize, then W W W undoes the resize, then the mark, then the summon.
      A new action after an undo clears redo.
- [x] Starting or stopping a take clears the history. W right after Record
      says "Nothing to undo".
- [x] The status line names what each undo and redo did.
- [x] Every existing summon, put-back, marks and traces check still passes.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Undo targets an object that is held by the author | Release it first, then apply the inverse; checked on controllers and desktop |
| Undo of a put-back after its tray slot was removed | The entry keeps the same object (nothing is disposed), so it returns even with no slot, and its bytes count toward the budget again |
| Undo of a summon or put-back would exceed the tray or scene budget | The budget counts objects in the scene, and undo restores one that was counted before; check it at the five-item limit |
| An object track with a gap, or a second track for the same object, breaks export, viewer or USDZ | Design review decides gap or new track; the acceptance check runs the GLB through upload, feed, AR and Quick Look |
| Undo while a mark or trace is still held | Keep today's rule: end it and drop samples until release |
| Undo of a place during a take reads as a glitch to viewers | Accepted: the event shows what happened. Design review may add a short ease instead of a jump; recorded either way |
| An action that is not registered silently breaks the stack's order | Unregistered actions are not in the stack, so the stack stays consistent; the brief template's Undo line and design review catch omissions |
| A later non-undoable action (carrying) changes the object an earlier undo targets | Inverses act on the current state, e.g. a resize undo applies the old size where the object is now; it doesn't restore an old pose |
| Halo input labels: the B-held flat Halo commits as `'key'` | Keep the label in the check log; out of scope |
| History grows without bound in a long session | It is cleared per take; cap pre-take history at 100 entries |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude (Opus) | Brief, integration, final handoff |
| Design reviewer | Codex, a different vendor (or the `design-reviewer` agent) | Read-only review before implementation |
| Implementer | Assigned after review | `apps/capture/src/runtime/` (history, `haloActions.ts`), `src/objects/` (summon, put back, place, resize, tray), `src/recording/` (object track gap or resume), `src/ui/captureHelp.ts`, styleguide Halo rows |
| Independent verifier | A different vendor from the implementer | Read-only; GLBs, reports, proof video |

## Design decision

There is one history with per-action `undo` and `redo`, which is the command
pattern. It is split by layer: the event is undone forward, and meaning is
undone out of the take. This keeps the recorded event honest, since nothing
is erased from what happened. It also keeps marks and traces working as they
do today.

Alternatives considered:

- **A separate stack per action kind**, for example "undo mark" against
  "undo object". Rejected: W would need to know which kind the author meant.
- **Rewriting the event on undo** (erasing the put-back from the take).
  Rejected by the user. It would also mean editing already-recorded object
  tracks mid-take.

The user approved this brief on 2026-11-11, including three choices: the
history is cleared at take start and stop, undoing a place returns the
object to its pose before the grab, and the tray actions (Find, removing a
slot) are undoable.

### Design review (2026-11-11, `design-reviewer` agent)

1. **A returning object keeps its track, with a gap.** The undo brings back
   the same `SceneObject` (`SceneObjectRegistry.restore`), so
   `ObjectSampleStore` writes null frames between its presence spans and
   `buildObjectExports` writes `presence` with two spans and a STEP scale of
   0 in the gap. `HOLOIM_objects` already allows several spans, the viewer
   plays the clip without reading `presence`, and `glb_to_usdz.py` turns any
   scale-0 step into visibility samples. No format or API change. No fixture
   had two spans yet: the summon check now exports one, and the pipeline
   check reads every span.
2. **An undone place jumps.** An ease would record motion the author never
   made, as a shrink on put-back would record a resize. The export's linear
   position track makes the jump a one-frame change. Physics must not sweep
   the object through others: its body is dropped and built again, at rest,
   where it lands (the same path a returning object takes).

Settled with the review:

- A summon's own hold (into the hand, then let go) is part of the summon,
  not a place. Undoing a summon puts the object back now; redoing it brings
  the same object back where it was when undone, without a new summon (no
  arm authoring span ends with it). Such returns are logged in the tray
  snapshot's `returns`.
- One hold's resizes are one Size entry: committed when a headset stretch is
  let go, when the hold ends, or just before W or E reads the history. A
  free object keeps its base where it rests when its size is undone.
- The redo of a place puts the object where it was when the place was
  undone. Undoing a throw while the object is still in the air makes the
  redo land it there, at rest. Accepted: it is what the author saw.
- Every tray add joins the history (Find, a file pick, the headset's Find),
  except the tray the page opens with. A restore that would pass five items
  or the byte budget is refused with "The tray is full", and the entry stays.
- Loading a new prepared object clears the history, because the object it
  replaced can no longer come back. A hold that spans Record or Stop starts
  its place and resize from the boundary.
- While a trace is open, W undoes it first (today's rule), even if newer
  entries follow it.
- Undo and redo are refused while a take exports ("Wait for the export").

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Undo and redo of every kind, on every input | `test:xr:summon` phases `undo-desktop`, `undo-touch`, `undo-controllers`, `undo-hands` (`apps/capture/scripts/lib/undo-take.mjs`); history assertions in every `test:xr:marks` phase (`held-mark-takes.ts`) | `output/ci-summon/report.json` (Halo log, history log and counts per take); all 20 summon phases and 4 marks phases pass |
| Interleaved order, redo clearing, boundaries | `undo-desktop`: summon, mark, resize, then W W W reads "Size undone", "Mark undone", "Summon undone"; E E restores Summon and Mark; a new summon leaves "Nothing to redo"; W right after Record says "Nothing to undo"; a summon held across Record and let go is a Place | Same report; `CaptureHistory.test.ts` holds the two history regressions the verifier reproduced |
| Put-back undo is forward in the event | `undo-desktop` exports the take | The bracket's presence is [10.42, 11.22] and [12.33, 17.53] s: ends at the put-back, resumes at the undo (within 2 frames) with 0 m offset |
| Place and resize undo are recorded jumps | `undo-desktop` exports the take | Place: a 3.14 m step at the undo frame, earlier frames unchanged; size: scale 1.6 → 1.0 at the undo frame |
| Export → upload → render | `summon.pipeline.spec.ts` "an undone put-back: two presence spans survive the feed card and USDZ" | Feed card scale 1 / 0 / 1 mid-span-1, mid-gap, mid-span-2, pose error 0; USDZ visibility inherited / invisible / inherited, minimum scale 1e-4; `output/summon-viewer/undo-put-back-report.json` |
| `verify:pr` | Run 2026-11-11 with the e2e ports moved (other agents held the defaults) | Every step passed except `bubble-capture` (B-043, fails on `main` too) |
| Independent verification | Codex (`-p standard`, read-only) against this brief and the tree | Found four defects, all fixed in `eb04a284253b`: redo returned an entry on top instead of to its place in time; the 100-entry cap also cut a take's history; a summon's hold spanning Record never became a Place; a Find load did not recheck the byte budget after an undo restored an item. Its coverage gaps (boundary hold, summon/mark/resize order) are now in `undo-desktop` |
| Proof | A real-time desktop take (`undo-desktop` with `PROOF_VIDEO_DIR`) | `output/proof/undo-redo.mp4` (ignored, not committed), sent to the user |

Not covered by an automated check: tray-add redo at the five-item or byte limit (the refusal is in `CaptureObjects` but no take fills the tray first), and an undo while a take exports.

## Physical-device limits

IWER proves the Halo commits and the stack order for hands and controllers.
Whether W or E is easy to reach mid-take on a real Quest needs a headset run,
and so do comfort and how an undone place looks to the author. These stay
Unverified until someone runs them on a headset.
