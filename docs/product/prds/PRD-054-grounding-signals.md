# PRD: Grounding signals at a moment

**Status:** Parked  
**Source ideas:** IDEA-007  
**Layer:** Conversation  
**Depends on:** live sessions (none), or Holo Replies (PRD-012) for an async form  
**Owner:** Alberto Elias  
**Last updated:** 2026-10-20

## Decision

Parked 2026-10-18 by the agreed lens in [what a hologram is](../concepts/what-a-hologram-is.md).
Rationale: the signals are mainly for live sessions, and realtime multiplayer
is not a current commitment (see [Approach](../APPROACH.md)). Their async form
overlaps with checkpoints (PRD-011) and replies (PRD-012), which should be
learned from first. Revisit when a live session is approved, or if async
recipients want a lighter reply than a recorded one.

## User Outcome

Before: in a spatial discussion, a listener who is confused has to interrupt,
or stays quiet and is lost from then on.
After: the listener makes a quick sign (understood, confused, disagree, need an
example) that attaches to the current moment and referent, and the speaker sees
it without stopping.

## Problem

Conversation runs on small acknowledgements. In VR and through portals the
usual ones (nods, faces) are weak or missing.

## Primary User And Moment

A listener in a live VR session, or later an async viewer at a confusing moment.

## Proposed Interaction

- Four signals from a fixed menu direction or a hand sign.
- A signal attaches to the moment and the current referent and shows to the
  speaker as a small mark near the listener.
- Recorded into the session so the replay shows where people were confused.

## Why Holograms

A thumbs-up in a call has no referent. Fair comparison: reactions in a video
call, or a chat message.

- **Anchored to the event:** a moment and referent.
- **Read from the body:** a hand sign can be the signal.
- **Intent, not a view:** signals state, never move views.
- **Works on a flat phone:** four buttons in the portal chrome.
- **Lost as a video:** the link between confusion and the thing being discussed.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Small mark by the listener | Hand sign or menu |
| Phone portal | Same mark | Four buttons |
| Desktop | Same | Keys or buttons |
| Still image or Quick Look | Not applicable | None |

## In Scope

- [ ] Four signals, attached to moment and referent, visible to the speaker.

## Out Of Scope

- [ ] Treating a glance or silence as agreement.

## Success Signals

- [ ] **Communication:** confusion is repaired sooner than in a video call.

## Risks And Open Questions

- [ ] Which signals are faster than speech and socially comfortable?

## Comparison And Learning

If reopened: a live explanation with planted ambiguity. Compare signals with
video-call reactions. Measures: time from confusion to repair.

## Links

- Concept: [communication protocols](../concepts/communication-protocols.md),
  [live VR and AR dialogue](../concepts/live-vr-ar-dialogue.md)
- Research: [open questions](../research/open-questions.md) (question 6)
- Mockups: none
- Feature brief: none
- Implementation issue: none
