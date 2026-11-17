# Feature brief: a far object on the feed card

**Lead:** Claude Code session card-framing-objects (2026-11-16)  
**Status:** Draft: the review-tool fix is built; the cap waits on the owner's choice  
**Layer:** view (`docs/product/concepts/what-a-hologram-is.md`)

## User outcome

The feed card shows a hologram's performer and what the performer acts on.
Today it already does. A recorded object far from the performer still widens
the frame, so the performer gets small. This brief asks whether to cap that.

## What was wrong, and what is fixed

Slice 1c's reader said the tallest-bar pointer "aimed at nothing", and the
brief read that as the card framing the performer and not the set. Measured
on 2026-11-16, the card shows every object. With a dome, Follow frames the
whole dome (`clocheFraming` in `packages/xr-ui-core/src/cloche.ts`, used by
`HologramCardCanvas.tsx`). The dome is fitted to everything the take draws,
recorded objects included (`drawnPoints.ts`). `cameraFraming.ts` is only the
fallback before the dome is fitted. The viewer and the sheet had not changed
since 1c, so that reader saw the same card.

The fault was in the review pack. `review.ts` cropped the card stills to the
cast's points plus 15 % + 12 px, which cut the chart to 15 % of its box. The
close view framed head to hips. A review-tool fault, not a viewer one.

Fixed on branch `bug/review-pack-framing`:

- the card stills keep the cast and every recorded object on the card;
- the close view widens to an object while a beat names it (look, reach, aim,
  turn, put, take, with 0.5 s either side) and while the performer holds it;
- `on-screen.json` gives each object's size on the card and whether it is
  whole on it; `lib/review-page.ts` reads objects from the viewer probe.

Holograms without objects review exactly as before.

## Measurement

Phone card as `review.ts` opens it (390×844 CSS px, DPR 1.5, mobile), the
current viewer test build, 21 times through each take, through the card's own
camera. Script and outputs are ignored, under
`apps/capture/output/authoring/framing/` (`measure.ts`, `today-<take>/`).

| Take | Performer (CSS px) | Face (CSS px) | Objects on the card |
|---|---|---|---|
| tallest-bar (chart 1.15 m from her) | 159–160 | 15.7–17.7 | table, cup, pointer, chart: all, every sample; the chart 58×154 px |
| tallest-bar without the chart | 177–179 | 17.5–19.8 | table, cup, pointer |
| watering | 169–172 | 13–19 | pedestal, can, pot, plant: all |
| goodbye (no objects, two performers) | 167–172 | 12.9–18.9 | none |
| chart moved 2 m forward | 128–129 | 12.6–14.2 | all |
| chart moved 3 m forward | 85–86 | 8.3–9.5 | all |
| chart moved 5 m forward | 52–53 | 5–5.8 | all |

The far-object rows are tallest-bar with only the chart moved (variant sheets
`far-{2,3,5}.json` in that folder). The performer's height on the card falls
roughly as 1 / the dome's size, and nothing caps it: an authoring take has no
bubble. A capture take keeps points within its 6 m recording bubble, so the
same shrinking happens there for an object up to 6 m away.

## The open decision: cap the far object?

| Option | What it does | Today's takes | Chart at 3 m | Cost |
|---|---|---|---|---|
| **A. No cap** (today) | The dome holds every object. | unchanged | performer 85 px, face 8–9 px | nothing to build; a far object can shrink the performer to a few pixels |
| **B. Floor the performer** at a share of her size without objects, e.g. 75 % | When objects would push her below the floor, the camera stops pulling back and centres between her and the dome, so the far object falls partly off the card. | unchanged (tallest-bar is at 90 %) | performer 134 px; chart partly on the card's edge | one bound in the Follow framing; the "size without objects" needs a second fit of the dome without objects |
| **C. Count objects near the performer only** (within N m of her path, e.g. 2 m) | Like capture's bubble, but tighter, applied only to the dome fit. | unchanged | performer about 178 px; the chart off the card | simplest rule; an object just past N disappears from the card, a jump rather than a slide |

Stills of A and B for the chart at 3 m (today, a 90 % floor, a 75 % floor),
simulated with the card's renderer and camera direction:
`apps/capture/output/authoring/framing/stills-far-3/compare-crop.jpg`.

**Recommendation: B at 75 %.** It changes no hologram on the feed today,
keeps the performer's face readable however far an object is placed, and
lets a far object stay partly in view rather than vanish. C is simpler, but
drops the object outright past a hard line.

A is reasonable while no real take has a far object: none of the authored
pieces does, and a captured take with an object several metres off is the
case that would show it.

## Scope

**Included:** the review pack fix (built); the cap decision; the cap in the
viewer's Follow framing if the owner picks B or C.  
**Excluded:** changing how the dome is drawn, the portal view, the close
view's framing in the viewer, and capture's 6 m bubble.

## Undo

None: the review fix is a tool, and the cap is viewer framing; neither adds a
capture authoring action.

## Acceptance criteria

- [x] A review pack's card stills and close view show the recorded objects the
  performer acts on, at the card's true framing (tallest-bar re-reviewed).
- [x] The stale lines in `directed-performance.md` and the authoring README say
  plainly that the 1c reading was a review-tool fault.
- [x] A fresh reader reviews tallest-bar from the fixed pack under a neutral
  title, recorded below whether or not it reads.
- [ ] The owner picks A, B or C. If B or C: holograms without objects frame
  exactly as today, and the far-chart variants give the measured sizes above.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| The crop fix hides the cast when objects are far | The crop is the union of the cast and every object; the stills stay at the card's own pixels |
| The close view jumps when a beat names an object | Its target and distance are smoothed over ±fps/2 frames as before |
| A sheet object's id differs from its name in the GLB | Matched through `spec.name ?? id`, the name the writer gives the node |
| A take without a sheet | Holds come from `HOLOIM_objects` and belong to the first performer |
| A take without objects changes | The close view with no objects is the old head-to-hips framing; the crop is the old cast crop |
| A cap shrinks takes that read today | B and C leave every current take unchanged (measured above) |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | card-framing-objects session | Brief, integration, handoff |
| Design reviewer | not run: the review fix has no product choice; the cap is put to the owner first | – |
| Implementer | card-framing-objects session | `apps/capture/scripts/authoring/review.ts`, `lib/review-page.ts` |
| Independent verifier | `verifier` subagent (Opus) | Read-only |

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Card stills and close view show the objects | `review.ts output/authoring/framing/tallest-bar.glb --out …/review/tallest-bar-fixed` | `sheet-card-NN.jpg`, `sheet-close-1-NN.jpg`, `on-screen.json` (ignored output) |
| Fresh reading | A reader subagent given only `reader/` | `reader.md`, `comparison.json` beside the pack; summary below |
| Far-object sizes | `measure.ts` on the far variants | `today-far-{2,3,5}/summary.json` |

### Fresh reading, tallest-bar (fixed pack)

Pending.

## Physical-device limits

None for the review fix (a desktop tool). A cap would need one look on a
real phone at a take with a far object.
