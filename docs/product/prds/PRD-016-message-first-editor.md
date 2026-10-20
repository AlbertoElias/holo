# PRD: Message-first editor, first lane operation

**Status:** Draft  
**Source ideas:** IDEA-022  
**Layer:** All layers  
**Depends on:** IDEA-069 (review), IDEA-032 (marks to edit)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: an author who wants to keep the performance but drop a wrong
pointing highlight, or keep the voice but fix a gesture, has to re-record
everything.
After: the author opens the take in lanes (performance, voice, environment,
marks, attention) and changes one lane without touching the others.

## Problem

Editing a hologram is not editing a video: there is no camera lane, and body,
voice, and meaning are separable data. A full editor is a large commitment the
[Approach](../APPROACH.md) warns against. This PRD asks for the single most
valuable lane operation, not the editor.

## Primary User And Moment

An author reviewing a take in capture or on a desktop before publishing.

## Proposed Interaction

Lanes as described in the [authoring concept](../concepts/hologram-authoring.md),
read-only except for one operation chosen by evidence. Candidates:

- Dismiss or confirm an inferred mark (marks lane), likely first.
- Trim the voice independently of the body (voice lane).
- Replace a time span of one lane (performance or voice).

No camera lane, ever.

## Why Holograms

A video editor's main lane is the camera; here there is none, because each
viewer's device frames the event. Fair comparison: the same correction made by
re-recording.

- **Anchored to the event:** lanes are the event and meaning layers.
- **Read from the body:** the marks lane starts from what was read from the body.
- **Intent, not a view:** no camera lane.
- **Works on a flat phone:** edits show in any viewer; editing itself may be desktop-only.
- **Lost as a video:** independent body, voice, and meaning tracks.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Lanes as a panel in capture review | Hands or controllers |
| Phone portal | Not an editing surface | None |
| Desktop | Lanes under a portal preview | Mouse and keyboard |
| Still image or Quick Look | Not applicable | None |

## In Scope

- [ ] Read-only lane view of a take.
- [ ] One editing operation chosen from the candidates above, with provenance.

## Out Of Scope

- [ ] A general timeline editor, keyframing, or animation tools.

## Success Signals

- [ ] **Technical:** an edit in one lane leaves every other lane bit-identical after export.
- [ ] **Authoring:** see the trial below.

## Risks And Open Questions

- [ ] Which lane operation is indispensable? Needs observation of real takes.
- [ ] Scope creep toward a full editor.

## Comparison And Learning

Task: an author corrects one wrong mark or one wrong word. Compare the lane
operation with re-recording. Measures: time and preference. Continue to a
second operation only with evidence; park if trimming and retakes cover most fixes.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [hologram authoring](../concepts/hologram-authoring.md)
- Research: [open questions](../research/open-questions.md) (question 14)
- Mockups: none
- Feature brief: none
- Implementation issue: none
