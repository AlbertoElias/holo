# PRD: Self-resolving pointing

**Status:** Approved  
**Source ideas:** IDEA-032  
**Layer:** Meaning (read)  
**Depends on:** hand-tracking fidelity (in verification), avatar height adaptation (complete), IDEA-045 portal (approved)  
**Owner:** Alberto Elias  
**Last updated:** 2026-10-22

## User Outcome

Before: when the author points and says "this one", a phone viewer has to
work out from one camera angle which of several nearby things the finger was
aimed at, and often guesses wrong.
After: while the author points, the thing their finger was aimed at lights up
in the feed portal on phone and desktop, without the author adding anything
in a headset (or by holding one point action on desktop), so the viewer names
the right referent on the first try. When the system is unsure it shows
nothing, so a highlight can be trusted.

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

- Detect pointing from the tracked hand pose (extended index finger, others
  curled) held long enough to be deliberate. Gaze is not a source in v0: the
  headset browser exposes head direction, not eye direction, and it should
  only be added once finger precision is measured.
- Cast the finger ray at export into the recorded scene and the author's own
  body; the first hit is the referent.
- While the pointing lasts, the referent gets an inferred-style highlight
  (outline or glow) and a faint ray from the fingertip.
- Low-confidence hits show nothing rather than a wrong highlight.
- Author review that can dismiss a wrong link comes later, not in v0.

### Capturing on desktop

Desktop capture (keyboard movement, pointer-lock mouse look) has no hand
control, so a 2D take never holds a pointing hand pose. Decided 2026-10-21:
add an explicit point action rather than leave 2D takes without highlights,
or read mouse-look as gaze (mouse-look mostly navigates, so it would flood
false highlights).

- While the author holds the point action (right mouse button, or F on a
  trackpad), the avatar's arm points along an aim ray from the avatar's eyes
  through the existing arm IK, and a crosshair shows where it lands. Mouse
  movement aims while the action is held, so the author can aim above eye
  level even in the third-person view.
- On desktop the ray resolves against the scene only; pointing at the
  avatar's own body is headset-only in v0.
- The take records that target ray directly, so the referent is the
  author's deliberate choice and needs no confidence guess.
- The synthesized arm pose is marked inferred (PRD-018); the target ray is
  recorded intent.
- Resolution works on the recorded event, a hand pose plus an optional
  explicit target ray, not on the capture device, so playback and
  highlighting are the same for headset and desktop takes.

### First mark: what v0 adopts from PRD-003 and PRD-018

Pointing is the first mark, so it brings in only the parts of the
meaning-layer record ([PRD-003](PRD-003-hologrammar-v0.md)) and of provenance
([PRD-018](PRD-018-provenance.md)) that it needs. Both PRDs stay Draft for
everything else.

**Meaning-layer record, v0.** One versioned, optional glTF extension on the
exported GLB holding a list of marks. Each pointing link has exactly four
fields, named as in the [design language](../concepts/design-language.md)
mark shape:

- **kind:** `link` (the only kind in v0).
- **anchor:** where the link starts and ends. `from` is the pointing hand's
  index fingertip, as a humanoid bone, so the viewer can draw the ray and
  tell two pointing hands apart. `to` is the referent, either a humanoid
  bone (by a stable humanoid name, not the avatar rig's own bone name) or a
  scene node, plus the hit point stored local to that bone or node. The
  scene bubble is already exported as one
  clipped mesh per source object, so "the thing" is that object's node; a hit
  on large undivided geometry (floor, walls) anchors to the point with a small
  radius. A multi-part object (a tree made of several meshes) highlights
  only the part that was hit. Never a screen position.
- **span:** start and end in recording time.
- **provenance:** `inferred` with a confidence for points read from the hand;
  `recorded` for the desktop point action, because the author chose the
  target. `added` is a valid value with no producer in v0.

Links are computed once in capture and stored; viewers render them and do
not recompute. Capture is the only place with the tracked hand joints (the
GLB keeps only retargeted avatar bones) and the full scene, so pointing is
read from the tracked hand while recording and resolved against the scene at
export. This answers PRD-003's "stored or recomputed" question for v0.
Older exports and other glTF viewers ignore the extension and play the event
unchanged. Intent, response contracts, author, content, state, and a second
mark kind stay out until a PRD needs them.

**Provenance, v0.** Every pointing link carries the field above, and the
highlight looks different by provenance: inferred links use the lighter,
inferred style; recorded links are plain. The desktop arm pose synthesized
during a point action is stored as an inferred motion span in the same
record, but v0 does not style it on the avatar. Styling inferred motion (this
arm, synthesized locomotion, filled tracking gaps), inspection by long-press
or hover, and the "unedited" badge stay with PRD-018.

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
| Headset (VR or AR) | Later: same outline and ray in the world (v0 plays the event without highlights) | Highlights toggle (Free can hide) |
| Phone portal | Outline on the referent (lighter for inferred, plain for recorded) and a faint ray from the fingertip; visible from any orbit | Highlights toggle |
| Desktop | Same | Same |
| Still image or Quick Look | Outline baked into a still at that moment; dropped in Quick Look | None |

## In Scope

- [ ] Pointing detection from tracked hand poses (gaze deferred).
- [ ] A desktop point action that drives the avatar's arm along the crosshair
  and records an explicit target ray, with the arm pose marked inferred.
- [ ] Ray casting into the recorded scene bubble and the avatar.
- [ ] A confidence threshold that prefers no highlight over a wrong one.
- [ ] Storage of links in the v0 meaning-layer record (PRD-003 subset above)
  with provenance, inferred or recorded.
- [ ] Rendering in the feed portal on phone and desktop, styled by provenance,
  with a highlights toggle.
- [ ] An end-to-end run on a real headset recording, with screenshots of each highlighted moment.
- [ ] A replay check of a desktop take using the point action, with the same evidence.

## Out Of Scope

- [ ] Follow camera behavior (IDEA-041).
- [ ] Object segmentation beyond what the scene bubble and avatar already provide.
- [ ] Authored notes (PRD-001, parked).
- [ ] Gaze as a pointing source; author review or dismissal of links.
- [ ] Highlights in the headset viewer, immersive AR, and Quick Look (the
  extension is ignored there in v0; the event still plays).
- [ ] Styling inferred motion on the avatar, provenance inspection, and the
  "unedited" badge (PRD-018).
- [ ] Re-resolving links for exports made before this feature.
- [ ] Points made with controllers rather than tracked hands.

## Success Signals

Targets are set precision-first, from open question 7: a missed point costs
the viewer what they have today, while a wrong highlight actively misleads.
They are measured against a hand-labelled list of deliberate points (start,
end, intended referent) for each recording, kept beside the fixture.

- [ ] **Technical, headset:** on at least three real headset recordings with
  at least 20 labelled deliberate points in total:
  - false highlights (a highlight on the wrong referent, or any highlight
    outside a labelled point) are at most 1 in 20 highlights shown (≤ 5%), and
    none fire during the open, fist, pinch, wave, or reach segments of the
    existing hand fixture;
  - at least 80% of labelled points produce the intended highlight;
  - a highlight appears within 0.5 s of the point becoming deliberate and
    clears within 0.5 s of it ending.
- [ ] **Technical, desktop:** every held point action whose ray hits the
  scene produces a highlight on what the crosshair was on, with no false
  highlights; a ray that hits nothing produces no link and shows nothing.
- [ ] **Communication:** the trial below shows recipients name the right
  referent more often with highlights than without.
- [ ] **Tolerance (question 7):** in the same trial, ask recipients after each
  task whether any highlight misled them. If anyone was misled while the
  measured false rate met 5%, lower the target; if nobody noticed at 5%,
  record that as the first answer to question 7.

## Risks And Open Questions

- [ ] Which pointing and gaze signals are reliable enough to fire without false highlights?
- [ ] The scene bubble is sampled geometry; "the thing" may not exist as a separate object.
- [ ] Hand-tracking quality on the physical headset sets the ceiling; emulation cannot answer it.
- [x] Does a button-driven point still pass the recorded-event test? Yes:
  the target is the author's choice, recorded as a `recorded` link, and the
  synthesized arm is stored as an inferred span.
- [ ] Only one real headset recording exists; the three-recording signal
  needs new physical-headset takes with labelled points.

## Comparison And Learning

Task: a real recording where the author points at three of several similar
nearby things. At least five recipients on their own phones, portal with
highlights versus portal without. Measures: correct referent, time, and
clarification questions. Continue if correct answers rise clearly; revise the
threshold if false highlights mislead; park if no difference.

## Decision

Approved 2026-10-22 by Alberto Elias, as tightened on 2026-10-21: v0 shows
highlights in the feed portal on phone and desktop, from finger pointing in a
headset and the held point action on desktop, with the precision-first
targets above. It brings in only the PRD-003 record and PRD-018 provenance
subset described under "First mark"; those PRDs stay Draft for the rest.

Amended 2026-10-22 after design review of the brief: a desktop hold that hits
nothing shows nothing (no link, no ray); desktop aiming uses an eye-origin aim
ray so third-person takes can aim upwards, and does not resolve against the
author's own body; the anchor names the pointing fingertip (`from`) as well as
the referent (`to`); controller points are out of v0. The
lens names this the first meaning-layer priority after portal view.

## Links

- Concept: [embodied communication](../concepts/embodied-communication.md),
  [viewer experience](../concepts/viewer-experience.md),
  [what a hologram is](../concepts/what-a-hologram-is.md)
- Research: [open questions](../research/open-questions.md) (questions 4, 7)
- Related PRDs: [PRD-003 HoloGrammar v0](PRD-003-hologrammar-v0.md),
  [PRD-030 Follow camera](PRD-030-follow-camera.md),
  [PRD-031 object-indexed timeline](PRD-031-object-indexed-timeline.md)
- Mockups: none
- Feature brief: [self-resolving pointing](../../features/self-resolving-pointing.md)
- Implementation issue: none
