# PRD: Notes left on real places

**Status:** Parked  
**Source ideas:** IDEA-015  
**Layer:** Meaning (added)  
**Depends on:** persistent AR anchors; an ownership and expiry model; identity (PRD-037)  
**Owner:** Alberto Elias  
**Last updated:** 2026-10-20

## Decision

Parked 2026-10-18 by the agreed lens in [what a hologram is](../concepts/what-a-hologram-is.md).
Rationale: these are typed notes, the same kind of added meaning parked in
PRD-001, placed in the viewer's own physical space, which also needs
persistent AR anchors and an ownership and expiry model. Proximity notes
(PRD-027) test place-based notes inside the recorded event first. Revisit when a team trial (PRD-048)
asks to leave guidance on real equipment.

## User Outcome

Before: guidance about a machine lives in a manual or a chat thread, away from
the machine.
After: someone wearing AR sees a short hologram or note pinned to the machine
itself, left by the colleague who knows it.

## Problem

Knowledge about places and equipment is separated from them.

## Primary User And Moment

A technician arriving at a shared machine; the expert who left the note earlier.

## Proposed Interaction

- The expert, in AR at the machine, records a short hologram and anchors it there.
- Others in AR at the same place see a marker and play it.
- Notes have an owner and an expiry.

## Why Holograms

Fair comparison: a laminated note or QR code on the machine linking to a video.

- **Anchored to the event:** anchored to a real place, and the note itself is an event.
- **Read from the body:** the note is a recorded explanation.
- **Intent, not a view:** "this applies here".
- **Works on a flat phone:** phone AR at the place; portal elsewhere.
- **Lost as a video:** the explanation standing at the machine it explains.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Marker on the real machine | Point to play |
| Phone portal | Phone AR at the place; otherwise a normal portal | Tap |
| Desktop | List of notes by place | Click |
| Still image or Quick Look | Not applicable | None |

## In Scope

- [ ] Persistent anchor, recording at a place, ownership, expiry.

## Out Of Scope

- [ ] Public notes on public places.

## Success Signals

- [ ] **Task:** technicians follow machine-specific guidance correctly more often than from a QR-linked video.

## Risks And Open Questions

- [ ] What ownership and expiry model is needed?
- [ ] Anchor persistence across devices and sessions in the browser.

## Comparison And Learning

If reopened: one shared machine, compare an anchored hologram with a QR-linked
video. Measures: correct procedure and time.

## Links

- Concept: [live VR and AR dialogue](../concepts/live-vr-ar-dialogue.md)
- Research: [open questions](../research/open-questions.md) (question 17)
- Related PRDs: [PRD-001 anchored notes](PRD-001-anchored-notes.md),
  [PRD-027 proximity notes](PRD-027-proximity-notes.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
