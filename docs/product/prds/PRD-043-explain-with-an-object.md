# PRD: Explain with an object

**Status:** Draft  
**Source ideas:** IDEA-059  
**Layer:** Event  
**Depends on:** IDEA-045 portal (approved); hand-tracking fidelity (in verification)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: to explain how two parts fit, or how a mechanism moves, an author
sends a video or a diagram, and the recipient still gets the orientation or
order wrong when they try it.
After: the author records themselves handling a supplied 3D model while
explaining; the recipient pauses, looks at the object from any side, and then
assembles or operates the real thing correctly on the first try.

## Problem

This is the [Approach](../APPROACH.md)'s candidate experiment and research
question 12. A source check on 2026-10-20 found the capture exporter writes
avatar bone, morph-target, and root tracks plus a static sampled scene bubble;
it does not record a moved object's transform over time. So the experiment
needs one new event capability: a supplied object whose motion is part of the
recording.

## Primary User And Moment

- **Author:** someone who knows an assembly or mechanism, in a Quest, with a
  supplied model of the parts.
- **Recipient:** someone who must do the task, watching on a phone just before
  they do it.

## Proposed Interaction

- Capture loads one supplied GLB model into the scene; the author grabs, moves,
  and rotates it while speaking.
- The object's transform is recorded every frame as part of the event and
  exported in the same GLB animation clip.
- The viewer plays it back in the portal with pause and orbit (PRD-002) so the
  recipient can inspect the object at any moment.

## Why Holograms

A video shows the object from one camera; a hologram lets the recipient look
at it from the side the explanation needs. The fair comparison is a decent
video of the same explanation, not a weak control.

- **Anchored to the event:** the object is part of the event, at true scale.
- **Read from the body:** its motion comes from the author's hands.
- **Intent, not a view:** the author handles the object; each device frames it.
- **Works on a flat phone:** paused, the portal orbits the object.
- **Lost as a video:** the object's orientation from any side, at any moment.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Life-size object in the author's hands | Walk around; pause |
| Phone portal | Same through the portal | Pause, orbit, zoom (PRD-002) |
| Desktop | Same | Same with mouse |
| Still image or Quick Look | Quick Look may play object motion if USDZ conversion keeps it; verify | None |

## In Scope

- [ ] Load one supplied model in capture; grab and move it with hands or controllers.
- [ ] Record and export its transform track; render it in viewer playback.
- [ ] End-to-end: record -> export -> upload -> view, with screenshots at key moments.
- [ ] The recipient trial below.

## Out Of Scope

- [ ] Multiple objects, physics, articulated parts, object authoring tools.
- [ ] Symbol Forge or any universal vocabulary (see the spatial-language concept).

## Success Signals

- [ ] **Technical:** object motion survives export and playback, synchronized with the body and voice.
- [ ] **Communication:** see the trial below. Technical success does not mean the idea helps.

## Risks And Open Questions

- [ ] Does inspecting the object improve performance on a real follow-up task?
- [ ] The task must truly depend on orientation or order; otherwise video wins.
- [ ] Physical-headset validation is needed for grabbing feel.

## Comparison And Learning

Task: assemble two real parts (or operate a simple mechanism) after one viewing.
Five or more recipients, hologram via portal versus a decent phone video of
the same explanation with the same preparation effort; counterbalance with two
equivalent tasks. Measures: first-try success, errors, time, clarification
questions, and author effort. Continue if hologram recipients make fewer
errors; revise if they never orbit; park if no difference. A broken pipeline
is a blocked result, not a negative one.

## Decision

Pending until explicitly decided. Drafting this document is not approval to
build. This is the Approach's leading candidate experiment alongside portal
and body-first work.

## Links

- Concept: [spatial language](../concepts/spatial-language.md),
  [hologram authoring](../concepts/hologram-authoring.md)
- Research: [open questions](../research/open-questions.md) (questions 1, 12)
- Related PRDs: [PRD-002 portal view](PRD-002-portal-view.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
