# PRD: Self-resolving pointing

**Status:** Draft  
**Source ideas:** IDEA-032  
**Layer:** Meaning (read)  
**Depends on:** hand-tracking fidelity (in verification), avatar height adaptation (complete), IDEA-045 portal (approved)  
**Owner:** Unassigned  
**Last updated:** 2026-10-21

## User Outcome

Before: when the author points and says "this one", a phone viewer has to
work out from one camera angle which of several nearby things the finger was
aimed at, and often guesses wrong.
After: the thing the author's finger (or gaze) was aimed at lights up while
they point, on every device, without the author adding anything, and the
viewer can name the right referent on the first try.

## Problem

Spoken explanations lean on deixis: "this", "that one", "over here". The body
resolves the reference for people standing next to the speaker; a fixed view
often does not, because candidates line up or the target is hidden. The parked
[PRD-001](PRD-001-anchored-notes.md) tried to fix this with typed notes. The
lens says to reveal what the body already said before asking for more, and
this is the first and most important case. It also unlocks the Follow camera
(IDEA-041), spatial subtitles (IDEA-014), the clarity co-director (IDEA-023),
and the object-indexed timeline (IDEA-044).

## Primary User And Moment

- **Author:** someone recording an explanation in VR who points at parts of
  the scene or their own body while talking. They do nothing extra.
- **Desktop author:** someone recording on a computer, steering the avatar
  with keyboard and mouse. Their hands are not tracked, so they hold a point
  action to aim (see Capturing on desktop).
- **Recipient:** someone watching later through the phone portal, at the
  moment the author says "this".

## Proposed Interaction

- Detect pointing from hand pose (extended index finger, others curled) held
  long enough to be deliberate, and optionally a gaze ray during speech.
- Cast the ray at playback time or export time into the recorded scene and the
  author's own body; the first hit is the referent.
- While the pointing lasts, the referent gets an inferred-style highlight
  (outline or glow) and a faint ray from the fingertip.
- Low-confidence hits show nothing rather than a wrong highlight.
- Author review (optional in the first version) can dismiss a wrong link.

### Capturing on desktop

Desktop capture (keyboard movement, pointer-lock mouse look) has no hand
control, so a 2D take never holds a pointing hand pose. Decided 2026-10-21:
add an explicit point action rather than leave 2D takes without highlights,
or read mouse-look as gaze (mouse-look mostly navigates, so it would flood
false highlights).

- While the author holds the point action (a mouse button or key), the
  avatar's arm points along the crosshair ray through the existing arm IK.
- The take records that target ray directly, so the referent is the
  author's deliberate choice and needs no confidence guess.
- The synthesized arm pose is marked inferred (PRD-018); the target ray is
  recorded intent.
- Resolution works on the recorded event, a hand pose plus an optional
  explicit target ray, not on the capture device, so playback and
  highlighting are the same for headset and desktop takes.

## Why Holograms

A video records pixels of a finger; it cannot know what the finger hit. A
hologram records the finger's pose and the scene in 3D at true scale, so the
hit can be computed. Fair comparison: the same hologram on the same portal
without highlights.

- **Anchored to the event:** the referent is a scene node, region, or body part
  at the moment of pointing.
- **Read from the body:** entirely; no authoring.
- **Intent, not a view:** "this is what I meant"; the device decides how to show it.
- **Works on a flat phone:** an outline is legible on a small card, and Follow
  can ease toward it later (IDEA-041).
- **Lost as a video:** the computed link between the finger and the thing.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Inferred-style outline on the referent; faint ray from fingertip | Highlights toggle (Free can hide) |
| Phone portal | Same outline through the portal; visible from any orbit | Same toggle |
| Desktop | Same | Same |
| Still image or Quick Look | Outline baked into a still at that moment; dropped in Quick Look | None |

## In Scope

- [ ] Pointing detection from recorded hand poses; gaze as a second source if reliable.
- [ ] A desktop point action that drives the avatar's arm along the crosshair
  and records an explicit target ray, with the arm pose marked inferred.
- [ ] Ray casting into the recorded scene bubble and the avatar.
- [ ] A confidence threshold that prefers no highlight over a wrong one.
- [ ] Storage of links in the meaning-layer record (PRD-003) with provenance "inferred".
- [ ] Rendering in the feed portal on phone and desktop.
- [ ] An end-to-end run on a real headset recording, with screenshots of each highlighted moment.
- [ ] A replay check of a desktop take using the point action, with the same evidence.

## Out Of Scope

- [ ] Follow camera behavior (IDEA-041).
- [ ] Object segmentation beyond what the scene bubble and avatar already provide.
- [ ] Authored notes (PRD-001, parked).

## Success Signals

- [ ] **Technical:** on at least three real recordings, every deliberate point
  produces the intended highlight and false highlights are rare (target to set
  from question 7 below).
- [ ] **Communication:** see the trial below.

## Risks And Open Questions

- [ ] Which pointing and gaze signals are reliable enough to fire without false highlights?
- [ ] The scene bubble is sampled geometry; "the thing" may not exist as a separate object.
- [ ] Hand-tracking quality on the physical headset sets the ceiling; emulation cannot answer it.
- [ ] Does a button-driven point still pass the recorded-event test? Working
  answer: yes, because the target is the author's choice and the synthesized
  arm is labelled inferred; confirm in review.

## Comparison And Learning

Task: a real recording where the author points at three of several similar
nearby things. At least five recipients on their own phones, portal with
highlights versus portal without. Measures: correct referent, time, and
clarification questions. Continue if correct answers rise clearly; revise the
threshold if false highlights mislead; park if no difference.

## Decision

Pending until explicitly decided. Drafting this document is not approval to
build. The lens names this the first meaning-layer priority after portal view.

## Links

- Concept: [embodied communication](../concepts/embodied-communication.md),
  [viewer experience](../concepts/viewer-experience.md),
  [what a hologram is](../concepts/what-a-hologram-is.md)
- Research: [open questions](../research/open-questions.md) (questions 4, 7)
- Related PRDs: [PRD-003 HoloGrammar v0](PRD-003-hologrammar-v0.md),
  [PRD-030 Follow camera](PRD-030-follow-camera.md),
  [PRD-031 object-indexed timeline](PRD-031-object-indexed-timeline.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
