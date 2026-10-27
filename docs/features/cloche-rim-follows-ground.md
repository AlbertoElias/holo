# Feature brief: The cloche's rim follows the ground

**Lead:** Claude (Opus)  
**Status:** Draft
**Layer:** View (see `docs/product/concepts/what-a-hologram-is.md`)

## User outcome

A take recorded on a hill no longer looks like a sheet of ground floating
halfway up an empty glass dome in the feed. The dome's rim settles onto the
ground under it, and where the ground stops short of the dome's edge, the
rim tucks in under the ground's lip. From any angle the glass and the ground
meet, so the event reads as a place standing on its own ground.

## Background

Since B-033 (`2b15fa8c`), the feed fits the cloche to everything the bubble
draws and stands its foot on the lowest drawn ground. On a hilltop take
(`avatar-recording-1792945435020`, media `w0ynfm6ikpzj6xcnb4sgqku8.glb`) that
foot is about 6 m below the author: the bubble (radius 6 m) cuts the hill's
flanks down to it, but the hill is a one-sided surface, so between the
ground and the foot the dome is empty glass. The author walks about 18 m
during the take (feet 17.1 m to 19.2 m), and the bubble and dome follow, so
the ground under the rim changes every frame.

Mockups (2026-10-27, scratch orbit videos, not committed) compared today's
view with an earth block under the ground, this rim, and a small patch of
ground with a smaller dome. The user chose the rim.

## Scope

**Included:** The feed portal's cloche (`HologramCardCanvas`, also the
portal view): the shell, embers and sparks follow a rim height per direction
round the foot, recomputed as the bubble moves. Takes on flat ground and
camera takes look as they do today.  
**Excluded:** The XR/AR viewer (its dome stands on the recorded floor at the
author's feet, B-022; whether it should follow the ground too is a separate
decision). The Quick Look USDZ edge. Removing scene triangles hidden below
the ground at capture (queued in `TODOS.md`). Changing what the bubble clips.

## Acceptance criteria

- [ ] On the hill take, at every direction round the dome, the rim sits on
  the ground at the foot's edge, or, where there is no ground there, on the
  nearest ground inward (within 5 cm), at the take's start and after the
  author has walked.
- [ ] Orbiting the hill take in the feed, no glass, ember or spark shows
  below the ground's edge, and no gap shows between the rim and the ground.
- [ ] As the author walks, the rim moves smoothly: no visible jump between
  frames where the ground under the rim changes (a cliff edge, a gap).
- [ ] A take on flat ground draws the same dome as before (rim height 0
  everywhere; numeric shape and a screenshot match).
- [ ] Camera takes and takes without a recorded avatar are unchanged.
- [ ] The feed keeps its frame budget on a phone-class profile, and the load
  cost of reading the ground fits the feed card's existing render wait.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| The ground reading picks up props (fences, posts, statues, trees) and the rim climbs them | Only large ground pieces count as ground (mockup: horizontal extent over 4 m); design review to settle the rule. Hill fixture check |
| No ground anywhere under or inside the rim (a take on a platform over a void, or no scene) | Rim height 0: today's dome |
| Ground higher than the dome can take (a mountain inside the foot) | Rim lift capped (mockup: 0.6 of the dome's height) |
| The bubble walks beyond the area whose ground was read | Read the ground over the take's whole path plus the bubble's radius at load |
| Reading the ground is slow on large scenes | Bounded grid (mockup: 0.2 m cells over the path), measured on the hill take; time-sliced if it exceeds the render wait |
| Rim pops where the inward search jumps (a cliff, a gap in the ground) | Smooth across neighbouring directions and over time |
| Water or glass surfaces count as ground | Ground rule excludes them, or accept and record; hill fixture has water (`Agua`) |
| The shade hangs in empty glass once the rim lifts | Decision below: the shade moves to the ground at the author's feet or is not drawn |
| Embers and sparks stay on the old shell | Same lift applied to all three parts |
| Flat-floor takes change | Lift is exactly 0 on flat ground; screenshot and shape comparison |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude (Opus) | Brief, integration, final handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only review before implementation |
| Implementer | To assign (Standard tier) | `packages/xr-ui-three/src/ThreeCloche.ts`, `packages/xr-ui-core/src/cloche.ts`, `apps/viewer-web/src/features/feed/HologramCardCanvas.tsx`, a ground-reading module under `apps/viewer-web/src/features/hologram/` |
| Independent verifier | Codex (different vendor) | Read-only verification; test artifacts only |

## Design decision

Chosen from mockups: the rim follows the ground. The mockup's mechanics,
to be challenged in design review:

- **Read the ground once at load.** Cast down over a grid covering the take's
  path plus the bubble's radius, against the large ground pieces only, and
  keep the top surface as a height field.
- **Rim height per direction.** Each frame, for each of 180 directions round
  the foot, take the ground at the foot's edge; if there is none, step inward
  until there is. Lift = ground − foot, clamped to [0, 0.6 × dome height].
- **Bend the dome.** Each vertex of the shell, embers and sparks moves up by
  lift(direction) × (1 − y / dome height): the rim rises fully, the crown not
  at all. The mockup did this on the CPU; a shader uniform array or a small
  texture is the likely production form.

Open for review: where the shade goes; smoothing; the ground rule; whether
the clip should also follow the bent dome; whether the XR viewer should adopt
the same rim later.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Rim on the ground, start and after walking | Extend the feed floor check (`e2e/floor-proof.ts`, `bubble-capture.pipeline.spec.ts`) with a rim report on a hill fixture | `*-report.json` with rim vs ground per direction; pending |
| Nothing below the ground's edge while orbiting | Feed portal orbit on the hill take | Screenshot contact sheet; proof video; pending |
| Smooth as the author walks | Rim heights per frame over the take | Max frame-to-frame change in the report; pending |
| Flat ground unchanged | Existing feed and cloche checks | Shape comparison and screenshot; pending |
| Camera takes unchanged | Existing camera-take checks | Pass; pending |
| Frame budget and load cost | Feed perf check, phone profile | Timing in the report; pending |

## Physical-device limits

Feed rendering on flat screens only; no headset check applies. A phone
browser check of the hill take confirms frame rate on real hardware.
