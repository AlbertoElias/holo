# Feature brief: one contact idea and a pose look (trial)

**Lead:** Claude (lead session)  
**Status:** Reviewed (design review 2026-11-26: approve with changes; the changes are in this text)
**Layer:** event (the authoring tool builds the recorded event; no change to the view)

## Why

The goodbye grab failed after 18 builds. The cause is in the tool, not in the piece.

- The director has 12 separate ways for a body part to meet a thing (reach, take, put,
  aim, drop, hold, wear, object placement, door or lid, feet, arms cleared from the
  body, look). None of them puts a body part onto a surface. A reach aims at a point on
  the line from the shoulder, `stopShort` metres short of it
  (`apps/capture/scripts/authoring/lib/direct.ts`).
- The author guesses numbers that it cannot see: `stopShort`, one of four palm
  directions, points in metres, amounts, and five timing values for each move.
- One look costs about 5.3 minutes, because `make.ts` builds the full take each time.

One more option for each new case does not correct these causes. This trial tests a
simpler model before any rewrite.

## User outcome

An AI author writes who touches what, and when. It writes no distances and no angles.
It sees a picture of each touch in a short time and corrects what it sees. The same
words work for a prop, another performer, the performer's own body and a part of the
set.

## Scope

**Included:** two parts, built in this order.

1. **Pose look.** A command that shows one moment (frame `f`) of a sheet.
   - It solves frames 0 to `f + 13` with the full solve (`solveTake`: pass 1, then up
     to 3 clearing rounds). The sheet keeps its duration, and only the frame loop
     stops early, because the life schedule depends on the duration. The
     solver carries state between frames (the clearing plan, the lift ease, the twist
     rate limit, goals fixed at first use, the other performer's last frame), so one
     frame alone does not give the pose of the full build.
   - It exports that short window and renders it through `viewer-check.ts`. It saves
     close pictures of each hand that touches something, from two angles.
   - The first step is to add phase timing to the build (setup, each `solveOnce` pass,
     export, viewer start). The 30-second target below is a measured gate. If the gate
     fails, the fallbacks are a warm process between looks, or a first-pass-only
     picture that says so in its file name and its report.
   - Measured 2026-11-27 (goodbye, 2.90 s): 83.7 s against a full build of about
     142 s, and the same pose to 0.000 mm. The 30-second gate failed, because the 4
     solve passes take 67 s. Decision: the full look stays the default, a warm
     process and a labelled first-pass-only look are added, and the tool turns the
     second picture to the view where the hand is not hidden.
2. **Contact, as a trial.** One new direction:
   `{ "kind": "contact", "part": "rightPalm", "on": "him.leftUpperArm", "fit": "rest" }`
   with the usual beat times. (The field is `fit`, not `kind`: each direction already
   uses `kind` for its name, as in `"kind": "reach"`.)
   - `part` is a palm only in the trial.
   - `fit` is `rest` or `grip`. They are two solves on one shared surface goal.
     `rest`: the palm normal goes against the surface normal and the fingers follow
     the surface. `grip`: the hand aligns with an axis and the fingers wrap.
   - The tool finds the contact point in the target bone's local frame, from the bind
     skin. It does not find it again at an arrival frame.
   - In each frame, the tool solves the target of a contact before the performer that
     touches. A mutual contact (handshake, hug) gives a clear error in the trial.
   - The contact target is exempt from arm clearing for that hand. The tool solves the
     contact after clearing, and clearing can move only the elbow of that arm. The
     target's skin for the fit is the PairMeter skin (`arm-quality.ts`). `fitGrip` and
     `clearArms` are not used as they are.
   - Contact writes the same grip and held rows that the present bars read
     (`make.ts`), and `contact` is added to `DIRECTION_FIELDS` and to `make.ts words`.
   - The trial covers three known cases:
     - a palm at rest on the other performer's upper arm (goodbye);
     - the stone grip (stone). The stone is a `take` today. In the trial, `contact`
       gives only the goal and the palm angle to the present take. The attach stays
       with `take`;
     - the hand on the door handle (baker). The handle is an anchor 4 cm out from the
       door face, not a mesh. The target is the door part, and the hand follows the
       door's `change`.

**Excluded:** `push`. The move of `take`, `put` and `reach` onto the contact path (a
later slice, only if the trial wins). Mutual contact. Parts other than a palm. Feet
and look stay as they are. Motion between contacts (how alive the movement looks) is a
separate decision. No change to a pin, a bar, a wrist limit or the solver time limit.
The stopped `feature/contact-reach` branch (`"onto": true` on a reach) is not merged.

## Undo

None. The trial changes the agent authoring tool (`scripts/authoring/`), not the
capture app, so it adds no authoring action to the capture history.

## Acceptance criteria

- [ ] The build log shows the time of each phase (setup, each solve pass, export,
      viewer start).
- [ ] The pose look gives the pictures of one moment of the goodbye sheet in less than
      30 seconds on an awake machine, or the evidence gives the measured time and the
      fallback that was used.
- [ ] The pose is the same as in the full build: each bone within 0.5° and each palm
      within 1 mm of that frame in `take.glb`.
- [ ] With `contact`, the palm lies on his upper arm in goodbye. During the hold
      frames, the gap at the palm centre is 3 mm or less and the deepest point of the
      hand skin inside him is 3 mm or less. Both numbers are in a JSON row.
- [ ] A fresh hands reader accepts the goodbye touch. Its input is the close stills
      from two angles and one question: "Does her palm lie on his arm?"
- [ ] The author's sheet for that touch has no `stopShort`, no palm direction and no
      point in metres.
- [ ] The goodbye touch passes in 3 builds or fewer. The count of builds and looks for
      each of the three cases is recorded next to today's count (goodbye: 18 builds,
      no pass).
- [ ] The stone grip and the door handle, written as `contact`, meet the bars that
      their present pieces meet. The numbers are side by side in the evidence.
- [ ] The tool gives the list of surface names that an author can use. A name that is
      not in the list gives an error with the list.
- [ ] A contact that a wrist limit prevents gives the report "not possible at this
      angle", with the limit and the nearest pose. No limit changes.
- [ ] All present pieces build with no change: `solver-regression.ts` passes with the
      pins on `main`, with no `--write-pins`. The contact sheets are separate files
      beside the regression cases.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| The contact point is found again on each frame, comes after his moving arm and pushes the palm into him | Find the point one time in the target bone's local frame, from the bind skin |
| She is solved before him, so his pose at that frame is an extrapolation | The target of a contact is solved first in each frame; a mutual contact is an error |
| Arm clearing pushes the hand off the surface that it must touch | The target is exempt for that hand; contact is solved after clearing; clearing moves only the elbow |
| A wrist limit (roll 85°, flex 60°, extend 55°, radial 20°, ulnar 30°) makes a flat palm not possible | The tool reports "not possible at this angle" with the nearest pose; it does not pass a limit |
| The named part is the wrong bone (`leftShoulder` is the root near the neck) | The tool lists the surface names an author can use |
| The pose look shows a pose that the full build does not make | It solves frames 0 to `f + 13` with both passes; the third criterion compares the two |
| The pose look is slow because setup, not the solve, takes the time | Measure the phases first; the fallbacks are in the scope |
| The stone leaves the hand or attaches twice | `contact` gives only the goal and palm; the attach stays with `take` |
| The hand does not follow the door as it swings | The target is the door part; the criterion for the baker case reads the present bars |
| A present piece moves | Contact is a new direction; nothing uses it until a sheet names it; the solver regression is the check |
| The trial shows no gain | Stop after the trial; the present paths stay; the pose look stays if it is fast |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Lead session | Brief, integration, final handoff |
| Design reviewer | `design-reviewer` subagent | Read-only review before implementation (done) |
| Implementer | Story session | `apps/capture/scripts/authoring/` (`make.ts`, `lib/direct.ts`, `lib/beats.ts`, a new pose-look script) |
| Independent verifier | `verifier` subagent | Read-only verification; test artifacts only |

## Design decision

**Chosen:** one contact direction that reads the target skin, plus a look at one
moment. The code has the two ideas already (`fitGrip` fits fingers onto a held object,
`clearArms` moves an arm out along the skin normal), but contact needs its own solve
after clearing.

**Alternatives considered:**

- `"onto": true` on a reach (the contact-reach brief). It corrects one case and adds
  a 13th special path. Stopped at the owner's request.
- More automatic fits of the guessed numbers (as `fitMiss` does for a grip). It keeps
  the numbers and the 5-minute cycle.
- Only the pose look. It makes the guesses fast, but a palm on a surface is still not
  possible. It is the first part of this trial for that reason.
- A one-frame solve for the pose look. The design review showed that the solver's
  carried state makes its pose different from the full build.

**Answers from the design review:**

- `rest` and `grip` need different solves on one shared surface goal. `push` is out
  of the trial.
- The time of each phase is not known. Part 1 measures it first.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Phase times | A full `make.ts --quick` build of the goodbye sheet | pending |
| Pose look time and same pose | The pose-look command on the goodbye sheet, compared with that frame in `take.glb` | pending |
| Palm on his arm | `make.ts` on the goodbye sheet with `contact`, the JSON row, a fresh hands reader | pending |
| Stone grip and door handle | `make.ts` on copies of the stone and baker sheets with `contact` | pending |
| Surface names and "not possible" report | A sheet with a wrong name; a sheet with an angle past a wrist limit | pending |
| No present piece moves | `solver-regression.ts` with no `--write-pins` | pending |
| Proof video | The three cases, before and after, close views | pending |

## Physical-device limits

None. The trial changes how a take is built. The takes play through the present
export and viewer, which do not change.
