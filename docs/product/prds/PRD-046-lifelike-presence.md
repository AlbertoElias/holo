# PRD: Which cues make someone feel present

**Status:** Draft  
**Source ideas:** IDEA-063  
**Layer:** Event  
**Depends on:** hand-tracking fidelity (in verification), avatar height adaptation (complete)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: a recipient watching a personal hologram sees an avatar that moves like
the sender, but does not feel the sender is there.
After: the recipient says it felt like the person was in front of them, and
would choose a hologram over a video for the next personal message.

## Problem

The user wants people to feel someone is in front of them. Lifelike capture
covers face, gaze, body, hands, voice, scale, and placement; it is unknown which
cues matter most. Visual realism alone may raise discomfort without raising
presence. This PRD is a study, not a capture technology commitment.

## Primary User And Moment

A recipient who knows the sender, receiving a short personal message, on a
phone and in AR.

## Proposed Interaction

Record one message once, then vary one cue at a time in playback:

- Hands: full finger tracking versus simplified hands.
- Scale and placement: true size on the floor in AR versus a small floating bubble.
- Voice: spatial versus flat audio.
- Face: none versus expression (if PRD-008 shows face data is available).

## Why Holograms

Video gives a real face but no presence in the room. The fair comparison is a
video message from the same person.

- **Anchored to the event:** every cue is part of the recorded body.
- **Read from the body:** nothing added.
- **Intent, not a view:** fidelity is chosen for felt connection, not spectacle.
- **Works on a flat phone:** the portal versions are part of the study.
- **Lost as a video:** a person at true scale in your space.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Life-size sender in the room | Walk around |
| Phone portal | Portal versions of each cue | Portal gestures |
| Desktop | Same as phone | Mouse |
| Still image or Quick Look | Quick Look AR at true scale on iOS | None |

## In Scope

- [ ] A study design varying one cue at a time with existing capture data.
- [ ] Playback toggles for each cue (dev-only).

## Out Of Scope

- [ ] Volumetric capture, photoreal avatars, new hardware.

## Success Signals

- [ ] **Presence:** see below. Presence ratings do not substitute for comprehension measures elsewhere.

## Risks And Open Questions

- [ ] Which cues provide felt presence at an acceptable capture cost?
- [ ] Novelty effects; consent for recording people the recipient knows.

## Comparison And Learning

Task: five or more recipient-sender pairs who know each other. Each recipient
sees cue variants and the video (counterbalanced). Measures: felt connection,
authenticity, discomfort, and which they would choose for the next message.
Continue with the cues that raise connection; park the cues that do not.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [embodied communication](../concepts/embodied-communication.md)
- Research: [open questions](../research/open-questions.md) (questions 3, 18)
- Related PRDs: [PRD-008 hybrid embodiment](PRD-008-hybrid-embodiment.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
