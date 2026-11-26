# Feature brief: one contact idea and a pose look (trial)

**Lead:** Claude (lead session)  
**Status:** Draft
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
It sees a picture of each touch in seconds and corrects what it sees. The same words
work for a prop, another performer, the performer's own body and a part of the set.

## Scope

**Included:** two parts, built in this order.

1. **Pose look.** A command that solves one moment of a sheet and saves one picture
   for each hand that touches something at that moment. It uses the present solver with
   no change to its results.
2. **Contact, as a trial.** One new direction:
   `{ "contact": { "part": "rightPalm", "on": "him.leftUpperArm", "kind": "rest" } }`
   with the usual beat times. `kind` is `rest`, `grip` or `push`. The tool finds the
   point on the target mesh and the hand angle. The trial covers three known cases:
   - a palm on the other performer's upper arm (goodbye);
   - the stone grip (stone);
   - the hand on the door handle (baker).

**Excluded:** the move of `take`, `put` and `reach` onto the contact path (a later
slice, only if the trial wins). Feet and look stay as they are. Motion between
contacts (how alive the movement looks) is a separate decision. No change to a pin,
a bar, the wrist limit or the solver time limit. The stopped `feature/contact-reach`
branch (`"onto": true` on a reach) is not merged.

## Undo

None. The trial changes the agent authoring tool (`scripts/authoring/`), not the
capture app, so it adds no authoring action to the capture history.

## Acceptance criteria

- [ ] The pose look gives a picture of one moment of the goodbye sheet in less than
      30 seconds on an awake machine. The measured time is in the evidence.
- [ ] The pose at that moment is the same as in the full build (same joint angles to
      the tolerance of the solver regression).
- [ ] With `contact`, the palm lies on his upper arm in goodbye: no gap of more than
      3 mm and no part of the hand more than 3 mm inside him during the hold, and a
      fresh hands reader accepts it.
- [ ] The author's sheet for that touch has no `stopShort`, no palm direction and no
      point in metres.
- [ ] The stone grip and the door handle, written as `contact`, meet the bars that
      their present pieces meet. The numbers are side by side in the evidence.
- [ ] The count of builds and looks to get each of the three cases right is recorded
      next to today's count (goodbye: 18 builds, no pass).
- [ ] All present pieces build with no change: the solver regression passes with the
      pins on `main`.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| The contact point is found again on each frame, comes after his moving arm and pushes the palm into him | Find the point one time, then move it with the target's bone (from the design review of contact-reach) |
| She is solved before him, so his pose at that frame is not known | The trial states the solve order; a contact on a moving performer reads the target's solved pose |
| The wrist limit (30°) makes a flat palm not possible | The tool reports "not possible at this angle" with the nearest pose; it does not pass the limit |
| The named part is the wrong bone (`leftShoulder` is the root near the neck) | The tool lists the surface names an author can use, with a picture |
| The pose look shows a pose that the full build does not make | The second acceptance criterion compares the two |
| The pose look is slow because setup, not the solve, takes the time | Measure the phases first; if setup is the cost, keep a warm process between looks |
| A present piece moves | Contact is a new direction; nothing uses it until a sheet names it; the solver regression is the check |
| The trial shows no gain | Stop after the trial; the present paths stay; the pose look stays if it is fast |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Lead session | Brief, integration, final handoff |
| Design reviewer | `design-reviewer` subagent | Read-only review before implementation |
| Implementer | Story session | `apps/capture/scripts/authoring/` (`make.ts`, `lib/direct.ts`, `lib/beats.ts`, a new pose-look script) |
| Independent verifier | `verifier` subagent | Read-only verification; test artifacts only |

## Design decision

**Chosen:** one contact direction that reads the target mesh, plus a one-moment look.
The method is in the code already in two places: `fitGrip` fits fingers onto a held
object, and `clearArms` moves an arm out along the skin normal.

**Alternatives considered:**

- `"onto": true` on a reach (the contact-reach brief). It corrects one case and adds
  a 13th special path. Stopped at the owner's request.
- More automatic fits of the guessed numbers (as `fitMiss` does for a grip). It keeps
  the numbers and the 5-minute cycle.
- Only the pose look. It makes the guesses fast, but a palm on a surface is still not
  possible. It is the first part of this trial for that reason.

**Open questions for the design review:**

- How much of one cycle is setup, solve and export. The build log does not time them.
- If `rest`, `grip` and `push` need different solves or only different hand shapes.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Pose look time and same pose | The pose-look command on the goodbye sheet, next to a full `make.ts --quick` build | pending |
| Palm on his arm | `make.ts` on the goodbye sheet with `contact`, `review.ts`, a fresh hands reader | pending |
| Stone grip and door handle | `make.ts` on the stone and baker sheets with `contact` | pending |
| No present piece moves | `solver-regression.ts` | pending |
| Proof video | The three cases, before and after, close views | pending |

## Physical-device limits

None. The trial changes how a take is built. The takes play through the present
export and viewer, which do not change.
