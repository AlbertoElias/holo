# PRD: Publish from capture

**Status:** Draft  
**Source ideas:** IDEA-046  
**Layer:** All layers  
**Depends on:** live deployment (in verification); IDEA-052 only if ownership is required  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: after recording in the headset, an author exports a GLB file, moves it
to a computer, opens the viewer, and uploads it with a title, so a message
takes many minutes and two devices to send.
After: right after recording, the author taps "Publish", adds a title, and gets
a link to send, without leaving the headset; the local export still works.

## Problem

Repeat use depends on sending being cheap. The Approach lists direct publishing
as step 4 of the candidate progression, to add "when export/upload friction
obstructs repeat use". The viewer API already supports a presigned
direct-to-storage upload flow, which capture can reuse.

## Primary User And Moment

An author in a Quest who just finished a take and wants to send it to one person.

## Proposed Interaction

- After a take, the recording panel offers Publish and Export.
- Publish asks for a title (voice or keyboard) and uploads via the existing
  initiate -> PUT -> complete flow, showing progress.
- On success: a short link and a QR code to open it on a phone. On failure: the
  recording stays local and Publish can be retried.

## Why Holograms

This is pipeline work; it has no meaning-layer element. How it serves the test:

- **Anchored to the event:** publishing must carry the whole event and meaning
  layer unchanged; no flattening on the way.
- **Read from the body / intent:** not applicable.
- **Works on a flat phone:** the result is a link that opens the portal (IDEA-058).
- **Lost as a video:** nothing; this keeps the hologram a hologram end to end.

Fair comparison: the current export-and-upload path, timed.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Publish in the recording panel, title, progress, link | Point and pinch; voice title |
| Phone portal | Opens the published link | None new |
| Desktop | Existing upload path stays | None new |
| Still image or Quick Look | Quick Look follows the existing async USDZ job | None new |

## In Scope

- [ ] Publish from the capture recording panel using the presigned upload flow.
- [ ] Title entry, progress, success link, and retry on failure.
- [ ] End-to-end check: record -> publish -> open on phone.

## Out Of Scope

- [ ] Accounts and ownership (IDEA-052), tags, editing after publish.

## Success Signals

- [ ] **Technical:** a take reaches a playable link with no file handling, and a
  failure never loses the recording.
- [ ] **Repeat use:** see below.

## Risks And Open Questions

- [ ] When does export/upload friction prevent repeat use? Observe before building.
- [ ] Text entry in the headset; anonymous publishing without identity.

## Comparison And Learning

Task: authors send three messages over a week. Compare the current path with
direct publish. Measures: time from end of take to sent link, and how many
messages authors choose to send. Continue if time drops and authors send more.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [creator pipeline](../concepts/creator-pipeline.md)
- Research: [open questions](../research/open-questions.md) (question 15)
- Feature brief (related, not this PRD): [live deployment](../../features/live-deployment.md)
- Mockups: none
- Implementation issue: none
